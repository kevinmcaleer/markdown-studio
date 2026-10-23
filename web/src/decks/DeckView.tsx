import { EditorView, keymap } from "@codemirror/view";
import { useEffect, useMemo, useRef, useState } from "react";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { ApiError } from "../api";
import { useNoteComments } from "../comments/useNoteComments";
import { Link } from "../Link";
import { Editor } from "../notes/Editor";
import { files, type FileMeta, type FileRole } from "../notes/filesApi";
import { LiveStatusBadge, Presence, useLiveNote } from "../notes/NoteView";
import { ShareButton } from "../sharing/ShareButton";
import { useSession } from "../session";
import { DECK_SUFFIX, deckTitle, parseDeck, slideAtLine } from "./deck";
import { ExportMenu } from "./ExportMenu";
import { Presentation } from "./Present";
import { SlideView } from "./SlideView";

// One deck: thumbnails down the side, the Markdown in the middle and the
// current slide on the right. The text is co-edited live, like a note.

type Mode = "edit" | "slides";

type Loaded = { file: FileMeta; role: FileRole };

export function DeckView({ fileId, onChanged }: { fileId: number; onChanged?: () => void }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    files.info(fileId).then(
      (data) => live && setLoaded(data),
      (err) => live && setError(err instanceof ApiError && err.status === 404 ? "This deck doesn't exist, or you don't have access to it." : "Couldn't open this deck."),
    );
    return () => {
      live = false;
    };
  }, [fileId]);

  if (error)
    return (
      <div className="notes-empty">
        <p className="error">{error}</p>
        <Link href="/decks">Back to your decks</Link>
      </div>
    );
  if (!loaded) return <div className="notes-empty" aria-busy="true" />;
  return <OpenDeck {...loaded} onChanged={onChanged} />;
}

function OpenDeck({ file: initialFile, role, onChanged }: Loaded & { onChanged?: () => void }) {
  const { user } = useSession();
  const [file, setFile] = useState(initialFile);
  const canEdit = role === "edit" || role === "owner";
  const [mode, setMode] = useState<Mode>(canEdit && window.innerWidth >= 700 ? "edit" : "slides");
  const live = useLiveNote(file.id, user?.username ?? "Guest");
  const [text, setText] = useState<string | null>(null);
  const deck = useMemo(() => parseDeck(text ?? ""), [text]);
  const [current, setCurrent] = useState(0);
  const [presenting, setPresenting] = useState<number | null>(null);
  const view = useRef<EditorView | null>(null);
  const comments = useNoteComments({ fileId: file.id, doc: text ?? "", role });

  // Which slide the cursor is on. Editor extensions are fixed at mount, so this reads the editor's own text.
  const cursor = useMemo(
    () =>
      EditorView.updateListener.of((update) => {
        if (!update.selectionSet && !update.docChanged) return;
        const line = update.state.doc.lineAt(update.state.selection.main.head).number - 1;
        setCurrent(slideAtLine(parseDeck(update.state.doc.toString()), line));
      }),
    [],
  );
  const extensions = useMemo(
    () => [
      ...(live.note ? [yCollab(live.note.text, live.note.provider.awareness, { undoManager: live.note.undo }), keymap.of(yUndoManagerKeymap)] : []),
      ...comments.extensions,
      cursor,
    ],
    [live.note, comments.extensions, cursor],
  );

  useEffect(() => {
    if (!live.note || !live.ready) return;
    const ytext = live.note.text;
    const update = () => setText(ytext.toString());
    update();
    ytext.observe(update);
    return () => ytext.unobserve(update);
  }, [live.note, live.ready]);

  const slide = deck.slides[Math.min(current, deck.slides.length - 1)];

  function select(index: number) {
    setCurrent(index);
    const v = view.current;
    const target = deck.slides[index];
    if (!v?.dom.isConnected || !target) return;
    const line = v.state.doc.line(Math.min(target.startLine + 1, v.state.doc.lines));
    // Put the cursor on the slide's first line with text.
    let pos = line.from;
    for (let n = line.number; n <= Math.min(target.endLine + 1, v.state.doc.lines); n++) {
      const l = v.state.doc.line(n);
      if (l.text.trim()) {
        pos = l.from;
        break;
      }
    }
    v.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 24 }) });
  }

  function addSlide() {
    const v = view.current;
    if (!v?.dom.isConnected) return;
    const after = slide ? v.state.doc.line(Math.min(slide.endLine + 1, v.state.doc.lines)).to : v.state.doc.length;
    const insert = `${after > 0 ? "\n\n---\n\n" : ""}## New slide\n\n- `;
    v.dispatch({ changes: { from: after, insert }, selection: { anchor: after + insert.length }, scrollIntoView: true });
    v.focus();
  }

  if (presenting !== null && text !== null)
    return <Presentation fileId={file.id} text={text} start={presenting} onExit={() => setPresenting(null)} />;

  const title = deckTitle(file);
  // Present starts on the selected slide, counted among the slides that are shown.
  const presentFrom = deck.slides.slice(0, current).filter((s) => !s.skipped).length;

  return (
    <article className={`note deck mode-${mode}`}>
      <header className="note-bar">
        <DeckName file={file} canRename={role === "owner"} onRenamed={(f) => (setFile(f), onChanged?.())} />
        <LiveStatusBadge status={live.status} readOnly={!canEdit} />
        <div className="spacer" />
        <Presence peers={live.peers} />
        {canEdit && (
          <div className="segmented" role="group" aria-label="View">
            {(["edit", "slides"] as const).map((m) => (
              <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>
                {m === "edit" ? "Edit" : "Slides"}
              </button>
            ))}
          </div>
        )}
        {comments.button}
        {role === "owner" && <ShareButton fileId={file.id} fileName={file.name} />}
        <ExportMenu file={file} title={title} text={() => live.note?.text.toString() ?? text ?? ""} author={user?.username} />
        <button type="button" className="primary present-button" disabled={!deck.slides.length} onClick={() => setPresenting(presentFrom)}>
          Present
        </button>
      </header>
      {live.status === "closed" ? (
        <div className="notes-empty">
          <p className="error">This deck was deleted, or you no longer have access to it.</p>
          <Link href="/decks">Back to your decks</Link>
        </div>
      ) : !live.ready || text === null ? (
        <div className="notes-empty muted" aria-busy="true">
          {live.status === "offline" ? "You're offline, and this deck hasn't been opened on this device before." : ""}
        </div>
      ) : (
        <div className="note-main">
          <div className="deck-body">
            <ol className="deck-rail" aria-label="Slides">
              {deck.slides.map((s) => (
                <li key={s.index}>
                  <button type="button" className={`deck-thumb ${s.index === current ? "current" : ""} ${s.skipped ? "skipped" : ""}`} aria-current={s.index === current} onClick={() => select(s.index)}>
                    <span className="deck-thumb-number">{s.index + 1}</span>
                    <SlideView slide={s} />
                  </button>
                </li>
              ))}
              {canEdit && mode === "edit" && (
                <li>
                  <button type="button" className="menu-button deck-add" onClick={addSlide}>
                    New slide
                  </button>
                </li>
              )}
            </ol>
            {mode === "edit" && (
              <div className="note-pane note-source deck-source">
                <Editor
                  initialDoc={live.note!.text.toString()}
                  readOnly={!canEdit}
                  history={false}
                  extensions={extensions}
                  onReady={(v) => {
                    view.current = v;
                    comments.onReady(v);
                  }}
                />
              </div>
            )}
            <div className="deck-stage">
              {slide ? <SlideView slide={slide} /> : <EmptyDeck canEdit={canEdit} />}
              {slide?.notes && <div className="deck-notes">{slide.notes}</div>}
              {slide?.skipped && <p className="muted small">This slide is hidden: it's skipped when presenting.</p>}
              {mode === "edit" && <DeckHelp />}
            </div>
          </div>
          {comments.panel}
        </div>
      )}
    </article>
  );
}

function EmptyDeck({ canEdit }: { canEdit: boolean }) {
  return (
    <div className="slide layout-statement">
      <div className="slide-inner">
        <div className="slide-body">
          <p className="muted">{canEdit ? "Start typing to add your first slide." : "This deck is empty."}</p>
        </div>
      </div>
    </div>
  );
}

function DeckHelp() {
  return (
    <details className="deck-help">
      <summary>How to write slides</summary>
      <ul>
        <li>
          Put a line with only <code>---</code> between slides.
        </li>
        <li>
          Start a slide with <code># Title</code> or <code>## Title</code>. A <code>#</code> title with a line under it makes a title slide.
        </li>
        <li>
          Speaker notes go after a line with only <code>???</code>.
        </li>
        <li>
          Pick a layout with <code>&lt;!-- layout: section --&gt;</code>: title, section, content, quote, statement or blank. Keynote layout names
          work too.
        </li>
        <li>
          <code>&lt;!-- transition: dissolve 1s --&gt;</code> sets the Keynote transition, and <code>&lt;!-- skipped --&gt;</code> hides a slide.
        </li>
        <li>Bullets, code, tables, quotes, images and ==highlights== all work.</li>
      </ul>
    </details>
  );
}

function DeckName({ file, canRename, onRenamed }: { file: FileMeta; canRename: boolean; onRenamed: (f: FileMeta) => void }) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const title = deckTitle(file);
  if (!editing)
    return (
      <h1 className="note-name">
        {canRename ? (
          <button type="button" title="Rename" onClick={() => setEditing(true)}>
            {title}
          </button>
        ) : (
          title
        )}
        {error && <span className="error-text small"> {error}</span>}
      </h1>
    );
  async function finish(name: string | null) {
    setEditing(false);
    if (name === null || !name.trim() || name.trim() === title) return;
    try {
      onRenamed((await files.rename(file.id, name.trim() + DECK_SUFFIX)).file);
      setError("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't rename it.");
    }
  }
  return (
    <input
      className="note-name-input"
      defaultValue={title}
      autoFocus
      aria-label="Deck name"
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(e.currentTarget.value);
        if (e.key === "Escape") finish(null);
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}
