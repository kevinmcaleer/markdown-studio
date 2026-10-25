import * as Y from "yjs";
import type { Resolved } from "./anchor";

// Pins a comment to the shared Yjs text with relative positions, which follow
// the passage through everyone's edits rather than counting characters.
// Stored as JSON in the thread's `anchor` field; the server never reads it.

type Stored = { y: { from: string; to: string } };

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

/** The anchor for `from..to` in `text`. */
export function createYAnchor(text: Y.Text, from: number, to: number): string {
  // The start sticks to the character after it and the end to the one before,
  // so typing just outside the passage doesn't widen it.
  const start = Y.createRelativePositionFromTypeIndex(text, from, 0);
  const end = Y.createRelativePositionFromTypeIndex(text, to, -1);
  const stored: Stored = {
    y: { from: toBase64(Y.encodeRelativePosition(start)), to: toBase64(Y.encodeRelativePosition(end)) },
  };
  return JSON.stringify(stored);
}

/**
 * Where the anchor's passage is now. "deleted" when everything in it was
 * removed; null when the anchor isn't ours or can't be read yet (say, its
 * text hasn't synced to this device), so the caller should fall back.
 */
export function resolveYAnchor(text: Y.Text, anchor: string, hasQuote: boolean): Resolved {
  let stored: Stored;
  try {
    stored = JSON.parse(anchor);
  } catch {
    return null;
  }
  if (!stored?.y || !text.doc) return null;
  try {
    const start = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(fromBase64(stored.y.from)), text.doc);
    const end = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(fromBase64(stored.y.to)), text.doc);
    if (!start || !end || start.type !== text || end.type !== text) return null;
    if (!hasQuote) return { from: start.index, to: start.index };
    if (end.index <= start.index) return "deleted";
    return { from: start.index, to: end.index };
  } catch {
    return null;
  }
}
