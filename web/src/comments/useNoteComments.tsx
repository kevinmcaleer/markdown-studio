import { Prec, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { allows, type Role } from "../sharing/api";
import type * as Y from "yjs";
import type { Thread } from "./api";
import type { Range, Resolver } from "./anchor";
import { commentMarks, setCommentMarks, type MarkHandlers } from "./commentMarks";
import { CommentsPanel, type PlacedThread } from "./CommentsPanel";
import type { Pin } from "./pin";
import { createYAnchor, resolveYAnchor } from "./yAnchor";

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

const NO_PINS: Pin[] = [];

/**
 * Everything the note page needs for comments: editor extensions, a toolbar
 * button and the side panel. Kept here so the note page only adds a few lines.
 *
 * New comments are pinned to the selection, or the word or line at the
 * cursor, with Yjs relative positions on `text` (the shared text the editor
 * is bound to) so the pin survives other people's edits. `fallbackPins` are
 * offered when there's no editor to pin from (Decks uses the current slide).
 */
export function useNoteComments({
  fileId,
  doc,
  role,
  text,
  fallbackPins = NO_PINS,
  onFocusRange,
}: {
  fileId: number;
  doc: string;
  role: Role;
  text?: Y.Text | null;
  fallbackPins?: Pin[];
  /** Called when a thread is picked in the panel, with where its passage is now. */
  onFocusRange?: (range: Range) => void;
}) {
  const [open, setOpen] = useState(readOpen);
  const [pins, setPins] = useState<Pin[]>(NO_PINS);
  const [active, setActive] = useState<number | null>(null);
  const [placed, setPlaced] = useState<PlacedThread[]>([]);
  const view = useRef<EditorView | null>(null);

  const showCard = (id: number) =>
    requestAnimationFrame(() =>
      document.querySelector(`[data-thread-card="${id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
    );
  const handlers = useRef<MarkHandlers>({ onPins: () => {}, onMarkClick: () => {}, onCursorMark: () => {} });
  handlers.current = {
    onPins: (next) => setPins((current) => (samePins(current, next) ? current : next)),
    onMarkClick: (id) => {
      setOpen(true);
      setActive(id);
      showCard(id);
    },
    onCursorMark: (id) => {
      setActive(id);
      if (id !== null) showCard(id);
    },
  };

  const resolve = useMemo<Resolver | undefined>(
    () => (text ? (anchor, hasQuote) => resolveYAnchor(text, anchor, hasQuote) : undefined),
    [text],
  );
  const makeAnchor = useMemo(
    () => (text ? (from: number, to: number) => createYAnchor(text, Math.min(from, text.length), Math.min(to, text.length)) : undefined),
    [text],
  );
  const focusRange = useRef(onFocusRange);
  focusRange.current = onFocusRange;

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

  const marks = useMemo(
    () => ({
      marks: placed.flatMap(({ thread, range }) => (range ? [{ id: thread.id, from: range.from, to: range.to }] : [])),
      active,
    }),
    [placed, active],
  );
  const latest = useRef(marks);
  latest.current = marks;

  // Null while there's no editor on screen (Preview mode, or not loaded yet).
  const liveView = () => (view.current?.dom.isConnected ? view.current : null);

  useEffect(() => {
    liveView()?.dispatch({ effects: setCommentMarks.of(marks) });
  }, [marks]);

  // The editor is rebuilt when switching to Preview and back; give it the marks again.
  const onReady = useCallback((v: EditorView) => {
    view.current = v;
    v.dispatch({ effects: setCommentMarks.of(latest.current) });
  }, []);

  const focusThread = useCallback((thread: Thread, range: Range | null) => {
    setActive(thread.id);
    if (range) focusRange.current?.(range);
    const v = liveView();
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
        pins={allows(role, "comment") ? (pins.length ? pins : fallbackPins) : NO_PINS}
        resolve={resolve}
        makeAnchor={makeAnchor}
        activeThreadId={active}
        onFocusThread={focusThread}
        onThreadsChange={setPlaced}
        onClose={() => setOpen(false)}
      />
    </div>
  );

  return { extensions, onReady, button, panel, placed };
}

function samePins(a: Pin[], b: Pin[]): boolean {
  return a.length === b.length && a.every((p, i) => p.from === b[i].from && p.to === b[i].to && p.kind === b[i].kind && p.text === b[i].text);
}
