import { useEffect, useRef, useState } from "react";

// Your bookmarks in this note: jump to one, give it a short private note, or
// remove it. `BookmarkList` is the list on its own, for the Outline panel.

export type ListedBookmark = { id: string; line: number; text: string; note: string };

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const BOOKMARK_KEYS = isMac ? "⌘⇧B" : "Ctrl+Shift+B";

type ListProps = {
  bookmarks: ListedBookmark[];
  onPick: (id: string) => void;
  onNote: (id: string, note: string) => void;
  onRemove: (id: string) => void;
};

export function BookmarkList({ bookmarks, onPick, onNote, onRemove }: ListProps) {
  if (bookmarks.length === 0)
    return (
      <p className="bookmarks-empty muted small">
        No bookmarks yet. Press {BOOKMARK_KEYS} on a line to keep your place there. Only you can see them.
      </p>
    );
  return (
    <ul className="bookmark-list">
      {bookmarks.map((b) => (
        <li key={b.id}>
          <button type="button" className="bookmark-jump" onClick={() => onPick(b.id)} title={`Go to line ${b.line}`}>
            <span className="bookmark-line muted small">{b.line}</span>
            <span className="bookmark-text">{b.text || <em className="muted">Blank line</em>}</span>
          </button>
          <NoteField value={b.note} onSave={(note) => onNote(b.id, note)} />
          <button type="button" className="bookmark-remove" aria-label={`Remove bookmark on line ${b.line}`} title="Remove" onClick={() => onRemove(b.id)}>
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

function NoteField({ value, onSave }: { value: string; onSave: (note: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const done = () => draft.trim() !== value && onSave(draft.trim());
  return (
    <input
      className="bookmark-note"
      value={draft}
      placeholder="Add a note"
      maxLength={200}
      aria-label="Bookmark note"
      onChange={(e) => setDraft(e.currentTarget.value)}
      onBlur={done}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") setDraft(value);
      }}
    />
  );
}

export function BookmarksMenu({
  onOpen,
  onToggleHere,
  canBookmark,
  ...list
}: ListProps & { onOpen: () => void; onToggleHere: () => void; canBookmark: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  return (
    <div className="menu bookmarks-menu" ref={ref}>
      <button
        type="button"
        className="icon-button bookmarks-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Bookmarks${list.bookmarks.length ? ` (${list.bookmarks.length})` : ""}`}
        title={`Bookmarks (${BOOKMARK_KEYS} to add one)`}
        onClick={() => {
          if (!open) onOpen();
          setOpen((o) => !o);
        }}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4.5L5 21V4a1 1 0 0 1 1-1Zm1 2v12.3l5-3.2 5 3.2V5H7Z" />
        </svg>
        {list.bookmarks.length > 0 && <span className="bookmarks-count">{list.bookmarks.length}</span>}
      </button>
      {open && (
        <div className="menu-list bookmarks-pop" role="dialog" aria-label="Bookmarks">
          <BookmarkList {...list} onPick={(id) => (setOpen(false), list.onPick(id))} />
          {canBookmark && (
            <button type="button" className="bookmark-here" onClick={() => (setOpen(false), onToggleHere())}>
              Toggle a bookmark on the cursor's line <span className="muted small">{BOOKMARK_KEYS}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
