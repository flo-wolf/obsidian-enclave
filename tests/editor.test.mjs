import test from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { findPayloadBlock } from "../src/editor.ts";
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
