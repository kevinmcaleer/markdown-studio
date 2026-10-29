import { forceParsing } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type * as Y from "yjs";
import { BookmarksMenu, type ListedBookmark } from "./BookmarksMenu";
import { bookmarkField, editorPlace, foldedLineStarts, foldsAt, goTo, setBookmarks, toggleBookmark, type Mark, type PlaceHandlers } from "./editorPlace";
import "./place.css";
import { emptyState, findSpot, loadFileState, makeSpot, saveFileState, type FileState } from "./fileState";

// How long to wait for the saved state before opening the note without it.
const LOAD_TIMEOUT = 1500;
const SAVE_DELAY = 1500;

/**
 * Picks up where this person left off in a note, and keeps their bookmarks,
 * folds and preferred view for it. Everything the note page needs comes back
 * from here, so the page only adds a few lines:
 *
 * - `loaded`: wait for it before showing the editor, so it opens in place
 * - `extensions` and `onReady` for the editor
 * - `view` / `rememberView` for the per-note view mode
 * - `button` (the Bookmarks menu) and `toast` ("Resumed where you left off")
 */
export function useFilePlace({
  fileId,
  signedIn,
  text,
  folds,
}: {
  fileId: number;
  signedIn: boolean;
  /** The shared text the editor is bound to, for positions that follow other people's edits. */
  text?: Y.Text | null;
  /** Fold headings and remember the folds (Markdown notes). */
  folds: boolean;
}) {
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState<string | undefined>(undefined);
  const [listed, setListed] = useState<ListedBookmark[]>([]);
  const [toast, setToast] = useState(false);
  const state = useRef<FileState>(emptyState());
  const ready = useRef(false);
  const editor = useRef<EditorView | null>(null);
  const restored = useRef(new WeakSet<EditorView>());
  const toasted = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const textRef = useRef(text);
  textRef.current = text;
  const where = useRef({ fileId, signedIn });

  /** Reads the editor into `state`, if it's the live one and has been restored. */
  const snapshot = useCallback(() => {
    const v = editor.current;
    if (!v || !v.dom.isConnected || !restored.current.has(v)) return;
    const { doc } = v.state;
    const t = textRef.current;
    const next: FileState = {
      ...state.current,
      cursor: makeSpot(doc, v.state.selection.main.head, t, false),
      top: makeSpot(doc, topOfView(v), t, false),
      bookmarks: v.state.field(bookmarkField).map((m) => ({
        id: m.id,
        at: makeSpot(doc, m.pos, t),
        ...(m.note ? { note: m.note } : {}),
        created_at: m.created_at,
      })),
    };
    if (folds) next.folds = foldedLineStarts(v.state).map((pos) => makeSpot(doc, pos, t));
    state.current = next;
  }, [folds]);

  const save = useCallback(
    (leaving = false) => {
      window.clearTimeout(timer.current);
      timer.current = undefined;
      if (!ready.current) return;
      snapshot();
      saveFileState(where.current.fileId, where.current.signedIn, state.current, leaving);
    },
    [snapshot],
  );

  const later = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => save(), SAVE_DELAY);
  }, [save]);

  const refreshList = useCallback(() => {
    const v = editor.current;
    if (!v) return;
    const { doc } = v.state;
    setListed(
      v.state.field(bookmarkField).map((m) => {
        const line = doc.lineAt(m.pos);
        return { id: m.id, line: line.number, text: line.text.trim(), note: m.note };
      }),
    );
  }, []);

  /** Puts this person's place back into a newly opened editor. */
  const restore = useCallback(
    (v: EditorView) => {
      if (!ready.current || restored.current.has(v)) return;
      restored.current.add(v);
      const saved = state.current;
      const t = textRef.current;
      const { doc } = v.state;
      // If the editor opened before the state arrived and they've started, leave the cursor be.
      const untouched = !v.hasFocus && v.state.selection.main.head === 0;
      const marks: Mark[] = (saved.bookmarks ?? [])
        .map((b) => ({ id: b.id, pos: doc.lineAt(findSpot(doc, b.at, t)).from, note: b.note ?? "", created_at: b.created_at }))
        .sort((a, b) => a.pos - b.pos);
      let foldEffects: ReturnType<typeof foldsAt> = [];
      if (folds && saved.folds?.length) {
        forceParsing(v, doc.length, 200);
        foldEffects = foldsAt(v.state, saved.folds.map((f) => findSpot(doc, f, t)));
      }
      const cursor = untouched && saved.cursor ? findSpot(doc, saved.cursor, t) : null;
      const top = untouched && saved.top ? doc.lineAt(findSpot(doc, saved.top, t)).from : null;
      v.dispatch({
        effects: [setBookmarks.of(marks), ...foldEffects],
        ...(cursor !== null ? { selection: { anchor: cursor } } : {}),
      });
      refreshList();
      if (cursor === null && top === null) return;
      // After the first layout, so the editor knows how tall things are.
      requestAnimationFrame(() => {
        if (!v.dom.isConnected) return;
        const at = top !== null && top > 0 ? top : cursor ?? 0;
        v.dispatch({ effects: EditorView.scrollIntoView(Math.min(at, v.state.doc.length), { y: top ? "start" : "center" }) });
        if (document.activeElement === document.body || document.activeElement === null) v.focus();
      });
      if (!toasted.current && ((cursor ?? 0) > 0 || (top ?? 0) > 0)) {
        toasted.current = true;
        setToast(true);
      }
    },
    [folds, refreshList],
  );

  useEffect(() => {
    let live = true;
    where.current = { fileId, signedIn };
    ready.current = false;
    toasted.current = false;
    state.current = emptyState();
    setLoaded(false);
    setView(undefined);
    setListed([]);
    setToast(false);
    const done = () => {
      if (!live || ready.current) return;
      ready.current = true;
      setLoaded(true);
      if (editor.current) restore(editor.current);
    };
    const giveUp = window.setTimeout(done, LOAD_TIMEOUT);
    loadFileState(fileId, signedIn).then((saved) => {
      if (!live) return;
      if (saved && !ready.current) {
        state.current = saved;
        setView(saved.view);
      }
      done();
    });
    const leaving = () => save(true);
    const hidden = () => document.visibilityState === "hidden" && save(true);
    window.addEventListener("pagehide", leaving);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      live = false;
      window.clearTimeout(giveUp);
      window.removeEventListener("pagehide", leaving);
      document.removeEventListener("visibilitychange", hidden);
      if (timer.current !== undefined) save(true);
    };
  }, [fileId, signedIn, restore, save]);

  // Scrolling is part of where they are, but it isn't an editor change.
  useEffect(() => {
    let frame = 0;
    const scrolled = (event: Event) => {
      const v = editor.current;
      if (!v || !(event.target instanceof Node) || !(event.target === v.scrollDOM || event.target.contains(v.dom))) return;
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          snapshot();
        });
      later();
    };
    document.addEventListener("scroll", scrolled, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("scroll", scrolled, true);
    };
  }, [later, snapshot]);

  const handlers = useRef<PlaceHandlers>({ onChange: () => {} });
  handlers.current = {
    onChange: (now) => {
      const v = editor.current;
      if (now) {
        // Kept straight away, so leaving the note a moment later doesn't lose them.
        snapshot();
        refreshList();
      } else if (v && restored.current.has(v)) {
        // Just the cursor: cheap, and needs no layout.
        state.current = { ...state.current, cursor: makeSpot(v.state.doc, v.state.selection.main.head, textRef.current, false) };
      }
      later();
    },
  };

  const extensions = useMemo(() => [editorPlace(handlers, folds)], [folds]);

  const onReady = useCallback(
    (v: EditorView) => {
      editor.current = v;
      restore(v);
    },
    [restore],
  );

  const rememberView = useCallback(
    (mode: string) => {
      if (!ready.current || state.current.view === mode) return;
      state.current = { ...state.current, view: mode };
      later();
    },
    [later],
  );

  const withEditor = (fn: (v: EditorView) => void) => {
    const v = editor.current;
    if (v && v.dom.isConnected) fn(v);
  };

  const button: ReactNode = (
    <BookmarksMenu
      bookmarks={listed}
      onOpen={refreshList}
      onPick={(id) =>
        withEditor((v) => {
          const mark = v.state.field(bookmarkField).find((m) => m.id === id);
          if (mark) goTo(v, mark.pos);
        })
      }
      onToggleHere={() => withEditor((v) => (toggleBookmark(v), v.focus()))}
      onNote={(id, note) =>
        withEditor((v) =>
          v.dispatch({ effects: setBookmarks.of(v.state.field(bookmarkField).map((m) => (m.id === id ? { ...m, note } : m))) }),
        )
      }
      onRemove={(id) =>
        withEditor((v) => v.dispatch({ effects: setBookmarks.of(v.state.field(bookmarkField).filter((m) => m.id !== id)) }))
      }
      canBookmark={editor.current?.dom.isConnected ?? false}
    />
  );

  const closeToast = useCallback(() => setToast(false), []);
  const toastNode: ReactNode = toast ? (
    <ResumedToast
      onTop={() => {
        setToast(false);
        withEditor((v) => {
          v.dispatch({ selection: { anchor: 0 }, effects: EditorView.scrollIntoView(0, { y: "start" }) });
          v.focus();
          v.scrollDOM.closest(".note-pane")?.scrollTo({ top: 0 });
        });
      }}
      onClose={closeToast}
    />
  ) : null;

  return { loaded, view, rememberView, extensions, onReady, button, toast: toastNode };
}

/** The first document position on screen, wherever the scrolling happens. */
function topOfView(view: EditorView): number {
  let top = 0;
  for (let el: HTMLElement | null = view.scrollDOM; el; el = el.parentElement) {
    const overflow = getComputedStyle(el).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && el.scrollHeight > el.clientHeight) {
      top = el.getBoundingClientRect().top;
      break;
    }
  }
  const height = top - view.documentTop;
  if (height <= 0) return 0;
  return view.lineBlockAtHeight(height).from;
}

function ResumedToast({ onTop, onClose }: { onTop: () => void; onClose: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onClose, 6000);
    return () => window.clearTimeout(timer);
  }, [onClose]);
  return (
    <div className="resume-toast" role="status">
      <span>Resumed where you left off</span>
      <button type="button" className="link-button" onClick={onTop}>
        Go to top
      </button>
      <button type="button" className="resume-toast-close" aria-label="Dismiss" onClick={onClose}>
        ×
      </button>
    </div>
  );
}
