import { App, PluginSettingTab, type SettingDefinitionItem } from "obsidian";
import { ConfirmModal } from "./ConfirmModal";
import { DEFAULT_ITERATIONS, type EnclavePayload, type EnclaveScope } from "./crypto";
import type EnclavePlugin from "./main";

/** A folder kept locked: notes moved or created in it are locked with its kind of password. */
export interface ProtectedFolder {
	path: string;
	scope: EnclaveScope;
	/** For a separate-password folder: a check its password is verified against. */
	check?: EnclavePayload;
}

/**
 * Which passwords stay in memory between unlocks: only the vault password (the
 * default: everyday notes open freely, separate passwords are asked for every
 * time), every password, or none.
 */
export type RememberPasswords = "vault" | "all" | "none";

/** The settings that can differ on phones and tablets, as they apply to one device. */
export interface DeviceSettings {
	rememberPasswords: RememberPasswords;
	forgetPasswordMinutes: number;
	autoLockMinutes: number;
}

export interface EnclaveSettings {
	/** PBKDF2 iteration count used when locking new notes. */
	iterations: number;
	/** Re-encrypt an unlocked note automatically when you navigate away. */
	autoLockOnClose: boolean;
	/** Desktop: re-encrypt unlocked notes when Obsidian is minimized or hidden. Mobile always does. */
	lockWhenHidden: boolean;
	/** Hide the properties box on locked notes, which only holds Enclave's own markers. */
	hideLockProperties: boolean;
	/** Re-encrypt unlocked notes after this many minutes of inactivity (0 = off). */
	autoLockMinutes: number;
	/** Forget remembered passwords after this many minutes unused (0 = until quit). */
	forgetPasswordMinutes: number;
	/** Which passwords stay in memory between unlocks. */
	rememberPasswords: RememberPasswords;
	/** Give phones and tablets their own values for the three mobile* settings below. */
	mobileOverrides: boolean;
	mobileRememberPasswords: RememberPasswords;
	mobileForgetPasswordMinutes: number;
	mobileAutoLockMinutes: number;
	/** Verify each note decrypts back to the original before overwriting it. */
	verifyOnLock: boolean;
	/** Folders kept locked, set by locking a folder. */
	protectedFolders: ProtectedFolder[];
	/** A check the vault password is verified against; set when it's first chosen or used. */
	vaultCheck: EnclavePayload | null;
}

export const DEFAULT_SETTINGS: EnclaveSettings = {
	iterations: DEFAULT_ITERATIONS,
	autoLockOnClose: true,
	lockWhenHidden: true,
	hideLockProperties: true,
	// Non-zero by default so a note left open in a background pane (where the
	// navigate-away hook never fires) still re-locks as a backstop.
	autoLockMinutes: 5,
	forgetPasswordMinutes: 30,
	rememberPasswords: "vault",
	mobileOverrides: false,
	mobileRememberPasswords: "vault",
	mobileForgetPasswordMinutes: 30,
	mobileAutoLockMinutes: 5,
	verifyOnLock: true,
	protectedFolders: [],
	vaultCheck: null,
};

export class EnclaveSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: EnclavePlugin
	) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const settings = this.plugin.settings;
		return [
			{
				type: "group",
				heading: "Locking",
				items: [
					{
						name: "Lock when leaving a note",
						desc: "Re-encrypt a note as soon as you switch to another note. Strongly recommended — while a note is unlocked its plaintext is written to disk.",
						control: { type: "toggle", key: "autoLockOnClose" },
					},
					{
						name: "Lock when Obsidian is hidden",
						desc: "Desktop only: re-encrypt unlocked notes when you minimize Obsidian or switch to another space or full-screen app. Quitting Obsidian always locks. On iOS and Android, notes always lock when the app goes to the background, since that's the last reliable moment to do it there.",
						control: { type: "toggle", key: "lockWhenHidden" },
					},
					{
						name: "Auto-lock after inactivity",
						desc: "Minutes a note may stay unlocked before it is re-encrypted. 0 disables the timer.",
						control: {
							type: "number",
							key: "autoLockMinutes",
							placeholder: "5",
							min: 0,
							max: MAX_MINUTES,
							validate: (value) => wholeNumberIn(value, 0, MAX_MINUTES),
						},
					},
					{
						name: "Remember passwords for the session",
						desc: "Which passwords stay in memory after you've entered them. Vault password only: everyday notes open without asking, and notes with a separate password ask every time. Remembered passwords are never written to disk.",
						control: { type: "dropdown", key: "rememberPasswords", options: REMEMBER_OPTIONS },
					},
					{
						name: "Forget passwords after",
						desc: "Minutes remembered passwords stay in memory without being used. After this you'll be asked again. 0 keeps them until Obsidian quits.",
						visible: () => this.plugin.settings.rememberPasswords !== "none",
						control: {
							type: "number",
							key: "forgetPasswordMinutes",
							placeholder: "30",
							min: 0,
							max: MAX_MINUTES,
							validate: (value) => wholeNumberIn(value, 0, MAX_MINUTES),
						},
					},
				],
			},
			{
				type: "group",
				heading: "Phones and tablets",
				items: [
					{
						name: "Use different settings on phones and tablets",
						desc: "Give phones and tablets their own values for remembering passwords and auto-locking; the settings above then apply to desktop only. Both sets are stored in the synced settings, so you can change the mobile values from any device.",
						control: { type: "toggle", key: "mobileOverrides" },
					},
					{
						name: "Remember passwords on mobile",
						desc: "Which passwords stay in memory on phones and tablets after you've entered them.",
						visible: () => this.plugin.settings.mobileOverrides,
						control: { type: "dropdown", key: "mobileRememberPasswords", options: REMEMBER_OPTIONS },
					},
					{
						name: "Forget passwords on mobile after",
						desc: "Minutes remembered passwords stay in memory on phones and tablets without being used. 0 keeps them until Obsidian quits.",
						visible: () =>
							this.plugin.settings.mobileOverrides && this.plugin.settings.mobileRememberPasswords !== "none",
						control: {
							type: "number",
							key: "mobileForgetPasswordMinutes",
							placeholder: "30",
							min: 0,
							max: MAX_MINUTES,
							validate: (value) => wholeNumberIn(value, 0, MAX_MINUTES),
						},
					},
					{
						name: "Auto-lock on mobile after inactivity",
						desc: "Minutes a note may stay unlocked on phones and tablets before it is re-encrypted. 0 disables the timer.",
						visible: () => this.plugin.settings.mobileOverrides,
						control: {
							type: "number",
							key: "mobileAutoLockMinutes",
							placeholder: "5",
							min: 0,
							max: MAX_MINUTES,
							validate: (value) => wholeNumberIn(value, 0, MAX_MINUTES),
						},
					},
				],
			},
			{
				type: "group",
				heading: "Display",
				items: [
					{
						name: "Hide properties of locked notes",
						desc: "Hide the properties box on locked notes. It only shows Enclave's own locked and lock-scope properties; the note's real properties are encrypted with the rest of it.",
						control: { type: "toggle", key: "hideLockProperties" },
					},
				],
			},
			{
				type: "group",
				heading: "Passwords and encryption",
				items: [
					// These two describe the current state, so their text is set while
					// rendering: Obsidian builds the definitions once and re-renders
					// rows each time the tab is shown.
					{
						name: "Vault password",
						desc: "Whether you've chosen a vault password, and a way to change it.",
						render: (setting) => {
							if (!this.plugin.settings.vaultCheck) {
								setting.setDesc(
									"You haven't chosen a vault password yet. You choose it the first time you lock a note with the vault password."
								);
								return;
							}
							setting.setDesc(
								"You've chosen a vault password, so a mistyped one is rejected right away. Change it to choose a new one the next time you lock a note; notes locked with the current one keep opening with it."
							);
							setting.addButton((button) =>
								button
									.setButtonText("Change")
									.setDestructive()
									.onClick(() => void this.changeVaultPassword())
							);
						},
					},
					{
						name: "Passwords in memory",
						desc: "Which passwords are in memory on this device, and a way to lock everything and forget them.",
						render: (setting) => {
							setting.setDesc(this.plugin.rememberedPasswordsSummary());
							setting.addButton((button) =>
								button.setButtonText("Lock and forget").onClick(() => void this.lockAndForget())
							);
						},
					},
					{
						name: "Key derivation iterations",
						desc: "PBKDF2 iterations used when locking new notes. Higher is slower but more resistant to brute force. Existing locked notes keep the value they were locked with.",
						control: {
							type: "number",
							key: "iterations",
							placeholder: String(DEFAULT_ITERATIONS),
							min: MIN_ITERATIONS,
							max: MAX_ITERATIONS,
							validate: (value) => wholeNumberIn(value, MIN_ITERATIONS, MAX_ITERATIONS),
						},
					},
					{
						name: "Verify before overwriting",
						desc: "After encrypting, decrypt the result and confirm it matches the original before replacing the note. Strongly recommended — prevents a faulty lock from destroying content. Roughly doubles lock time.",
						control: { type: "toggle", key: "verifyOnLock" },
					},
					{
						name: "There is no password recovery",
						desc: "If you forget a password, the notes locked with it can't be decrypted. Keep backups of important notes. You can permanently decrypt a note or folder at any time with its password.",
					},
				],
			},
			{
				type: "list",
				heading: "Locked folders",
				emptyState: "None yet. Right-click a folder → Enclave: lock folder.",
				items: settings.protectedFolders.map((folder) => ({
					name: folder.path,
					desc: folder.scope === "note" ? "Separate password" : "Vault password",
				})),
				// Deleting stops locking new notes there; its notes stay as they are.
				onDelete: (index) => void this.unprotect(index),
			},
		];
	}

	/**
	 * Settings live inside the plugin's data file next to its crash-recovery
	 * ledger, so they're saved through the plugin rather than the default, which
	 * would overwrite the whole file with the settings alone.
	 */
	async setControlValue(key: string, value: unknown): Promise<void> {
		this.plugin.settings = { ...this.plugin.settings, [key]: value };
		if (key === "hideLockProperties") this.plugin.applyPropertyHiding();
		if (REMEMBER_KEYS.includes(key)) {
			// A stricter choice forgets what it no longer allows right away.
			this.plugin.applyRememberPolicy();
			this.update();
		}
		await this.plugin.saveSettings();
	}

	private async changeVaultPassword(): Promise<void> {
		const confirmed = await new ConfirmModal(this.app, {
			title: "Change the vault password?",
			message:
				"The next time you lock a note with the vault password, you'll choose a new one. Notes already locked with the current one still open with it, and switch to the new one the next time they lock while you're using it.",
			cta: "Change",
		}).ask();
		if (!confirmed) return;
		await this.plugin.resetVaultCheck();
		this.update();
	}

	private async lockAndForget(): Promise<void> {
		await this.plugin.lockAndForget();
		this.update();
	}

	private async unprotect(index: number): Promise<void> {
		const folder = this.plugin.settings.protectedFolders[index];
		if (!folder) return;
		await this.plugin.unprotectFolder(folder.path);
		this.update();
	}
}

/** Labels for the "remember passwords" choices. */
const REMEMBER_OPTIONS: Record<RememberPasswords, string> = {
	vault: "Vault password only",
	all: "Vault and separate passwords",
	none: "Don't remember",
};

/** Settings that change which passwords may stay in memory on this device, or what's shown. */
const REMEMBER_KEYS = ["rememberPasswords", "mobileOverrides", "mobileRememberPasswords"];

/** Upper bound for the minute settings, so a typo can't mean "practically never". */
const MAX_MINUTES = 100000;
/** Bounds for PBKDF2 iterations: a floor for security, a ceiling so a typo can't freeze locking. */
const MIN_ITERATIONS = 100000;
const MAX_ITERATIONS = 10000000;

/**
 * Validation message unless `value` is a whole number in [min, max]. Invalid
 * input is rejected rather than snapped to a default, since for some fields a
 * wrong default (0) would silently weaken security.
 */
function wholeNumberIn(value: number, min: number, max: number): string | void {
	if (!Number.isInteger(value) || value < min || value > max) {
		return `Enter a whole number from ${min.toLocaleString()} to ${max.toLocaleString()}.`;
	}
}
