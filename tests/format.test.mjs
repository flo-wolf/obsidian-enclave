import test from "node:test";
import assert from "node:assert/strict";
import { buildLockedNote, isLocked, parseLockedNote, readScope } from "../src/format.ts";

const PAYLOAD_JSON = JSON.stringify({
	v: 1,
	alg: "AES-GCM",
	kdf: "PBKDF2",
	hash: "SHA-256",
	iterations: 310000,
	salt: "c2FsdA==",
	iv: "aXZpdmk=",
	ct: "Y2lwaGVydGV4dA==",
	scope: "note",
});

test("buildLockedNote generates valid frontmatter, callout, and enclave codeblock", () => {
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
	const locked = buildLockedNote(payload);

	assert.match(locked, /^---\n/);
	assert.match(locked, /^locked: true$/m);
	assert.match(locked, /^lock-scope: vault$/m);
	assert.doesNotMatch(locked, /^(?:locky|locker)(?:-scope)?:/m);
	assert.match(locked, /```enclave\n/);
	assert.ok(isLocked(locked));
	assert.equal(readScope(locked), "vault");

	const parsed = parseLockedNote(locked);
	assert.deepEqual(parsed, payload);
});

test("isLocked recognizes legacy locker format", () => {
	const legacy = [
		"---",
		"locker: true",
		"locker-scope: note",
		"---",
		"",
		"> [!lock]- Encrypted with Lockbox",
		"",
		"```locker",
		JSON.stringify({
			v: 1,
			alg: "AES-GCM",
			kdf: "PBKDF2",
			hash: "SHA-256",
			iterations: 310000,
			salt: "c2FsdA==",
			iv: "aXZpdmk=",
			ct: "Y2lwaGVydGV4dA==",
			scope: "note",
		}),
		"```",
	].join("\n");

	assert.ok(isLocked(legacy));
	assert.equal(readScope(legacy), "note");
	const parsed = parseLockedNote(legacy);
	assert.equal(parsed.scope, "note");
});

test("isLocked recognizes legacy locky format", () => {
	const legacy = ["---", "locky: true", "locker: true", "locky-scope: note", "locker-scope: note", "---", "", "```locky", PAYLOAD_JSON, "```"].join("\n");
	assert.ok(isLocked(legacy));
	assert.equal(readScope(legacy), "note");
});

test("isLocked handles CRLF line endings", () => {
	const content = "---\r\nlocked: true\r\n---\r\n```enclave\r\n{\"v\":1,\"alg\":\"AES-GCM\",\"kdf\":\"PBKDF2\",\"hash\":\"SHA-256\",\"iterations\":310000,\"salt\":\"c2FsdA==\",\"iv\":\"aXZpdmk=\",\"ct\":\"Y2lwaGVydGV4dA==\",\"scope\":\"vault\"}\r\n```\r\n";
	assert.ok(isLocked(content));
});

test("isLocked rejects normal notes with locker keyword in body", () => {
	const content = "# Title\n\nThis mentions locker: true in the body.\n\n```locker\nhello\n```";
	assert.equal(isLocked(content), false);
});

test("isLocked rejects a plain note that merely has a locked property", () => {
	const content = "---\nlocked: true\n---\n\n# Meeting notes\n";
	assert.equal(isLocked(content), false);
});
