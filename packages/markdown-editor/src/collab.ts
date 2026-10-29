import type { Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import type * as Y from "yjs";

// Co-editing, kept out of the main bundle: pass `extensions: [collab(...)]`
// and `history: false` to mount(), with a Yjs text and a provider's awareness.
// (Markdown Studio's Notes app does the same with its own LiveNote.)

export type CollabOptions = {
  text: Y.Text;
  /** The provider's awareness (y-protocols), for other people's cursors; leave out for none. */
  awareness?: unknown;
  /** Undo that only takes back your own edits. */
  undoManager?: Y.UndoManager | false;
};

export function collab({ text, awareness, undoManager }: CollabOptions): Extension {
  // Left out, y-codemirror makes its own undo manager for the text.
  const undo = undoManager === undefined ? {} : { undoManager };
  return [yCollab(text, awareness ?? null, undo as { undoManager: Y.UndoManager | false }), keymap.of(yUndoManagerKeymap)];
}
