// Finding a comment's passage again after the document has changed.
//
// A thread stores the offsets of the selection when it was started and the
// text that was selected. If the text is still at those offsets we use them;
// otherwise we look for the same text and take the copy nearest to where it
// was. If it's gone, the thread is "detached" and shown without a highlight.

export type Anchor = { anchor_from: number; anchor_to: number; quote: string };
export type Range = { from: number; to: number };

export function locate(doc: string, anchor: Anchor): Range | null {
  const { anchor_from: from, anchor_to: to, quote } = anchor;
  if (!quote) {
    // A comment on a position rather than a passage.
    const at = Math.min(Math.max(0, from), doc.length);
    return { from: at, to: at };
  }
  if (doc.slice(from, to) === quote) return { from, to };
  let best: number | null = null;
  for (let i = doc.indexOf(quote); i !== -1; i = doc.indexOf(quote, i + 1)) {
    if (best === null || Math.abs(i - from) < Math.abs(best - from)) best = i;
  }
  return best === null ? null : { from: best, to: best + quote.length };
}

/** Threads in reading order: by where their passage is now, detached ones last. */
export function inDocumentOrder<T extends Anchor>(doc: string, threads: T[]): { thread: T; range: Range | null }[] {
  return threads
    .map((thread) => ({ thread, range: locate(doc, thread) }))
    .sort((a, b) => (a.range?.from ?? Infinity) - (b.range?.from ?? Infinity));
}
