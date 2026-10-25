import { EditorState, StateEffect, StateField, Transaction, type Extension, type Range as CMRange } from "@codemirror/state";
import { Decoration, EditorView, hoverTooltip, WidgetType, type DecorationSet } from "@codemirror/view";
import { ySyncAnnotation } from "y-codemirror.next";

// Suggesting mode. Typing doesn't change the document: each edit is folded
// into a draft suggestion ("replace from..to with insert") that is drawn over
// the text (deleted text struck through, new text underlined after it) and
// saved as a suggestion record. Changes from co-editors, and accepted
// suggestions (applied to the shared text directly), pass through untouched.

/** The suggestion being typed. `id` is set once it's saved. */
export type Draft = { key: number; from: number; to: number; insert: string; id?: number };

/** One edit, as a single span of the old document and what replaces it. */
export type Edit = { from: number; to: number; insert: string };

/** A saved suggestion, where its passage is now. */
export type SuggestionMark = { id: number; from: number; to: number; insert: string; color: string; active: boolean };

let nextKey = 1;

/**
 * Folds an edit into the draft. Typing straight after the draft's new text
 * adds to it, Backspace there takes from its new text (and then strikes out
 * more of the old text before it), and Delete strikes out the text after it.
 * Anything else starts a new draft. The cursor stays after the draft's new
 * text, which is where it's drawn. A draft that no longer changes anything is
 * null.
 */
export function foldEdit(draft: Draft | null, edit: Edit, cursorOnly: boolean): { draft: Draft | null; cursor: number } {
  const removed = edit.to - edit.from;
  let next: Draft | null = null;
  if (draft && !removed && edit.insert && edit.from === draft.to) {
    next = { ...draft, insert: draft.insert + edit.insert };
  } else if (draft && cursorOnly && !edit.insert && edit.to === draft.to) {
    const fromInsert = Math.min(removed, draft.insert.length);
    next = {
      ...draft,
      insert: draft.insert.slice(0, draft.insert.length - fromInsert),
      from: Math.max(0, draft.from - (removed - fromInsert)),
    };
  } else if (draft && cursorOnly && !edit.insert && edit.from === draft.to) {
    next = { ...draft, to: edit.to };
  } else {
    next = { key: nextKey++, from: edit.from, to: edit.to, insert: edit.insert };
  }
  const cursor = next.to;
  return { draft: next.from === next.to && !next.insert ? null : next, cursor };
}

/** A transaction's changes as one span of the old document. */
export function editOf(tr: Transaction): Edit | null {
  let fromA = Infinity;
  let toA = -Infinity;
  let fromB = Infinity;
  let toB = -Infinity;
  tr.changes.iterChangedRanges((fa, ta, fb, tb) => {
    fromA = Math.min(fromA, fa);
    toA = Math.max(toA, ta);
    fromB = Math.min(fromB, fb);
    toB = Math.max(toB, tb);
  });
  if (fromA === Infinity) return null;
  return { from: fromA, to: toA, insert: tr.newDoc.sliceString(fromB, toB) };
}

export const setSuggesting = StateEffect.define<boolean>();
const setDraft = StateEffect.define<Draft | null>();
/** Records the saved id of a draft, so its saved copy isn't drawn twice. */
export const setDraftId = StateEffect.define<{ key: number; id: number }>();
export const setSuggestionMarks = StateEffect.define<SuggestionMark[]>();

const suggestingField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setSuggesting)) value = e.value;
    return value;
  },
});

export const draftField = StateField.define<Draft | null>({
  create: () => null,
  update(draft, tr) {
    let set = false;
    for (const e of tr.effects) {
      if (e.is(setDraft)) {
        draft = e.value;
        set = true;
      } else if (e.is(setDraftId) && draft?.key === e.value.key) {
        draft = { ...draft, id: e.value.id };
      } else if (e.is(setSuggesting) && !e.value) {
        draft = null;
        set = true;
      }
    }
    if (!draft || set) return draft;
    if (tr.docChanged) {
      const from = tr.changes.mapPos(draft.from, 1);
      draft = { ...draft, from, to: Math.max(from, tr.changes.mapPos(draft.to, -1)) };
    }
    // Moving the cursor elsewhere finishes the draft.
    if (tr.selection && !tr.docChanged && tr.selection.main.head !== draft.to) return null;
    return draft;
  },
});

const marksField = StateField.define<SuggestionMark[]>({
  create: () => [],
  update(marks, tr) {
    for (const e of tr.effects) if (e.is(setSuggestionMarks)) return e.value;
    if (!tr.docChanged) return marks;
    return marks.map((m) => {
      const from = tr.changes.mapPos(m.from, 1);
      return { ...m, from, to: Math.max(from, tr.changes.mapPos(m.to, -1)) };
    });
  },
});

class InsertWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly id: number | null,
    readonly color: string,
  ) {
    super();
  }
  eq(other: InsertWidget) {
    return other.text === this.text && other.id === this.id && other.color === this.color;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "sugg-ins";
    span.textContent = this.text;
    span.style.setProperty("--sugg", this.color);
    if (this.id !== null) span.dataset.suggestion = String(this.id);
    return span;
  }
  ignoreEvent() {
    return false;
  }
}

function decorate(marks: (Omit<SuggestionMark, "id"> & { id: number | null })[], length: number): DecorationSet {
  const ranges: CMRange<Decoration>[] = [];
  for (const m of marks) {
    const from = Math.min(m.from, length);
    const to = Math.min(Math.max(m.to, from), length);
    const attributes: Record<string, string> = { style: `--sugg: ${m.color}` };
    if (m.id !== null) attributes["data-suggestion"] = String(m.id);
    const active = m.active ? " active" : "";
    if (to > from) ranges.push(Decoration.mark({ class: `sugg-del${active}`, attributes }).range(from, to));
    if (m.insert) ranges.push(Decoration.widget({ widget: new InsertWidget(m.insert, m.id, m.color), side: -1 }).range(to));
  }
  return Decoration.set(ranges, true);
}

export type SuggestHandlers = {
  /** The colour the person typing gets. */
  ownColor: () => string;
  /** Called when the draft changes; `previous` is the draft it replaces, if it was a different one (it's finished). */
  onDraft: (draft: Draft | null, previous: Draft | null, state: EditorState) => void;
  onMarkClick: (id: number) => void;
  /** The hover card for a saved suggestion, or null for none. */
  card: (id: number) => HTMLElement | null;
};

/** The editor extension. Handlers are read through the ref on each event, so they can change. */
export function suggestMode(handlers: { current: SuggestHandlers }): Extension {
  return [
    suggestingField,
    draftField,
    marksField,
    EditorState.transactionFilter.of((tr) => {
      if (!tr.docChanged || !tr.startState.field(suggestingField)) return tr;
      // A co-editor's change, or an accepted suggestion, arriving through Yjs.
      if (tr.annotation(ySyncAnnotation) !== undefined || tr.annotation(Transaction.remote)) return tr;
      const edit = editOf(tr);
      if (!edit) return tr;
      const { draft, cursor } = foldEdit(tr.startState.field(draftField), edit, tr.startState.selection.main.empty);
      return {
        effects: setDraft.of(draft),
        selection: { anchor: Math.min(cursor, tr.startState.doc.length) },
        scrollIntoView: true,
      };
    }),
    EditorView.decorations.compute([marksField, draftField], (state) => {
      const draft = state.field(draftField);
      const marks: (Omit<SuggestionMark, "id"> & { id: number | null })[] = state
        .field(marksField)
        .filter((m) => m.id !== draft?.id);
      if (draft) marks.push({ id: draft.id ?? null, from: draft.from, to: draft.to, insert: draft.insert, color: handlers.current.ownColor(), active: true });
      return decorate(marks, state.doc.length);
    }),
    EditorView.updateListener.of((update) => {
      const before = update.startState.field(draftField);
      const after = update.state.field(draftField);
      if (before === after) return;
      handlers.current.onDraft(after, before && before.key !== after?.key ? before : null, update.state);
    }),
    EditorView.domEventHandlers({
      click(event) {
        const mark = (event.target as HTMLElement).closest?.("[data-suggestion]");
        if (mark) handlers.current.onMarkClick(Number(mark.getAttribute("data-suggestion")));
        return false;
      },
    }),
    hoverTooltip((view, pos) => {
      const draftId = view.state.field(draftField)?.id;
      const mark = view.state.field(marksField).find((m) => m.id !== draftId && m.from <= pos && pos <= m.to);
      if (!mark) return null;
      return {
        pos: mark.from,
        end: mark.to,
        above: true,
        create: () => ({ dom: handlers.current.card(mark.id) ?? document.createElement("span") }),
      };
    }),
  ];
}
