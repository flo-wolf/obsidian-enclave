import test from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { findPayloadBlock, LOCKED_CLASS, lockedNoteReadOnly } from "../src/editor.ts";
import { buildLockedNote } from "../src/format.ts";

const payload = {
	v: 1,
	alg: "AES-GCM",
	kdf: "PBKDF2",
	hash: "SHA-256",
	iterations: 310000,
	salt: "c2FsdA==",
	iv: "aXZpdmk=",
	ct: "Y2lwaGVydGV4dA==",
	scope: "vault",
};

test("findPayloadBlock covers the payload block of a locked note, fences included", () => {
	const doc = buildLockedNote(payload);
	const block = findPayloadBlock(EditorState.create({ doc }));
	assert.ok(block);
	assert.equal(doc.slice(block.from, block.to), "```enclave\n" + JSON.stringify(payload) + "\n```");
	assert.deepEqual(JSON.parse(block.source), payload);
});

test("findPayloadBlock accepts a blank line between the frontmatter and the block", () => {
	const doc = buildLockedNote(payload).replace("---\n```", "---\n\n```");
	assert.ok(findPayloadBlock(EditorState.create({ doc })));
});

test("findPayloadBlock ignores notes that aren't locked", () => {
	const plain = "---\ntags: [a]\n---\n```enclave\n{}\n```\n";
	const markerOnly = "---\nlocked: true\n---\n\n# Just a note\n";
	assert.equal(findPayloadBlock(EditorState.create({ doc: plain })), null);
	assert.equal(findPayloadBlock(EditorState.create({ doc: markerOnly })), null);
	assert.equal(findPayloadBlock(EditorState.create({ doc: "Hello" })), null);
});

test("lockedNoteReadOnly refuses the user's edits to a locked note", () => {
	let blocked = 0;
	const state = EditorState.create({
		doc: buildLockedNote(payload),
		extensions: [lockedNoteReadOnly(() => blocked++)],
	});
	for (const userEvent of ["input.type", "input.paste", "delete.backward", "move.drop", "undo"]) {
		const next = state.update({ changes: { from: state.doc.length, insert: "typed" }, userEvent }).state;
		assert.equal(next.doc.toString(), state.doc.toString(), userEvent);
	}
	assert.equal(blocked, 5);
});

test("lockedNoteReadOnly lets programmatic changes and unlocked notes through", () => {
	const locked = EditorState.create({
		doc: buildLockedNote(payload),
		extensions: [lockedNoteReadOnly(() => {})],
	});
	// Enclave unlocking the note replaces the whole text without a user event.
	const unlocked = locked.update({ changes: { from: 0, to: locked.doc.length, insert: "Plain text" } }).state;
	assert.equal(unlocked.doc.toString(), "Plain text");

	// Once it's plain text, typing works.
	const typed = unlocked.update({ changes: { from: unlocked.doc.length, insert: "!" }, userEvent: "input.type" }).state;
	assert.equal(typed.doc.toString(), "Plain text!");
});

test("lockedNoteReadOnly makes only a locked note's text non-editable", () => {
	const extensions = [lockedNoteReadOnly(() => {})];
	const editable = (doc) =>
		!EditorState.create({ doc, extensions })
			.facet(EditorView.contentAttributes)
			.some((attrs) => attrs.contenteditable === "false");

	assert.equal(editable(buildLockedNote(payload)), false);
	assert.equal(editable("---\ntags: [a]\n---\nPlain note"), true);

	// The attribute follows the document: unlocking makes the note editable again.
	const locked = EditorState.create({ doc: buildLockedNote(payload), extensions });
	const unlocked = locked.update({ changes: { from: 0, to: locked.doc.length, insert: "Plain text" } }).state;
	assert.equal(unlocked.facet(EditorView.contentAttributes).some((a) => a.contenteditable === "false"), false);
});

test("lockedNoteReadOnly marks a locked note's editor so its cursor can be hidden", () => {
	const extensions = [lockedNoteReadOnly(() => {})];
	const marked = (doc) =>
		EditorState.create({ doc, extensions })
			.facet(EditorView.editorAttributes)
			.some((attrs) => attrs.class === LOCKED_CLASS);

	assert.equal(marked(buildLockedNote(payload)), true);
	assert.equal(marked("Plain note"), false);
});
