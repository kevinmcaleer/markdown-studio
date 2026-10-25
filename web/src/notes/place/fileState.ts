import type { Text } from "@codemirror/state";
import * as Y from "yjs";
import { api, csrf, getShareToken } from "../../api";
import { fromBase64, toBase64 } from "../../comments/yAnchor";

// One person's own state for a file: where they left off, their bookmarks,
// folded sections and how they like it opened. Never part of the Markdown and
// never shown to anyone else. Signed-in people keep it on the server (so it
// follows them between devices); anonymous share-link visitors keep it in
// this browser.

/**
 * A place in the text that survives other people's edits: a Yjs relative
 * position, plus the offset and the line's text to fall back on when the
 * position can't be read (the note was replaced, or hasn't synced here yet).
 */
export type Spot = { y?: string; offset: number; quote?: string };

export type Bookmark = { id: string; at: Spot; note?: string; created_at: string };

export type FileState = {
  v: 1;
  /** The view this note opens in (Write, Raw, ...), if it differs per note. */
  view?: string;
  /** The cursor, and the first line on screen. */
  cursor?: Spot;
  top?: Spot;
  bookmarks?: Bookmark[];
  /** The start of each folded section. */
  folds?: Spot[];
};

const MAX_QUOTE = 120;

export function emptyState(): FileState {
  return { v: 1 };
}

/** The line containing `pos`, trimmed, as a fallback for finding it again. */
function lineQuote(doc: Text, pos: number): string {
  return doc.lineAt(pos).text.trim().slice(0, MAX_QUOTE);
}

/**
 * A spot for `pos` in `doc`. With `text` (the shared Yjs text the editor is
 * bound to) it also keeps a relative position. `assoc` 0 sticks to the
 * character after `pos`, which suits the start of a line.
 */
export function makeSpot(doc: Text, pos: number, text?: Y.Text | null, quote = true): Spot {
  const spot: Spot = { offset: pos };
  if (text && text.length === doc.length) {
    spot.y = toBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, pos, 0)));
  }
  if (quote) spot.quote = lineQuote(doc, pos);
  return spot;
}

/** Where `spot` is now in `doc`: its Yjs position, else its line, else its offset. */
export function findSpot(doc: Text, spot: Spot, text?: Y.Text | null): number {
  if (spot.y && text?.doc && text.length === doc.length) {
    try {
      const abs = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(fromBase64(spot.y)), text.doc);
      if (abs && abs.type === text) return Math.min(abs.index, doc.length);
    } catch {
      /* not ours; fall back */
    }
  }
  const offset = Math.max(0, Math.min(spot.offset, doc.length));
  if (spot.quote) {
    if (lineQuote(doc, offset) === spot.quote) return offset;
    const line = nearestLine(doc, spot.quote, doc.lineAt(offset).number);
    if (line !== null) return doc.line(line).from;
  }
  return offset;
}

/** The number of the line reading `quote` closest to line `near`, if any. */
function nearestLine(doc: Text, quote: string, near: number): number | null {
  for (let d = 0; d < doc.lines; d++) {
    for (const n of d === 0 ? [near] : [near - d, near + d]) {
      if (n >= 1 && n <= doc.lines && doc.line(n).text.trim().slice(0, MAX_QUOTE) === quote) return n;
    }
    if (near - d < 1 && near + d > doc.lines) break;
  }
  return null;
}

export function newBookmarkId(): string {
  // crypto.randomUUID needs https, and self-hosted copies often run on plain http.
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ------------------------------------------------------------------ storage

const localKey = (fileId: number) => `notes.fileState.${fileId}`;

function readLocal(fileId: number): FileState | null {
  try {
    const raw = localStorage.getItem(localKey(fileId));
    return raw ? clean(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function writeLocal(fileId: number, state: FileState): void {
  try {
    localStorage.setItem(localKey(fileId), JSON.stringify(state));
  } catch {
    /* private mode, or full */
  }
}

function clean(value: unknown): FileState | null {
  return value && typeof value === "object" && !Array.isArray(value) ? ({ ...(value as object), v: 1 } as FileState) : null;
}

/**
 * This person's state for the file. Signed in, it's the server's copy (or this
 * browser's, when offline); anonymous, it's only ever this browser's.
 */
export async function loadFileState(fileId: number, signedIn: boolean): Promise<FileState | null> {
  if (!signedIn) return readLocal(fileId);
  try {
    const { state } = await api<{ state: unknown }>(`/api/files/${fileId}/my-state`);
    return clean(state) ?? readLocal(fileId);
  } catch {
    return readLocal(fileId);
  }
}

/**
 * Keeps `state`. A copy always stays in this browser too, so a signed-in
 * person who is offline still picks up where they left off on this device.
 * `leaving` sends it even if the page is closing.
 */
export async function saveFileState(fileId: number, signedIn: boolean, state: FileState, leaving = false): Promise<void> {
  writeLocal(fileId, state);
  if (!signedIn) return;
  const headers: Record<string, string> = { "Content-Type": "application/json", "X-CSRF-Token": csrf() };
  const share = getShareToken();
  if (share) headers["X-Share-Token"] = share;
  try {
    await fetch(`/api/files/${fileId}/my-state`, {
      method: "PUT",
      headers,
      credentials: "same-origin",
      body: JSON.stringify({ state }),
      keepalive: leaving,
    });
  } catch {
    /* offline: the local copy will do until next time */
  }
}
