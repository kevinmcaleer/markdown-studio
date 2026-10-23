import { keymap } from "@codemirror/view";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { ApiError } from "../api";
import { useNoteComments } from "../comments/useNoteComments";
import { Link } from "../Link";
import { ShareButton } from "../sharing/ShareButton";
import { useSession } from "../session";
import { DownloadMenu } from "./DownloadMenu";
import { Editor } from "./Editor";
import { files, formatSize, isMarkdown, isText, TABLES_MIME, withShare, type FileMeta, type FileRole } from "./filesApi";
import { LiveNote, type LiveStatus, type Peer } from "./live";
import { renderMarkdown } from "./markdown";

type Mode = "write" | "split" | "read";

const MODE_KEY = "notes.mode";

type Loaded = { file: FileMeta; role: FileRole };

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
        if (live) setLoaded({ file, role });
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
  if (!isText(loaded.file)) return <BinaryFile file={loaded.file} />;
  return <TextFile {...loaded} onRenamed={onRenamed} onSaved={onSaved} />;
}

function TextFile({
  file: initialFile,
  role,
  onRenamed,
  onSaved,
}: Loaded & { onRenamed: () => void; onSaved: (file: FileMeta) => void }) {
  const { user } = useSession();
  const [file, setFile] = useState(initialFile);
  const markdown = isMarkdown(file);
  const canEdit = role === "edit" || role === "owner";
  const [mode, setMode] = useState<Mode>(() => (markdown ? readMode() : "write"));
  const live = useLiveNote(file.id, user?.username ?? "Guest");
  const [text, setText] = useState<string | null>(null);
  const preview = useDeferredValue(text ?? "");
  const html = useMemo(() => (markdown && mode !== "write" ? renderMarkdown(preview) : ""), [markdown, mode, preview]);
  const comments = useNoteComments({ fileId: file.id, doc: text ?? "", role });
  const extensions = useMemo(
    () => [
      ...(live.note ? [yCollab(live.note.text, live.note.provider.awareness, { undoManager: live.note.undo }), keymap.of(yUndoManagerKeymap)] : []),
      ...comments.extensions,
    ],
    [live.note, comments.extensions],
  );

  useEffect(() => {
    if (!live.note || !live.ready) return;
    const ytext = live.note.text;
    const update = () => setText(ytext.toString());
    update();
    ytext.observe(update);
    return () => ytext.unobserve(update);
  }, [live.note, live.ready]);

  // The server saves; refresh the file's size and date in the list now and then.
  const saved = useRef(onSaved);
  saved.current = onSaved;
  useEffect(() => {
    if (live.status !== "live" || text === null) return;
    const timer = window.setTimeout(() => files.info(file.id).then(({ file }) => saved.current(file), () => {}), 3000);
    return () => window.clearTimeout(timer);
  }, [text, live.status, file.id]);

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
        <LiveStatusBadge status={live.status} readOnly={!canEdit} />
        <div className="spacer" />
        <Presence peers={live.peers} />
        {markdown && (
          <div className="segmented" role="group" aria-label="View">
            {(["write", "split", "read"] as const).map((m) => (
              <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>
                {m === "write" ? "Write" : m === "split" ? "Split" : "Preview"}
              </button>
            ))}
          </div>
        )}
        {comments.button}
        {role === "owner" && <ShareButton fileId={file.id} fileName={file.name} />}
        <DownloadMenu file={file} markdown={markdown} />
      </header>
      {live.status === "closed" ? (
        <div className="notes-empty">
          <p className="error">This note was deleted, or you no longer have access to it.</p>
          <Link href="/notes">Back to your files</Link>
        </div>
      ) : !live.ready || text === null ? (
        <div className="notes-empty muted" aria-busy="true">
          {live.status === "offline" ? "You're offline, and this note hasn't been opened on this device before." : ""}
        </div>
      ) : (
        <div className="note-main">
        <div className="note-body">
          {mode !== "read" && (
            <div className="note-pane note-source">
              <Editor initialDoc={live.note!.text.toString()} readOnly={!canEdit} history={false} extensions={extensions} onReady={comments.onReady} />
            </div>
          )}
          {markdown && mode !== "write" && (
            <div className="note-pane note-preview">
              <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />
            </div>
          )}
        </div>
        {comments.panel}
        </div>
      )}
    </article>
  );
}

/** Opens the note live for as long as the component is mounted. */
export function useLiveNote(fileId: number, name: string) {
  const [note, setNote] = useState<LiveNote | null>(null);
  const [ready, setReady] = useState(false);
  const [, rerender] = useState(0);

  useEffect(() => {
    const live = new LiveNote(fileId, { name, key: name === "Guest" ? String(Math.random()) : name });
    setNote(live);
    setReady(false);
    const unsubscribe = live.subscribe(() => rerender((n) => n + 1));
    live.ready.then(() => setReady(true));
    return () => {
      unsubscribe();
      live.destroy();
    };
  }, [fileId, name]);

  return { note, ready, status: note?.status ?? ("connecting" as LiveStatus), peers: note?.peers() ?? [] };
}

export function LiveStatusBadge({ status, readOnly }: { status: LiveStatus; readOnly: boolean }) {
  const label = { connecting: "Connecting…", live: readOnly ? "Read only" : "Saved", offline: "Offline: changes are kept on this device", closed: "" }[status];
  return (
    <span className={`note-status small ${status === "offline" ? "warn-text" : "muted"}`} aria-live="polite">
      {status === "live" && <span className="live-dot" aria-hidden="true" />}
      {label}
    </span>
  );
}

export function Presence({ peers }: { peers: Peer[] }) {
  if (peers.length < 2) return null;
  return (
    <ul className="presence" aria-label="Editing now">
      {peers.map((p) => (
        <li key={p.clientId} title={p.self ? `${p.name} (you)` : p.name} style={{ background: p.color }}>
          {p.name.slice(0, 1).toUpperCase()}
        </li>
      ))}
    </ul>
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
  const src = withShare(`/api/files/${file.id}/content`);
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
        ) : file.mime_type === TABLES_MIME ? (
          <p>
            This is a database. <Link href={`/tables/${file.id}`}>Open it in Tables</Link>
          </p>
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
