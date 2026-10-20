import test from "node:test";
import assert from "node:assert/strict";
import EnclavePlugin from "../src/main.ts";
import { isLocked, buildLockedNote, parseLockedNote } from "../src/format.ts";
import { decryptContent, encryptContent } from "../src/crypto.ts";
import { Platform, TFile, TFolder } from "obsidian";

// The plugin schedules its move-in prompt with window.setTimeout.
globalThis.window ??= globalThis;

class TestEnclavePlugin extends EnclavePlugin {
	constructor(app) {
		super(app, { id: "enclave", name: "Enclave" });
		this.persistedData = null;
		this.suppliedPassword = null;
		/** When set, each password prompt takes the next entry instead of suppliedPassword. */
		this.passwordQueue = null;
		this.confirmResponse = true;
		this.moveInPrompts = [];
	}

	async loadData() {
		return this.persistedData;
	}

	async saveData(data) {
		this.persistedData = data;
	}

	promptPassword() {
		this.prompts = (this.prompts ?? 0) + 1;
		if (this.passwordQueue) return Promise.resolve(this.passwordQueue.shift() ?? null);
		return Promise.resolve(this.suppliedPassword);
	}

	confirmBulk() {
		return Promise.resolve(this.confirmResponse);
	}

	confirmMoveIn(message) {
		this.moveInPrompts.push(message);
		return Promise.resolve(this.confirmResponse);
	}

	confirmFolderLock() {
		return Promise.resolve(this.confirmResponse);
	}

	// Expose internals for verification in tests
	getUnlockedMap() {
		return this.unlocked;
	}

	getLedger() {
		return this.app.loadLocalStorage("enclave-ledger") ?? [];
	}

	triggerSweep() {
		return this.sweep();
	}
}

function createMockApp(filesMap) {
	const files = new Map();
	for (const [path, content] of Object.entries(filesMap)) {
		files.set(path, new TFile(path, content));
	}

	const app = {
		vault: {
			read: async (file) => files.get(file.path)?.content ?? "",
			modify: async (file, content) => {
				const f = files.get(file.path);
				if (f) f.content = content;
			},
			process: async (file, fn) => {
				const f = files.get(file.path);
				if (f) {
					f.content = fn(f.content);
				}
				return f?.content;
			},
			getMarkdownFiles: () => Array.from(files.values()),
			getAbstractFileByPath: (path) => files.get(path) ?? null,
			getRoot: () => new TFolder("/"),
			on: () => ({}),
		},
		workspace: {
			getActiveFile: () => null,
			getLeavesOfType: () => [],
			on: () => ({}),
			onLayoutReady: (cb) => cb(),
		},
		// Obsidian's per-vault, per-device localStorage.
		localStorage: new Map(),
		loadLocalStorage(key) {
			return this.localStorage.has(key) ? this.localStorage.get(key) : null;
		},
		saveLocalStorage(key, data) {
			if (data === null) this.localStorage.delete(key);
			else this.localStorage.set(key, structuredClone(data));
		},
	};
	return { app, files };
}

test("permanentlyDecryptNote on locked note undoes encryption permanently", async () => {
	const initialPlaintext = "# Important Notes\n\nSecret contents here.";
	const password = "myVaultPassword123";
	const payload = await encryptContent(initialPlaintext, password, "vault", 100000);
	const lockedContent = buildLockedNote(payload);

	const { app, files } = createMockApp({
		"secret.md": lockedContent,
	});

	const plugin = new TestEnclavePlugin(app);
	plugin.suppliedPassword = password;
	plugin.settings.iterations = 100000;

	const targetFile = files.get("secret.md");
	assert.ok(isLocked(targetFile.content));

	// Permanently decrypt the note
	await plugin.permanentlyDecryptNote(targetFile);

	// 1. Content on disk should now be plain markdown
	assert.equal(targetFile.content, initialPlaintext);
	assert.equal(isLocked(targetFile.content), false);

	// 2. Note must NOT be tracked in unlocked map
	assert.equal(plugin.getUnlockedMap().has("secret.md"), false);

	// 3. Note must NOT be in persisted crash recovery ledger
	assert.equal(plugin.getLedger().length, 0);

	// 4. Inactivity sweep should NOT re-lock the note
	await plugin.triggerSweep();
	assert.equal(targetFile.content, initialPlaintext);
	assert.equal(isLocked(targetFile.content), false);
});

test("permanentlyDecryptNote on already unlocked note removes tracking so it is not re-locked", async () => {
	const initialPlaintext = "# Confidential\n\nUnlocked plaintext currently in memory.";
	const password = "myVaultPassword123";
	const payload = await encryptContent(initialPlaintext, password, "vault", 100000);
	const lockedContent = buildLockedNote(payload);

	const { app, files } = createMockApp({
		"doc.md": lockedContent,
	});

	const plugin = new TestEnclavePlugin(app);
	plugin.suppliedPassword = password;
	plugin.confirmResponse = true;

	const targetFile = files.get("doc.md");

	// Step 1: Unlock note normally (this puts it into unlocked map)
	await plugin.unlockNote(targetFile);
	assert.equal(targetFile.content, initialPlaintext);
	assert.ok(plugin.getUnlockedMap().has("doc.md"));
	assert.equal(plugin.getLedger().length, 1);

	// Step 2: Permanently decrypt note
	await plugin.permanentlyDecryptNote(targetFile);

	// Note should now be untracked
	assert.equal(plugin.getUnlockedMap().has("doc.md"), false);
	assert.equal(plugin.getLedger().length, 0);
	assert.equal(targetFile.content, initialPlaintext);

	// Step 3: Trigger sweep (auto-lock). It must NOT re-lock!
	plugin.settings.autoLockMinutes = 1;
	await plugin.triggerSweep();

	assert.equal(targetFile.content, initialPlaintext);
	assert.equal(isLocked(targetFile.content), false);
});

test("permanentlyDecryptFiles permanently decrypts a group of notes and untracks already-unlocked ones", async () => {
	const password = "groupPassword123";
	const note1Plain = "Note 1 content";
	const note2Plain = "Note 2 content";
	const note3Plain = "Note 3 already unlocked content";

	const payload1 = await encryptContent(note1Plain, password, "vault", 100000);
	const payload2 = await encryptContent(note2Plain, password, "vault", 100000);
	const payload3 = await encryptContent(note3Plain, password, "vault", 100000);

	const { app, files } = createMockApp({
		"folder/note1.md": buildLockedNote(payload1),
		"folder/note2.md": buildLockedNote(payload2),
		"folder/note3.md": buildLockedNote(payload3),
	});

	const plugin = new TestEnclavePlugin(app);
	plugin.suppliedPassword = password;
	plugin.confirmResponse = true;

	// Unlock note3 first so it's in unlocked map
	await plugin.unlockNote(files.get("folder/note3.md"));
	assert.equal(plugin.getUnlockedMap().size, 1);

	// Permanently decrypt all notes in the group
	const groupFiles = [
		files.get("folder/note1.md"),
		files.get("folder/note2.md"),
		files.get("folder/note3.md"),
	];
	await plugin.permanentlyDecryptFiles(groupFiles, "selected group");

	// All 3 notes should be plaintext and not locked
	for (const f of groupFiles) {
		assert.equal(isLocked(f.content), false);
	}
	assert.equal(files.get("folder/note1.md").content, note1Plain);
	assert.equal(files.get("folder/note2.md").content, note2Plain);
	assert.equal(files.get("folder/note3.md").content, note3Plain);

	// None should be in unlocked map or ledger
	assert.equal(plugin.getUnlockedMap().size, 0);
	assert.equal(plugin.getLedger().length, 0);

	// Sweep does not re-lock
	await plugin.triggerSweep();
	for (const f of groupFiles) {
		assert.equal(isLocked(f.content), false);
	}
});

test("permanentlyDecryptFolder permanently decrypts entire vault", async () => {
	const password = "vaultPassword123";
	const p1 = await encryptContent("Vault note 1", password, "vault", 100000);
	const p2 = await encryptContent("Vault note 2", password, "vault", 100000);

	const { app, files } = createMockApp({
		"v1.md": buildLockedNote(p1),
		"v2.md": buildLockedNote(p2),
		"plain.md": "Already plain note",
	});

	const plugin = new TestEnclavePlugin(app);
	plugin.suppliedPassword = password;
	plugin.confirmResponse = true;

	await plugin.permanentlyDecryptFolder(app.vault.getRoot());

	assert.equal(files.get("v1.md").content, "Vault note 1");
	assert.equal(files.get("v2.md").content, "Vault note 2");
	assert.equal(files.get("plain.md").content, "Already plain note");
	assert.equal(isLocked(files.get("v1.md").content), false);
	assert.equal(isLocked(files.get("v2.md").content), false);
	assert.equal(plugin.getUnlockedMap().size, 0);
});

test("lockFiles with a separate password locks a group that unlockFiles opens with that password", async () => {
	const { app, files } = createMockApp({
		"private/a.md": "Note A",
		"private/b.md": "Note B",
	});
	const plugin = new TestEnclavePlugin(app);
	plugin.settings.iterations = 100000;
	plugin.suppliedPassword = "groupSecret123";

	await plugin.lockFolder(new TFolder("private"), "note");
	for (const f of [files.get("private/a.md"), files.get("private/b.md")]) {
		assert.ok(isLocked(f.content));
		assert.match(f.content, /^lock-scope: note$/m);
	}

	await plugin.unlockFolder(new TFolder("private"));
	assert.equal(files.get("private/a.md").content, "Note A");
	assert.equal(files.get("private/b.md").content, "Note B");
	assert.equal(plugin.getUnlockedMap().get("private/a.md").scope, "note");
	assert.equal(plugin.getUnlockedMap().get("private/a.md").password, "groupSecret123");
});

test("unlockFolder asks for the vault and separate passwords and leaves notes with another password locked", async () => {
	const vaultPw = "vaultPassword123";
	const groupPw = "groupSecret123";
	const { app, files } = createMockApp({
		"v.md": buildLockedNote(await encryptContent("Vault note", vaultPw, "vault", 100000)),
		"g1.md": buildLockedNote(await encryptContent("Group note 1", groupPw, "note", 100000)),
		"g2.md": buildLockedNote(await encryptContent("Group note 2", groupPw, "note", 100000)),
		"other.md": buildLockedNote(await encryptContent("Other note", "otherSecret123", "note", 100000)),
	});
	const plugin = new TestEnclavePlugin(app);
	plugin.passwordQueue = [vaultPw, groupPw];

	await plugin.unlockFolder(app.vault.getRoot());

	assert.equal(files.get("v.md").content, "Vault note");
	assert.equal(files.get("g1.md").content, "Group note 1");
	assert.equal(files.get("g2.md").content, "Group note 2");
	assert.ok(isLocked(files.get("other.md").content));
	assert.equal(plugin.getUnlockedMap().get("v.md").scope, "vault");
	assert.equal(plugin.getUnlockedMap().get("g1.md").scope, "note");
	assert.equal(plugin.getUnlockedMap().has("other.md"), false);
});

test("permanentlyDecryptFolder skips separate-password notes when that prompt is cancelled", async () => {
	const vaultPw = "vaultPassword123";
	const { app, files } = createMockApp({
		"v.md": buildLockedNote(await encryptContent("Vault note", vaultPw, "vault", 100000)),
		"s.md": buildLockedNote(await encryptContent("Separate note", "groupSecret123", "note", 100000)),
	});
	const plugin = new TestEnclavePlugin(app);
	plugin.passwordQueue = [vaultPw, null];

	await plugin.permanentlyDecryptFolder(app.vault.getRoot());

	assert.equal(files.get("v.md").content, "Vault note");
	assert.ok(isLocked(files.get("s.md").content));
	assert.equal(plugin.getUnlockedMap().size, 0);
});

test("permanentlyDecryptFiles decrypts separate-password notes with the shared password", async () => {
	const groupPw = "groupSecret123";
	const { app, files } = createMockApp({
		"s1.md": buildLockedNote(await encryptContent("Separate 1", groupPw, "note", 100000)),
		"s2.md": buildLockedNote(await encryptContent("Separate 2", groupPw, "note", 100000)),
	});
	const plugin = new TestEnclavePlugin(app);
	plugin.passwordQueue = [groupPw];

	await plugin.permanentlyDecryptFiles([files.get("s1.md"), files.get("s2.md")], "selection");

	assert.equal(files.get("s1.md").content, "Separate 1");
	assert.equal(files.get("s2.md").content, "Separate 2");
	assert.equal(plugin.getUnlockedMap().size, 0);
	assert.equal(plugin.getLedger().length, 0);
});

test("cancelling the vault password prompt changes nothing", async () => {
	const { app, files } = createMockApp({
		"v.md": buildLockedNote(await encryptContent("Vault note", "vaultPassword123", "vault", 100000)),
		"s.md": buildLockedNote(await encryptContent("Separate note", "groupSecret123", "note", 100000)),
	});
	const plugin = new TestEnclavePlugin(app);
	plugin.passwordQueue = [null, "groupSecret123"];

	await plugin.unlockFolder(app.vault.getRoot());

	assert.ok(isLocked(files.get("v.md").content));
	assert.ok(isLocked(files.get("s.md").content));
	assert.equal(plugin.getUnlockedMap().size, 0);
});

test("locking an unlocked separate-password note reuses its password instead of asking for the vault password", async () => {
	const notePw = "noteSecret123";
	const { app, files } = createMockApp({
		"private.md": buildLockedNote(await encryptContent("Private note", notePw, "note", 100000)),
	});
	const plugin = new TestEnclavePlugin(app);
	plugin.passwordQueue = [notePw];

	await plugin.unlockNote(files.get("private.md"));
	assert.equal(files.get("private.md").content, "Private note");

	// No more passwords: any prompt now returns null and would leave the note unlocked.
	await plugin.lockNote(files.get("private.md"), "vault");

	const content = files.get("private.md").content;
	assert.ok(isLocked(content));
	assert.match(content, /^lock-scope: note$/m);
	assert.equal(plugin.getUnlockedMap().size, 0);

	plugin.passwordQueue = [notePw];
	await plugin.unlockNote(files.get("private.md"));
	assert.equal(files.get("private.md").content, "Private note");
});

/** Move a mock file to a new path, as a vault rename would, and return it. */
function moveFile(files, oldPath, newPath) {
	const file = files.get(oldPath);
	files.delete(oldPath);
	file.path = newPath;
	file.name = newPath.split("/").pop();
	files.set(newPath, file);
	return file;
}

/** The locked-folder list without the stored password checks, for comparisons. */
function foldersWithoutChecks(plugin) {
	return plugin.settings.protectedFolders.map(({ path, scope }) => ({ path, scope }));
}

async function waitFor(condition) {
	for (let i = 0; i < 100 && !condition(); i++) await new Promise((r) => setTimeout(r, 20));
}

test("a plain note moved into a protected folder is locked after one prompt", async () => {
	const { app, files } = createMockApp({ "inbox/idea.md": "An idea", "inbox/todo.md": "A todo" });
	const plugin = new TestEnclavePlugin(app);
	plugin.settings.iterations = 100000;
	plugin.settings.protectedFolders = [{ path: "private", scope: "vault" }];
	plugin.passwordQueue = ["vaultPassword123"];

	plugin.onRename(moveFile(files, "inbox/idea.md", "private/idea.md"), "inbox/idea.md");
	plugin.onRename(moveFile(files, "inbox/todo.md", "private/todo.md"), "inbox/todo.md");
	await plugin.promptMovedIn();

	assert.equal(plugin.moveInPrompts.length, 1);
	assert.match(plugin.moveInPrompts[0], /2 notes were moved into "private"/);
	assert.ok(isLocked(files.get("private/idea.md").content));
	assert.ok(isLocked(files.get("private/todo.md").content));
});

test("declining the move-in prompt leaves the note as it is", async () => {
	const { app, files } = createMockApp({ "inbox/idea.md": "An idea" });
	const plugin = new TestEnclavePlugin(app);
	plugin.settings.protectedFolders = [{ path: "private", scope: "vault" }];
	plugin.confirmResponse = false;

	plugin.onRename(moveFile(files, "inbox/idea.md", "private/idea.md"), "inbox/idea.md");
	await plugin.promptMovedIn();

	assert.equal(plugin.moveInPrompts.length, 1);
	assert.equal(files.get("private/idea.md").content, "An idea");
});

test("renaming a note inside a protected folder does not prompt", async () => {
	const { app, files } = createMockApp({ "private/old.md": "Plain note" });
	const plugin = new TestEnclavePlugin(app);
	plugin.settings.protectedFolders = [{ path: "private", scope: "vault" }];

	plugin.onRename(moveFile(files, "private/old.md", "private/new.md"), "private/old.md");
	await plugin.promptMovedIn();

	assert.equal(plugin.moveInPrompts.length, 0);
});

test("renaming a protected folder keeps it protected without prompting for its notes", async () => {
	const { app, files } = createMockApp({ "private/a.md": "Plain note", "private/sub/b.md": "Plain note" });
	const plugin = new TestEnclavePlugin(app);
	plugin.settings.protectedFolders = [
		{ path: "private", scope: "vault" },
		{ path: "private/sub", scope: "note" },
	];

	plugin.onRename(new TFolder("vault-private"), "private");
	plugin.onRename(moveFile(files, "private/a.md", "vault-private/a.md"), "private/a.md");
	plugin.onRename(moveFile(files, "private/sub/b.md", "vault-private/sub/b.md"), "private/sub/b.md");
	await plugin.promptMovedIn();

	assert.deepEqual(plugin.settings.protectedFolders, [
		{ path: "vault-private", scope: "vault" },
		{ path: "vault-private/sub", scope: "note" },
	]);
	assert.equal(plugin.moveInPrompts.length, 0);
});

test("moving an unprotected folder into a protected one asks about its notes", async () => {
	const { app, files } = createMockApp({ "drafts/a.md": "Draft A", "drafts/b.md": "Draft B" });
	const plugin = new TestEnclavePlugin(app);
	plugin.settings.protectedFolders = [{ path: "private", scope: "vault" }];
	plugin.confirmResponse = false;

	plugin.onRename(new TFolder("private/drafts"), "drafts");
	plugin.onRename(moveFile(files, "drafts/a.md", "private/drafts/a.md"), "drafts/a.md");
	plugin.onRename(moveFile(files, "drafts/b.md", "private/drafts/b.md"), "drafts/b.md");
	await plugin.promptMovedIn();

	assert.deepEqual(plugin.settings.protectedFolders, [{ path: "private", scope: "vault" }]);
	assert.equal(plugin.moveInPrompts.length, 1);
	assert.match(plugin.moveInPrompts[0], /2 notes were moved/);
});

test("a note created in a protected folder is locked when you leave it", async () => {
	const { app, files } = createMockApp({ "private/new.md": "Fresh note" });
	const plugin = new TestEnclavePlugin(app);
	plugin.settings.iterations = 100000;
	plugin.settings.protectedFolders = [{ path: "private", scope: "vault" }];
	plugin.passwordQueue = ["vaultPassword123"];

	plugin.onCreate(files.get("private/new.md"));
	plugin.lastActiveFile = "private/new.md";
	plugin.handleActiveChange(); // the mock workspace reports no active file: the note was left

	await waitFor(() => isLocked(files.get("private/new.md").content));
	assert.ok(isLocked(files.get("private/new.md").content));
	assert.match(files.get("private/new.md").content, /^lock-scope: vault$/m);
});

test("a permanently decrypted note in a protected folder is not locked again when left", async () => {
	const { app, files } = createMockApp({ "private/kept-plain.md": "Decrypted on purpose" });
	const plugin = new TestEnclavePlugin(app);
	plugin.settings.protectedFolders = [{ path: "private", scope: "vault" }];

	plugin.lastActiveFile = "private/kept-plain.md";
	plugin.handleActiveChange();
	await new Promise((r) => setTimeout(r, 50));

	assert.equal(files.get("private/kept-plain.md").content, "Decrypted on purpose");
});

test("locking a folder keeps it locked, even when it is empty", async () => {
	const { app, files } = createMockApp({ "work/a.md": "Note A" });
	const plugin = new TestEnclavePlugin(app);
	plugin.settings.iterations = 100000;
	plugin.passwordQueue = ["vaultPassword123"];

	await plugin.lockFolder(new TFolder("work"));
	await plugin.lockFolder(new TFolder("empty"));

	assert.ok(isLocked(files.get("work/a.md").content));
	assert.deepEqual(plugin.settings.protectedFolders, [
		{ path: "work", scope: "vault" },
		{ path: "empty", scope: "vault" },
	]);
});

test("a note moved into a separate-password folder is locked with that folder's password", async () => {
	const folderPw = "folderSecret123";
	const { app, files } = createMockApp({
		"private/a.md": "Note A",
		"inbox/idea.md": "An idea",
	});
	const plugin = new TestEnclavePlugin(app);
	plugin.settings.iterations = 100000;
	plugin.passwordQueue = [folderPw];
	await plugin.lockFolder(new TFolder("private"), "note");
	assert.deepEqual(foldersWithoutChecks(plugin), [{ path: "private", scope: "note" }]);
	assert.ok(plugin.settings.protectedFolders[0].check, "a separate-password folder keeps a check");

	// A wrong password is rejected and nothing is locked.
	plugin.passwordQueue = ["wrongPassword123"];
	plugin.onRename(moveFile(files, "inbox/idea.md", "private/idea.md"), "inbox/idea.md");
	await plugin.promptMovedIn();
	assert.equal(files.get("private/idea.md").content, "An idea");

	// Moving it out and back in asks again; the right password locks it.
	plugin.onRename(moveFile(files, "private/idea.md", "inbox/idea.md"), "private/idea.md");
	plugin.onRename(moveFile(files, "inbox/idea.md", "private/idea.md"), "inbox/idea.md");
	plugin.passwordQueue = [folderPw];
	await plugin.promptMovedIn();
	assert.ok(isLocked(files.get("private/idea.md").content));
	assert.match(files.get("private/idea.md").content, /^lock-scope: note$/m);

	plugin.passwordQueue = [folderPw];
	await plugin.unlockNote(files.get("private/idea.md"));
	assert.equal(files.get("private/idea.md").content, "An idea");
});

test("re-locking a separate-password folder must reuse its existing password", async () => {
	const folderPw = "folderSecret123";
	const { app, files } = createMockApp({
		"private/a.md": buildLockedNote(await encryptContent("Note A", folderPw, "note", 100000)),
		"private/b.md": "Note B, added later",
	});
	const plugin = new TestEnclavePlugin(app);
	plugin.settings.iterations = 100000;

	plugin.passwordQueue = ["aDifferentPassword"];
	await plugin.lockFolder(new TFolder("private"), "note");
	assert.equal(files.get("private/b.md").content, "Note B, added later");
	assert.deepEqual(plugin.settings.protectedFolders, []);

	plugin.passwordQueue = [folderPw];
	await plugin.lockFolder(new TFolder("private"), "note");
	assert.ok(isLocked(files.get("private/b.md").content));
	assert.deepEqual(foldersWithoutChecks(plugin), [{ path: "private", scope: "note" }]);
	assert.ok(plugin.settings.protectedFolders[0].check, "a separate-password folder keeps a check");
});

test("permanently decrypting a folder stops keeping it and its subfolders locked", async () => {
	const vaultPw = "vaultPassword123";
	const { app, files } = createMockApp({
		"private/a.md": buildLockedNote(await encryptContent("Note A", vaultPw, "vault", 100000)),
	});
	const plugin = new TestEnclavePlugin(app);
	plugin.settings.protectedFolders = [
		{ path: "private", scope: "vault" },
		{ path: "private/sub", scope: "note" },
		{ path: "other", scope: "vault" },
	];
	plugin.passwordQueue = [vaultPw];

	await plugin.permanentlyDecryptFolder(new TFolder("private"));

	assert.equal(files.get("private/a.md").content, "Note A");
	assert.deepEqual(plugin.settings.protectedFolders, [{ path: "other", scope: "vault" }]);
});

test("a note created in a separate-password folder asks for that password when left", async () => {
	const folderPw = "folderSecret123";
	const { app, files } = createMockApp({
		"private/a.md": buildLockedNote(await encryptContent("Note A", folderPw, "note", 100000)),
		"private/new.md": "Fresh note",
	});
	const plugin = new TestEnclavePlugin(app);
	plugin.settings.iterations = 100000;
	plugin.settings.protectedFolders = [{ path: "private", scope: "note" }];
	plugin.passwordQueue = [folderPw];

	plugin.onCreate(files.get("private/new.md"));
	plugin.lastActiveFile = "private/new.md";
	plugin.handleActiveChange();

	await waitFor(() => isLocked(files.get("private/new.md").content));
	assert.match(files.get("private/new.md").content, /^lock-scope: note$/m);
});

test("the vault password is chosen once, then a mistyped one is rejected", async () => {
	const { app, files } = createMockApp({ "a.md": "Note A", "b.md": "Note B" });
	const plugin = new TestEnclavePlugin(app);
	plugin.settings.iterations = 100000;

	plugin.passwordQueue = ["vaultPassword123"];
	await plugin.lockNote(files.get("a.md"), "vault");
	assert.ok(isLocked(files.get("a.md").content));
	assert.ok(plugin.settings.vaultCheck, "choosing the vault password stores a check");

	// Next session: a typo is refused instead of becoming a second vault password.
	plugin.forgetVaultPassword(true);
	plugin.passwordQueue = ["vaultPasword123"];
	await plugin.lockNote(files.get("b.md"), "vault");
	assert.equal(files.get("b.md").content, "Note B");

	plugin.passwordQueue = ["vaultPassword123"];
	await plugin.lockNote(files.get("b.md"), "vault");
	assert.ok(isLocked(files.get("b.md").content));
});

test("a vault check is created the first time the vault password opens a note", async () => {
	const vaultPw = "vaultPassword123";
	const { app, files } = createMockApp({
		"a.md": buildLockedNote(await encryptContent("Note A", vaultPw, "vault", 100000)),
	});
	const plugin = new TestEnclavePlugin(app);
	plugin.settings.iterations = 100000;

	plugin.passwordQueue = ["wrongPassword123"];
	await plugin.unlockNote(files.get("a.md"));
	assert.equal(plugin.settings.vaultCheck, null, "a wrong password never becomes the check");

	plugin.passwordQueue = [vaultPw];
	await plugin.unlockNote(files.get("a.md"));
	assert.equal(files.get("a.md").content, "Note A");
	assert.ok(plugin.settings.vaultCheck);
});

test("forgetting the vault check lets a new vault password be chosen", async () => {
	const { app, files } = createMockApp({ "a.md": "Note A", "b.md": "Note B" });
	const plugin = new TestEnclavePlugin(app);
	plugin.settings.iterations = 100000;
	plugin.passwordQueue = ["vaultPassword123"];
	await plugin.lockNote(files.get("a.md"), "vault");

	await plugin.resetVaultCheck();
	assert.equal(plugin.settings.vaultCheck, null);

	plugin.passwordQueue = ["newVaultPassword456"];
	await plugin.lockNote(files.get("b.md"), "vault");
	assert.ok(isLocked(files.get("b.md").content));

	plugin.forgetVaultPassword(true);
	plugin.passwordQueue = ["newVaultPassword456"];
	await plugin.unlockNote(files.get("b.md"));
	assert.equal(files.get("b.md").content, "Note B");
});

test("a separate-password folder accepts only its own password, even with other passwords inside", async () => {
	const folderPw = "folderSecret123";
	const otherPw = "otherSecret456";
	const { app, files } = createMockApp({
		"private/a.md": "Note A",
		"inbox/idea.md": "An idea",
	});
	const plugin = new TestEnclavePlugin(app);
	plugin.settings.iterations = 100000;
	plugin.passwordQueue = [folderPw];
	await plugin.lockFolder(new TFolder("private"), "note");

	// A note with its own, different separate password sits in the folder too.
	files.set("private/own.md", new TFile("private/own.md", buildLockedNote(await encryptContent("Own", otherPw, "note", 100000))));

	plugin.passwordQueue = [otherPw];
	plugin.onRename(moveFile(files, "inbox/idea.md", "private/idea.md"), "inbox/idea.md");
	await plugin.promptMovedIn();
	assert.equal(files.get("private/idea.md").content, "An idea", "the other note's password is refused");

	plugin.onRename(moveFile(files, "private/idea.md", "inbox/idea.md"), "private/idea.md");
	plugin.onRename(moveFile(files, "inbox/idea.md", "private/idea.md"), "inbox/idea.md");
	plugin.passwordQueue = [folderPw];
	await plugin.promptMovedIn();
	assert.ok(isLocked(files.get("private/idea.md").content));

	plugin.passwordQueue = [folderPw];
	await plugin.unlockNote(files.get("private/idea.md"));
	assert.equal(files.get("private/idea.md").content, "An idea");
});

test("locking an empty folder with a separate password sets its password right away", async () => {
	const folderPw = "folderSecret123";
	const { app, files } = createMockApp({ "inbox/idea.md": "An idea" });
	const plugin = new TestEnclavePlugin(app);
	plugin.settings.iterations = 100000;

	plugin.passwordQueue = [folderPw];
	await plugin.lockFolder(new TFolder("empty"), "note");
	assert.ok(plugin.settings.protectedFolders[0].check);

	plugin.passwordQueue = ["wrongPassword123"];
	plugin.onRename(moveFile(files, "inbox/idea.md", "empty/idea.md"), "inbox/idea.md");
	await plugin.promptMovedIn();
	assert.equal(files.get("empty/idea.md").content, "An idea");

	plugin.onRename(moveFile(files, "empty/idea.md", "inbox/idea.md"), "empty/idea.md");
	plugin.onRename(moveFile(files, "inbox/idea.md", "empty/idea.md"), "inbox/idea.md");
	plugin.passwordQueue = [folderPw];
	await plugin.promptMovedIn();
	assert.ok(isLocked(files.get("empty/idea.md").content));
});

test("invalid entries in the settings file are dropped on load", async () => {
	const { app } = createMockApp({});
	const plugin = new TestEnclavePlugin(app);
	plugin.persistedData = {
		settings: {
			protectedFolders: ["Misc/old style", { path: "ok", scope: "vault" }, { path: "bad", scope: "other" }],
			vaultCheck: "not a payload",
		},
		ledger: [],
	};
	await plugin.loadSettings();
	assert.deepEqual(plugin.settings.protectedFolders, [{ path: "ok", scope: "vault" }]);
	assert.equal(plugin.settings.vaultCheck, null);
});

test("hiding Obsidian on desktop locks unlocked notes only when the setting is on", async () => {
	const vaultPw = "vaultPassword123";
	const { app, files } = createMockApp({
		"a.md": buildLockedNote(await encryptContent("Note A", vaultPw, "vault", 100000)),
	});
	const plugin = new TestEnclavePlugin(app);
	plugin.settings.iterations = 100000;
	plugin.passwordQueue = [vaultPw];
	await plugin.unlockNote(files.get("a.md"));

	plugin.settings.lockWhenHidden = false;
	plugin.handleHidden();
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(files.get("a.md").content, "Note A");

	plugin.settings.lockWhenHidden = true;
	plugin.handleHidden();
	await waitFor(() => isLocked(files.get("a.md").content));
	assert.ok(isLocked(files.get("a.md").content));
});

test("hiding Obsidian on mobile always locks unlocked notes", async () => {
	const vaultPw = "vaultPassword123";
	const { app, files } = createMockApp({
		"a.md": buildLockedNote(await encryptContent("Note A", vaultPw, "vault", 100000)),
	});
	const plugin = new TestEnclavePlugin(app);
	plugin.settings.iterations = 100000;
	plugin.passwordQueue = [vaultPw];
	await plugin.unlockNote(files.get("a.md"));

	plugin.settings.lockWhenHidden = false;
	Platform.isMobile = true;
	try {
		plugin.handleHidden();
		await waitFor(() => isLocked(files.get("a.md").content));
	} finally {
		Platform.isMobile = false;
	}
	assert.ok(isLocked(files.get("a.md").content));
});

test("after the vault password is changed, notes locked with the earlier one still unlock", async () => {
	const oldPw = "oldVaultPassword123";
	const newPw = "newVaultPassword456";
	const { app, files } = createMockApp({ "old.md": "Old note", "new.md": "New note" });
	const plugin = new TestEnclavePlugin(app);
	plugin.settings.iterations = 100000;

	plugin.passwordQueue = [oldPw];
	await plugin.lockNote(files.get("old.md"), "vault");
	await plugin.resetVaultCheck();
	plugin.passwordQueue = [newPw];
	await plugin.lockNote(files.get("new.md"), "vault");

	// Typed in a fresh session: the earlier password opens the old note,
	// but isn't kept as the session's vault password.
	plugin.forgetVaultPassword(true);
	plugin.passwordQueue = [oldPw];
	await plugin.unlockNote(files.get("old.md"));
	assert.equal(files.get("old.md").content, "Old note");
	assert.equal(plugin.vaultPassword, null);
});

test("when the current vault password doesn't open a note, the earlier one is asked for", async () => {
	const oldPw = "oldVaultPassword123";
	const newPw = "newVaultPassword456";
	const { app, files } = createMockApp({ "old.md": "Old note", "new.md": "New note" });
	const plugin = new TestEnclavePlugin(app);
	plugin.settings.iterations = 100000;

	plugin.passwordQueue = [oldPw];
	await plugin.lockNote(files.get("old.md"), "vault");
	await plugin.resetVaultCheck();
	plugin.passwordQueue = [newPw];
	await plugin.lockNote(files.get("new.md"), "vault");
	assert.equal(plugin.vaultPassword, newPw);

	// The session's (new) vault password fails on the old note, so the earlier one is asked for.
	plugin.passwordQueue = [oldPw];
	await plugin.unlockNote(files.get("old.md"));
	assert.equal(files.get("old.md").content, "Old note");
	assert.equal(plugin.vaultPassword, newPw, "the current vault password stays in use");

	// Locking it again moves it to the current vault password.
	await plugin.lockAll(true);
	assert.ok(isLocked(files.get("old.md").content));
	plugin.forgetVaultPassword(true);
	plugin.passwordQueue = [newPw];
	await plugin.unlockNote(files.get("old.md"));
	assert.equal(files.get("old.md").content, "Old note");
});

test("declining the folder lock confirmation changes nothing", async () => {
	const { app, files } = createMockApp({ "work/a.md": "Note A" });
	const plugin = new TestEnclavePlugin(app);
	plugin.confirmResponse = false;
	plugin.passwordQueue = ["vaultPassword123"];

	await plugin.lockFolder(new TFolder("work"));

	assert.equal(files.get("work/a.md").content, "Note A");
	assert.deepEqual(plugin.settings.protectedFolders, []);
	assert.deepEqual(plugin.passwordQueue, ["vaultPassword123"], "no password is asked for");
});

async function separateNoteSetup(notePw) {
	const { app, files } = createMockApp({
		"private/a.md": buildLockedNote(await encryptContent("Note A", notePw, "note", 100000)),
	});
	const plugin = new TestEnclavePlugin(app);
	plugin.settings.iterations = 100000;
	plugin.settings.autoLockMinutes = 0;
	return { plugin, files };
}

test("separate passwords are asked for every time unless remembering is on", async () => {
	const notePw = "noteSecret123";
	const { plugin, files } = await separateNoteSetup(notePw);

	plugin.passwordQueue = [notePw, notePw];
	await plugin.unlockNote(files.get("private/a.md"));
	await plugin.lockAll(true);
	await plugin.unlockNote(files.get("private/a.md"));

	assert.equal(files.get("private/a.md").content, "Note A");
	assert.equal(plugin.prompts, 2);
});

test("a remembered separate password opens the note again without asking", async () => {
	const notePw = "noteSecret123";
	const { plugin, files } = await separateNoteSetup(notePw);
	plugin.settings.rememberPasswords = "all";

	plugin.passwordQueue = [notePw];
	await plugin.unlockNote(files.get("private/a.md"));
	await plugin.lockAll(true);
	assert.ok(isLocked(files.get("private/a.md").content));

	await plugin.unlockNote(files.get("private/a.md"));
	assert.equal(files.get("private/a.md").content, "Note A");
	assert.equal(plugin.prompts, 1);
});

test("remembered separate passwords follow a renamed note and expire with the vault password", async () => {
	const notePw = "noteSecret123";
	const { plugin, files } = await separateNoteSetup(notePw);
	plugin.settings.rememberPasswords = "all";
	plugin.settings.forgetPasswordMinutes = 1;
	let clock = 1_000_000;
	plugin.now = () => clock;

	plugin.passwordQueue = [notePw];
	await plugin.unlockNote(files.get("private/a.md"));
	await plugin.lockAll(true);

	plugin.onRename(moveFile(files, "private/a.md", "private/renamed.md"), "private/a.md");
	await plugin.unlockNote(files.get("private/renamed.md"));
	assert.equal(plugin.prompts, 1, "still remembered after the rename");
	await plugin.lockAll(true);

	clock += 61 * 1000;
	await plugin.triggerSweep();
	plugin.passwordQueue = [notePw];
	await plugin.unlockNote(files.get("private/renamed.md"));
	assert.equal(plugin.prompts, 2, "asked again once it expired");
});

test("forgetting all passwords also forgets remembered separate passwords", async () => {
	const notePw = "noteSecret123";
	const { plugin, files } = await separateNoteSetup(notePw);
	plugin.settings.rememberPasswords = "all";

	plugin.passwordQueue = [notePw, notePw];
	await plugin.unlockNote(files.get("private/a.md"));
	await plugin.lockAll(true);
	await plugin.lockAndForget();
	await plugin.unlockNote(files.get("private/a.md"));

	assert.equal(plugin.prompts, 2);
});

test("with a remembered folder password, a note moved in is locked after a confirmation", async () => {
	const folderPw = "folderSecret123";
	const { app, files } = createMockApp({ "private/a.md": "Note A", "inbox/idea.md": "An idea" });
	const plugin = new TestEnclavePlugin(app);
	plugin.settings.iterations = 100000;
	plugin.settings.rememberPasswords = "all";
	plugin.passwordQueue = [folderPw];
	await plugin.lockFolder(new TFolder("private"), "note");
	assert.equal(plugin.prompts, 1);

	plugin.onRename(moveFile(files, "inbox/idea.md", "private/idea.md"), "inbox/idea.md");
	await plugin.promptMovedIn();

	assert.equal(plugin.prompts, 1, "no password prompt");
	assert.equal(plugin.moveInPrompts.length, 1, "but a confirmation");
	assert.match(plugin.moveInPrompts[0], /locked with a separate password/);
	assert.ok(isLocked(files.get("private/idea.md").content));

	await plugin.lockAndForget();
	plugin.passwordQueue = [folderPw];
	await plugin.unlockNote(files.get("private/idea.md"));
	assert.equal(files.get("private/idea.md").content, "An idea", "locked with the folder's password");
});

test("with remembering off, the vault password is asked for every time", async () => {
	const vaultPw = "vaultPassword123";
	const { app, files } = createMockApp({ "a.md": "Note A", "b.md": "Note B" });
	const plugin = new TestEnclavePlugin(app);
	plugin.settings.iterations = 100000;
	plugin.settings.rememberPasswords = "none";

	plugin.passwordQueue = [vaultPw, vaultPw];
	await plugin.lockNote(files.get("a.md"), "vault");
	await plugin.lockNote(files.get("b.md"), "vault");
	assert.ok(isLocked(files.get("a.md").content));
	assert.ok(isLocked(files.get("b.md").content));
	assert.equal(plugin.prompts, 2);
	assert.equal(plugin.vaultPassword, null);

	// An unlocked note still re-locks on its own, with the password it was opened with.
	plugin.passwordQueue = [vaultPw];
	await plugin.unlockNote(files.get("a.md"));
	await plugin.lockAll(true);
	assert.ok(isLocked(files.get("a.md").content));
});

test("the old 'remember separate passwords' toggle carries over", async () => {
	const { app } = createMockApp({});
	for (const [old, expected] of [
		[true, "all"],
		[false, "vault"],
		[undefined, "vault"],
	]) {
		const plugin = new TestEnclavePlugin(app);
		plugin.persistedData = { settings: { rememberSeparatePasswords: old }, ledger: [] };
		await plugin.loadSettings();
		assert.equal(plugin.settings.rememberPasswords, expected, `toggle ${old}`);
		assert.equal("rememberSeparatePasswords" in plugin.settings, false);
	}
});

/** Run `fn` as if on a phone or tablet. */
async function onMobile(fn) {
	Platform.isMobile = true;
	try {
		return await fn();
	} finally {
		Platform.isMobile = false;
	}
}

test("phones and tablets use their own values only when that's turned on", async () => {
	const { app } = createMockApp({});
	const plugin = new TestEnclavePlugin(app);
	Object.assign(plugin.settings, {
		rememberPasswords: "all",
		forgetPasswordMinutes: 60,
		autoLockMinutes: 10,
		mobileRememberPasswords: "none",
		mobileForgetPasswordMinutes: 5,
		mobileAutoLockMinutes: 1,
	});
	const desktop = { rememberPasswords: "all", forgetPasswordMinutes: 60, autoLockMinutes: 10 };

	assert.deepEqual(plugin.device(), desktop);
	assert.deepEqual(await onMobile(() => plugin.device()), desktop, "off: mobile uses the regular values");

	plugin.settings.mobileOverrides = true;
	assert.deepEqual(plugin.device(), desktop, "desktop is unaffected");
	assert.deepEqual(await onMobile(() => plugin.device()), {
		rememberPasswords: "none",
		forgetPasswordMinutes: 5,
		autoLockMinutes: 1,
	});
});

test("on mobile with its own settings, its remember choice and auto-lock apply", async () => {
	const vaultPw = "vaultPassword123";
	const { app, files } = createMockApp({ "a.md": "Note A" });
	const plugin = new TestEnclavePlugin(app);
	plugin.settings.iterations = 100000;
	Object.assign(plugin.settings, {
		rememberPasswords: "vault",
		autoLockMinutes: 0,
		mobileOverrides: true,
		mobileRememberPasswords: "none",
		mobileAutoLockMinutes: 1,
	});
	let clock = 1_000_000;
	plugin.now = () => clock;

	await onMobile(async () => {
		plugin.passwordQueue = [vaultPw, vaultPw];
		await plugin.lockNote(files.get("a.md"), "vault");
		assert.equal(plugin.vaultPassword, null, "mobile doesn't remember");
		await plugin.unlockNote(files.get("a.md"));
		assert.equal(plugin.prompts, 2);

		clock += 61 * 1000;
		await plugin.triggerSweep();
		assert.ok(isLocked(files.get("a.md").content), "mobile's 1-minute auto-lock applied");
	});

	plugin.passwordQueue = [vaultPw];
	await plugin.unlockNote(files.get("a.md"));
	assert.equal(plugin.vaultPassword, vaultPw, "desktop remembers the vault password");
});

test("switching mobile to a stricter choice forgets what it no longer allows", async () => {
	const notePw = "noteSecret123";
	const { plugin, files } = await separateNoteSetup(notePw);
	plugin.settings.mobileOverrides = true;
	plugin.settings.mobileRememberPasswords = "all";

	await onMobile(async () => {
		plugin.passwordQueue = [notePw, notePw];
		await plugin.unlockNote(files.get("private/a.md"));
		await plugin.lockAll(true);

		plugin.settings.mobileRememberPasswords = "vault";
		plugin.applyRememberPolicy();
		await plugin.unlockNote(files.get("private/a.md"));
	});
	assert.equal(plugin.prompts, 2, "the separate password was forgotten");
});

test("the settings tab can tell which passwords are in memory", async () => {
	const notePw = "noteSecret123";
	const { plugin, files } = await separateNoteSetup(notePw);
	plugin.settings.rememberPasswords = "all";
	assert.match(plugin.rememberedPasswordsSummary(), /^Nothing is unlocked/);

	plugin.passwordQueue = [notePw];
	await plugin.unlockNote(files.get("private/a.md"));
	assert.equal(
		plugin.rememberedPasswordsSummary(),
		"1 note is unlocked and Enclave remembers a separate password for 1 note or folder temporarily. The note locks again when you leave it or when Obsidian is hidden or closed. Passwords are forgotten after 30 minutes unused. You don't need to do anything; Lock and forget just does it now."
	);

	await plugin.lockAll(true);
	assert.equal(
		plugin.rememberedPasswordsSummary(),
		"Enclave remembers a separate password for 1 note or folder temporarily. Passwords are forgotten after 30 minutes unused. You don't need to do anything; Lock and forget just does it now."
	);
});

test("lock and forget locks unlocked notes first, so no password is left", async () => {
	const vaultPw = "vaultPassword123";
	const { app, files } = createMockApp({
		"a.md": buildLockedNote(await encryptContent("Note A", vaultPw, "vault", 100000)),
	});
	const plugin = new TestEnclavePlugin(app);
	plugin.settings.iterations = 100000;
	plugin.passwordQueue = [vaultPw];
	await plugin.unlockNote(files.get("a.md"));
	assert.equal(
		plugin.rememberedPasswordsSummary(),
		"1 note is unlocked and Enclave remembers the vault password temporarily. The note locks again when you leave it, after 5 minutes without use, or when Obsidian is hidden or closed. The password is forgotten after 30 minutes unused. You don't need to do anything; Lock and forget just does it now."
	);

	await plugin.lockAndForget();

	assert.ok(isLocked(files.get("a.md").content), "the unlocked note was locked with its password first");
	assert.equal(plugin.vaultPassword, null);
	assert.equal(plugin.getUnlockedMap().size, 0);
	assert.match(plugin.rememberedPasswordsSummary(), /^Nothing is unlocked/);
});

// ---- api for sync plugins ----

test("the api says which notes must not be uploaded", async () => {
	const vaultPw = "vaultPassword123";
	const { app, files } = createMockApp({
		"open.md": buildLockedNote(await encryptContent("Open note", vaultPw, "vault", 100000)),
		"plain.md": "Ordinary note",
		"private/draft.md": "Not locked yet",
		"private/done.md": buildLockedNote(await encryptContent("Locked", vaultPw, "vault", 100000)),
	});
	const plugin = new TestEnclavePlugin(app);
	plugin.settings.iterations = 100000;
	plugin.settings.protectedFolders = [{ path: "private", scope: "vault" }];
	plugin.passwordQueue = [vaultPw];
	await plugin.unlockNote(files.get("open.md"));

	assert.equal(plugin.api.version, 1);
	assert.equal(await plugin.api.holdReason("open.md"), "unlocked");
	assert.equal(await plugin.api.holdReason("plain.md"), null, "plain notes outside locked folders sync as usual");
	assert.equal(await plugin.api.holdReason("private/draft.md"), "not-locked-yet");
	assert.equal(await plugin.api.holdReason("private/done.md"), null, "locked content may be uploaded");

	await plugin.lockAll(true);
	assert.equal(await plugin.api.holdReason("open.md"), null);
});

test("intentionally plain notes in a locked folder may be uploaded, until they're locked again", async () => {
	const vaultPw = "vaultPassword123";
	const { app, files } = createMockApp({
		"private/a.md": buildLockedNote(await encryptContent("Note A", vaultPw, "vault", 100000)),
		"inbox/idea.md": "An idea",
	});
	const plugin = new TestEnclavePlugin(app);
	plugin.settings.iterations = 100000;
	plugin.settings.protectedFolders = [{ path: "private", scope: "vault" }];

	// Permanently decrypted on purpose.
	plugin.passwordQueue = [vaultPw];
	await plugin.permanentlyDecryptNote(files.get("private/a.md"));
	assert.equal(plugin.api.isIntentionallyPlain("private/a.md"), true);
	assert.equal(await plugin.api.holdReason("private/a.md"), null);

	// Declined when moved in.
	plugin.confirmResponse = false;
	plugin.onRename(moveFile(files, "inbox/idea.md", "private/idea.md"), "inbox/idea.md");
	await plugin.promptMovedIn();
	assert.equal(await plugin.api.holdReason("private/idea.md"), null);

	// Renaming keeps the mark; locking again removes it.
	plugin.onRename(moveFile(files, "private/a.md", "private/b.md"), "private/a.md");
	assert.equal(plugin.api.isIntentionallyPlain("private/b.md"), true);
	plugin.passwordQueue = [vaultPw];
	await plugin.lockNote(files.get("private/b.md"), "vault");
	assert.equal(plugin.api.isIntentionallyPlain("private/b.md"), false);
});

test("a note locked again unchanged gets back its exact earlier encrypted version", async () => {
	const vaultPw = "vaultPassword123";
	const original = buildLockedNote(await encryptContent("Note A", vaultPw, "vault", 100000));
	const { app, files } = createMockApp({ "a.md": original });
	const plugin = new TestEnclavePlugin(app);
	plugin.settings.iterations = 100000;
	plugin.passwordQueue = [vaultPw];

	await plugin.unlockNote(files.get("a.md"));
	await plugin.lockAll(true);
	assert.equal(files.get("a.md").content, original, "unchanged: byte for byte the same file");

	await plugin.unlockNote(files.get("a.md"));
	files.get("a.md").content = "Note A, edited";
	await plugin.lockAll(true);
	assert.ok(isLocked(files.get("a.md").content));
	assert.notEqual(files.get("a.md").content, original, "edited: encrypted anew");
});

test("the api reports every lock to listeners until they unsubscribe", async () => {
	const { app, files } = createMockApp({ "a.md": "Note A", "b.md": "Note B" });
	const plugin = new TestEnclavePlugin(app);
	plugin.settings.iterations = 100000;
	const locked = [];
	const unsubscribe = plugin.api.onLocked((path) => locked.push(path));

	plugin.passwordQueue = ["vaultPassword123"];
	await plugin.lockNote(files.get("a.md"), "vault");
	unsubscribe();
	await plugin.lockNote(files.get("b.md"), "vault");

	assert.deepEqual(locked, ["a.md"]);
});

test("a merge session decrypts conflict versions in memory and seals the result", async () => {
	const vaultPw = "vaultPassword123";
	const otherPw = "otherSecret456";
	const { app } = createMockApp({});
	const plugin = new TestEnclavePlugin(app);
	plugin.settings.iterations = 100000;

	const base = buildLockedNote(await encryptContent("line 1\nline 2", vaultPw, "vault", 100000));
	const mine = buildLockedNote(await encryptContent("line 1 mine\nline 2", vaultPw, "vault", 100000));
	const theirs = buildLockedNote(await encryptContent("line 1\nline 2 theirs", otherPw, "note", 100000));

	plugin.prompts = 0;
	plugin.passwordQueue = [vaultPw, otherPw];
	const session = await plugin.api.openForMerge("a.md", [
		{ label: "the last synced version", content: base, optional: true },
		{ label: "this device's version", content: mine },
		{ label: "GitLab's version", content: theirs },
	]);
	assert.ok(session);
	assert.equal(plugin.prompts, 2, "asked for this device's and GitLab's password, never the base's");
	assert.deepEqual(session.texts, [null, "line 1 mine\nline 2", "line 1\nline 2 theirs"]);
	assert.deepEqual(session.locks, [null, { scope: "vault" }, { scope: "note" }]);
	assert.equal(session.sameLock, false);

	const sealed = await session.seal("line 1 mine\nline 2 theirs", 2);
	assert.ok(isLocked(sealed));
	assert.match(sealed, /^lock-scope: note$/m, "kept GitLab's kind of lock");
	assert.equal(await decryptContent(parseLockedNote(sealed), otherPw), "line 1 mine\nline 2 theirs");
	await assert.rejects(() => session.seal("again", 2), "passwords are forgotten after sealing");
});

test("a merge session uses passwords Enclave already has, without asking", async () => {
	const vaultPw = "vaultPassword123";
	const { app, files } = createMockApp({ "a.md": "Note A" });
	const plugin = new TestEnclavePlugin(app);
	plugin.settings.iterations = 100000;
	plugin.passwordQueue = [vaultPw];
	await plugin.lockNote(files.get("a.md"), "vault");

	const remote = buildLockedNote(await encryptContent("Note A from elsewhere", vaultPw, "vault", 100000));
	plugin.prompts = 0;
	const session = await plugin.api.openForMerge("a.md", [
		{ label: "this device's version", content: files.get("a.md").content },
		{ label: "GitLab's version", content: remote },
	]);
	assert.equal(plugin.prompts, 0);
	assert.deepEqual(session.texts, ["Note A", "Note A from elsewhere"]);
	assert.equal(session.sameLock, true);
	session.close();
});

test("the crash-recovery ledger stays on the device, out of the synced data file", async () => {
	const vaultPw = "vaultPassword123";
	const { app, files } = createMockApp({
		"a.md": buildLockedNote(await encryptContent("Note A", vaultPw, "vault", 100000)),
	});
	const plugin = new TestEnclavePlugin(app);
	plugin.settings.iterations = 100000;
	plugin.passwordQueue = [vaultPw];
	let writes = 0;
	const saveData = plugin.saveData.bind(plugin);
	plugin.saveData = async (data) => {
		writes++;
		await saveData(data);
	};

	await plugin.unlockNote(files.get("a.md"));
	assert.deepEqual(plugin.getLedger(), [{ path: "a.md", scope: "vault" }]);
	assert.equal("ledger" in plugin.persistedData, false, "the data file has no ledger");
	const writesAfterUnlock = writes;

	await plugin.lockAll(true);
	assert.deepEqual(plugin.getLedger(), []);
	assert.equal(writes, writesAfterUnlock, "locking changed no setting, so the data file wasn't rewritten");
});

test("a ledger left in the data file by an older version is still recovered", async () => {
	const { app } = createMockApp({ "a.md": "Plain text left by a crash" });
	const plugin = new TestEnclavePlugin(app);
	plugin.persistedData = { settings: {}, ledger: [{ path: "a.md", scope: "vault" }] };

	await plugin.loadSettings();
	await plugin.recoverExposedNotes();

	assert.equal(await plugin.api.holdReason("a.md"), "exposed");
	assert.equal("ledger" in plugin.persistedData, false, "the next save drops it from the data file");
});
