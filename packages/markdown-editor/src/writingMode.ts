import { StateEffect, StateField, type EditorState, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";

// Writing mode: focus (every paragraph but the cursor's is dimmed), typewriter
// scrolling (the cursor's line stays centred), and the word counts behind the
// status bar. None of it touches the Markdown.

export type WritingSettings = { focus: boolean; typewriter: boolean };

/** Turn focus dimming or typewriter scrolling on or off in a running editor. */
export const setWriting = StateEffect.define<WritingSettings>();

const writingField = StateField.define<WritingSettings>({
  create: () => ({ focus: false, typewriter: false }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setWriting)) value = e.value;
    return value;
  },
  provide: (f) =>
    EditorView.editorAttributes.from(f, (s) => ({
      class: [s.focus ? "cm-focus-dim" : "", s.typewriter ? "cm-typewriter" : ""].join(" ").trim(),
    })),
});

/** The lines of the paragraph around `pos`: the run of non-blank lines it sits in. */
export function paragraphAt(doc: Text, pos: number): { from: number; to: number } {
  const line = doc.lineAt(pos);
  if (!line.text.trim()) return { from: line.number, to: line.number };
  let from = line.number;
  let to = line.number;
  while (from > 1 && doc.line(from - 1).text.trim()) from--;
  while (to < doc.lines && doc.line(to + 1).text.trim()) to++;
  return { from, to };
}

const currentPara = Decoration.line({ class: "cm-focus-para" });

function paragraphDecorations(state: EditorState): DecorationSet {
  if (!state.field(writingField).focus) return Decoration.none;
  const { from, to } = paragraphAt(state.doc, state.selection.main.head);
  const ranges = [];
  for (let n = from; n <= to; n++) ranges.push(currentPara.range(state.doc.line(n).from));
  return Decoration.set(ranges);
}

const focusDim = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = paragraphDecorations(view.state);
    }
    update(update: ViewUpdate) {
      const toggled = update.startState.field(writingField) !== update.state.field(writingField);
      if (toggled || update.docChanged || update.selectionSet) this.decorations = paragraphDecorations(update.state);
    }
  },
  { decorations: (v) => v.decorations },
);

/** Your own typing and cursor moves keep the line centred; a collaborator's edits don't scroll you. */
const typewriter = EditorView.updateListener.of((update) => {
  if (!update.state.field(writingField).typewriter) return;
  const local = update.transactions.some((tr) => tr.selection || tr.isUserEvent("input") || tr.isUserEvent("delete"));
  if (!local) return;
  const head = update.state.selection.main.head;
  // Scrolling is a new transaction, so it has to wait for this update to finish.
  queueMicrotask(() => {
    if (update.view.state.selection.main.head === head) update.view.dispatch({ effects: EditorView.scrollIntoView(head, { y: "center" }) });
  });
});

const writingTheme = EditorView.theme({
  "&.cm-focus-dim .cm-content > *": { opacity: "0.28", transition: "opacity 0.2s ease" },
  "&.cm-focus-dim .cm-content > .cm-focus-para": { opacity: "1" },
  // Room above the first line too, so it can sit in the middle of the screen.
  "&.cm-typewriter .cm-content": { paddingTop: "40vh" },
});

export function writingMode(initial?: WritingSettings): Extension {
  return [initial ? writingField.init(() => initial) : writingField, focusDim, typewriter, writingTheme];
}

// ------------------------------------------------------------------ counts

const WORD = /[\p{L}\p{N}]+(?:['’.\-][\p{L}\p{N}]+)*/gu;

/** Words in Markdown, leaving out link targets, image addresses and HTML comments. */
export function countWords(text: string): number {
  const prose = text.replace(/<!--[\s\S]*?-->/g, " ").replace(/\]\([^)\s]*(?:\s+"[^"]*")?\)/g, "] ");
  return prose.match(WORD)?.length ?? 0;
}

/** Characters as people count them: one per code point, so an emoji is one. */
export function countChars(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

/** Minutes to read, at about 230 words a minute; at least one when there are any words. */
export function readingMinutes(words: number): number {
  return words === 0 ? 0 : Math.max(1, Math.round(words / 230));
}

export type SelectionStats = { words: number; chars: number } | null;

/**
 * Reports what's selected, and the words you add or remove yourself, so the
 * day's goal only counts your own writing and not a collaborator's.
 */
export function writingStats(handlers: { onSelection: (s: SelectionStats) => void; onWritten: (delta: number) => void }): Extension {
  return ViewPlugin.fromClass(
    class {
      words: number;
      constructor(view: EditorView) {
        this.words = countWords(view.state.doc.toString());
      }
      update(update: ViewUpdate) {
        if (update.docChanged) {
          const words = countWords(update.state.doc.toString());
          const mine = update.transactions.some((tr) => tr.docChanged && (tr.isUserEvent("input") || tr.isUserEvent("delete") || tr.isUserEvent("move")));
          if (mine && words !== this.words) handlers.onWritten(words - this.words);
          this.words = words;
        }
        if (update.selectionSet || update.docChanged) {
          const sel = update.state.selection.main;
          if (sel.empty) handlers.onSelection(null);
          else {
            const text = update.state.sliceDoc(sel.from, sel.to);
            handlers.onSelection({ words: countWords(text), chars: countChars(text) });
          }
        }
      }
    },
  );
}
