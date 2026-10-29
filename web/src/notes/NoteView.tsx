import { openSearchPanel } from "@codemirror/search";
import { keymap, type EditorView } from "@codemirror/view";
import {
  Editor,
  findReplace,
  useFormatting,
  useWritingLint,
  slashMenu,
  smartPaste,
  proofing as proofingExtension,
  setProofing,
  useProofing,
  speechEditor,
  useDictation,
  useReadAloud,
  useDailyGoal,
  useTypewriter,
  WritingBar,
  setWriting,
  writingMode,
  writingStats,
  type SelectionStats,
} from "@markdown-studio/markdown-editor";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { ApiError } from "../api";
import { useNoteComments } from "../comments/useNoteComments";
import { Link } from "../Link";
import { ShareButton } from "../sharing/ShareButton";
import { SyncBanners, SyncMenu, useNoteSync } from "../sync/Sync";
import { useSession } from "../session";
import { DownloadMenu } from "./DownloadMenu";
import { files, formatSize, isMarkdown, isText, TABLES_MIME, withShare, type FileMeta, type FileRole } from "./filesApi";
import { LiveNote, type LiveStatus, type Peer } from "./live";
import { NoteTitle } from "./NoteTitle";
import { useFilePlace } from "./place/useFilePlace";
import { useOutline } from "./useOutline";

/** "write" is the live view (rendered as you type); "raw" shows all the Markdown. */
type Mode = "write" | "raw";

const MODES: { mode: Mode; label: string; title: string }[] = [
  { mode: "write", label: "Write", title: "Write, with the Markdown shown as it reads" },
  { mode: "raw", label: "Raw", title: "All the Markdown, as text" },
];

// A new key, so everyone starts on the live view rather than their old choice.
const MODE_KEY = "notes.view";

type Loaded = { file: FileMeta; role: FileRole };

// Spelling, grammar and the right-click menu. Built once; settings arrive by effect.
const notesProofing = proofingExtension();

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
  const comments = useNoteComments({ fileId: file.id, doc: text ?? "", role, text: live.note?.text, suggestions: true });
  const outline = useOutline({
    fileId: file.id,
    doc: text ?? "",
    canEdit,
    note: live.note,
    threads: comments.placed,
  });
  // Cloud sync needs an account, so it's for signed-in people who can edit.
  const noteSync = useNoteSync(file.id, markdown && canEdit && user !== null);
  const [focus, setFocus] = useState(false);
  const [typewriter, setTypewriter] = useTypewriter();
  const [selection, setSelection] = useState<SelectionStats>(null);
  const goal = useDailyGoal();
  const lint = useWritingLint();
  const addWritten = goal.add;
  const proofing = useProofing(user !== null);
  // Pasted and dropped images go beside the note when it's yours, otherwise in your own files.
  const folderId = role === "owner" ? file.folder_id : null;
  const treeChanged = useRef(onRenamed);
  treeChanged.current = onRenamed;
  const uploadImage = useMemo(
    () =>
      user && canEdit
        ? async (image: File) => {
            const { file: stored } = await files.upload(image, folderId);
            treeChanged.current();
            return `/api/files/${stored.id}/content`;
          }
        : undefined,
    [user, canEdit, folderId],
  );
  const format = useFormatting({ show: markdown, readOnly: !canEdit && !comments.suggesting, uploadImage });
  // Where this person left off, their bookmarks and folds, and how they like this note opened.
  const place = useFilePlace({ fileId: file.id, signedIn: user !== null, text: live.note?.text, folds: markdown });
  const rememberView = place.rememberView;
  useEffect(() => {
    if (!markdown || place.view === undefined) return;
    const next = toMode(place.view);
    setMode(next);
    // A note last opened in Split or Preview is saved as the live view from now on.
    if (next !== place.view) rememberView(next);
  }, [markdown, place.view, rememberView]);
  const extensions = useMemo(
    () => [
      ...(live.note ? [yCollab(live.note.text, live.note.provider.awareness, { undoManager: live.note.undo }), keymap.of(yUndoManagerKeymap)] : []),
      ...comments.extensions,
      ...place.extensions,
      ...(markdown ? outline.extensions : []),
      ...(markdown ? [slashMenu(), smartPaste({ uploadImage }), ...lint.extensions, notesProofing, ...format.extensions] : []),
      findReplace(),
      writingMode(),
      speechEditor(),
      writingStats({ onSelection: setSelection, onWritten: addWritten }),
    ],
    [live.note, comments.extensions, place.extensions, outline.extensions, markdown, uploadImage, addWritten, lint.extensions, format.extensions],
  );
  const editorView = useRef<EditorView | null>(null);
  const writing = useRef({ focus, typewriter });
  writing.current = { focus, typewriter };
  const proofingSettings = useRef(proofing.settings);
  proofingSettings.current = proofing.settings;
  const commentsReady = comments.onReady;
  const placeReady = place.onReady;
  const outlineReady = outline.onReady;
  const lintReady = lint.onReady;
  const formatReady = format.onReady;
  const onEditorReady = useCallback(
    (view: EditorView) => {
      editorView.current = view;
      view.dispatch({ effects: setWriting.of(writing.current) });
      if (markdown) view.dispatch({ effects: setProofing.of(proofingSettings.current) });
      commentsReady(view);
      if (markdown) outlineReady(view);
      if (markdown) lintReady(view);
      if (markdown) formatReady(view);
      placeReady(view);
    },
    [commentsReady, outlineReady, placeReady, lintReady, formatReady, markdown],
  );
  useWritingMode(focus, setFocus);
  const openEditor = () => (editorView.current?.dom.isConnected ? editorView.current : null);
  const dictation = useDictation({ view: openEditor, enabled: canEdit || comments.suggesting });
  const readAloud = useReadAloud({ view: openEditor, doc: () => live.note?.text.toString() ?? text ?? "" });
  useEffect(() => {
    const view = editorView.current;
    if (view?.dom.isConnected) view.dispatch({ effects: setWriting.of({ focus, typewriter }) });
  }, [focus, typewriter]);
  useEffect(() => {
    const view = editorView.current;
    if (markdown && view?.dom.isConnected) view.dispatch({ effects: setProofing.of(proofing.settings) });
  }, [markdown, proofing.settings]);
  const renamed = (f: FileMeta) => (setFile(f), onRenamed());
  const title = (
    <NoteTitle file={file} canRename={role === "owner"} onRenamed={renamed} onEnter={() => editorView.current?.focus()} />
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

  // The choice becomes this note's view, and the default for notes without one.
  const chooseMode = (next: Mode) => {
    setMode(next);
    place.rememberView(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      /* private mode */
    }
  };

  return (
    <article className={`note mode-${mode}`}>
      <header className="note-bar">
        <FileName file={file} canRename={role === "owner"} onRenamed={renamed} />
        <LiveStatusBadge status={live.status} readOnly={!canEdit && !comments.suggesting} />
        <div className="spacer" />
        <Presence peers={live.peers} />
        {markdown && (
          <div className="segmented" role="group" aria-label="View">
            {MODES.map((m) => (
              <button key={m.mode} type="button" title={m.title} aria-pressed={mode === m.mode} onClick={() => chooseMode(m.mode)}>
                {m.label}
              </button>
            ))}
          </div>
        )}
        {comments.suggestSwitch}
        {dictation.button}
        {markdown && outline.button}
        {place.button}
        {comments.button}
        {role === "owner" && <ShareButton fileId={file.id} fileName={file.name} />}
        <SyncMenu note={file} role={role} sync={noteSync} currentText={() => live.note?.text.toString() ?? text ?? ""} />
        <DownloadMenu file={file} markdown={markdown} />
      </header>
      <SyncBanners sync={noteSync} onCopy={onRenamed} />
      {format.bar}
      {live.status === "closed" ? (
        <div className="notes-empty">
          <p className="error">This note was deleted, or you no longer have access to it.</p>
          <Link href="/notes">Back to your files</Link>
        </div>
      ) : !live.ready || text === null || !place.loaded ? (
        <div className="notes-empty muted" aria-busy="true">
          {live.status === "offline" ? "You're offline, and this note hasn't been opened on this device before." : ""}
        </div>
      ) : (
        <div className="note-main">
        {markdown && outline.panel}
        <div className="note-body">
          <div className="note-pane note-source titled">
            {title}
            <Editor
              initialDoc={live.note!.text.toString()}
              // Commenters type in Suggesting mode; what they type becomes suggestions, not edits.
              // Viewers get the same rendered note, read only.
              readOnly={!canEdit && !comments.suggesting}
              history={false}
              livePreview={markdown && mode === "write"}
              extensions={extensions}
              onReady={onEditorReady}
            />
          </div>
        </div>
        {comments.panel}
        {place.toast}
        </div>
      )}
      {readAloud.bar}
      {live.ready && text !== null && (
        <WritingBar
          text={preview}
          selection={selection}
          goal={goal}
          focus={focus}
          onFocus={setFocus}
          {...(readAloud.supported && { reading: readAloud.reading, onReadAloud: readAloud.toggle })}
          typewriter={typewriter}
          onTypewriter={setTypewriter}
          onFind={() => editorView.current && openSearchPanel(editorView.current)}
          lint={markdown ? lint.status : undefined}
          {...(markdown && { proofing })}
        />
      )}
    </article>
  );
}

/** Focus mode hides the app around the note; Ctrl/Cmd+Shift+F toggles it and Escape leaves. */
function useWritingMode(focus: boolean, setFocus: (update: (on: boolean) => boolean) => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setFocus((on) => !on);
      } else if (e.key === "Escape" && !e.defaultPrevented) setFocus(() => false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setFocus]);

  useEffect(() => {
    document.documentElement.classList.toggle("writing-focus", focus);
    return () => document.documentElement.classList.remove("writing-focus");
  }, [focus]);
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

/** Raw, or the live view. Split and Preview have gone, so a choice saved as either opens the live view. */
export function toMode(value: unknown): Mode {
  return value === "raw" ? "raw" : "write";
}

function readMode(): Mode {
  try {
    const value = localStorage.getItem(MODE_KEY);
    const mode = toMode(value);
    if (value !== null && value !== mode) localStorage.setItem(MODE_KEY, mode);
    return mode;
  } catch {
    /* private mode */
  }
  return "write";
}
