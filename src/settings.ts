import { App, PluginSettingTab, Setting } from "obsidian";
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

export interface EnclaveSettings {
	/** PBKDF2 iteration count used when locking new notes. */
	iterations: number;
	/** Re-encrypt an unlocked note automatically when you navigate away. */
	autoLockOnClose: boolean;
	/** Re-encrypt unlocked notes after this many minutes of inactivity (0 = off). */
	autoLockMinutes: number;
	/** Forget the cached vault password after this many minutes (0 = until quit). */
	forgetPasswordMinutes: number;
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
	// Non-zero by default so a note left open in a background pane (where the
	// navigate-away hook never fires) still re-locks as a backstop.
	autoLockMinutes: 5,
	forgetPasswordMinutes: 30,
	verifyOnLock: true,
	protectedFolders: [],
	vaultCheck: null,
};

export class EnclaveSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: EnclavePlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Auto-lock on close")
			.setDesc(
				"Re-encrypt a note as soon as you navigate away from it. Strongly recommended — while a note is unlocked its plaintext is written to disk."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoLockOnClose).onChange(async (value) => {
					this.plugin.settings.autoLockOnClose = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Auto-lock after inactivity")
			.setDesc("Minutes a note may stay unlocked before it is re-encrypted. 0 disables the timer.")
			.addText((text) => {
				text
					.setPlaceholder("5")
					.setValue(String(this.plugin.settings.autoLockMinutes))
					.onChange(async (value) => {
						const n = parseBoundedInt(value, 0, 100000);
						if (n === null) return; // ignore invalid/partial input; keep prior value
						this.plugin.settings.autoLockMinutes = n;
						await this.plugin.saveSettings();
					});
				// On blur, snap back to the saved value so invalid input is visibly rejected.
				text.inputEl.addEventListener("blur", () =>
					text.setValue(String(this.plugin.settings.autoLockMinutes))
				);
			});

		new Setting(containerEl)
			.setName("Forget vault password after")
			.setDesc(
				"Minutes the vault password stays cached in memory. After this you'll be asked again on the next unlock. 0 keeps it until Obsidian quits."
			)
			.addText((text) => {
				text
					.setPlaceholder("30")
					.setValue(String(this.plugin.settings.forgetPasswordMinutes))
					.onChange(async (value) => {
						// Crucially, do NOT collapse invalid input to 0 — that would
						// silently switch off password expiry (a security downgrade).
						const n = parseBoundedInt(value, 0, 100000);
						if (n === null) return;
						this.plugin.settings.forgetPasswordMinutes = n;
						await this.plugin.saveSettings();
					});
				text.inputEl.addEventListener("blur", () =>
					text.setValue(String(this.plugin.settings.forgetPasswordMinutes))
				);
			});

		new Setting(containerEl)
			.setName("Key derivation iterations")
			.setDesc(
				"PBKDF2 iterations used when locking new notes. Higher is slower but more resistant to brute force. Existing locked notes keep the value they were locked with."
			)
			.addText((text) => {
				text
					.setPlaceholder(String(DEFAULT_ITERATIONS))
					.setValue(String(this.plugin.settings.iterations))
					.onChange(async (value) => {
						// Reject sub-floor / absurd values rather than snapping silently;
						// an upper bound prevents a typo from freezing the UI on next lock.
						const n = parseBoundedInt(value, 100000, 10000000);
						if (n === null) return;
						this.plugin.settings.iterations = n;
						await this.plugin.saveSettings();
					});
				text.inputEl.addEventListener("blur", () =>
					text.setValue(String(this.plugin.settings.iterations))
				);
			});

		new Setting(containerEl)
			.setName("Verify before overwriting")
			.setDesc(
				"After encrypting, decrypt the result and confirm it matches the original before replacing the note. Strongly recommended — prevents a faulty lock from destroying content. Roughly doubles lock time."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.verifyOnLock).onChange(async (value) => {
					this.plugin.settings.verifyOnLock = value;
					await this.plugin.saveSettings();
				})
			);

		const vaultPassword = new Setting(containerEl)
			.setName("Vault password")
			.setDesc(
				this.plugin.settings.vaultCheck
					? "Set. A mistyped vault password is rejected right away. Forget it to choose a new vault password the next time you lock a note; notes already locked keep needing the current one."
					: "Not set yet. You choose it the first time you lock a note with the vault password."
			);
		if (this.plugin.settings.vaultCheck) {
			vaultPassword.addButton((button) =>
				button
					.setButtonText("Forget")
					.setWarning()
					.onClick(async () => {
						const confirmed = await new ConfirmModal(this.app, {
							title: "Forget the vault password?",
							message:
								"Enclave will accept the next vault password you enter as the new one. Notes already locked with the current vault password still need it to unlock.",
							cta: "Forget",
						}).open();
						if (!confirmed) return;
						await this.plugin.resetVaultCheck();
						this.display();
					})
			);
		}

		new Setting(containerEl)
			.setName("Locked folders")
			.setDesc(
				"Folders you've locked. A note moved into one is offered to be locked with the folder's password; a note created in one is locked when you leave it. Permanently decrypting a folder removes it from this list."
			)
			.setHeading();
		if (this.plugin.settings.protectedFolders.length === 0) {
			containerEl.createEl("p", {
				cls: "setting-item-description",
				text: "None yet. Right-click a folder → Enclave: lock folder.",
			});
		}
		for (const folder of this.plugin.settings.protectedFolders) {
			new Setting(containerEl)
				.setName(folder.path)
				.setDesc(folder.scope === "note" ? "Separate password" : "Vault password")
				.addExtraButton((button) =>
					button
						.setIcon("x")
						.setTooltip("Stop locking new notes in this folder. Its notes stay as they are.")
						.onClick(async () => {
							await this.plugin.unprotectFolder(folder.path);
							this.display();
						})
				);
		}

		const warn = containerEl.createEl("div", { cls: "enclave-settings-warning" });
		warn.createEl("strong", { text: "Heads up: " });
		warn.appendText(
			"There is no password recovery. If you forget a password, the encrypted note cannot be decrypted. Keep backups of important notes. You can permanently decrypt a note or vault at any time with its password to permanently remove encryption."
		);
	}
}

/**
 * Parse an integer within [min, max]. Returns null for empty/invalid/out-of-range
 * input so callers can leave the previous (valid) value untouched rather than
 * snapping to a default — important because for some fields a wrong default (0)
 * silently weakens security.
 */
function parseBoundedInt(value: string, min: number, max: number): number | null {
	if (!/^\d+$/.test(value.trim())) return null;
	const n = Number.parseInt(value, 10);
	if (!Number.isInteger(n) || n < min || n > max) return null;
	return n;
}
