import { StateEffect, StateField, type Extension, type Range as CMRange } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

// Highlights commented passages in the editor and reports the selection, so
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
  /** Called with the selected text (or null when the selection is empty). */
  onSelection: (selection: { from: number; to: number; text: string } | null) => void;
  /** Called when a highlighted passage is clicked. */
  onMarkClick: (threadId: number) => void;
};

/** The editor extension. Handlers are read through the ref on each event, so they can change. */
export function commentMarks(handlers: { current: MarkHandlers }): Extension {
  return [
    marksField,
    EditorView.updateListener.of((update) => {
      if (!update.selectionSet && !update.docChanged) return;
      const { from, to } = update.state.selection.main;
      handlers.current.onSelection(from === to ? null : { from, to, text: update.state.sliceDoc(from, to) });
    }),
    EditorView.domEventHandlers({
      click(event) {
        const mark = (event.target as HTMLElement).closest?.("[data-thread]");
        if (mark) handlers.current.onMarkClick(Number(mark.getAttribute("data-thread")));
        return false;
      },
    }),
  ];
}
