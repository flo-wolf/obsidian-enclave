import { App, Modal, Setting } from "obsidian";

/** A minimal yes/no confirmation modal. Resolves true on confirm, false otherwise. */
export class ConfirmModal extends Modal {
	private resolver: ((value: boolean) => void) | null = null;
	private confirmed = false;

	constructor(
		app: App,
		private opts: { title: string; message: string; cta?: string }
	) {
		super(app);
	}

	/** Open the modal and wait for the answer: true if confirmed. */
	ask(): Promise<boolean> {
		const answer = new Promise<boolean>((resolve) => {
			this.resolver = resolve;
		});
		this.open();
		return answer;
	}

	onOpen(): void {
		this.titleEl.setText(this.opts.title);
		this.contentEl.createEl("p", { text: this.opts.message });
		let cancelEl: HTMLElement | null = null;
		new Setting(this.contentEl)
			.addButton((btn) => {
				cancelEl = btn.buttonEl;
				btn.setButtonText("Cancel").onClick(() => this.close());
			})
			.addButton((btn) => {
				btn.setButtonText(this.opts.cta ?? "Confirm").setCta();
				btn.onClick(() => {
					this.confirmed = true;
					this.close();
				});
			});
		// Focus Cancel by default: the action is destructive, so an accidental
		// Enter should cancel (activate the focused Cancel button), not confirm.
		// Escape also cancels (Obsidian Modal closes -> resolves false).
		window.setTimeout(() => cancelEl?.focus(), 0);
	}

	onClose(): void {
		this.contentEl.empty();
		if (this.resolver) {
			this.resolver(this.confirmed);
			this.resolver = null;
		}
	}
}
