/*
 * Editor support for locked notes.
 *
 * In Live Preview, Obsidian shows a code block's source whenever the cursor is
 * inside it — and when a note opens, the cursor lands on the first line of the
 * body, which in a locked note is the payload block. lockedCardExtension
 * replaces the block with the unlock card as an atomic range, so the cursor
 * can't enter it and the card is always what you see. Source mode is left
 * alone, so the raw block is still visible there.
 *
 * lockedNoteReadOnly keeps the user from typing into a locked note, in either mode.
 */

import { EditorState, Prec, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { editorInfoField, editorLivePreviewField } from "obsidian";
import { FENCE_LANG } from "./format";

/** Draws the unlock card into `el` for the note at `path`. */
export type CardRenderer = (el: HTMLElement, source: string, path: string | null) => void;

/** How far into the frontmatter to look for the `locked` marker. */
const MAX_FRONTMATTER_LINES = 50;

/**
 * The payload block of a locked note: from its opening fence to its closing
 * fence, plus the payload JSON. Null if `state` isn't a locked note. Only reads
 * the lines it needs, since this runs on every edit of every note.
 */
export function findPayloadBlock(state: EditorState): { from: number; to: number; source: string } | null {
	const doc = state.doc;
	if (doc.lines < 4 || doc.line(1).text !== "---") return null;

	let close = 2;
	let marked = false;
	for (; close <= Math.min(doc.lines, MAX_FRONTMATTER_LINES); close++) {
		const text = doc.line(close).text;
		if (text === "---") break;
		if (/^locked:\s*true\s*$/.test(text)) marked = true;
	}
	if (!marked || close > doc.lines || doc.line(close).text !== "---") return null;

	let open = close + 1;
	while (open <= doc.lines && doc.line(open).text.trim() === "") open++;
	if (open > doc.lines || !doc.line(open).text.startsWith("```" + FENCE_LANG)) return null;

	let end = open + 1;
	while (end <= doc.lines && doc.line(end).text !== "```") end++;
	if (end > doc.lines) return null;

	return {
		from: doc.line(open).from,
		to: doc.line(end).to,
		source: doc.sliceString(doc.line(open).to, doc.line(end).from).trim(),
	};
}

class CardWidget extends WidgetType {
	constructor(
		readonly source: string,
		readonly path: string | null,
		private readonly render: CardRenderer
	) {
		super();
	}

	eq(other: CardWidget): boolean {
		return other.source === this.source && other.path === this.path;
	}

	toDOM(): HTMLElement {
		const el = document.createElement("div");
		this.render(el, this.source, this.path);
		return el;
	}

	/** Let the Unlock button handle its own clicks instead of the editor. */
	ignoreEvent(): boolean {
		return true;
	}
}

/** Editor extension that shows locked notes' payload block as the unlock card in Live Preview. */
export function lockedCardExtension(render: CardRenderer) {
	const build = (state: EditorState): DecorationSet => {
		if (!state.field(editorLivePreviewField, false)) return Decoration.none;
		const block = findPayloadBlock(state);
		if (!block) return Decoration.none;
		const path = state.field(editorInfoField, false)?.file?.path ?? null;
		return Decoration.set(
			Decoration.replace({ widget: new CardWidget(block.source, path, render), block: true }).range(
				block.from,
				block.to
			)
		);
	};

	const field = StateField.define<DecorationSet>({
		create: build,
		update: (decorations, tr) =>
			tr.docChanged ||
			tr.startState.field(editorLivePreviewField, false) !== tr.state.field(editorLivePreviewField, false)
				? build(tr.state)
				: decorations,
		provide: (f) => [EditorView.decorations.from(f), EditorView.atomicRanges.of((view) => view.state.field(f))],
	});

	// Highest precedence so this card wins over Obsidian's own rendering of the block.
	return Prec.highest(field);
}

/** User actions that change the text: typing, deleting, pasting, dropping, moving text, undo and redo. */
const EDIT_EVENTS = ["input", "delete", "move", "undo", "redo"];

/**
 * Editor extension that refuses edits the user makes to a locked note, so nothing
 * gets typed into the encrypted file (where unlocking would silently drop it).
 * Changes without a user event, such as Enclave unlocking the note or Obsidian
 * reloading it after a sync, still go through.
 */
export function lockedNoteReadOnly(onBlocked: () => void) {
	return EditorState.changeFilter.of((tr) => {
		if (!tr.docChanged || !EDIT_EVENTS.some((event) => tr.isUserEvent(event))) return true;
		if (!findPayloadBlock(tr.startState)) return true;
		onBlocked();
		return false;
	});
}
