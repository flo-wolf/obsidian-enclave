import test from "node:test";
import assert from "node:assert/strict";
import EnclavePlugin from "../src/main.ts";
import { isLocked, buildLockedNote } from "../src/format.ts";
import { encryptContent } from "../src/crypto.ts";
import { TFile, TFolder } from "obsidian";

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

	// Expose internals for verification in tests
	getUnlockedMap() {
		return this.unlocked;
	}

	getLedger() {
		return this.persistedData?.ledger ?? [];
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
	assert.deepEqual(plugin.settings.protectedFolders, [{ path: "private", scope: "note" }]);

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
	assert.deepEqual(plugin.settings.protectedFolders, [{ path: "private", scope: "note" }]);
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
