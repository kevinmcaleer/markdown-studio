import { StateEffect, StateField, type Extension, type Range as CMRange } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet } from "@codemirror/view";
import { pinsAt, type Pin } from "./pin";

// Highlights commented passages in the editor and reports what a new comment
// would be pinned to (the selection, or the word or line at the cursor), so
// the comments panel can offer "comment on this" and jump between the two.

export type Mark = { id: number; from: number; to: number };

export const setCommentMarks = StateEffect.define<{ marks: Mark[]; active: number | null }>();

const marksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(set, tr) {
    set = set.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setCommentMarks)) continue;
      const length = tr.state.doc.length;
      const ranges: CMRange<Decoration>[] = effect.value.marks
        .map((m) => ({ ...m, from: Math.min(m.from, length), to: Math.min(m.to, length) }))
        .filter((m) => m.to > m.from)
        .sort((a, b) => a.from - b.from || a.to - b.to)
        .map((m) =>
          Decoration.mark({
            class: m.id === effect.value.active ? "comment-mark active" : "comment-mark",
            attributes: { "data-thread": String(m.id) },
          }).range(m.from, m.to),
        );
      set = Decoration.set(ranges, true);
    }
    return set;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export type MarkHandlers = {
  /** Called with what a new comment would pin to, best first; empty when nothing (a blank line, or no editor). */
  onPins: (pins: Pin[]) => void;
  /** Called when a highlighted passage is clicked. */
  onMarkClick: (threadId: number) => void;
  /** Called when the cursor moves into a highlighted passage (with its thread) or out of one (null). */
  onCursorMark: (threadId: number | null) => void;
};

/** The thread whose highlight covers `pos`, preferring the shortest passage. */
function markAt(set: DecorationSet, pos: number): number | null {
  let best: { id: number; size: number } | null = null;
  set.between(pos, pos, (from, to, deco) => {
    if (from > pos || to < pos) return;
    const id = Number(deco.spec.attributes?.["data-thread"]);
    if (!best || to - from < best.size) best = { id, size: to - from };
  });
  return best ? (best as { id: number }).id : null;
}

/** The editor extension. Handlers are read through the ref on each event, so they can change. */
export function commentMarks(handlers: { current: MarkHandlers }): Extension {
  // Until someone puts the cursor in the editor, it's sitting at the start by
  // default, which isn't a place they chose to comment on.
  const touched = new WeakSet<EditorView>();
  return [
    marksField,
    EditorView.updateListener.of((update) => {
      if (update.view.hasFocus) touched.add(update.view);
      if (!touched.has(update.view)) return;
      if (!update.selectionSet && !update.docChanged && !update.focusChanged) return;
      handlers.current.onPins(pinsAt(update.state));
      if (update.selectionSet && update.view.hasFocus) {
        handlers.current.onCursorMark(markAt(update.state.field(marksField), update.state.selection.main.head));
      }
    }),
    // Switching to a mode without the editor leaves nothing to pin to.
    ViewPlugin.define(() => ({ destroy: () => handlers.current.onPins([]) })),
    EditorView.domEventHandlers({
      click(event) {
        const mark = (event.target as HTMLElement).closest?.("[data-thread]");
        if (mark) handlers.current.onMarkClick(Number(mark.getAttribute("data-thread")));
        return false;
      },
    }),
  ];
}
