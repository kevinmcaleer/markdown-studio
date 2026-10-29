import { useEffect, useMemo, useRef, useState } from "react";
import { DECK_SUFFIX } from "../decks/deck";
import { Link } from "../Link";
import { files, isMarkdown, type FileMeta, type Tree } from "./filesApi";
import { renderMarkdown } from "@markdown-studio/markdown-editor";
import "./notesHome.css";

// The Notes home page, shown at /notes when no note is open: a tile to start a
// new document, then the most recent notes as cards with a picture of their
// first page, like the Google Docs start page.

/** Markdown notes (not decks), most recently changed first. */
export function recentNotes(tree: Tree): FileMeta[] {
  return tree.files
    .filter((f) => isMarkdown(f) && !f.name.toLowerCase().endsWith(DECK_SUFFIX))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id - a.id);
}

/** A note's name for its card: the file name without .md. */
export function noteTitle(file: Pick<FileMeta, "name">): string {
  return file.name.replace(/\.(md|markdown)$/i, "") || file.name;
}

/** The start of a note, enough to fill the first page of its card. */
export function firstPage(text: string): string {
  const lines = text.split("\n").slice(0, 80).join("\n");
  return lines.length > 4000 ? lines.slice(0, 4000) : lines;
}

export function NotesHome({
  tree,
  onNew,
  onMenu,
}: {
  tree: Tree | null;
  onNew: () => void;
  onMenu: (file: FileMeta, anchor: HTMLElement) => void;
}) {
  const notes = useMemo(() => (tree ? recentNotes(tree) : []), [tree]);
  return (
    <div className="notes-home">
      <section className="notes-home-start" aria-labelledby="notes-home-start">
        <h2 id="notes-home-start">Start a new document</h2>
        <button type="button" className="doc-new" onClick={onNew} aria-label="New blank document">
          <span className="doc-new-page">
            <svg width="48" height="48" viewBox="0 0 48 48" aria-hidden="true">
              <path d="M24 10v28M10 24h28" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
            </svg>
          </span>
          <span className="doc-new-label">Blank</span>
        </button>
      </section>
      <section className="notes-home-recent" aria-labelledby="notes-home-recent">
        <h2 id="notes-home-recent">Recent documents</h2>
        {!tree ? (
          <p className="muted" aria-busy="true">
            Loading…
          </p>
        ) : notes.length === 0 ? (
          <p className="muted">No documents yet. Start one above, or upload Markdown files from the Files panel.</p>
        ) : (
          <ul className="doc-grid">
            {notes.map((file) => (
              <DocCard key={file.id} file={file} onMenu={onMenu} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function DocCard({ file, onMenu }: { file: FileMeta; onMenu: (file: FileMeta, anchor: HTMLElement) => void }) {
  const title = noteTitle(file);
  const created = new Date(file.created_at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  return (
    <li className="doc-card">
      <Link href={`/notes/${file.id}`} className="doc-card-link" title={file.name}>
        <FirstPage file={file} />
        <span className="doc-card-body">
          <span className="doc-card-title">{title}</span>
          <span className="doc-card-meta muted small">
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 1.5h5.5L13 5v9.5H4zM9.5 1.5V5H13M6 8h5M6 10.5h5M6 13h3" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
            </svg>
            <span>
              Created <time dateTime={file.created_at}>{created}</time>
            </span>
          </span>
        </span>
      </Link>
      <button type="button" className="icon-button doc-card-menu" aria-label={`More actions for ${title}`} title="More actions" onClick={(e) => onMenu(file, e.currentTarget)}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="3.5" r="1.2" fill="currentColor" />
          <circle cx="8" cy="8" r="1.2" fill="currentColor" />
          <circle cx="8" cy="12.5" r="1.2" fill="currentColor" />
        </svg>
      </button>
    </li>
  );
}

/** A small rendered copy of the note's first page. Loads once the card scrolls into view. */
function FirstPage({ file }: { file: FileMeta }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    if (typeof IntersectionObserver === "undefined") return setVisible(true);
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let live = true;
    files.text(file.id).then(
      (t) => live && setText(t),
      () => live && setText(""),
    );
    return () => {
      live = false;
    };
  }, [visible, file.id, file.updated_at]);

  const html = useMemo(() => (text ? renderMarkdown(firstPage(text)) : ""), [text]);
  return (
    <span ref={ref} className="doc-card-thumb" aria-hidden="true">
      {html && <span className="doc-card-page prose" dangerouslySetInnerHTML={{ __html: html }} />}
    </span>
  );
}
