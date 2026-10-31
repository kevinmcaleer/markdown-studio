import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, Facet, type Range, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";

// HTML comments a host keeps in the Markdown for itself, hidden in the live
// view. kevsrobots marks the pinout table it writes with
// `<!-- pinout from the wiring diagram: 1a2b3c4d -->` to tell later whether
// the table still matches the wiring; the published page never shows an
// HTML comment, so the live view shouldn't either. The Raw view shows it.
//
// Only comments a host's test accepts are hidden: a writer's own comments
// stay in sight. A hidden comment is a whole block (a comment on lines of
// its own), never one inside a paragraph.

/** Whether a comment block (its text, `<!--` to `-->`) is hidden in the live view. */
export type HiddenComment = (comment: string) => boolean;

/** The hosts' tests; a comment any of them accepts is hidden. */
export const hiddenComments = Facet.define<HiddenComment>();

/** The comment blocks to hide in `state`, as block replacements. */
export function findHiddenComments(state: EditorState): DecorationSet {
  const tests = state.facet(hiddenComments);
  if (!tests.length) return Decoration.none;
  const out: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === "Document") return true;
      if (node.name === "CommentBlock") {
        const from = state.doc.lineAt(node.from).from;
        const to = state.doc.lineAt(node.to).to;
        const text = state.sliceDoc(node.from, node.to).trim();
        if (tests.some((test) => test(text))) out.push(Decoration.replace({ block: true }).range(from, to));
      }
      return false;
    },
  });
  return Decoration.set(out, true);
}

export const hiddenCommentsField = StateField.define<DecorationSet>({
  create: findHiddenComments,
  update(hidden, tr) {
    if (tr.docChanged || tr.reconfigured || syntaxTree(tr.state) !== syntaxTree(tr.startState)) return findHiddenComments(tr.state);
    return hidden.map(tr.changes);
  },
  provide: (field) => [EditorView.decorations.from(field), EditorView.atomicRanges.of((view) => view.state.field(field))],
});

/** Hides the comments `test` accepts (for a host that mounts its own editor). */
export function hideComments(test: HiddenComment): Extension {
  return hiddenComments.of(test);
}
