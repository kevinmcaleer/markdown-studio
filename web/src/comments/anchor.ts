// Finding a comment's passage again after the document has changed.
//
// New threads carry an editor anchor (Yjs relative positions, see yAnchor.ts)
// that follows the passage through everyone's edits. Older threads, and ones
// whose anchor can't be read on this device yet, fall back to the offsets and
// quoted text stored with the thread: the offsets if the text is still there,
// otherwise the copy of the quote nearest to where it was.
//
// If the passage was deleted, the thread is "removed": it stays in the panel,
// without a highlight, showing the text it was about.

export type Anchor = { anchor_from: number; anchor_to: number; quote: string; anchor?: string | null };
export type Range = { from: number; to: number };

/** A passage found from an editor anchor; "deleted" if it's gone, null if the anchor is no help. */
export type Resolved = Range | "deleted" | null;
export type Resolver = (anchor: string, hasQuote: boolean) => Resolved;

/** "edited" means the passage is still there but its text has changed since the comment. */
export type AnchorStatus = "ok" | "edited" | "removed";
export type Placement = { range: Range | null; status: AnchorStatus };

export function locate(doc: string, anchor: Anchor, resolve?: Resolver): Range | null {
  return place(doc, anchor, resolve).range;
}

export function place(doc: string, anchor: Anchor, resolve?: Resolver): Placement {
  const { anchor_from: from, anchor_to: to, quote } = anchor;
  const resolved = anchor.anchor && resolve ? resolve(anchor.anchor, quote !== "") : null;
  if (resolved === "deleted") return { range: null, status: "removed" };
  if (resolved) {
    const range = { from: Math.min(resolved.from, doc.length), to: Math.min(resolved.to, doc.length) };
    return { range, status: !quote || doc.slice(range.from, range.to) === quote ? "ok" : "edited" };
  }
  if (!quote) {
    // A comment on a position rather than a passage.
    const at = Math.min(Math.max(0, from), doc.length);
    return { range: { from: at, to: at }, status: "ok" };
  }
  if (doc.slice(from, to) === quote) return { range: { from, to }, status: "ok" };
  let best: number | null = null;
  for (let i = doc.indexOf(quote); i !== -1; i = doc.indexOf(quote, i + 1)) {
    if (best === null || Math.abs(i - from) < Math.abs(best - from)) best = i;
  }
  return best === null ? { range: null, status: "removed" } : { range: { from: best, to: best + quote.length }, status: "ok" };
}

/** Threads in reading order: by where their passage is now, removed ones last. */
export function inDocumentOrder<T extends Anchor>(doc: string, threads: T[], resolve?: Resolver): ({ thread: T } & Placement)[] {
  return threads
    .map((thread) => ({ thread, ...place(doc, thread, resolve) }))
    .sort((a, b) => (a.range?.from ?? Infinity) - (b.range?.from ?? Infinity));
}
