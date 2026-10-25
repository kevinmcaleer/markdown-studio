import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import { files, type FileMeta } from "./filesApi";

// The big title at the top of a note, like Obsidian's inline title: the file
// name without its extension. Editing it renames the file and keeps the
// extension, so "Ideas.md" titled "Plans" becomes "Plans.md".

/** Splits "Ideas.md" into ["Ideas", ".md"]. A leading dot (".env") isn't an extension. */
export function splitName(name: string): [stem: string, ext: string] {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
}

/** The file name a typed title gives, or null when it leaves the name as it is. */
export function nameFromTitle(title: string, name: string): string | null {
  const [, ext] = splitName(name);
  let stem = title.replace(/\s+/g, " ").trim();
  // Typing the extension too ("Plans.md") shouldn't double it up.
  if (ext && stem.toLowerCase().endsWith(ext.toLowerCase())) stem = stem.slice(0, -ext.length).trimEnd();
  if (!stem) return null;
  const next = stem + ext;
  return next === name ? null : next;
}

export function NoteTitle({
  file,
  canRename,
  onRenamed,
  onEnter,
}: {
  file: FileMeta;
  canRename: boolean;
  onRenamed: (file: FileMeta) => void;
  /** Enter in the title moves on to the note itself. */
  onEnter?: () => void;
}) {
  const title = splitName(file.name)[0];
  const [draft, setDraft] = useState(title);
  const [error, setError] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);

  // A rename from elsewhere (the header, the file list) shows up here too,
  // unless someone is typing in the title right now.
  useEffect(() => {
    if (document.activeElement !== field.current) setDraft(title);
  }, [title]);

  // Long titles wrap onto more lines rather than scrolling sideways.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  if (!canRename) return <h1 className="note-title">{title}</h1>;

  async function commit() {
    const name = nameFromTitle(draft, file.name);
    if (name === null) {
      setDraft(title);
      return;
    }
    try {
      onRenamed((await files.rename(file.id, name)).file);
      setError("");
    } catch (err) {
      setDraft(title);
      setError(err instanceof ApiError ? err.message : "Couldn't rename it.");
    }
  }

  return (
    <div className="note-title-wrap">
      <textarea
        ref={field}
        className="note-title"
        rows={1}
        value={draft}
        placeholder="Untitled"
        aria-label="Title"
        spellCheck
        onChange={(e) => setDraft(e.target.value.replace(/\n/g, ""))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
            onEnter?.();
          }
          if (e.key === "Escape") {
            setDraft(title);
            // Let the blur see the reverted title, not the typed one.
            requestAnimationFrame(() => field.current?.blur());
          }
        }}
        onBlur={commit}
      />
      {error && (
        <p className="error-text small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
