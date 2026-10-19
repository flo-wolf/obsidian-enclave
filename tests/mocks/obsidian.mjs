export class App {}

export class Plugin {
	constructor(app, manifest) {
		this.app = app;
		this.manifest = manifest;
	}
	addSettingTab() {}
	addRibbonIcon() {
		return {
			toggleClass: () => {},
			setAttribute: () => {},
		};
	}
	registerMarkdownCodeBlockProcessor() {}
	registerEditorExtension() {}
	addStatusBarItem() {
		return {
			addClass: () => {},
			addEventListener: () => {},
			empty: () => {},
			createSpan: () => ({ setText: () => {} }),
			toggleClass: () => {},
			setAttribute: () => {},
		};
	}
	registerCommands() {}
	addCommand() {}
	registerEvents() {}
	registerEvent() {}
	registerInterval() {}
	registerDomEvent() {}
	loadData() { return Promise.resolve(null); }
	saveData() { return Promise.resolve(); }
}

export class TAbstractFile {
	constructor(path = "") {
		this.path = path;
		this.name = path.split("/").pop() || "";
	}
}

export class TFile extends TAbstractFile {
	constructor(path = "", content = "") {
		super(path);
		this.basename = this.name.replace(/\.[^/.]+$/, "");
		this.extension = "md";
		this.content = content;
	}
}

export class TFolder extends TAbstractFile {
	constructor(path = "") {
		super(path);
	}
	isRoot() {
		return this.path === "" || this.path === "/";
	}
}

export class Notice {
	constructor(message, duration) {
		this.message = message;
		this.duration = duration;
	}
	hide() {}
}

export class Menu {
	addItem(fn) {
		const item = {
			setTitle: () => item,
			setIcon: () => item,
			onClick: (cb) => { item._cb = cb; return item; },
		};
		fn(item);
		return this;
	}
}

export class MarkdownView {
	constructor(file, content) {
		this.file = file;
		this.editor = {
			getValue: () => this.file.content,
			setValue: (val) => { this.file.content = val; },
		};
	}
}

export function setIcon(el, iconId) {}

export class Modal {
	constructor(app) {
		this.app = app;
		this.titleEl = { setText: () => {} };
		this.contentEl = {
			empty: () => {},
			createEl: () => ({ setText: () => {} }),
			createDiv: () => ({ createDiv: () => ({}), createSpan: () => ({ setText: () => {} }) }),
			querySelector: () => null,
		};
	}
	open() {}
	close() {}
}

export class Setting {
	constructor(containerEl) {}
	setName() { return this; }
	setDesc() { return this; }
	addToggle() { return this; }
	addText() { return this; }
	addButton() { return this; }
}

export class PluginSettingTab {
	constructor(app, plugin) {
		this.app = app;
		this.plugin = plugin;
	}
}

// Editor state fields Obsidian adds to every Markdown editor. Never present in
// test editor states, so lookups with `require: false` return undefined.
export const editorInfoField = {};
export const editorLivePreviewField = {};
