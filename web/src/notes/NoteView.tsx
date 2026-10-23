import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../api";
import { Link } from "../Link";
import { Editor } from "./Editor";
import { files, formatSize, isMarkdown, isText, type FileMeta, type FileRole } from "./filesApi";
import { renderMarkdown } from "./markdown";

type Mode = "write" | "split" | "read";
type SaveState = "saved" | "saving" | "unsaved" | "error";

const MODE_KEY = "notes.mode";
const SAVE_DELAY = 700;

type Loaded = { file: FileMeta; role: FileRole; text: string | null };

export function NoteView({
  fileId,
  onRenamed,
  onSaved,
}: {
  fileId: number;
  onRenamed: () => void;
  onSaved: (file: FileMeta) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const { file, role } = await files.info(fileId);
        const text = isText(file) ? await files.text(fileId) : null;
        if (live) setLoaded({ file, role, text });
      } catch (err) {
        if (live) setError(err instanceof ApiError && err.status === 404 ? "This file doesn't exist, or you don't have access to it." : "Couldn't open this file.");
      }
    })();
    return () => {
      live = false;
    };
  }, [fileId]);

  if (error)
    return (
      <div className="notes-empty">
        <p className="error">{error}</p>
        <Link href="/notes">Back to your files</Link>
      </div>
    );
  if (!loaded) return <div className="notes-empty" aria-busy="true" />;
  if (loaded.text === null) return <BinaryFile file={loaded.file} />;
  return <TextFile {...loaded} text={loaded.text} onRenamed={onRenamed} onSaved={onSaved} />;
}

function TextFile({
  file: initialFile,
  role,
  text: initialText,
  onRenamed,
  onSaved,
}: Loaded & { text: string; onRenamed: () => void; onSaved: (file: FileMeta) => void }) {
  const [file, setFile] = useState(initialFile);
  const markdown = isMarkdown(file);
  const canEdit = role === "edit" || role === "owner";
  const [mode, setMode] = useState<Mode>(() => (markdown ? readMode() : "write"));
  const [text, setText] = useState(initialText);
  const preview = useDeferredValue(text);
  const html = useMemo(() => (markdown && mode !== "write" ? renderMarkdown(preview) : ""), [markdown, mode, preview]);
  const save = useAutosave(file.id, setFile, onSaved);

  useEffect(() => {
    try {
      if (markdown) localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* private mode */
    }
  }, [markdown, mode]);

  return (
    <article className={`note mode-${mode}`}>
      <header className="note-bar">
        <FileName file={file} canRename={role === "owner"} onRenamed={(f) => (setFile(f), onRenamed())} />
        <SaveStatus state={save.state} readOnly={!canEdit} />
        <div className="spacer" />
        {markdown && (
          <div className="segmented" role="group" aria-label="View">
            {(["write", "split", "read"] as const).map((m) => (
              <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>
                {m === "write" ? "Write" : m === "split" ? "Split" : "Preview"}
              </button>
            ))}
          </div>
        )}
        <a className="menu-button" href={files.downloadUrl(file.id)}>
          Download
        </a>
      </header>
      <div className="note-body">
        {mode !== "read" && (
          <div className="note-pane note-source">
            <Editor
              initialDoc={initialText}
              readOnly={!canEdit}
              onChange={(doc) => {
                setText(doc);
                save.change(doc);
              }}
            />
          </div>
        )}
        {markdown && mode !== "write" && (
          <div className="note-pane note-preview">
            <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />
          </div>
        )}
      </div>
    </article>
  );
}

/** Saves a little after typing stops, and once more when the note closes. */
function useAutosave(fileId: number, setFile: (f: FileMeta) => void, onSaved: (f: FileMeta) => void) {
  const [state, setState] = useState<SaveState>("saved");
  const pending = useRef<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const saved = useRef({ setFile, onSaved });
  saved.current = { setFile, onSaved };

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    const doc = pending.current;
    if (doc === null) return;
    pending.current = null;
    setState("saving");
    try {
      const { file } = await files.save(fileId, doc);
      saved.current.setFile(file);
      saved.current.onSaved(file);
      setState(pending.current === null ? "saved" : "unsaved");
    } catch {
      // Keep the text so the next edit (or leaving the note) tries again.
      pending.current ??= doc;
      setState("error");
    }
  }, [fileId]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (pending.current !== null) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
      flush();
    };
  }, [flush]);

  const change = useCallback(
    (doc: string) => {
      pending.current = doc;
      setState("unsaved");
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, SAVE_DELAY);
    },
    [flush],
  );

  return { state, change };
}

function SaveStatus({ state, readOnly }: { state: SaveState; readOnly: boolean }) {
  if (readOnly) return <span className="note-status muted small">Read only</span>;
  const label = { saved: "Saved", saving: "Saving…", unsaved: "Editing", error: "Not saved, retrying on next edit" }[state];
  return (
    <span className={`note-status small ${state === "error" ? "error-text" : "muted"}`} aria-live="polite">
      {label}
    </span>
  );
}

function FileName({ file, canRename, onRenamed }: { file: FileMeta; canRename: boolean; onRenamed: (f: FileMeta) => void }) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  if (!editing)
    return (
      <h1 className="note-name">
        {canRename ? (
          <button type="button" title="Rename" onClick={() => setEditing(true)}>
            {file.name}
          </button>
        ) : (
          file.name
        )}
        {error && <span className="error-text small"> {error}</span>}
      </h1>
    );
  async function finish(name: string | null) {
    setEditing(false);
    if (name === null || !name.trim() || name.trim() === file.name) return;
    try {
      onRenamed((await files.rename(file.id, name)).file);
      setError("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't rename it.");
    }
  }
  return (
    <input
      className="note-name-input"
      defaultValue={file.name}
      autoFocus
      aria-label="File name"
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(e.currentTarget.value);
        if (e.key === "Escape") finish(null);
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}

function BinaryFile({ file }: { file: FileMeta }) {
  const src = `/api/files/${file.id}/content`;
  return (
    <article className="note">
      <header className="note-bar">
        <h1 className="note-name">{file.name}</h1>
        <span className="note-status muted small">{formatSize(file.size)}</span>
        <div className="spacer" />
        <a className="menu-button" href={files.downloadUrl(file.id)}>
          Download
        </a>
      </header>
      <div className="note-binary">
        {file.mime_type.startsWith("image/") ? (
          <img src={src} alt={file.name} />
        ) : (
          <p className="muted">There's no preview for this kind of file. Download it to open it.</p>
        )}
      </div>
    </article>
  );
}

function readMode(): Mode {
  try {
    const value = localStorage.getItem(MODE_KEY);
    if (value === "write" || value === "split" || value === "read") return value;
  } catch {
    /* private mode */
  }
  return window.innerWidth < 900 ? "write" : "split";
}
