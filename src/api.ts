/*
 * The interface Enclave offers other plugins, mainly sync plugins such as
 * Courier, at `app.plugins.getPlugin("enclave").api`.
 *
 * Its purpose is to let a sync plugin upload only what's safe: a note's plain
 * text must never leave the device while Enclave considers it encrypted. The
 * sync plugin asks holdReason() for every note it's about to upload, and can
 * resolve conflicts between locked notes through openForMerge() without ever
 * handling the passwords itself.
 *
 * `version` is bumped on incompatible changes. A caller should check it and,
 * if it doesn't know the version, treat Enclave as unavailable and hold back
 * anything that looks like a locked note turned plain.
 */

/** Why a note must not be uploaded right now. */
export type HoldReason =
	/** Unlocked in this session: its plain text is on disk until it locks again. */
	| "unlocked"
	/** Left unlocked by a crash or force-quit and not secured yet. */
	| "exposed"
	/** Not encrypted, but in a locked folder: Enclave will lock it, or the user decides. */
	| "not-locked-yet";

/** One version of a note in a conflict, as handed to openForMerge(). */
export interface MergeVersion {
	/** How the version is described to the user, e.g. "this device's version". */
	label: string;
	/** The file's text, or null if this side deleted the note. */
	content: string | null;
	/**
	 * Optional versions (the common base) are only decrypted with passwords Enclave
	 * already has; Enclave never asks for them. They come back as null otherwise.
	 */
	optional?: boolean;
}

/** How a locked version was encrypted, without the password. */
export interface LockInfo {
	scope: "vault" | "note";
}

/**
 * The decrypted versions of a conflict, kept only in memory. The passwords that
 * opened them stay inside the session; seal() encrypts the merged text with the
 * password of one of the versions, and close() forgets them all.
 */
export interface MergeSession {
	/** Plain text of each version (null for a deleted side or an optional version that couldn't be opened). */
	texts: (string | null)[];
	/** How each version was locked (null if it wasn't locked). */
	locks: (LockInfo | null)[];
	/** Whether all locked versions share the same password and kind of lock. */
	sameLock: boolean;
	/** Encrypt `text` with the password and kind of lock of version `keep`, returning the locked note. */
	seal(text: string, keep: number): Promise<string>;
	/** Forget the passwords. Called automatically by seal(). */
	close(): void;
}

export interface EnclaveApi {
	readonly version: 1;
	/** Resolves once Enclave has loaded and checked for notes a crash left unlocked. */
	ready(): Promise<void>;
	/** Why the note at `path` must not be uploaded right now, or null if its current content may be. */
	holdReason(path: string): Promise<HoldReason | null>;
	/** Whether `content` is a note locked by Enclave. */
	isLockedContent(content: string): boolean;
	/** Whether the note at `path` was made plain on purpose (permanently decrypted, or left unlocked when asked). */
	isIntentionallyPlain(path: string): boolean;
	/** Lock every unlocked note. Resolves with how many are still unlocked because they couldn't be locked. */
	lockAll(): Promise<number>;
	/** Call `callback` with a note's path whenever Enclave locks it. Returns a function that unsubscribes. */
	onLocked(callback: (path: string) => void): () => void;
	/**
	 * Decrypt the versions of a conflict in memory to merge them. Asks the user for
	 * any password it doesn't have. Resolves null if the user cancels or enters a
	 * wrong password.
	 */
	openForMerge(path: string, versions: MergeVersion[]): Promise<MergeSession | null>;
}

export const API_VERSION = 1 as const;
