import { Prec, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { allows, type Role } from "../sharing/api";
import type { Thread } from "./api";
import type { Range } from "./anchor";
import { commentMarks, setCommentMarks, type MarkHandlers } from "./commentMarks";
import { CommentsPanel, type PlacedThread, type Selection } from "./CommentsPanel";

const OPEN_KEY = "notes.commentsOpen";

function readOpen(): boolean {
  try {
    const value = localStorage.getItem(OPEN_KEY);
    if (value !== null) return value === "1";
  } catch {
    /* private mode */
  }
  return window.innerWidth >= 1100;
}

/**
 * Everything the note page needs for comments: editor extensions, a toolbar
 * button and the side panel. Kept here so the note page only adds a few lines.
 */
export function useNoteComments({ fileId, doc, role }: { fileId: number; doc: string; role: Role }) {
  const [open, setOpen] = useState(readOpen);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [placed, setPlaced] = useState<PlacedThread[]>([]);
  const view = useRef<EditorView | null>(null);

  const handlers = useRef<MarkHandlers>({ onSelection: () => {}, onMarkClick: () => {} });
  handlers.current = {
    onSelection: setSelection,
    onMarkClick: (id) => {
      setOpen(true);
      setActive(id);
      requestAnimationFrame(() =>
        document.querySelector(`[data-thread-card="${id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
      );
    },
  };

  // Read once by the editor at mount, so it must not change identity.
  const extensions = useMemo<Extension[]>(() => {
    const list: Extension[] = [commentMarks(handlers)];
    // Commenters can't edit, but still need to select text to comment on it.
    if (role === "comment") list.push(Prec.highest(EditorView.editable.of(true)));
    return list;
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, open ? "1" : "0");
    } catch {
      /* private mode */
    }
  }, [open]);

  useEffect(() => {
    const marks = placed.flatMap(({ thread, range }) => (range ? [{ id: thread.id, from: range.from, to: range.to }] : []));
    view.current?.dispatch({ effects: setCommentMarks.of({ marks, active }) });
  }, [placed, active]);

  const onReady = useCallback((v: EditorView) => {
    view.current = v;
  }, []);

  const focusThread = useCallback((thread: Thread, range: Range | null) => {
    setActive(thread.id);
    const v = view.current;
    if (!v || !range) return;
    const to = Math.min(range.to, v.state.doc.length);
    v.dispatch({ selection: { anchor: Math.min(range.from, to), head: to }, scrollIntoView: true });
  }, []);

  const count = placed.length;
  const button = (
    <button type="button" className="menu-button" aria-pressed={open} onClick={() => setOpen((o) => !o)}>
      Comments{count > 0 ? ` (${count})` : ""}
    </button>
  );

  const panel = (
    <div className="note-comments" hidden={!open}>
      <CommentsPanel
        fileId={fileId}
        doc={doc}
        selection={allows(role, "comment") ? selection : null}
        activeThreadId={active}
        onFocusThread={focusThread}
        onThreadsChange={setPlaced}
        onClose={() => setOpen(false)}
      />
    </div>
  );

  return { extensions, onReady, button, panel };
}
