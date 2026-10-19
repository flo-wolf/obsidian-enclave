/*
 * On-disk format for a locked note.
 *
 * A locked note remains a valid `.md` file so its title stays visible in the
 * file explorer and it continues to participate in links and the graph. The
 * original file contents (including any of the note's own frontmatter) are
 * encrypted wholesale and embedded in a fenced ```enclave block. A small
 * frontmatter marker plus a human-readable callout sit above it so the file
 * reads sensibly in preview mode and is easy to detect.
 *
 * Layout:
 *
 *   ---
 *   locked: true
 *   lock-scope: vault
 *   ---
 *
 *   > [!lock]- Encrypted with Enclave
 *   > Run "Enclave: Unlock note" (or click the ribbon) to decrypt.
 *
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
 *  - Notes written by Locky (`locky`, `locky-scope`, ```locky) and Lockbox
 *    (`locker`, `locker-scope`, ```locker) are still detected and read. They are
 *    never written; such a note switches to this format the next time it is locked.
 */

import type { EnclavePayload, EnclaveScope } from "./crypto";

/** Fence languages recognized as a payload block. The first one is written. */
export const FENCE_LANGS = ["enclave", "locky", "locker"] as const;

const FENCE_RE = new RegExp("```(?:" + FENCE_LANGS.join("|") + ")[^\\n]*\\n([\\s\\S]*?)\\n```");
const MARKER_RE = /^(?:locked|locky|locker):\s*true\s*$/m;
const SCOPE_RE = /^(?:lock|locky|locker)-scope:\s*(vault|note)\s*$/m;

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
		"",
		"> [!lock]- 🔒 Encrypted with Enclave",
		`> This note is locked${
			payload.scope === "note" ? " with its own password" : ""
		}. Run **Enclave: Unlock note** (or click the ribbon lock icon) to decrypt it.`,
		"",
		"```" + FENCE_LANGS[0],
		json,
		"```",
		"",
	].join("\n");
}

/** Returns true if the file content is an encrypted note (Enclave or legacy format). */
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
