import { codeFolding, foldable, foldedRanges, foldEffect, foldKeymap, foldState, syntaxTree, unfoldEffect } from "@codemirror/language";
import { type EditorState, type Extension, Prec, type Range, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { newBookmarkId } from "./fileState";

// The editor side of bookmarks and folds. Bookmarks live in a state field as
// line starts, mapped through every edit (yours and other people's), and are
// drawn as a ribbon in the right margin. Headings get a fold toggle in the
// left margin. Neither touches the text.

export type Mark = { id: string; pos: number; note: string; created_at: string };

export const setBookmarks = StateEffect.define<Mark[]>();

const byPos = (a: Mark, b: Mark) => a.pos - b.pos;

export const bookmarkField = StateField.define<Mark[]>({
  create: () => [],
  update(marks, tr) {
    for (const effect of tr.effects) if (effect.is(setBookmarks)) return effect.value;
    if (!tr.docChanged || marks.length === 0) return marks;
    // Follow the text: a line pushed down by Enter at its start takes its bookmark with it.
    return marks.map((m) => ({ ...m, pos: tr.state.doc.lineAt(tr.changes.mapPos(m.pos, 1)).from })).sort(byPos);
  },
  provide: (field) =>
    EditorView.decorations.from(field, (marks) =>
      Decoration.set(
        marks.map((m) =>
          Decoration.line({
            class: "cm-bookmarked",
            attributes: { "data-bookmark": m.id, ...(m.note ? { title: m.note } : {}) },
          }).range(m.pos),
        ),
        true,
      ),
    ),
});

/** The bookmarks after bookmarking (or un-bookmarking) the cursor's line. */
export function toggledBookmarks(state: EditorState): Mark[] {
  const line = state.doc.lineAt(state.selection.main.head);
  const marks = state.field(bookmarkField);
  if (marks.some((m) => m.pos === line.from)) return marks.filter((m) => m.pos !== line.from);
  return [...marks, { id: newBookmarkId(), pos: line.from, note: "", created_at: new Date().toISOString() }].sort(byPos);
}

export function toggleBookmark(view: EditorView): boolean {
  view.dispatch({ effects: setBookmarks.of(toggledBookmarks(view.state)) });
  return true;
}

/** Moves the cursor to `pos`, opening any fold that hides it. */
export function goTo(view: EditorView, pos: number): void {
  const effects: StateEffect<unknown>[] = [];
  foldedRanges(view.state).between(pos, pos + 1, (from, to) => {
    if (from <= pos && to >= pos) effects.push(unfoldEffect.of({ from, to }));
  });
  view.dispatch({ effects: [...effects, EditorView.scrollIntoView(pos, { y: "center" })], selection: { anchor: pos } });
  view.focus();
}

/** The next (or previous) bookmark after the cursor's line, wrapping round. */
export function nextBookmark(state: EditorState, dir: 1 | -1): Mark | null {
  const marks = state.field(bookmarkField);
  if (marks.length === 0) return null;
  const here = state.doc.lineAt(state.selection.main.head).from;
  if (dir === 1) return marks.find((m) => m.pos > here) ?? marks[0];
  return [...marks].reverse().find((m) => m.pos < here) ?? marks[marks.length - 1];
}

function jump(dir: 1 | -1) {
  return (view: EditorView) => {
    const mark = nextBookmark(view.state, dir);
    if (mark) goTo(view, mark.pos);
    return mark !== null;
  };
}

// ---------------------------------------------------------------- folds

/** The start of each folded section's first line. */
export function foldedLineStarts(state: EditorState): number[] {
  const starts: number[] = [];
  foldedRanges(state).between(0, state.doc.length, (from) => {
    starts.push(state.doc.lineAt(from).from);
  });
  return starts;
}

/** Folds that fold the lines starting at `starts`, where they can still be folded. */
export function foldsAt(state: EditorState, starts: number[]): StateEffect<unknown>[] {
  const effects: StateEffect<unknown>[] = [];
  for (const start of starts) {
    const line = state.doc.lineAt(start);
    const range = foldable(state, line.from, line.to);
    if (range) effects.push(foldEffect.of(range));
  }
  return effects;
}

class FoldToggle extends WidgetType {
  constructor(readonly folded: boolean) {
    super();
  }

  eq(other: FoldToggle) {
    return other.folded === this.folded;
  }

  toDOM(view: EditorView) {
    const button = document.createElement("span");
    button.className = `cm-fold-toggle${this.folded ? " folded" : ""}`;
    button.setAttribute("role", "button");
    button.setAttribute("aria-label", this.folded ? "Unfold section" : "Fold section");
    button.title = this.folded ? "Unfold section" : "Fold section";
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const line = view.state.doc.lineAt(view.posAtDOM(button));
      const open: StateEffect<unknown>[] = [];
      foldedRanges(view.state).between(line.from, line.to + 1, (from, to) => {
        if (view.state.doc.lineAt(from).number === line.number) open.push(unfoldEffect.of({ from, to }));
      });
      view.dispatch({ effects: open.length ? open : foldsAt(view.state, [line.from]) });
    });
    return button;
  }

  ignoreEvent() {
    return true;
  }
}

function headingToggles(view: EditorView): DecorationSet {
  const { state } = view;
  const folded = new Set(foldedLineStarts(state));
  const ranges: Range<Decoration>[] = [];
  const seen = new Set<number>();
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        if (!/^(ATX|Setext)Heading\d$/.test(node.name)) return;
        const line = state.doc.lineAt(node.from);
        if (seen.has(line.from)) return false;
        seen.add(line.from);
        const isFolded = folded.has(line.from);
        if (isFolded || foldable(state, line.from, line.to)) {
          ranges.push(Decoration.line({ class: "cm-foldable" }).range(line.from));
          ranges.push(Decoration.widget({ widget: new FoldToggle(isFolded), side: -1 }).range(line.from));
        }
        return false;
      },
    });
  }
  return Decoration.set(ranges, true);
}

const foldToggles = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = headingToggles(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state) ||
        update.startState.field(foldState, false) !== update.state.field(foldState, false)
      )
        this.decorations = headingToggles(update.view);
    }
  },
  { decorations: (v) => v.decorations },
);

const placeTheme = EditorView.baseTheme({
  ".cm-bookmarked, .cm-foldable": { position: "relative" },
  ".cm-bookmarked::after": {
    content: '""',
    position: "absolute",
    right: "-1.15rem",
    top: "0.35em",
    width: "8px",
    height: "12px",
    background: "var(--accent)",
    clipPath: "polygon(0 0, 100% 0, 100% 100%, 50% 72%, 0 100%)",
    pointerEvents: "none",
  },
  ".cm-fold-toggle": {
    position: "absolute",
    left: "-1.3rem",
    top: "0",
    bottom: "0",
    width: "1.1rem",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    color: "var(--muted)",
    opacity: "0",
    transition: "opacity 120ms",
    fontFamily: "var(--font-sans)",
    fontSize: "12px",
  },
  ".cm-fold-toggle::before": { content: '"▾"' },
  ".cm-fold-toggle.folded::before": { content: '"▸"' },
  ".cm-line:hover > .cm-fold-toggle, .cm-fold-toggle.folded, .cm-fold-toggle:focus-visible": { opacity: "1" },
  ".cm-foldPlaceholder": {
    border: "0",
    borderRadius: "4px",
    padding: "0 0.4em",
    margin: "0 0.3em",
    background: "var(--surface-2)",
    color: "var(--muted)",
    cursor: "pointer",
  },
});

export type PlaceHandlers = {
  /** Something worth remembering changed. `now` for bookmarks and folds, which shouldn't be lost. */
  onChange: (now: boolean) => void;
};

/**
 * Bookmarks (Mod-Shift-B to toggle, F2 / Shift-F2 to move between them) and,
 * when `folds`, heading fold toggles plus CodeMirror's fold keys.
 */
export function editorPlace(handlers: { current: PlaceHandlers }, folds: boolean): Extension {
  return [
    bookmarkField,
    Prec.high(
      keymap.of([
        { key: "Mod-Shift-b", run: toggleBookmark, preventDefault: true },
        { key: "F2", run: jump(1) },
        { key: "Shift-F2", run: jump(-1) },
      ]),
    ),
    folds ? [codeFolding({ placeholderText: "…" }), keymap.of(foldKeymap), foldToggles] : [],
    placeTheme,
    EditorView.updateListener.of((update) => {
      const marks = update.startState.field(bookmarkField, false) !== update.state.field(bookmarkField, false);
      const foldsChanged = update.startState.field(foldState, false) !== update.state.field(foldState, false);
      if (marks && !update.docChanged) handlers.current.onChange(true);
      else if (foldsChanged && !update.docChanged) handlers.current.onChange(true);
      else if (update.selectionSet || update.docChanged || marks || foldsChanged) handlers.current.onChange(false);
    }),
  ];
}
