/*
 * On-disk format for a locked note.
 *
 * A locked note remains a valid `.md` file so its title stays visible in the
 * file explorer and it continues to participate in links and the graph. The
 * original file contents (including any of the note's own frontmatter) are
 * encrypted wholesale and embedded in a fenced ```enclave block, with a small
 * frontmatter marker above it so the note is easy to detect. In Obsidian the
 * block renders as an "unlock" card (see renderLockedCard in main.ts).
 *
 * Layout:
 *
 *   ---
 *   locked: true
 *   lock-scope: vault
 *   ---
 *   ```enclave
 *   {"v":1,...}
 *   ```
 *
 * Robustness notes:
 *  - All detection/parsing normalizes CRLF -> LF first, so notes touched by
 *    Windows editors or sync clients are still recognized (otherwise a user can
 *    be locked out of their own ciphertext).
 *  - Locked-note detection requires the `locked: true` marker to live in the
 *    file's ACTUAL leading YAML frontmatter (anchored at offset 0), not just
 *    anywhere a `---`/`---` pair happens to appear in the body, AND a parseable
 *    payload block. A plain note that happens to use a `locked` property is
 *    therefore never misdetected as encrypted.
 */

import type { EnclavePayload, EnclaveScope } from "./crypto";

/** Language of the fenced block that holds the encrypted payload. */
export const FENCE_LANG = "enclave";

const FENCE_RE = /```enclave[^\n]*\n([\s\S]*?)\n```/;
const MARKER_RE = /^locked:\s*true\s*$/m;
const SCOPE_RE = /^lock-scope:\s*(vault|note)\s*$/m;

/** Collapse CRLF/CR line endings to LF for stable detection and parsing. */
function normalize(content: string): string {
	return content.replace(/\r\n?/g, "\n");
}

/** Extract the file's leading YAML frontmatter block, or null if none. */
function leadingFrontmatter(content: string): string | null {
	const m = normalize(content).match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
	return m ? m[1] : null;
}

export function buildLockedNote(payload: EnclavePayload): string {
	const json = JSON.stringify(payload);
	return [
		"---",
		"locked: true",
		`lock-scope: ${payload.scope}`,
		"---",
		"```" + FENCE_LANG,
		json,
		"```",
		"",
	].join("\n");
}

/** Returns true if the file content is an Enclave-encrypted note. */
export function isLocked(content: string): boolean {
	const fm = leadingFrontmatter(content);
	if (!fm || !MARKER_RE.test(fm)) return false;
	return parseLockedNote(content) !== null;
}

/**
 * Extract the encrypted payload from a locked note. Returns null if the
 * content is not a valid locked note or the payload cannot be parsed.
 */
export function parseLockedNote(content: string): EnclavePayload | null {
	const match = normalize(content).match(FENCE_RE);
	if (!match) return null;
	try {
		const payload = JSON.parse(match[1].trim()) as EnclavePayload;
		if (
			payload &&
			payload.alg === "AES-GCM" &&
			typeof payload.ct === "string" &&
			payload.ct.length > 0 &&
			typeof payload.salt === "string" &&
			typeof payload.iv === "string"
		) {
			return payload;
		}
		return null;
	} catch {
		return null;
	}
}

/** Best-effort read of the declared scope from the leading frontmatter. */
export function readScope(content: string): EnclaveScope {
	const fm = leadingFrontmatter(content);
	const m = fm?.match(SCOPE_RE);
	return m && m[1] === "note" ? "note" : "vault";
}
