import { EditorView, keymap } from "@codemirror/view";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { ApiError } from "../api";
import { useNoteComments } from "../comments/useNoteComments";
import { Link } from "../Link";
import { Editor } from "@markdown-studio/markdown-editor";
import { files, type FileMeta, type FileRole } from "../notes/filesApi";
import { LiveStatusBadge, Presence, useLiveNote } from "../notes/NoteView";
import { slashMenu } from "@markdown-studio/markdown-editor";
import { ShareButton } from "../sharing/ShareButton";
import { useSession } from "../session";
import { DECK_SUFFIX, deckTitle, moveSlide, parseDeck, slideAtLine, slideAtOffset, slidePin, type Deck } from "./deck";
import { ExportMenu } from "./ExportMenu";
import { Presentation } from "./Present";
import { deckCommands } from "./slashCommands";
import { SlideView } from "./SlideView";

// One deck: thumbnails down the side, the Markdown in the middle and the
// current slide on the right. The text is co-edited live, like a note.

type Mode = "edit" | "slides";

// How much of the space beside the rail the Markdown gets; the slide gets the rest.
const SPLIT_KEY = "decks.split";
const SPLIT_DEFAULT = 0.5;
const SPLIT_MIN = 0.2;
const SPLIT_MAX = 0.8;

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
  const [split, setSplit] = useState(readSplit);
  const live = useLiveNote(file.id, user?.username ?? "Guest");
  const [text, setText] = useState<string | null>(null);
  const deck = useMemo(() => parseDeck(text ?? ""), [text]);
  const [current, setCurrent] = useState(0);
  const [presenting, setPresenting] = useState<number | null>(null);
  const view = useRef<EditorView | null>(null);
  const rail = useRef<HTMLOListElement | null>(null);
  // While a thumbnail is dragged: which slide, and the gap it would drop into (before slide n).
  const [drag, setDrag] = useState<{ from: number; before: number | null } | null>(null);
  const refocus = useRef<number | null>(null);
  // With no editor (or the cursor on a blank line), a comment goes on the slide being shown.
  const pinSlide = deck.slides[Math.min(current, deck.slides.length - 1)];
  const fallbackPins = useMemo(() => {
    const pin = pinSlide && text !== null ? slidePin(text, pinSlide) : null;
    return pin ? [pin] : [];
  }, [text, pinSlide]);
  const comments = useNoteComments({
    fileId: file.id,
    doc: text ?? "",
    role,
    text: live.note?.text,
    fallbackPins,
    onFocusRange: (range) => text !== null && setCurrent(slideAtOffset(deck, text, range.from)),
  });
  // How many open comments are on each slide, for the thumbnails.
  const commentCounts = useMemo(() => {
    const counts = new Map<number, number>();
    if (text === null) return counts;
    for (const { range } of comments.placed) {
      if (!range) continue;
      const index = slideAtOffset(deck, text, range.from);
      counts.set(index, (counts.get(index) ?? 0) + 1);
    }
    return counts;
  }, [comments.placed, deck, text]);

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
      slashMenu(deckCommands),
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

  function select(index: number, slides: Deck = deck) {
    setCurrent(index);
    const v = view.current;
    const target = slides.slides[index];
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

  // Reorders the slides in the shared text, as one change so it undoes in one step.
  function reorder(from: number, before: number) {
    const ytext = live.note?.text;
    if (!ytext || !canEdit) return;
    const old = ytext.toString();
    const next = moveSlide(old, from, before);
    if (next === old) return;
    // Only rewrite the part between the common start and end, so other people's cursors and comments elsewhere stay put.
    let a = 0;
    while (a < old.length && a < next.length && old[a] === next[a]) a++;
    let b = 0;
    while (b < old.length - a && b < next.length - a && old[old.length - 1 - b] === next[next.length - 1 - b]) b++;
    const apply = () => {
      ytext.delete(a, old.length - a - b);
      ytext.insert(a, next.slice(a, next.length - b));
    };
    if (ytext.doc) ytext.doc.transact(apply);
    else apply();
    const to = before > from ? before - 1 : before;
    select(to, parseDeck(next));
  }

  function dragOver(e: React.DragEvent<HTMLLIElement>, index: number) {
    if (!drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const box = e.currentTarget.getBoundingClientRect();
    // The rail runs across the top on phones, so the drop side follows its direction.
    const across = rail.current && getComputedStyle(rail.current).flexDirection === "row";
    const after = across ? e.clientX > box.left + box.width / 2 : e.clientY > box.top + box.height / 2;
    const before = index + (after ? 1 : 0);
    if (before !== drag.before) setDrag({ ...drag, before });
  }

  function thumbKey(e: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!e.altKey || !canEdit) return;
    const step = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const to = index + step;
    if (to < 0 || to >= deck.slides.length) return;
    refocus.current = to;
    reorder(index, step < 0 ? to : to + 1);
  }

  // After a keyboard move, keep focus on the slide that moved.
  useEffect(() => {
    if (refocus.current === null) return;
    rail.current?.querySelectorAll<HTMLButtonElement>(".deck-thumb")[refocus.current]?.focus();
    refocus.current = null;
  }, [deck]);

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
  // Where the drop line shows: nowhere when the drop wouldn't move the slide.
  const dropAt = drag && drag.before !== null && drag.before !== drag.from && drag.before !== drag.from + 1 ? drag.before : null;
  const canReorder = canEdit && deck.slides.length > 1;

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
          <div className="deck-body" style={{ "--deck-source": `${split * 100}fr`, "--deck-stage": `${(1 - split) * 100}fr` } as CSSProperties}>
            <ol
              ref={rail}
              className="deck-rail"
              aria-label="Slides"
              onDragOver={(e) => drag && e.preventDefault()}
              onDrop={(e) => {
                if (!drag) return;
                e.preventDefault();
                if (drag.before !== null) reorder(drag.from, drag.before);
                setDrag(null);
              }}
            >
              {deck.slides.map((s) => (
                <li
                  key={s.index}
                  className={[drag?.from === s.index && "dragging", dropAt === s.index && "drop-before", dropAt === deck.slides.length && s.index === deck.slides.length - 1 && "drop-after"]
                    .filter(Boolean)
                    .join(" ")}
                  draggable={canReorder}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "move";
                    // Firefox only starts a drag that carries some data.
                    e.dataTransfer.setData("text/plain", s.title ?? `Slide ${s.index + 1}`);
                    setDrag({ from: s.index, before: null });
                  }}
                  onDragOver={(e) => dragOver(e, s.index)}
                  onDragEnd={() => setDrag(null)}
                >
                  <button
                    type="button"
                    className={`deck-thumb ${s.index === current ? "current" : ""} ${s.skipped ? "skipped" : ""}`}
                    aria-current={s.index === current}
                    aria-keyshortcuts={canReorder ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
                    title={canReorder ? "Drag to reorder, or press Alt+Up or Alt+Down" : undefined}
                    onClick={() => select(s.index)}
                    onKeyDown={(e) => thumbKey(e, s.index)}
                  >
                    <span className="deck-thumb-number">{s.index + 1}</span>
                    {commentCounts.has(s.index) && (
                      <span className="deck-thumb-comments" title={`${commentCounts.get(s.index)} comment${commentCounts.get(s.index) === 1 ? "" : "s"}`}>
                        {commentCounts.get(s.index)}
                      </span>
                    )}
                    <SlideView slide={s} />
                  </button>
                </li>
              ))}
              {canEdit && mode === "edit" && (
                <li onDragOver={(e) => drag && (e.preventDefault(), drag.before !== deck.slides.length && setDrag({ ...drag, before: deck.slides.length }))}>
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
            {mode === "edit" && <SplitHandle split={split} onChange={setSplit} />}
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

// The divider between the Markdown and the slide: drag it, or use the arrow keys.
// Double-click (or Enter) puts it back to half and half. The split is remembered on this device.
function SplitHandle({ split, onChange }: { split: number; onChange: (split: number) => void }) {
  const set = (value: number) => {
    const next = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, value));
    onChange(next);
    saveSplit(next);
  };
  const reset = () => {
    onChange(SPLIT_DEFAULT);
    saveSplit(SPLIT_DEFAULT);
  };

  return (
    <div
      className="deck-split"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the editor and the slide"
      aria-valuemin={SPLIT_MIN * 100}
      aria-valuemax={SPLIT_MAX * 100}
      aria-valuenow={Math.round(split * 100)}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const handle = e.currentTarget;
        const source = handle.previousElementSibling!.getBoundingClientRect();
        const stage = handle.nextElementSibling!.getBoundingClientRect();
        const width = stage.right - source.left;
        handle.setPointerCapture(e.pointerId);
        handle.classList.add("dragging");
        let last = split;
        const move = (ev: PointerEvent) => {
          last = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, (ev.clientX - source.left) / width));
          onChange(last);
        };
        const end = () => {
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", end);
          handle.removeEventListener("pointercancel", end);
          handle.classList.remove("dragging");
          saveSplit(last);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", end);
        handle.addEventListener("pointercancel", end);
      }}
      onDoubleClick={reset}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") set(split - 0.05);
        else if (e.key === "ArrowRight") set(split + 0.05);
        else if (e.key === "Enter") reset();
        else return;
        e.preventDefault();
      }}
    />
  );
}

function readSplit(): number {
  try {
    const value = Number(localStorage.getItem(SPLIT_KEY));
    if (value >= SPLIT_MIN && value <= SPLIT_MAX) return value;
  } catch {
    /* private mode */
  }
  return SPLIT_DEFAULT;
}

function saveSplit(value: number) {
  try {
    if (value === SPLIT_DEFAULT) localStorage.removeItem(SPLIT_KEY);
    else localStorage.setItem(SPLIT_KEY, String(value));
  } catch {
    /* private mode */
  }
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
        <li>
          Drag a slide in the list to move it, or select it and press <kbd>Alt</kbd>+<kbd>↑</kbd> or <kbd>Alt</kbd>+<kbd>↓</kbd>.
        </li>
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
