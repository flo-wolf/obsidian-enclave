import {
	MarkdownView,
	Menu,
	Notice,
	Platform,
	Plugin,
	setIcon,
	TAbstractFile,
	TFile,
	TFolder,
} from "obsidian";
import {
	createPasswordCheck,
	decryptContent,
	DecryptError,
	encryptContent,
	encryptContentVerified,
	type EnclavePayload,
	type EnclaveScope,
	passwordMatchesCheck,
	SelfCheckError,
} from "./crypto";
import { buildLockedNote, FENCE_LANG, isLocked, isPayload, parseLockedNote, readScope } from "./format";
import { ConfirmModal } from "./ConfirmModal";
import { PasswordModal, type PasswordPromptOptions } from "./PasswordModal";
import { lockedCardExtension, lockedNoteReadOnly } from "./editor";
import { DEFAULT_SETTINGS, type EnclaveSettings, EnclaveSettingTab, type ProtectedFolder } from "./settings";

const SWEEP_INTERVAL_MS = 30 * 1000;

/** Body class that hides the properties box of locked notes (see styles.css). */
const HIDE_PROPERTIES_CLASS = "enclave-hide-lock-properties";

/** Class on the view of a locked note, editing or reading (see styles.css). */
const LOCKED_VIEW_CLASS = "enclave-locked-note";

/** How long to gather notes moved into protected folders before asking once about all of them. */
const MOVE_BATCH_MS = 500;

/** Tracks a note that is currently decrypted on disk so it can be re-locked. */
interface UnlockedNote {
	password: string;
	scope: EnclaveScope;
	iterations: number;
	lastTouched: number;
}

/** One crash-recovery ledger entry: a path that held plaintext, plus its scope. */
interface LedgerEntry {
	path: string;
	scope: EnclaveScope;
}

/** A note that is locked on disk, read once for a bulk operation. */
interface LockedNote {
	file: TFile;
	content: string;
	payload: EnclavePayload;
}

/** Notes found by a bulk operation, grouped by the password they need. */
interface LockedSet {
	vault: LockedNote[];
	note: LockedNote[];
	alreadyUnlocked: TFile[];
}

/** A bulk decrypt ready to run: each locked note paired with the password to try. */
interface BulkDecrypt {
	work: (LockedNote & { scope: EnclaveScope; password: string })[];
	vaultPassword: string | null;
	/** Separate-password notes left alone because that prompt was cancelled. */
	skippedSeparate: number;
}

/** Shape persisted via saveData: settings plus a crash-recovery ledger. */
interface PersistedData {
	settings: EnclaveSettings;
	/** Notes that held plaintext on disk at last write — used to recover after a crash. */
	ledger: LedgerEntry[];
}

export default class EnclavePlugin extends Plugin {
	settings: EnclaveSettings = { ...DEFAULT_SETTINGS };

	/** Vault password cached for the session, never persisted to disk. */
	private vaultPassword: string | null = null;
	private vaultPasswordSetAt = 0;

	/** path -> details needed to re-lock an unlocked note. */
	private unlocked = new Map<string, UnlockedNote>();

	/** Serializes mutating operations per file path (lock/unlock/relock/decrypt). */
	private inFlight = new Set<string>();

	/** True while a bulk folder/vault operation runs, so auto-lock backs off. */
	private bulkActive = false;

	private statusBarEl: HTMLElement | null = null;
	private ribbonEl: HTMLElement | null = null;
	private lastActiveFile: string | null = null;

	/** Notes created in a protected folder this session, locked the first time they're left. */
	private newInProtected = new Set<string>();

	/** Notes moved into a protected folder, waiting for the batched "lock them?" prompt. */
	private movedIn = new Set<string>();
	private movedInTimer: number | null = null;

	/**
	 * Protected folders as they were before the latest folder rename in this batch.
	 * Rename events for the notes inside a renamed protected folder carry old paths
	 * from before the rename, so they are checked against this list too.
	 */
	private protectedBeforeRename: ProtectedFolder[] = [];

	/**
	 * Separate passwords kept in memory while "Remember separate passwords" is on,
	 * keyed by noteKey()/folderKey(). Never written to disk.
	 */
	private separatePasswords = new Map<string, { password: string; usedAt: number }>();

	/** When the "this note is locked" hint was last shown, so typing doesn't flood notices. */
	private lastLockedEditNotice = 0;

	/** Ledger read at startup, and notes found still exposed (plaintext) after a crash. */
	private startupLedger: LedgerEntry[] = [];
	private exposed: { file: TFile; scope: EnclaveScope }[] = [];

	async onload(): Promise<void> {
		await this.loadSettings();
		this.applyPropertyHiding();

		this.addSettingTab(new EnclaveSettingTab(this.app, this));

		this.ribbonEl = this.addRibbonIcon("lock", "Enclave: toggle lock on current note", async () => {
			await this.toggleActiveNote();
		});

		// Show the encrypted payload block as an "unlock" card instead of a wall of
		// base64: in reading view via a code block processor, and in Live Preview via
		// an editor extension that also keeps the cursor out of the block.
		this.registerMarkdownCodeBlockProcessor(FENCE_LANG, (source, el, ctx) =>
			this.renderLockedCard(el, source, ctx.sourcePath)
		);
		this.registerEditorExtension([
			lockedCardExtension((el, source, path) => this.renderLockedCard(el, source, path)),
			lockedNoteReadOnly(() => this.notifyLockedEdit()),
		]);

		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass("enclave-status");
		this.statusBarEl.addEventListener("click", () => {
			if (this.unlocked.size > 0) void this.lockAll();
		});
		this.updateStatusBar();

		this.registerCommands();
		this.registerEvents();

		// One fixed-cadence sweep; it reads current settings each tick, so settings
		// changes take effect without re-registering (avoids leaking intervals).
		this.registerInterval(window.setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS));

		this.app.workspace.onLayoutReady(() => {
			this.lastActiveFile = this.app.workspace.getActiveFile()?.path ?? null;
			this.markLockedViews();
			void this.recoverExposedNotes();
			// Registered after layout-ready: Obsidian fires "create" for every file while loading the vault.
			this.registerEvent(this.app.vault.on("create", (file) => this.onCreate(file)));
		});
	}

	onunload(): void {
		// Obsidian does NOT await an async onunload, so this is best-effort: kick off
		// a re-lock of anything still decrypted. The persisted ledger lets the next
		// session detect and re-secure anything this didn't finish in time.
		void this.lockAll(true);
		this.vaultPassword = null;
		this.separatePasswords.clear();
		document.body.removeClass(HIDE_PROPERTIES_CLASS);
		for (const view of this.markdownViews()) view.containerEl.removeClass(LOCKED_VIEW_CLASS);
	}

	/** Show or hide locked notes' properties box, per the setting (styles.css does the hiding). */
	applyPropertyHiding(): void {
		document.body.toggleClass(HIDE_PROPERTIES_CLASS, this.settings.hideLockProperties);
	}

	/** Every open Markdown view. */
	private markdownViews(): MarkdownView[] {
		return this.app.workspace
			.getLeavesOfType("markdown")
			.map((leaf) => leaf.view)
			.filter((view): view is MarkdownView => view instanceof MarkdownView);
	}

	/**
	 * Mark the open views of locked notes, so styles.css can hide their
	 * properties box in editing and reading view. Uses Obsidian's parsed
	 * frontmatter, which is updated after every lock and unlock.
	 */
	private markLockedViews(): void {
		for (const view of this.markdownViews()) {
			const frontmatter = view.file ? this.app.metadataCache.getFileCache(view.file)?.frontmatter : undefined;
			const locked =
				frontmatter?.locked === true &&
				(frontmatter["lock-scope"] === "vault" || frontmatter["lock-scope"] === "note");
			view.containerEl.toggleClass(LOCKED_VIEW_CLASS, locked);
		}
	}

	private registerCommands(): void {
		this.addCommand({
			id: "lock-note",
			name: "Lock note (vault password)",
			checkCallback: (checking) => this.commandOnFile(checking, (f) => this.lockNote(f, "vault")),
		});
		this.addCommand({
			id: "lock-note-separate-password",
			name: "Lock note with a separate password",
			checkCallback: (checking) => this.commandOnFile(checking, (f) => this.lockNote(f, "note")),
		});
		this.addCommand({
			id: "unlock-note",
			name: "Unlock note",
			checkCallback: (checking) => this.commandOnFile(checking, (f) => this.unlockNote(f)),
		});
		this.addCommand({
			id: "permanently-decrypt-note",
			name: "Permanently decrypt note (remove encryption)",
			checkCallback: (checking) => this.commandOnFile(checking, (f) => this.permanentlyDecryptNote(f)),
		});
		this.addCommand({
			id: "lock-all",
			name: "Lock all currently-unlocked notes",
			callback: () => this.lockAll(),
		});

		this.addCommand({
			id: "lock-vault",
			name: "Lock every note in the vault (vault password)",
			callback: () => this.lockFolder(this.app.vault.getRoot()),
		});

		this.addCommand({
			id: "unlock-vault",
			name: "Unlock every locked note in the vault",
			callback: () => this.unlockFolder(this.app.vault.getRoot()),
		});

		this.addCommand({
			id: "permanently-decrypt-vault",
			name: "Permanently decrypt every locked note in the vault",
			callback: () => this.permanentlyDecryptFolder(this.app.vault.getRoot()),
		});

		this.addCommand({
			id: "forget-vault-password",
			name: "Forget remembered passwords",
			callback: () => this.forgetAllPasswords(),
		});
		this.addCommand({
			id: "secure-exposed",
			name: "Secure notes left exposed (after a crash)",
			checkCallback: (checking) => {
				if (this.exposed.length === 0) return false;
				if (!checking) void this.secureExposed();
				return true;
			},
		});
	}

	private registerEvents(): void {
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu: Menu, file) => {
				if (file instanceof TFile && file.extension === "md") {
					this.addFileMenuItems(menu, file);
				} else if (file instanceof TFolder) {
					this.addFolderMenuItems(menu, file);
				}
			})
		);

		this.registerEvent(
			this.app.workspace.on("files-menu", (menu: Menu, files: TAbstractFile[]) => {
				const mdFiles = this.collectMarkdownFiles(files);
				if (mdFiles.length === 0) return;
				this.addFilesMenuItems(menu, mdFiles);
			})
		);

		// Auto-lock the note being left. Listen to both events: file-open misses
		// switches to non-file views / closing the last tab, which leaf-change catches.
		this.registerEvent(this.app.workspace.on("file-open", () => this.handleActiveChange()));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.handleActiveChange()));

		// Keep the "locked note" class on views in step with what they show.
		this.registerEvent(this.app.workspace.on("file-open", () => this.markLockedViews()));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.markLockedViews()));
		this.registerEvent(this.app.metadataCache.on("changed", () => this.markLockedViews()));

		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onRename(file, oldPath)));
		this.registerEvent(
			this.app.vault.on("delete", (file: TAbstractFile) => {
				this.newInProtected.delete(file.path);
				this.movedIn.delete(file.path);
				if (file instanceof TFolder) void this.forgetProtectedUnder(file.path);
				if (this.unlocked.delete(file.path)) {
					void this.persist();
					this.updateStatusBar();
				}
			})
		);

		// Best-effort re-lock on app quit (in addition to onunload).
		this.registerEvent(
			// 'quit' is a real workspace event but not in the public typings.
			(this.app.workspace as { on(name: string, cb: () => void): import("obsidian").EventRef }).on(
				"quit",
				() => void this.lockAll(true)
			)
		);

		// Re-lock when the app/webview goes to the background. This is the ONLY
		// reliable re-lock signal on mobile: onunload and the 'quit' event are not
		// delivered on an OS-initiated suspend, and setInterval (the sweep) is frozen
		// while backgrounded. visibilitychange/pagehide fire on backgrounding in the
		// Capacitor webview, so they bound the plaintext-on-disk window on mobile.
		// pagehide also fires when a desktop window closes.
		this.registerDomEvent(window.document, "visibilitychange", () => {
			if (window.document.hidden) this.handleHidden();
		});
		this.registerDomEvent(window, "pagehide", () => void this.lockAll(true));
	}

	// ---- settings & persistence ----------------------------------------

	async loadSettings(): Promise<void> {
		const raw = (await this.loadData()) as Partial<PersistedData> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, raw?.settings);
		// Drop anything that isn't a valid entry, e.g. from a hand-edited data file.
		this.settings.protectedFolders = (this.settings.protectedFolders ?? [])
			.filter(
				(f): f is ProtectedFolder => typeof f?.path === "string" && (f.scope === "vault" || f.scope === "note")
			)
			.map((f) => (isPayload(f.check) ? f : { path: f.path, scope: f.scope }));
		if (!isPayload(this.settings.vaultCheck)) this.settings.vaultCheck = null;
		this.startupLedger = normalizeLedger(raw?.ledger);
	}

	async saveSettings(): Promise<void> {
		await this.persist();
	}

	private async persist(): Promise<void> {
		const data: PersistedData = {
			settings: this.settings,
			ledger: Array.from(this.unlocked, ([path, info]) => ({ path, scope: info.scope })),
		};
		await this.saveData(data);
	}

	// ---- command plumbing ----------------------------------------------

	private commandOnFile(checking: boolean, run: (file: TFile) => Promise<void>): boolean {
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== "md") return false;
		if (!checking) void run(file);
		return true;
	}

	private addFileMenuItems(menu: Menu, file: TFile): void {
		menu.addItem((item) =>
			item
				.setTitle("Enclave: lock note")
				.setIcon("lock")
				.onClick(() => this.lockNote(file, "vault"))
		);
		menu.addItem((item) =>
			item
				.setTitle("Enclave: lock with separate password")
				.setIcon("lock")
				.onClick(() => this.lockNote(file, "note"))
		);
		menu.addItem((item) =>
			item
				.setTitle("Enclave: unlock note")
				.setIcon("unlock")
				.onClick(() => this.unlockNote(file))
		);
		menu.addItem((item) =>
			item
				.setTitle("Enclave: permanently decrypt note")
				.setIcon("unlock")
				.onClick(() => this.permanentlyDecryptNote(file))
		);
	}

	private addFolderMenuItems(menu: Menu, folder: TFolder): void {
		const hasNotes = this.notesInFolder(folder).length > 0;
		const isProtected = this.settings.protectedFolders.some((f) => f.path === folder.path);
		// An empty folder can still be locked, so notes added later are locked too.
		if (!hasNotes && folder.isRoot()) return;
		menu.addItem((item) =>
			item
				.setTitle("Enclave: lock folder")
				.setIcon("lock")
				.onClick(() => this.lockFolder(folder))
		);
		menu.addItem((item) =>
			item
				.setTitle("Enclave: lock folder with separate password")
				.setIcon("lock")
				.onClick(() => this.lockFolder(folder, "note"))
		);
		if (hasNotes) {
			menu.addItem((item) =>
				item
					.setTitle("Enclave: unlock all notes in folder")
					.setIcon("unlock")
					.onClick(() => this.unlockFolder(folder))
			);
		}
		if (hasNotes || isProtected) {
			menu.addItem((item) =>
				item
					.setTitle("Enclave: permanently decrypt folder")
					.setIcon("unlock")
					.onClick(() => this.permanentlyDecryptFolder(folder))
			);
		}
	}

	private addFilesMenuItems(menu: Menu, files: TFile[]): void {
		const desc = `${files.length} selected note(s)`;
		menu.addItem((item) =>
			item
				.setTitle("Enclave: lock selected notes (vault password)")
				.setIcon("lock")
				.onClick(() => this.lockFiles(files, desc))
		);
		menu.addItem((item) =>
			item
				.setTitle("Enclave: lock selected notes with separate password")
				.setIcon("lock")
				.onClick(() => this.lockFiles(files, desc, "note"))
		);
		menu.addItem((item) =>
			item
				.setTitle("Enclave: unlock selected notes")
				.setIcon("unlock")
				.onClick(() => this.unlockFiles(files, desc))
		);
		menu.addItem((item) =>
			item
				.setTitle("Enclave: permanently decrypt selected notes")
				.setIcon("unlock")
				.onClick(() => this.permanentlyDecryptFiles(files, desc))
		);
	}

	/** The card a locked note shows in reading view and live preview. */
	private renderLockedCard(el: HTMLElement, source: string, path: string | null): void {
		let scope: EnclaveScope = "vault";
		try {
			if ((JSON.parse(source) as Partial<EnclavePayload>).scope === "note") scope = "note";
		} catch {
			/* malformed payload; unlocking will report it */
		}

		const card = el.createDiv({ cls: "enclave-card" });
		setIcon(card.createDiv({ cls: "enclave-card-icon" }), "lock");
		card.createDiv({ cls: "enclave-card-title", text: "This note is locked" });
		card.createDiv({
			cls: "enclave-card-desc",
			text: scope === "note" ? "Encrypted with a separate password" : "Encrypted with the vault password",
		});
		const button = card.createEl("button", { cls: "mod-cta", text: "Unlock" });
		button.addEventListener("click", () => {
			const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
			if (file instanceof TFile) void this.unlockNote(file);
		});
	}

	private async toggleActiveNote(): Promise<void> {
		// While anything is unlocked the ribbon is a "lock everything" button: each
		// note goes back under its own password, so no vault password is needed.
		if (this.unlocked.size > 0) {
			await this.lockAll();
			return;
		}
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice("Enclave: open a note first.");
			return;
		}
		if (file.extension !== "md") {
			new Notice(`Enclave only locks markdown (.md) notes; "${file.name}" is a .${file.extension} file.`);
			return;
		}
		const content = await this.readLiveContent(file);
		if (isLocked(content)) {
			await this.unlockNote(file);
		} else {
			await this.lockNote(file, "vault");
		}
	}

	// ---- reading / writing safely --------------------------------------

	/** Every MarkdownView currently editing `file` (a note can be open in many panes/windows). */
	private findEditorViews(file: TFile): MarkdownView[] {
		const views: MarkdownView[] = [];
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file && view.file.path === file.path) {
				views.push(view);
			}
		}
		return views;
	}

	/**
	 * Read the note's TRUE current content: the live editor buffer when it's open
	 * (which may contain unsaved keystrokes not yet flushed to disk), otherwise
	 * the file on disk. Reading the buffer is what prevents locking from silently
	 * encrypting away the user's most recent, unsaved edits.
	 */
	private async readLiveContent(file: TFile): Promise<string> {
		const views = this.findEditorViews(file);
		if (views.length > 0) return views[0].editor.getValue();
		return this.app.vault.read(file);
	}

	/**
	 * Write `next` to `file`, but only if its content still equals `expected`
	 * (i.e. nothing changed during the slow crypto step). Returns false without
	 * writing if it changed, so the caller can abort instead of clobbering.
	 *
	 *  - Open in editor(s): abort if ANY open buffer diverged, then set EVERY open
	 *    buffer so no stale pane can later re-flush over what we wrote (a note open
	 *    in two panes would otherwise clobber the ciphertext).
	 *  - Not open: use the atomic vault.process() read-modify-write.
	 */
	private async writeContent(file: TFile, expected: string, next: string): Promise<boolean> {
		const views = this.findEditorViews(file);
		if (views.length > 0) {
			if (views.some((v) => v.editor.getValue() !== expected)) return false;
			for (const v of views) v.editor.setValue(next);
			await this.app.vault.modify(file, next);
			return true;
		}
		let aborted = false;
		await this.app.vault.process(file, (current) => {
			if (current !== expected) {
				aborted = true;
				return current; // no-op write
			}
			return next;
		});
		return !aborted;
	}

	/**
	 * Run `fn` while holding an exclusive in-flight lock on `path`. Returns false
	 * (without running `fn`) if that path is already in flight — callers doing
	 * bulk work use this to count genuinely-skipped notes. Also a backstop catch
	 * so the many `void`-dispatched call sites can't surface unhandled rejections.
	 */
	private async withFileLock(path: string, fn: () => Promise<void>): Promise<boolean> {
		if (this.inFlight.has(path)) return false;
		this.inFlight.add(path);
		try {
			await fn();
		} catch (e) {
			console.error("Enclave: operation failed", e);
			new Notice("Enclave: operation failed. See console for details.");
		} finally {
			this.inFlight.delete(path);
		}
		return true;
	}

	// ---- lock / unlock / permanent decrypt -----------------------------

	async lockNote(file: TFile, scope: EnclaveScope): Promise<void> {
		// A note unlocked this session is re-locked with the password it was unlocked
		// with. Only an explicit "separate password" lock of a vault note re-keys it.
		const info = this.unlocked.get(file.path);
		if (info && (scope === "vault" || info.scope === scope)) {
			await this.relock(file.path);
			if (isLocked(await this.readLiveContent(file))) new Notice(`Enclave: locked "${file.basename}".`);
			return;
		}

		const ran = await this.withFileLock(file.path, async () => {
			if (isLocked(await this.readLiveContent(file))) {
				new Notice("Enclave: that note is already locked.");
				return;
			}

			const password =
				scope === "note"
					? await this.promptPassword({
							title: "Lock note with a separate password",
							description: `"${file.basename}" will need this exact password to unlock. There is no recovery.`,
							confirm: true,
							cta: "Lock",
						})
					: await this.ensureVaultPassword(true);
			if (!password) return;

			// Re-read AFTER the prompt so we encrypt the freshest content.
			const content = await this.readLiveContent(file);
			try {
				const payload = await this.seal(content, password, scope, this.settings.iterations);
				const written = await this.writeContent(file, content, buildLockedNote(payload));
				if (!written) {
					new Notice(`Enclave: "${file.basename}" changed while locking — left unlocked.`);
					return;
				}
				this.unlocked.delete(file.path);
				await this.persist();
				this.updateStatusBar();
				new Notice(`Enclave: locked "${file.basename}".`);
			} catch (e) {
				if (e instanceof SelfCheckError) {
					console.error("Enclave: encryption self-check failed", e);
					new Notice("Enclave: encryption self-check failed — note left unlocked to avoid data loss.");
				} else {
					console.error("Enclave: failed to lock note", e);
					new Notice("Enclave: failed to lock note. See console for details.");
				}
			}
		});
		if (!ran) new Notice("Enclave: that note is busy — try again in a moment.");
	}

	async unlockNote(file: TFile): Promise<void> {
		const ran = await this.withFileLock(file.path, async () => {
			const content = await this.readLiveContent(file);
			const payload = parseLockedNote(content);
			if (!payload || !isLocked(content)) {
				new Notice("Enclave: that note isn't locked.");
				return;
			}

			const scope = payload.scope ?? readScope(content);
			const opened = await this.openLockedNote(file, payload, scope, {
				title: "Unlock note",
				description: `Enter the password for "${file.basename}".`,
				cta: "Unlock",
			});
			if (!opened) return;
			const { plaintext, password } = opened;

			try {
				const written = await this.writeContent(file, content, plaintext);
				if (!written) {
					new Notice(`Enclave: "${file.basename}" changed while unlocking — try again.`);
					return;
				}
				this.unlocked.set(file.path, {
					password,
					scope,
					iterations: payload.iterations,
					lastTouched: this.now(),
				});
				if (scope === "vault") await this.vaultPasswordWorked(password);
				await this.persist();
				this.updateStatusBar();
				new Notice(`Enclave: unlocked "${file.basename}".`);
			} catch (e) {
				console.error("Enclave: failed to unlock note", e);
				new Notice("Enclave: failed to unlock note. See console for details.");
			}
		});
		if (!ran) new Notice("Enclave: that note is busy — try again in a moment.");
	}

	/**
	 * Permanently decrypts a note, completely undoing the encryption action.
	 * If the note was locked, prompts for the password, decrypts, and writes plaintext back to disk.
	 * If the note was already unlocked in memory, removes it from the auto-lock registry and persists.
	 * The note is no longer tracked or auto-locked, remaining plain markdown at rest.
	 */
	async permanentlyDecryptNote(file: TFile): Promise<void> {
		const ran = await this.withFileLock(file.path, async () => {
			// Case 1: Note is already unlocked in this session (plaintext on disk, tracked in unlocked map)
			if (this.unlocked.has(file.path)) {
				const confirmed = await this.confirmBulk(
					"permanently decrypt",
					1,
					`"${file.basename}"`,
					`"${file.basename}" is currently unlocked. Permanently decrypting will undo encryption, remove it from auto-lock, and keep it as a normal plain markdown note on disk.`
				);
				if (!confirmed) return;

				this.unlocked.delete(file.path);
				this.exposed = this.exposed.filter((e) => e.file.path !== file.path);
				await this.persist();
				this.updateStatusBar();
				new Notice(`Enclave: permanently decrypted "${file.basename}".`);
				return;
			}

			// Case 2: Note is locked on disk
			const content = await this.readLiveContent(file);
			const payload = parseLockedNote(content);
			if (!payload || !isLocked(content)) {
				new Notice(`Enclave: "${file.basename}" is not locked.`);
				return;
			}

			const scope = payload.scope ?? readScope(content);
			const opened = await this.openLockedNote(file, payload, scope, {
				title: "Permanently decrypt note",
				description: `Enter the password for "${file.basename}" to permanently remove encryption and restore plaintext.`,
				cta: "Permanently Decrypt",
			});
			if (!opened) return;
			const { plaintext, password } = opened;

			try {
				const written = await this.writeContent(file, content, plaintext);
				if (!written) {
					new Notice(`Enclave: "${file.basename}" changed while decrypting — try again.`);
					return;
				}
				this.unlocked.delete(file.path);
				this.exposed = this.exposed.filter((e) => e.file.path !== file.path);
				if (scope === "vault") await this.vaultPasswordWorked(password);
				await this.persist();
				this.updateStatusBar();
				new Notice(`Enclave: permanently decrypted "${file.basename}".`);
			} catch (e) {
				console.error("Enclave: failed to permanently decrypt note", e);
				new Notice("Enclave: failed to permanently decrypt note. See console for details.");
			}
		});
		if (!ran) new Notice("Enclave: that note is busy — try again in a moment.");
	}

	/**
	 * Decrypt a locked note, asking for its password. A separate-password note asks
	 * for its own. A vault note uses the vault password; if the current vault
	 * password doesn't open it, the note was locked before the vault password was
	 * changed, so the earlier one is asked for. Reports a wrong password itself
	 * and returns null then, or when cancelled.
	 */
	private async openLockedNote(
		file: TFile,
		payload: EnclavePayload,
		scope: EnclaveScope,
		ask: PasswordPromptOptions
	): Promise<{ plaintext: string; password: string } | null> {
		if (scope === "note") return this.openSeparateNote(file, payload, ask);
		let password = await this.ensureVaultPassword(false);
		if (!password) return null;
		let plaintext = await this.tryDecrypt(payload, password);
		if (plaintext === null && (await this.isCurrentVaultPassword(password))) {
			password = await this.promptPassword({
				...ask,
				description: `"${file.basename}" was locked with a vault password you've since changed. Enter that earlier password.`,
			});
			if (!password) return null;
			plaintext = await this.tryDecrypt(payload, password);
		}
		if (plaintext === null) {
			new Notice("Enclave: incorrect password.");
			return null;
		}
		return { plaintext, password };
	}

	/**
	 * Decrypt a separate-password note. With "Remember separate passwords" on, a
	 * password remembered for the note or its separate-password folder is tried
	 * first, and one entered here is remembered for the note (and for the folder,
	 * if it's the folder's password).
	 */
	private async openSeparateNote(
		file: TFile,
		payload: EnclavePayload,
		ask: PasswordPromptOptions
	): Promise<{ plaintext: string; password: string } | null> {
		const folder = this.protectedFolderOf(file.path);
		const separateFolder = folder?.scope === "note" ? folder : null;
		for (const key of [noteKey(file.path), separateFolder ? folderKey(separateFolder.path) : null]) {
			const remembered = key ? this.rememberedPassword(key) : null;
			if (!remembered) continue;
			const plaintext = await this.tryDecrypt(payload, remembered);
			if (plaintext !== null) return { plaintext, password: remembered };
		}

		const password = await this.promptPassword(ask);
		if (!password) return null;
		const plaintext = await this.tryDecrypt(payload, password);
		if (plaintext === null) {
			new Notice("Enclave: incorrect password.");
			return null;
		}
		this.rememberPassword(noteKey(file.path), password);
		if (
			this.settings.rememberSeparatePasswords &&
			separateFolder?.check &&
			(await passwordMatchesCheck(separateFolder.check, password))
		) {
			this.rememberPassword(folderKey(separateFolder.path), password);
		}
		return { plaintext, password };
	}

	/** Decrypt `payload`, or null if `password` is wrong. */
	private async tryDecrypt(payload: EnclavePayload, password: string): Promise<string | null> {
		try {
			return await decryptContent(payload, password);
		} catch (e) {
			if (e instanceof DecryptError) return null;
			throw e;
		}
	}

	/** Re-encrypt a note that was previously unlocked, using its stored password. */
	private async relock(path: string): Promise<void> {
		await this.withFileLock(path, async () => {
			const info = this.unlocked.get(path);
			if (!info) return;

			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) {
				this.unlocked.delete(path);
				await this.persist();
				this.updateStatusBar();
				return;
			}

			const content = await this.readLiveContent(file);
			if (isLocked(content)) {
				this.unlocked.delete(path);
				await this.persist();
				this.updateStatusBar();
				return; // already locked (e.g. user locked it manually)
			}

			// For vault-scoped notes prefer the CURRENT cached vault password, so an
			// auto-lock always matches the user's live vault password rather than a
			// stale snapshot captured at unlock time. A note opened with an earlier
			// vault password thereby moves to the current one.
			const password =
				info.scope === "vault" ? this.vaultPassword ?? info.password : info.password;

			try {
				const payload = await this.seal(content, password, info.scope, info.iterations);
				const written = await this.writeContent(file, content, buildLockedNote(payload));
				if (!written) {
					new Notice(`Enclave: "${file.basename}" changed while locking — left unlocked, will retry.`);
					return;
				}
				this.unlocked.delete(path);
				await this.persist();
			} catch (e) {
				console.error("Enclave: failed to auto-lock note", e);
				new Notice(`Enclave: could not auto-lock "${file.basename}" — it remains unlocked. See console.`);
			} finally {
				this.updateStatusBar();
			}
		});
	}

	async lockAll(silent = false): Promise<void> {
		// A bulk run manages its own locking; a user-triggered lock-all (status-bar
		// click / command, silent=false) must not interfere with it. The quit/
		// background re-lock paths pass silent=true and are allowed to force through.
		if (this.bulkActive && !silent) {
			new Notice("Enclave: a bulk operation is in progress.");
			return;
		}
		const paths = Array.from(this.unlocked.keys());
		for (const path of paths) {
			await this.relock(path);
		}
		if (!silent) {
			new Notice(
				paths.length ? `Enclave: locked ${paths.length} note(s).` : "Enclave: nothing to lock."
			);
		}
	}

	// ---- bulk operations (folder, selected files, vault) ----------------

	/** All markdown notes at or under `folder` (recursive). */
	private notesInFolder(folder: TFolder): TFile[] {
		// A non-root folder path has no trailing slash; appending "/" ensures
		// "a" matches "a/x.md" but NOT a sibling "ab/x.md".
		const prefix = folder.isRoot() ? "" : folder.path + "/";
		return this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(prefix));
	}

	/** Collect all unique markdown files from a list of files and folders. */
	private collectMarkdownFiles(items: TAbstractFile[]): TFile[] {
		const files: TFile[] = [];
		for (const item of items) {
			if (item instanceof TFile && item.extension === "md") {
				files.push(item);
			} else if (item instanceof TFolder) {
				files.push(...this.notesInFolder(item));
			}
		}
		const seen = new Set<string>();
		return files.filter((f) => {
			if (seen.has(f.path)) return false;
			seen.add(f.path);
			return true;
		});
	}

	/** Confirmation gate for mass operations. Overridable for tests. */
	protected confirmBulk(
		verb: string,
		count: number,
		where: string,
		customMessage?: string,
		extra = ""
	): Promise<boolean> {
		return new ConfirmModal(this.app, {
			title: `Enclave: ${verb} ${count} note${count === 1 ? "" : "s"}?`,
			message:
				customMessage ??
				`This will ${verb} ${count} note${count === 1 ? "" : "s"} in ${where}.${
					verb.includes("decrypt")
						? " Plain markdown will be restored to disk and auto-lock will no longer re-encrypt."
						: ""
				}${extra}`,
			cta: verb.includes("decrypt") ? "Permanently Decrypt" : "Proceed",
		}).ask();
	}

	private describeFolder(folder: TFolder): string {
		return folder.isRoot() ? "the entire vault" : `"${folder.path}"`;
	}

	/**
	 * Lock every currently-unlocked note in a list of files, either with the vault
	 * password or with one separate password shared by all of them. Options:
	 * `confirm: false` skips the bulk confirmation for callers that already asked;
	 * `password` replaces the password prompt (resolving null cancels).
	 * Returns false if the user cancelled.
	 */
	async lockFiles(
		files: TFile[],
		targetDescription: string,
		scope: EnclaveScope = "vault",
		opts: { confirm?: boolean; password?: () => Promise<string | null> } = {}
	): Promise<boolean> {
		const work: { file: TFile; content: string }[] = [];
		for (const file of files) {
			try {
				const content = await this.readLiveContent(file);
				if (!isLocked(content)) work.push({ file, content });
			} catch (e) {
				console.error("Enclave: could not read note for bulk lock", file.path, e);
			}
		}
		if (work.length === 0) {
			new Notice("Enclave: no unlocked notes to lock here.");
			return true;
		}
		if ((opts.confirm ?? true) && !(await this.confirmBulk("encrypt", work.length, targetDescription))) {
			return false;
		}

		const password = opts.password
			? await opts.password()
			: scope === "note"
				? await this.promptPassword({
						title: "Lock with a separate password",
						description: `All ${work.length} note(s) will need this exact password to unlock. There is no recovery.`,
						confirm: true,
						cta: "Lock",
					})
				: await this.ensureVaultPassword(true);
		if (!password) {
			// A custom password step explains its own refusals.
			if (!opts.password) new Notice("Enclave: cancelled — no notes were changed.");
			return false;
		}

		const progress = new Notice(`Enclave: locking ${work.length} note(s)…`, 0);
		let locked = 0;
		let changed = 0;
		let failed = 0;
		let skipped = 0;
		const trouble: string[] = [];
		this.bulkActive = true;
		try {
			for (const { file, content } of work) {
				const ran = await this.withFileLock(file.path, async () => {
					try {
						const payload = await this.seal(content, password, scope, this.settings.iterations);
						if (await this.writeContent(file, content, buildLockedNote(payload))) {
							this.unlocked.delete(file.path);
							locked++;
						} else {
							changed++;
							trouble.push(file.basename);
						}
					} catch (e) {
						console.error("Enclave: failed to lock note in bulk", file.path, e);
						failed++;
						trouble.push(file.basename);
					}
				});
				if (!ran) skipped++;
			}
		} finally {
			this.bulkActive = false;
			try {
				await this.persist();
				this.updateStatusBar();
			} finally {
				progress.hide();
			}
		}
		new Notice(this.bulkSummary("locked", locked, { changed, failed, skipped }, trouble));
		return true;
	}

	/**
	 * Lock a folder: lock every unlocked note in it and, unless it's the vault root,
	 * keep it locked, so notes moved or created there later are locked too.
	 */
	async lockFolder(folder: TFolder, scope: EnclaveScope = "vault"): Promise<void> {
		const notes = this.notesInFolder(folder);
		let unlockedCount = 0;
		for (const file of notes) {
			if (!isLocked(await this.readLiveContent(file))) unlockedCount++;
		}
		if (folder.isRoot()) {
			if (unlockedCount > 0) await this.lockFiles(notes, this.describeFolder(folder), scope);
			else new Notice("Enclave: no unlocked notes to lock here.");
			return;
		}
		if (!(await this.confirmFolderLock(folder.path, scope, unlockedCount))) return;

		// A separate-password folder gets its password here, once, and keeps a check of it.
		let folderPassword: string | null = null;
		const askPassword = async () => (folderPassword = await this.folderPassword(folder.path));
		if (unlockedCount > 0) {
			const opts = scope === "note" ? { confirm: false, password: askPassword } : { confirm: false };
			if (!(await this.lockFiles(notes, this.describeFolder(folder), scope, opts))) return;
		} else if (scope === "note" && !(await askPassword())) {
			return;
		}
		const check = folderPassword
			? await createPasswordCheck(folderPassword, "note", this.settings.iterations)
			: undefined;
		await this.setProtection(folder.path, scope, check);
		if (folderPassword) this.rememberPassword(folderKey(folder.path), folderPassword);
		if (unlockedCount === 0) {
			new Notice(`Enclave: "${folder.path}" is locked. Notes moved or created there will be locked too.`);
		}
	}

	/** Explain what locking a folder does and ask to go ahead. Overridable for tests. */
	protected confirmFolderLock(path: string, scope: EnclaveScope, unlockedCount: number): Promise<boolean> {
		const password = scope === "note" ? "the folder's own password" : "the vault password";
		const now =
			unlockedCount > 0
				? `This encrypts the ${unlockedCount === 1 ? "unlocked note" : `${unlockedCount} unlocked notes`} in "${path}" and its subfolders with ${password}.`
				: `"${path}" has no unlocked notes right now.`;
		return new ConfirmModal(this.app, {
			title: `Enclave: lock folder "${path}"?`,
			message: `${now} The folder then stays locked: notes moved into it or created in it are locked with ${password} too. Notes that are already locked keep their own password.`,
			cta: "Lock folder",
		}).ask();
	}

	/**
	 * Locked notes among `files`, split by the password they need. Notes already
	 * unlocked this session (plaintext on disk) are returned separately.
	 */
	private async collectLocked(files: TFile[]): Promise<LockedSet> {
		const set: LockedSet = { vault: [], note: [], alreadyUnlocked: [] };
		for (const file of files) {
			if (this.unlocked.has(file.path)) {
				set.alreadyUnlocked.push(file);
				continue;
			}
			try {
				const content = await this.readLiveContent(file);
				const payload = parseLockedNote(content);
				if (!payload || !isLocked(content)) continue;
				const scope = payload.scope ?? readScope(content);
				(scope === "note" ? set.note : set.vault).push({ file, content, payload });
			} catch (e) {
				console.error("Enclave: could not read note for bulk operation", file.path, e);
			}
		}
		return set;
	}

	/**
	 * Ask for the passwords a bulk decrypt needs and pair each locked note with its
	 * password: the vault password for vault notes, and ONE separate password that
	 * is tried on every separate-password note (notes locked together as a group
	 * share it). Cancelling the vault prompt cancels everything; cancelling the
	 * separate prompt only skips those notes. Returns null if nothing is left to do.
	 */
	private async prepareBulkDecrypt(set: LockedSet, action: string, cta: string): Promise<BulkDecrypt | null> {
		let vaultPassword: string | null = null;
		if (set.vault.length > 0) {
			vaultPassword = await this.ensureVaultPassword(false);
			if (!vaultPassword) return null;
		}
		let notePassword: string | null = null;
		if (set.note.length > 0) {
			notePassword = await this.promptPassword({
				title: "Enter separate password",
				description: `${set.note.length} note(s) here are locked with a separate password. Enter it to ${action} every note it opens; notes with a different password stay locked. Cancel to skip them.`,
				cta,
			});
		}
		if (!vaultPassword && !notePassword) return null;

		const work: BulkDecrypt["work"] = [];
		if (vaultPassword) {
			for (const n of set.vault) work.push({ ...n, scope: "vault", password: vaultPassword });
		}
		if (notePassword) {
			for (const n of set.note) work.push({ ...n, scope: "note", password: notePassword });
		}
		return {
			work,
			vaultPassword,
			skippedSeparate: notePassword ? 0 : set.note.length,
		};
	}

	/** After a bulk decrypt: a vault password that opened notes may be kept for the session. */
	private async settleVaultPassword(bulk: BulkDecrypt, vaultDone: number): Promise<void> {
		if (bulk.vaultPassword && vaultDone > 0) await this.vaultPasswordWorked(bulk.vaultPassword);
	}

	/** Suffix for a bulk summary when the separate-password prompt was cancelled. */
	private skippedSeparateNote(count: number): string {
		return count ? ` Skipped ${count} separate-password note(s).` : "";
	}

	/**
	 * Unlock every locked note in a list of files. Vault-password notes use the
	 * vault password; separate-password notes are tried with one separate password,
	 * and any that need a different one are reported and left locked.
	 */
	async unlockFiles(files: TFile[], targetDescription: string): Promise<void> {
		const set = await this.collectLocked(files);
		const total = set.vault.length + set.note.length;
		if (total === 0) {
			new Notice("Enclave: no locked notes to unlock here.");
			return;
		}
		if (!(await this.confirmBulk("decrypt (write plaintext for)", total, targetDescription))) return;

		const bulk = await this.prepareBulkDecrypt(set, "unlock", "Unlock");
		if (!bulk) {
			new Notice("Enclave: cancelled — no notes were changed.");
			return;
		}

		const progress = new Notice(`Enclave: unlocking ${bulk.work.length} note(s)…`, 0);
		let unlockedCount = 0;
		let vaultDone = 0;
		let wrongPassword = 0;
		let otherPassword = 0;
		let changed = 0;
		let failed = 0;
		let skipped = 0;
		const trouble: string[] = [];
		this.bulkActive = true;
		try {
			for (const { file, content, payload, scope, password } of bulk.work) {
				const ran = await this.withFileLock(file.path, async () => {
					try {
						const plaintext = await decryptContent(payload, password);
						if (await this.writeContent(file, content, plaintext)) {
							this.unlocked.set(file.path, {
								password,
								scope,
								iterations: payload.iterations,
								lastTouched: this.now(),
							});
							// Persist per note so a crash mid-bulk still leaves a recoverable
							// ledger of the plaintext we've already written (matches unlockNote).
							await this.persist();
							if (scope === "note") this.rememberPassword(noteKey(file.path), password);
							unlockedCount++;
							if (scope === "vault") vaultDone++;
						} else {
							changed++;
							trouble.push(file.basename);
						}
					} catch (e) {
						if (e instanceof DecryptError) {
							if (scope === "vault") wrongPassword++;
							else otherPassword++;
						} else {
							console.error("Enclave: failed to unlock note in bulk", file.path, e);
							failed++;
						}
						trouble.push(file.basename);
					}
				});
				if (!ran) skipped++;
			}
			await this.settleVaultPassword(bulk, vaultDone);
		} finally {
			this.bulkActive = false;
			try {
				await this.persist();
				this.updateStatusBar();
			} finally {
				progress.hide();
			}
		}
		new Notice(
			this.bulkSummary("unlocked", unlockedCount, { wrongPassword, otherPassword, changed, failed, skipped }, trouble) +
				this.skippedSeparateNote(bulk.skippedSeparate)
		);
	}

	/** Unlock every locked note in a folder. */
	unlockFolder(folder: TFolder): Promise<void> {
		return this.unlockFiles(this.notesInFolder(folder), this.describeFolder(folder));
	}

	/**
	 * Permanently decrypts a group of notes, completely undoing initial encryption.
	 * Decrypts locked notes (asking for the vault and/or a separate password as
	 * needed), untracks any currently-unlocked notes, writes plain markdown, and
	 * prevents subsequent auto-locking.
	 */
	async permanentlyDecryptFiles(files: TFile[], targetDescription: string, extra = ""): Promise<boolean> {
		const set = await this.collectLocked(files);
		const lockedCount = set.vault.length + set.note.length;
		const totalEligible = lockedCount + set.alreadyUnlocked.length;
		if (totalEligible === 0) {
			new Notice("Enclave: no encrypted notes found to decrypt here.");
			return true;
		}

		if (!(await this.confirmBulk("permanently decrypt", totalEligible, targetDescription, undefined, extra))) {
			return false;
		}

		let bulk: BulkDecrypt = { work: [], vaultPassword: null, skippedSeparate: 0 };
		if (lockedCount > 0) {
			const prepared = await this.prepareBulkDecrypt(set, "permanently decrypt", "Permanently Decrypt");
			if (!prepared) {
				new Notice("Enclave: cancelled — no notes were changed.");
				return false;
			}
			bulk = prepared;
		}

		const progress = new Notice(
			`Enclave: permanently decrypting ${bulk.work.length + set.alreadyUnlocked.length} note(s)…`,
			0
		);
		let decryptedCount = 0;
		let vaultDone = 0;
		let wrongPassword = 0;
		let otherPassword = 0;
		let changed = 0;
		let failed = 0;
		let skipped = 0;
		const trouble: string[] = [];
		this.bulkActive = true;

		try {
			// 1. Untrack and finalize notes that were already unlocked (plaintext on disk)
			for (const file of set.alreadyUnlocked) {
				const ran = await this.withFileLock(file.path, async () => {
					this.unlocked.delete(file.path);
					this.exposed = this.exposed.filter((e) => e.file.path !== file.path);
					decryptedCount++;
				});
				if (!ran) skipped++;
			}

			// 2. Decrypt and write plaintext for notes that were locked on disk
			for (const { file, content, payload, scope, password } of bulk.work) {
				const ran = await this.withFileLock(file.path, async () => {
					try {
						const plaintext = await decryptContent(payload, password);
						if (await this.writeContent(file, content, plaintext)) {
							this.unlocked.delete(file.path);
							this.exposed = this.exposed.filter((e) => e.file.path !== file.path);
							decryptedCount++;
							if (scope === "vault") vaultDone++;
						} else {
							changed++;
							trouble.push(file.basename);
						}
					} catch (e) {
						if (e instanceof DecryptError) {
							if (scope === "vault") wrongPassword++;
							else otherPassword++;
						} else {
							console.error("Enclave: failed to permanently decrypt note in bulk", file.path, e);
							failed++;
						}
						trouble.push(file.basename);
					}
				});
				if (!ran) skipped++;
			}

			await this.settleVaultPassword(bulk, vaultDone);
		} finally {
			this.bulkActive = false;
			try {
				await this.persist();
				this.updateStatusBar();
			} finally {
				progress.hide();
			}
		}

		new Notice(
			this.bulkSummary(
				"permanently decrypted",
				decryptedCount,
				{ wrongPassword, otherPassword, changed, failed, skipped },
				trouble
			) + this.skippedSeparateNote(bulk.skippedSeparate)
		);
		return true;
	}

	/** Permanently decrypts all notes in a folder (or vault), and stops keeping it locked. */
	async permanentlyDecryptFolder(folder: TFolder): Promise<void> {
		const path = folder.isRoot() ? "" : folder.path;
		const locked = this.settings.protectedFolders.some((f) => !path || f.path === path || f.path.startsWith(path + "/"));
		const extra = locked
			? ` The folder also stops being locked, so notes moved or created there later stay unencrypted.`
			: "";
		if (!(await this.permanentlyDecryptFiles(this.notesInFolder(folder), this.describeFolder(folder), extra))) return;
		if (await this.forgetProtectedUnder(path)) {
			new Notice(`Enclave: ${folder.isRoot() ? "no folders are" : `"${path}" is`} locked anymore.`);
		}
	}

	/** Build a human summary line for a bulk run, naming the notes that didn't complete. */
	private bulkSummary(
		verb: string,
		ok: number,
		issues: {
			wrongPassword?: number;
			otherPassword?: number;
			changed?: number;
			failed?: number;
			skipped?: number;
		},
		trouble: string[]
	): string {
		const parts: string[] = [];
		if (issues.wrongPassword) parts.push(`${issues.wrongPassword} wrong password`);
		if (issues.otherPassword) parts.push(`${issues.otherPassword} need a different password`);
		if (issues.changed) parts.push(`${issues.changed} changed (retry)`);
		if (issues.failed) parts.push(`${issues.failed} failed`);
		if (issues.skipped) parts.push(`${issues.skipped} busy`);
		const names = trouble.length ? ` Left unchanged: ${trouble.slice(0, 5).join(", ")}${trouble.length > 5 ? "…" : ""}.` : "";
		return `Enclave: ${verb} ${ok} note(s)${parts.length ? ` — ${parts.join(", ")}` : ""}.${names}`;
	}

	/**
	 * Encrypt content into a payload. When the verify setting is on, the result
	 * is round-trip checked so callers can safely overwrite the plaintext.
	 */
	private seal(
		plaintext: string,
		password: string,
		scope: EnclaveScope,
		iterations: number
	): Promise<EnclavePayload> {
		if (this.settings.verifyOnLock) {
			return encryptContentVerified(plaintext, password, scope, iterations);
		}
		return encryptContent(plaintext, password, scope, iterations);
	}

	private updateStatusBar(): void {
		const count = this.unlocked.size;

		// Mirror the unlocked state onto the ribbon icon too, so there's a visible
		// indicator on mobile (where the status bar isn't shown).
		if (this.ribbonEl) {
			this.ribbonEl.toggleClass("enclave-ribbon-warn", count > 0);
			this.ribbonEl.setAttribute(
				"aria-label",
				count > 0
					? `Enclave: ${count} note(s) unlocked — click to lock all`
					: "Enclave: toggle lock on current note"
			);
		}

		if (!this.statusBarEl) return;
		// Only shown while plaintext is on disk; otherwise there is nothing to report.
		this.statusBarEl.toggle(count > 0);
		if (count === 0) return;
		this.statusBarEl.empty();
		setIcon(this.statusBarEl.createSpan({ cls: "enclave-status-icon" }), "unlock");
		this.statusBarEl.createSpan({ cls: "enclave-status-text", text: `${count} unlocked` });
		this.statusBarEl.setAttribute(
			"aria-label",
			`Enclave: ${count} note(s) unlocked (plaintext on disk) — click to lock all`
		);
	}

	// ---- crash recovery -------------------------------------------------

	/** After load, find notes the ledger says were unlocked but are still plaintext. */
	private async recoverExposedNotes(): Promise<void> {
		const exposed: { file: TFile; scope: EnclaveScope }[] = [];
		for (const entry of this.startupLedger) {
			const file = this.app.vault.getAbstractFileByPath(entry.path);
			if (file instanceof TFile && file.extension === "md") {
				try {
					if (!isLocked(await this.app.vault.read(file))) exposed.push({ file, scope: entry.scope });
				} catch {
					/* unreadable; skip */
				}
			}
		}
		this.exposed = exposed;
		// Clear the stale on-disk ledger now that we've captured it (unlocked is empty
		// at startup, so this writes an empty ledger).
		await this.persist();
		if (exposed.length > 0) {
			new Notice(
				`Enclave: ${exposed.length} note(s) may have been left unlocked after an unclean shutdown. ` +
					`Run "Enclave: secure notes left exposed" to re-encrypt them.`,
				12000
			);
		}
	}

	/** Re-encrypt one exposed note at its ORIGINAL scope. Returns true if it ends up locked. */
	private async lockExposed(
		entry: { file: TFile; scope: EnclaveScope },
		password: string
	): Promise<boolean> {
		let ok = false;
		await this.withFileLock(entry.file.path, async () => {
			const content = await this.readLiveContent(entry.file);
			if (isLocked(content)) {
				ok = true; // someone already re-locked it
				return;
			}
			try {
				const payload = await this.seal(content, password, entry.scope, this.settings.iterations);
				ok = await this.writeContent(entry.file, content, buildLockedNote(payload));
			} catch (e) {
				console.error("Enclave: failed to secure exposed note", entry.file.path, e);
			}
		});
		return ok;
	}

	private async secureExposed(): Promise<void> {
		// Vault-scoped notes re-lock with the vault password. Separate-password notes
		// CANNOT be faithfully recovered (their password was only in memory), so we
		// prompt for a new password per note rather than silently re-keying them to
		// the vault password.
		const vaultNotes = this.exposed.filter((e) => e.scope === "vault");
		const noteNotes = this.exposed.filter((e) => e.scope === "note");
		const stillExposed: { file: TFile; scope: EnclaveScope }[] = [];
		let secured = 0;

		if (vaultNotes.length > 0) {
			const password = await this.ensureVaultPassword(true);
			if (!password) {
				new Notice("Enclave: cancelled — no notes were changed.");
				return;
			}
			for (const entry of vaultNotes) {
				if (await this.lockExposed(entry, password)) secured++;
				else stillExposed.push(entry);
			}
		}

		for (const entry of noteNotes) {
			const password = await this.promptPassword({
				title: `Re-secure "${entry.file.basename}"`,
				description: `This note used its own password, which can't be recovered after a crash. Set a NEW password to re-encrypt it (or cancel to leave it for now).`,
				confirm: true,
				cta: "Lock",
			});
			if (!password) {
				stillExposed.push(entry);
				continue;
			}
			if (await this.lockExposed(entry, password)) secured++;
			else stillExposed.push(entry);
		}

		this.exposed = stillExposed;
		new Notice(
			`Enclave: secured ${secured} note(s).` +
				(stillExposed.length ? ` ${stillExposed.length} still exposed.` : "")
		);
	}

	// ---- vault password session ----------------------------------------

	/** Indirection point so tests can supply passwords without UI. */
	protected promptPassword(opts: PasswordPromptOptions): Promise<string | null> {
		return new PasswordModal(this.app, opts).ask();
	}

	/**
	 * The vault password for this session, asking for it if needed. It's chosen
	 * once (entered twice); after that it's checked against the stored vault
	 * check, so a typo is rejected instead of locking notes under a new password.
	 */
	private async ensureVaultPassword(confirm: boolean): Promise<string | null> {
		if (this.vaultPassword) {
			this.vaultPasswordSetAt = this.now();
			return this.vaultPassword;
		}
		const check = this.settings.vaultCheck;
		const choosing = confirm && !check;
		const password = await this.promptPassword({
			title: choosing ? "Set vault password" : "Enter vault password",
			description: choosing
				? "This password unlocks every note locked with the vault default. It is kept in memory only for this session and never written to disk."
				: `Enter your vault password to ${confirm ? "lock" : "unlock"} this note.`,
			confirm: choosing,
			cta: confirm ? "Lock" : "Unlock",
		});
		if (!password) return null;
		if (!confirm) {
			// Unlocking: the note itself shows whether the password is right, and an
			// earlier vault password must still open notes locked with it. It's kept
			// for the session only once it has opened a note (vaultPasswordWorked).
			return password;
		}
		if (check && !(await passwordMatchesCheck(check, password))) {
			new Notice("Enclave: that isn't your vault password.");
			return null;
		}
		if (choosing) await this.saveVaultCheck(password);
		this.cacheVaultPassword(password);
		return password;
	}

	/**
	 * A vault password just opened a note. Keep it for the session if it's the
	 * current vault password, creating the vault check if none exists yet (notes
	 * locked before checks existed). An earlier vault password is not kept, so new
	 * locks always use the current one.
	 */
	private async vaultPasswordWorked(password: string): Promise<void> {
		if (!this.settings.vaultCheck) {
			this.cacheVaultPassword(password);
			await this.saveVaultCheck(password);
		} else if (await this.isCurrentVaultPassword(password)) {
			this.cacheVaultPassword(password);
		}
	}

	/** Whether `password` is the vault password as it is now. */
	private async isCurrentVaultPassword(password: string): Promise<boolean> {
		if (password === this.vaultPassword) return true;
		const check = this.settings.vaultCheck;
		return !!check && (await passwordMatchesCheck(check, password));
	}

	/** A remembered separate password, restarting its expiry clock; null if none. */
	private rememberedPassword(key: string): string | null {
		const entry = this.separatePasswords.get(key);
		if (!entry) return null;
		entry.usedAt = this.now();
		return entry.password;
	}

	/** Keep a separate password in memory, if "Remember separate passwords" is on. */
	private rememberPassword(key: string, password: string): void {
		if (this.settings.rememberSeparatePasswords) {
			this.separatePasswords.set(key, { password, usedAt: this.now() });
		}
	}

	/** Re-key remembered passwords after a note or folder is renamed or moved. */
	private moveRememberedPasswords(oldPath: string, newPath: string): void {
		for (const [key, entry] of Array.from(this.separatePasswords)) {
			const path = key.slice(key.indexOf(":") + 1);
			const kind = key.slice(0, key.indexOf(":"));
			if (path === oldPath || path.startsWith(oldPath + "/")) {
				this.separatePasswords.delete(key);
				this.separatePasswords.set(`${kind}:${newPath}${path.slice(oldPath.length)}`, entry);
			}
		}
	}

	forgetSeparatePasswords(): void {
		this.separatePasswords.clear();
	}

	/** Forget the vault password and every remembered separate password. */
	forgetAllPasswords(): void {
		this.forgetVaultPassword(true);
		this.forgetSeparatePasswords();
		new Notice("Enclave: forgot all remembered passwords.");
	}

	/** Tell the user why their edit was refused, at most every few seconds. */
	private notifyLockedEdit(): void {
		const now = this.now();
		if (now - this.lastLockedEditNotice < 4000) return;
		this.lastLockedEditNotice = now;
		new Notice("Enclave: this note is locked. Unlock it to edit.");
	}

	private async saveVaultCheck(password: string): Promise<void> {
		const vaultCheck = await createPasswordCheck(password, "vault", this.settings.iterations);
		this.settings = { ...this.settings, vaultCheck };
		await this.persist();
	}

	/** Forget the vault check, so the next vault password entered becomes the new one. */
	async resetVaultCheck(): Promise<void> {
		this.settings = { ...this.settings, vaultCheck: null };
		this.forgetVaultPassword(true);
		await this.persist();
	}

	private cacheVaultPassword(password: string): void {
		this.vaultPassword = password;
		this.vaultPasswordSetAt = this.now();
	}

	forgetVaultPassword(silent = false): void {
		this.vaultPassword = null;
		this.vaultPasswordSetAt = 0;
		if (!silent) new Notice("Enclave: forgot the cached vault password.");
	}

	// ---- protected folders ----------------------------------------------

	/** The innermost protected folder `path` lies in, checked against `folders` (default: current settings). */
	private protectedFolderOf(
		path: string,
		folders: ProtectedFolder[] = this.settings.protectedFolders
	): ProtectedFolder | null {
		let match: ProtectedFolder | null = null;
		for (const folder of folders) {
			if (path.startsWith(folder.path + "/") && (!match || folder.path.length > match.path.length)) {
				match = folder;
			}
		}
		return match;
	}

	/** Keep `path` locked with the given kind of password (and, for a separate one, its check). */
	private async setProtection(path: string, scope: EnclaveScope, check?: EnclavePayload): Promise<void> {
		const others = this.settings.protectedFolders.filter((f) => f.path !== path);
		const folder: ProtectedFolder = check ? { path, scope, check } : { path, scope };
		this.settings = { ...this.settings, protectedFolders: [...others, folder] };
		await this.persist();
	}

	/** Stop keeping a folder locked. Its notes stay as they are. */
	async unprotectFolder(path: string): Promise<void> {
		if (!this.settings.protectedFolders.some((f) => f.path === path)) return;
		this.settings = {
			...this.settings,
			protectedFolders: this.settings.protectedFolders.filter((f) => f.path !== path),
		};
		await this.persist();
		new Notice(`Enclave: "${path}" is no longer kept locked.`);
	}

	/** Stop keeping a folder and its subfolders locked ("" means every folder). Returns whether any were. */
	private async forgetProtectedUnder(path: string): Promise<boolean> {
		const kept = path
			? this.settings.protectedFolders.filter((f) => f.path !== path && !f.path.startsWith(path + "/"))
			: [];
		if (kept.length === this.settings.protectedFolders.length) return false;
		for (const folder of this.settings.protectedFolders) {
			if (!kept.includes(folder)) this.separatePasswords.delete(folderKey(folder.path));
		}
		this.settings = { ...this.settings, protectedFolders: kept };
		await this.persist();
		return true;
	}

	/** Payloads of the notes in `folderPath` (recursively) that are locked with a separate password. */
	private async separatePayloadsIn(folderPath: string): Promise<EnclavePayload[]> {
		const payloads: EnclavePayload[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!file.path.startsWith(folderPath + "/")) continue;
			const content = await this.readLiveContent(file);
			const payload = isLocked(content) ? parseLockedNote(content) : null;
			if (payload && (payload.scope ?? readScope(content)) === "note") payloads.push(payload);
		}
		return payloads;
	}

	/**
	 * Ask for a separate-password folder's password. A locked folder keeps a check
	 * of its password, so only that password is accepted, whatever other notes sit
	 * inside. A folder being locked for the first time accepts the password of a
	 * separate-password note already in it, or, with none, a new password entered
	 * twice. `context` explains why it's asked. Returns null if cancelled or wrong.
	 */
	private async askFolderPassword(folderPath: string, context?: string): Promise<string | null> {
		const check = this.settings.protectedFolders.find((f) => f.path === folderPath)?.check;
		const samples = check ? [] : (await this.separatePayloadsIn(folderPath)).slice(0, 5);
		const choosing = !check && samples.length === 0;
		const ask = choosing
			? `Choose a password for "${folderPath}". Its notes, and notes added to it later, will need it to unlock. There is no recovery.`
			: `Enter the password the notes in "${folderPath}" are locked with.`;
		const password = await this.promptPassword({
			title: `Password for "${folderPath}"`,
			description: context ? `${context} ${ask}` : ask,
			confirm: choosing,
			cta: "Lock",
		});
		if (!password) return null;
		if (choosing) return password;
		if (check ? await passwordMatchesCheck(check, password) : await this.opensAny(samples, password)) {
			return password;
		}
		new Notice(`Enclave: that isn't the password for "${folderPath}". Nothing was locked.`);
		return null;
	}

	/** A separate-password folder's password: remembered, or asked for (see askFolderPassword). */
	private async folderPassword(folderPath: string): Promise<string | null> {
		return this.rememberedPassword(folderKey(folderPath)) ?? (await this.askFolderPassword(folderPath));
	}

	/** Whether `password` decrypts at least one of `payloads`. */
	private async opensAny(payloads: EnclavePayload[], password: string): Promise<boolean> {
		for (const payload of payloads) {
			try {
				await decryptContent(payload, password);
				return true;
			} catch (e) {
				if (!(e instanceof DecryptError)) throw e;
			}
		}
		return false;
	}

	/**
	 * Lock notes that arrived in a protected folder with that folder's kind of
	 * password. Moved notes are only locked after the user agrees; for a
	 * separate-password folder, entering the password is that agreement.
	 */
	private async lockIntoFolder(folder: ProtectedFolder, files: TFile[], how: "moved" | "created"): Promise<void> {
		const one = files.length === 1;
		const subject = `${one ? `"${files[0].basename}" was` : `${files.length} notes were`} ${
			how === "moved" ? "moved into" : "created in"
		} "${folder.path}"`;
		const target = one ? `"${files[0].basename}"` : `${files.length} note(s)`;

		// Without a password to type, moved notes need an explicit yes before they're locked.
		const remembered = folder.scope === "note" ? this.rememberedPassword(folderKey(folder.path)) : null;
		if (folder.scope === "vault" || remembered) {
			const kind = folder.scope === "vault" ? "the vault password" : "a separate password";
			const agreed =
				how === "created" ||
				(await this.confirmMoveIn(`${subject}, which is locked with ${kind}. Lock ${one ? "it" : "them"} too?`));
			if (!agreed) return;
			const password = remembered ? async () => remembered : undefined;
			await this.lockFiles(files, target, folder.scope, { confirm: false, password });
			return;
		}

		const password = await this.askFolderPassword(
			folder.path,
			`${subject}. Lock ${one ? "it" : "them"} too, or cancel to leave ${one ? "it" : "them"} unlocked.`
		);
		if (!password) return;
		this.rememberPassword(folderKey(folder.path), password);
		await this.lockFiles(files, target, "note", { confirm: false, password: async () => password });
	}

	/** Lock a note created in a protected folder, unless it's already encrypted (e.g. synced in). */
	private async lockNewNote(file: TFile): Promise<void> {
		const folder = this.protectedFolderOf(file.path);
		if (!folder || isLocked(await this.readLiveContent(file))) return;
		await this.lockIntoFolder(folder, [file], "created");
	}

	private onCreate(file: TAbstractFile): void {
		if (file instanceof TFile && file.extension === "md" && this.protectedFolderOf(file.path)) {
			this.newInProtected.add(file.path);
		}
	}

	private onRename(file: TAbstractFile, oldPath: string): void {
		// Keep path-keyed state in sync with the vault.
		const info = this.unlocked.get(oldPath);
		if (info) {
			this.unlocked.delete(oldPath);
			this.unlocked.set(file.path, info);
			void this.persist();
		}
		if (this.lastActiveFile === oldPath) this.lastActiveFile = file.path;
		if (this.newInProtected.delete(oldPath)) this.newInProtected.add(file.path);
		if (this.movedIn.delete(oldPath)) this.movedIn.add(file.path);
		this.moveRememberedPasswords(oldPath, file.path);

		if (file instanceof TFolder) {
			this.followFolderRename(oldPath, file.path);
			return;
		}
		if (!(file instanceof TFile) || file.extension !== "md") return;

		const wasProtected =
			this.protectedFolderOf(oldPath) !== null ||
			this.protectedFolderOf(oldPath, this.protectedBeforeRename) !== null;
		if (this.protectedFolderOf(file.path) && !wasProtected && !this.unlocked.has(file.path)) {
			this.movedIn.add(file.path);
			this.scheduleMovedInPrompt();
		}
	}

	/** A renamed or moved folder takes its own and its subfolders' protection along. */
	private followFolderRename(oldPath: string, newPath: string): void {
		const before = this.settings.protectedFolders;
		const after = before.map((f) =>
			f.path === oldPath
				? { ...f, path: newPath }
				: f.path.startsWith(oldPath + "/")
					? { ...f, path: newPath + f.path.slice(oldPath.length) }
					: f
		);
		if (after.every((f, i) => f === before[i])) return;
		this.protectedBeforeRename = before;
		this.settings = { ...this.settings, protectedFolders: after };
		void this.persist();
		this.scheduleMovedInPrompt();
	}

	private scheduleMovedInPrompt(): void {
		if (this.movedInTimer !== null) window.clearTimeout(this.movedInTimer);
		this.movedInTimer = window.setTimeout(() => void this.promptMovedIn(), MOVE_BATCH_MS);
	}

	/** Ask, once per protected folder, whether to lock the unencrypted notes moved into it. */
	private async promptMovedIn(): Promise<void> {
		this.movedInTimer = null;
		this.protectedBeforeRename = [];
		const paths = Array.from(this.movedIn);
		this.movedIn.clear();

		const groups = new Map<string, { folder: ProtectedFolder; files: TFile[] }>();
		for (const path of paths) {
			const file = this.app.vault.getAbstractFileByPath(path);
			const folder = this.protectedFolderOf(path);
			if (!(file instanceof TFile) || !folder || this.unlocked.has(path)) continue;
			if (isLocked(await this.readLiveContent(file))) continue;
			const group = groups.get(folder.path) ?? { folder, files: [] };
			group.files.push(file);
			groups.set(folder.path, group);
		}
		for (const { folder, files } of groups.values()) await this.lockIntoFolder(folder, files, "moved");
	}

	/** Confirmation for locking notes moved into a vault-password folder. Overridable for tests. */
	protected confirmMoveIn(message: string): Promise<boolean> {
		return new ConfirmModal(this.app, { title: "Enclave: lock moved notes?", message, cta: "Lock" }).ask();
	}

	// ---- events & timers ------------------------------------------------

	private handleActiveChange(): void {
		const current = this.app.workspace.getActiveFile()?.path ?? null;
		const previous = this.lastActiveFile;
		this.lastActiveFile = current;
		if (!this.settings.autoLockOnClose || this.bulkActive) return;
		if (!previous || previous === current) return;
		// Don't lock a note that's still open in another pane/window — the
		// inactivity sweep will catch it once it's genuinely idle.
		const prevFile = this.app.vault.getAbstractFileByPath(previous);
		if (prevFile instanceof TFile && this.findEditorViews(prevFile).length > 0) return;
		if (this.unlocked.has(previous)) {
			void this.relock(previous);
		} else if (this.newInProtected.delete(previous) && prevFile instanceof TFile) {
			// A note created in a protected folder is locked the first time it's left.
			void this.lockNewNote(prevFile);
		}
	}

	/**
	 * Obsidian was hidden: backgrounded on mobile, or minimized / moved to another
	 * space on desktop. Mobile always locks here, since nothing later is reliable;
	 * desktop only if the setting is on, as quitting and the timer still lock.
	 */
	private handleHidden(): void {
		if (Platform.isMobile || this.settings.lockWhenHidden) void this.lockAll(true);
	}

	private async sweep(): Promise<void> {
		// Don't fight a bulk run — it manages its own locking and password lifetime.
		if (this.bulkActive) return;
		const now = this.now();

		if (this.settings.autoLockMinutes > 0) {
			const maxAge = this.settings.autoLockMinutes * 60 * 1000;
			const active = this.app.workspace.getActiveFile()?.path ?? null;
			// Snapshot keys: relock() mutates the map mid-iteration.
			for (const path of Array.from(this.unlocked.keys())) {
				const info = this.unlocked.get(path);
				if (!info) continue;
				if (path === active) {
					info.lastTouched = now; // keep refreshing the note in view
					continue;
				}
				if (now - info.lastTouched >= maxAge) {
					await this.relock(path);
				}
			}
		}

		if (this.settings.forgetPasswordMinutes > 0) {
			const maxAge = this.settings.forgetPasswordMinutes * 60 * 1000;
			if (this.vaultPassword && now - this.vaultPasswordSetAt >= maxAge) this.forgetVaultPassword(true);
			for (const [key, entry] of Array.from(this.separatePasswords)) {
				if (now - entry.usedAt >= maxAge) this.separatePasswords.delete(key);
			}
		}
	}

	private now(): number {
		return Date.now();
	}
}

/** Key a remembered separate password by the note it opened. */
function noteKey(path: string): string {
	return `note:${path}`;
}

/** Key a remembered separate password by the separate-password folder it belongs to. */
function folderKey(path: string): string {
	return `folder:${path}`;
}

/** Parse a persisted ledger, dropping malformed entries. */
function normalizeLedger(raw: unknown): LedgerEntry[] {
	if (!Array.isArray(raw)) return [];
	const out: LedgerEntry[] = [];
	for (const e of raw) {
		if (e && typeof e === "object" && typeof (e as LedgerEntry).path === "string") {
			const scope: EnclaveScope = (e as LedgerEntry).scope === "note" ? "note" : "vault";
			out.push({ path: (e as LedgerEntry).path, scope });
		}
	}
	return out;
}
