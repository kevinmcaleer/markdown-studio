import { codeFolding, foldedRanges, foldEffect, unfoldEffect } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import type { PlacedThread } from "../comments/CommentsPanel";
import type { LiveNote } from "./live";
import { downTarget, headingKeys, moveSection, parseOutline, sectionAt, shiftLevel, upTarget, type Change, type Heading } from "@markdown-studio/markdown-editor";

// The Outline panel: the note's headings, to jump to, fold, and move whole
// sections around. It's all worked out from the Markdown as it is now; the
// only thing kept is which sections you folded, on this device, per note.

const OPEN_KEY = "notes.outlineOpen";
const foldsKey = (fileId: number) => `notes.folds.${fileId}`;

function readOpen(): boolean {
  try {
    const value = localStorage.getItem(OPEN_KEY);
    if (value !== null) return value === "1";
  } catch {
    /* private mode */
  }
  return window.innerWidth >= 1400;
}

function readFolds(fileId: number): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(foldsKey(fileId)) ?? "[]");
    if (Array.isArray(value)) return new Set(value.map(String));
  } catch {
    /* private mode, or not JSON */
  }
  return new Set();
}

function writeFolds(fileId: number, keys: Set<string>) {
  try {
    if (keys.size) localStorage.setItem(foldsKey(fileId), JSON.stringify([...keys]));
    else localStorage.removeItem(foldsKey(fileId));
  } catch {
    /* private mode */
  }
}

/** What a folded section hides: everything after its heading line, up to the line break that ends it. */
function foldRange(doc: string, h: Heading): { from: number; to: number } | null {
  const to = doc[h.to - 1] === "\n" ? h.to - 1 : h.to;
  return to > h.lineEnd ? { from: h.lineEnd, to } : null;
}

type Collaborator = { clientId: number; name: string; color: string; pos: number };

function collaborators(note: LiveNote | null): Collaborator[] {
  if (!note) return [];
  const list: Collaborator[] = [];
  note.provider.awareness.getStates().forEach((state, clientId) => {
    if (clientId === note.doc.clientID || !state.user || !state.cursor?.head) return;
    try {
      const pos = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(state.cursor.head), note.doc);
      if (pos && pos.type === note.text) list.push({ clientId, name: String(state.user.name), color: String(state.user.color), pos: pos.index });
    } catch {
      /* a cursor from an older copy of the note */
    }
  });
  return list;
}

export function useOutline({
  fileId,
  doc,
  canEdit,
  note,
  threads,
}: {
  fileId: number;
  /** The note's text: the outline is worked out from this. */
  doc: string;
  canEdit: boolean;
  note: LiveNote | null;
  threads: PlacedThread[];
}) {
  const [open, setOpen] = useState(readOpen);
  const view = useRef<EditorView | null>(null);
  const [head, setHead] = useState(0);
  const [folded, setFolded] = useState<Set<string>>(() => readFolds(fileId));
  const headings = useMemo(() => parseOutline(doc), [doc]);
  const keys = useMemo(() => headingKeys(headings), [headings]);
  const latest = useRef({ fileId });
  latest.current = { fileId };

  const liveView = () => (view.current?.dom.isConnected ? view.current : null);

  // Which sections are folded, read back from the editor after any fold or unfold.
  const readFolded = useCallback((v: EditorView) => {
    const ranges = foldedRanges(v.state);
    const text = v.state.doc.toString();
    const outline = parseOutline(text);
    const names = headingKeys(outline);
    const now = new Set<string>();
    outline.forEach((h, i) => {
      const range = foldRange(text, h);
      let hit = false;
      if (range) ranges.between(range.from, range.from, (from, to) => void (from === range.from && to === range.to && (hit = true)));
      if (hit && names[i]) now.add(names[i]);
    });
    setFolded(now);
    writeFolds(latest.current.fileId, now);
  }, []);

  // Read once by the editor at mount, so it must not change identity.
  const extensions = useMemo<Extension[]>(
    () => [
      codeFolding({ placeholderText: "…" }),
      EditorView.updateListener.of((update) => {
        if (update.selectionSet || update.docChanged) setHead(update.state.selection.main.head);
        if (update.transactions.some((tr) => tr.effects.some((e) => e.is(foldEffect) || e.is(unfoldEffect)))) readFolded(update.view);
      }),
    ],
    [],
  );

  // The editor is rebuilt when the note is reopened; fold what was folded again.
  const onReady = useCallback((v: EditorView) => {
    view.current = v;
    const text = v.state.doc.toString();
    const stored = readFolds(latest.current.fileId);
    const outline = parseOutline(text);
    const names = headingKeys(outline);
    const effects = outline.flatMap((h, i) => {
      const range = stored.has(names[i]) ? foldRange(text, h) : null;
      return range ? [foldEffect.of(range)] : [];
    });
    setHead(v.state.selection.main.head);
    if (effects.length) v.dispatch({ effects });
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, open ? "1" : "0");
    } catch {
      /* private mode */
    }
  }, [open]);

  const current = sectionAt(headings, Math.min(head, doc.length));

  const apply = useCallback((changes: Change[] | null, select?: number) => {
    const v = liveView();
    if (!v || !changes) return;
    v.dispatch({ changes, ...(select !== undefined ? { selection: { anchor: select } } : {}), scrollIntoView: true, userEvent: "move.section" });
  }, []);

  const goTo = useCallback(
    (index: number) => {
      const h = headings[index];
      if (!h) return;
      const v = liveView();
      if (!v) return;
      // Open any folded section the heading is hidden in.
      const effects: ReturnType<typeof unfoldEffect.of>[] = [];
      foldedRanges(v.state).between(h.from, h.from, (from, to) => {
        if (from < h.from && to >= h.from) effects.push(unfoldEffect.of({ from, to }));
      });
      v.dispatch({ effects: [...effects, EditorView.scrollIntoView(h.from, { y: "start", yMargin: 24 })], selection: { anchor: h.lineEnd } });
      v.focus();
    },
    [headings],
  );

  const toggleFold = useCallback(
    (index: number) => {
      const v = liveView();
      const h = headings[index];
      if (!v || !h) return;
      const range = foldRange(doc, h);
      if (!range) return;
      const isFolded = folded.has(keys[index]);
      v.dispatch({ effects: (isFolded ? unfoldEffect : foldEffect).of(range) });
    },
    [headings, keys, doc, folded],
  );

  const move = useCallback(
    (index: number, target: number | null) => {
      if (target === null) return;
      const h = headings[index];
      const changes = moveSection(doc, headings, index, target);
      if (!changes || !h) return;
      // Where the heading lands, once the section has been taken out from before it.
      const length = h.to - h.from;
      const landing = (target > h.from ? target - length : target) + (target === doc.length && !doc.endsWith("\n") ? 1 : 0);
      apply(changes, landing + (h.lineEnd - h.from));
    },
    [doc, headings, apply],
  );

  const shift = useCallback((index: number, delta: number) => apply(shiftLevel(doc, headings, index, delta)), [doc, headings, apply]);

  const peers = collaborators(note);
  const commentCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const { range } of threads) {
      if (!range) continue;
      const i = sectionAt(headings, range.from);
      if (i >= 0) counts.set(i, (counts.get(i) ?? 0) + 1);
    }
    return counts;
  }, [threads, headings]);

  const button = (
    <button type="button" className="menu-button" aria-pressed={open} onClick={() => setOpen((o) => !o)}>
      Outline
    </button>
  );

  const panel = (
    <div className="note-outline" hidden={!open}>
      <OutlinePanel
        headings={headings}
        keys={keys}
        current={current}
        folded={folded}
        canEdit={canEdit}
        commentCounts={commentCounts}
        peers={peers.map((p) => ({ ...p, section: sectionAt(headings, Math.min(p.pos, doc.length)) }))}
        docLength={doc.length}
        onGo={goTo}
        onFold={toggleFold}
        onMove={move}
        onShift={shift}
        onClose={() => setOpen(false)}
      />
    </div>
  );

  return { extensions, onReady, button, panel, headings };
}

function OutlinePanel({
  headings,
  keys,
  current,
  folded,
  canEdit,
  commentCounts,
  peers,
  docLength,
  onGo,
  onFold,
  onMove,
  onShift,
  onClose,
}: {
  headings: Heading[];
  keys: string[];
  current: number;
  folded: Set<string>;
  canEdit: boolean;
  commentCounts: Map<number, number>;
  peers: (Collaborator & { section: number })[];
  docLength: number;
  onGo: (index: number) => void;
  onFold: (index: number) => void;
  onMove: (index: number, target: number | null) => void;
  onShift: (index: number, delta: number) => void;
  onClose: () => void;
}) {
  const [dragging, setDragging] = useState<number | null>(null);
  // Where a drop would put the section: before heading `n`, or at the end when n is headings.length.
  const [dropAt, setDropAt] = useState<number | null>(null);
  const minLevel = headings.reduce((m, h) => Math.min(m, h.level), 6);
  const list = useRef<HTMLOListElement>(null);

  // Headings under a folded one are hidden from the list too, as they are in the note.
  const hidden = new Set<number>();
  headings.forEach((h, i) => {
    if (!folded.has(keys[i])) return;
    for (let j = i + 1; j < headings.length && headings[j].from < h.to; j++) hidden.add(j);
  });

  const insideDragged = (n: number) => {
    if (dragging === null) return false;
    const h = headings[dragging];
    const at = n < headings.length ? headings[n].from : docLength;
    return at >= h.from && at <= h.to;
  };

  const focusItem = (index: number) =>
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-heading="${index}"] .outline-go`)?.focus());

  const drop = (n: number) => {
    if (dragging === null || insideDragged(n)) return;
    onMove(dragging, n < headings.length ? headings[n].from : docLength);
    setDragging(null);
    setDropAt(null);
  };

  return (
    <aside className="outline-panel" aria-label="Outline">
      <header>
        <h2>Outline</h2>
        <button type="button" className="icon-button" aria-label="Close outline" onClick={onClose}>
          ×
        </button>
      </header>
      {headings.length === 0 ? (
        <p className="muted small">Headings in the note show up here. Start a line with # to add one.</p>
      ) : (
        <ol className="outline-list" ref={list} onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDropAt(null)}>
          {headings.map((h, i) => {
            if (hidden.has(i)) return null;
            const isFolded = folded.has(keys[i]);
            const here = peers.filter((p) => p.section === i);
            const comments = commentCounts.get(i) ?? 0;
            const hasBody = h.to > h.lineEnd + 1;
            return (
              <li
                key={keys[i]}
                data-heading={i}
                className={[
                  "outline-item",
                  i === current ? "current" : "",
                  dragging === i ? "dragging" : "",
                  dropAt === i && !insideDragged(i) ? "drop-before" : "",
                ].join(" ")}
                style={{ paddingLeft: `${(h.level - minLevel) * 0.85}rem` }}
                draggable={canEdit}
                onDragStart={(e) => {
                  setDragging(i);
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", h.text);
                }}
                onDragEnd={() => {
                  setDragging(null);
                  setDropAt(null);
                }}
                onDragOver={(e) => {
                  if (dragging === null) return;
                  e.preventDefault();
                  // The lower half of a heading means after it, which is before the next one shown.
                  const rect = e.currentTarget.getBoundingClientRect();
                  const below = e.clientY > rect.top + rect.height / 2;
                  let n = i;
                  if (below) {
                    n = i + 1;
                    while (hidden.has(n)) n++;
                  }
                  setDropAt(n);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dropAt !== null) drop(dropAt);
                }}
              >
                {hasBody ? (
                  <button
                    type="button"
                    className="outline-fold"
                    aria-label={isFolded ? `Unfold ${h.text}` : `Fold ${h.text}`}
                    aria-expanded={!isFolded}
                    onClick={() => onFold(i)}
                  >
                    {isFolded ? "▸" : "▾"}
                  </button>
                ) : (
                  <span className="outline-fold" aria-hidden="true" />
                )}
                <button
                  type="button"
                  className="outline-go"
                  aria-current={i === current ? "location" : undefined}
                  title={canEdit ? "Drag to move this section. Alt+↑/↓ moves it, Alt+←/→ changes its level." : undefined}
                  onClick={() => onGo(i)}
                  onKeyDown={(e) => {
                    if (!canEdit || !e.altKey) return;
                    const handled: Record<string, () => void> = {
                      ArrowUp: () => onMove(i, upTarget(headings, i)),
                      ArrowDown: () => onMove(i, downTarget(headings, i)),
                      ArrowLeft: () => onShift(i, -1),
                      ArrowRight: () => onShift(i, 1),
                    };
                    const action = handled[e.key];
                    if (!action) return;
                    e.preventDefault();
                    action();
                    focusItem(i);
                  }}
                >
                  <span className={`outline-text level-${h.level}`}>{h.text || "Untitled"}</span>
                </button>
                <span className="outline-meta">
                  {here.length > 0 && (
                    <span className="outline-peers" aria-label={`Here now: ${here.map((p) => p.name).join(", ")}`}>
                      {here.slice(0, 3).map((p) => (
                        <span key={p.clientId} title={p.name} style={{ background: p.color }} />
                      ))}
                    </span>
                  )}
                  {comments > 0 && (
                    <span className="outline-comments" title={`${comments} open comment${comments === 1 ? "" : "s"}`}>
                      {comments}
                    </span>
                  )}
                  <span className="outline-words" title="Words in this section">
                    {h.words}
                  </span>
                </span>
              </li>
            );
          })}
          {canEdit && dragging !== null && (
            <li
              className={`outline-end${dropAt === headings.length && !insideDragged(headings.length) ? " drop-before" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDropAt(headings.length);
              }}
              onDrop={(e) => {
                e.preventDefault();
                drop(headings.length);
              }}
            >
              Move to the end
            </li>
          )}
        </ol>
      )}
    </aside>
  );
}
