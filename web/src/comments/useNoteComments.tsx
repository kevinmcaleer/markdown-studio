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
import { useSuggestions } from "../suggestions/useSuggestions";

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

type Tab = "comments" | "suggestions";

/**
 * Everything the note page needs for comments: editor extensions, a toolbar
 * button and the side panel. Kept here so the note page only adds a few lines.
 *
 * New comments are pinned to the selection, or the word or line at the
 * cursor, with Yjs relative positions on `text` (the shared text the editor
 * is bound to) so the pin survives other people's edits. `fallbackPins` are
 * offered when there's no editor to pin from (Decks uses the current slide).
 *
 * With `suggestions` on (Notes), the panel gets a Suggestions tab and the
 * editor a Suggesting mode; see `useSuggestions`.
 */
export function useNoteComments({
  fileId,
  doc,
  role,
  text,
  fallbackPins = NO_PINS,
  onFocusRange,
  suggestions = false,
}: {
  fileId: number;
  doc: string;
  role: Role;
  text?: Y.Text | null;
  fallbackPins?: Pin[];
  /** Called when a thread is picked in the panel, with where its passage is now. */
  onFocusRange?: (range: Range) => void;
  /** Offer Suggesting mode and the Suggestions tab. */
  suggestions?: boolean;
}) {
  const [open, setOpen] = useState(readOpen);
  const [tab, setTab] = useState<Tab>("comments");
  const [reloadKey, setReloadKey] = useState(0);
  const [pins, setPins] = useState<Pin[]>(NO_PINS);
  const [active, setActive] = useState<number | null>(null);
  const [placed, setPlaced] = useState<PlacedThread[]>([]);
  const view = useRef<EditorView | null>(null);

  const showCard = (id: number, attribute = "data-thread-card") =>
    requestAnimationFrame(() =>
      document.querySelector(`[${attribute}="${id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
    );
  const handlers = useRef<MarkHandlers>({ onPins: () => {}, onMarkClick: () => {}, onCursorMark: () => {} });
  handlers.current = {
    onPins: (next) => setPins((current) => (samePins(current, next) ? current : next)),
    onMarkClick: (id) => {
      setOpen(true);
      setTab("comments");
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

  const suggest = useSuggestions({
    fileId,
    doc,
    role,
    text,
    resolve,
    enabled: suggestions,
    onOpenPanel: (id) => {
      setOpen(true);
      setTab("suggestions");
      showCard(id, "data-suggestion-card");
    },
    onOpenThread: (id) => {
      setOpen(true);
      setTab("comments");
      setActive(id);
      setReloadKey((k) => k + 1);
      showCard(id);
    },
  });

  // Read once by the editor at mount, so it must not change identity.
  const extensions = useMemo<Extension[]>(() => {
    const list: Extension[] = [commentMarks(handlers), ...(suggestions ? suggest.extensions : [])];
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
  const suggestReady = suggest.onReady;
  const onReady = useCallback(
    (v: EditorView) => {
      view.current = v;
      v.dispatch({ effects: setCommentMarks.of(latest.current) });
      suggestReady(v);
    },
    [suggestReady],
  );

  const focusThread = useCallback((thread: Thread, range: Range | null) => {
    setActive(thread.id);
    if (range) focusRange.current?.(range);
    const v = liveView();
    if (!v || !range) return;
    const to = Math.min(range.to, v.state.doc.length);
    v.dispatch({ selection: { anchor: Math.min(range.from, to), head: to }, scrollIntoView: true });
  }, []);

  const count = placed.length + (suggestions ? suggest.openCount : 0);
  const button = (
    <button type="button" className="menu-button" aria-pressed={open} onClick={() => setOpen((o) => !o)}>
      Comments{count > 0 ? ` (${count})` : ""}
    </button>
  );

  const title = suggestions ? (
    <div className="panel-tabs" role="tablist" aria-label="Comments and suggestions">
      <button type="button" role="tab" aria-selected={tab === "comments"} onClick={() => setTab("comments")}>
        Comments{placed.length > 0 ? ` (${placed.length})` : ""}
      </button>
      <button type="button" role="tab" aria-selected={tab === "suggestions"} onClick={() => setTab("suggestions")}>
        Suggestions{suggest.openCount > 0 ? ` (${suggest.openCount})` : ""}
      </button>
    </div>
  ) : undefined;

  const panel = (
    <div className="note-comments" hidden={!open}>
      {suggestions && tab === "suggestions" && suggest.panel(title, () => setOpen(false))}
      <div className="panel-tab" hidden={suggestions && tab !== "comments"}>
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
        title={title}
        reloadKey={reloadKey}
      />
      </div>
    </div>
  );

  return { extensions, onReady, button, panel, placed, suggesting: suggest.suggesting, suggestSwitch: suggest.switcher };
}

function samePins(a: Pin[], b: Pin[]): boolean {
  return a.length === b.length && a.every((p, i) => p.from === b[i].from && p.to === b[i].to && p.kind === b[i].kind && p.text === b[i].text);
}
