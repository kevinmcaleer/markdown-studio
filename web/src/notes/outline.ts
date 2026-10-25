import MarkdownIt from "markdown-it";

// The note's outline: its headings, each with the section it starts (the
// heading and everything up to the next heading of the same or a higher
// level). Worked out from the Markdown each time; nothing here is stored.
// Headings inside quotes and lists don't start sections, the same as in a
// Word document, so only top-level ones count, and that matches the order of
// the headings that are direct children of the preview.

export type Heading = {
  level: number;
  text: string;
  /** Where the heading's line starts. */
  from: number;
  /** Where its heading line ends (before the line break). */
  lineEnd: number;
  /** Where its section ends: the next heading of the same or a higher level, or the end of the note. */
  to: number;
  /** Where the next heading of any level starts, or the end of the note: the part that's this heading's own. */
  ownTo: number;
  /** Words in the section, under-sections included, not counting the heading itself. */
  words: number;
};

const md = new MarkdownIt({ html: false });

export function parseOutline(doc: string): Heading[] {
  const tokens = md.parse(doc, {});
  const starts = lineStarts(doc);
  const found: { level: number; text: string; line: number; endLine: number }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "heading_open" || t.level !== 0 || !t.map) continue;
    const inline = tokens[i + 1];
    found.push({ level: Number(t.tag.slice(1)), text: plainText(inline?.children ?? []) || inline?.content || "", line: t.map[0], endLine: t.map[1] });
  }
  const offset = (line: number) => (line < starts.length ? starts[line] : doc.length);
  const headings = found.map((h) => {
    const from = offset(h.line);
    // A setext heading's underline is part of the heading too.
    const lineEnd = Math.max(from, offset(h.endLine) - (h.endLine < starts.length ? 1 : 0));
    return { level: h.level, text: h.text.trim(), from, lineEnd, to: doc.length, ownTo: doc.length, words: 0 };
  });
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (i + 1 < headings.length) h.ownTo = headings[i + 1].from;
    const next = headings.findIndex((o, j) => j > i && o.level <= h.level);
    if (next >= 0) h.to = headings[next].from;
  }
  // Words in each heading's own part, then summed into its section.
  const own = headings.map((h) => countWords(doc.slice(h.lineEnd, h.ownTo)));
  headings.forEach((h, i) => {
    let words = own[i];
    for (let j = i + 1; j < headings.length && headings[j].from < h.to; j++) words += own[j];
    h.words = words;
  });
  return headings;
}

/** The index of the heading whose own part holds `pos`, or -1 before the first heading. */
export function sectionAt(headings: Heading[], pos: number): number {
  let found = -1;
  for (let i = 0; i < headings.length && headings[i].from <= pos; i++) found = i;
  return found;
}

export function countWords(text: string): number {
  return text.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

export type Change = { from: number; to?: number; insert?: string };

/**
 * Moves section `index` so it starts at `target`: another heading's start, or
 * the end of the note. Returns null when that would be no move at all, or
 * would put the section inside itself. The changes are given against the
 * current note, so they go in one editor transaction (and one Yjs one).
 */
export function moveSection(doc: string, headings: Heading[], index: number, target: number): Change[] | null {
  const h = headings[index];
  if (!h || target < 0 || target > doc.length) return null;
  if (target >= h.from && target <= h.to) return null;
  let text = doc.slice(h.from, h.to);
  if (!text.endsWith("\n")) text += "\n";
  const changes: Change[] = [{ from: h.from, to: h.to, insert: "" }];
  // At the end of a note with no closing line break, the break goes before it instead.
  if (target === doc.length && !doc.endsWith("\n")) changes.push({ from: target, insert: "\n" + text.replace(/\n$/, "") });
  else changes.push({ from: target, insert: text });
  return changes;
}

/** Where moving section `index` up one place puts it: before the section at its level just above, if it has one under the same parent. */
export function upTarget(headings: Heading[], index: number): number | null {
  const h = headings[index];
  for (let k = index - 1; k >= 0; k--) if (headings[k].level <= h.level) return headings[k].level === h.level ? headings[k].from : null;
  return null;
}

/** Where moving section `index` down one place puts it: after the section at its level just below, if it has one under the same parent. */
export function downTarget(headings: Heading[], index: number): number | null {
  const h = headings[index];
  const next = headings.find((o) => o.from === h.to);
  return next && next.level === h.level ? next.to : null;
}

/**
 * Changes a section's heading level by `delta` (-1 promotes, +1 demotes), and
 * every heading under it with it, so the section keeps its shape. Null when
 * any heading would go past # or ######. Setext headings become # ones.
 */
export function shiftLevel(doc: string, headings: Heading[], index: number, delta: number): Change[] | null {
  const h = headings[index];
  if (!h) return null;
  const inside = headings.filter((o, j) => j >= index && o.from < h.to);
  if (inside.some((o) => o.level + delta < 1 || o.level + delta > 6)) return null;
  return inside.map((o) => {
    const line = doc.slice(o.from, o.lineEnd);
    const atx = /^ {0,3}(#{1,6})(?=[ \t]|$)/.exec(line);
    const hashes = "#".repeat(o.level + delta);
    if (atx) return { from: o.from + atx.index + atx[0].length - atx[1].length, to: o.from + atx[0].length, insert: hashes };
    return { from: o.from, to: o.lineEnd, insert: `${hashes} ${line.split("\n")[0].trim()}` };
  });
}

/** Applies changes given against `doc` (as CodeMirror would), for tests and previews. */
export function applyChanges(doc: string, changes: Change[]): string {
  const sorted = [...changes].sort((a, b) => b.from - a.from || (b.to ?? b.from) - (a.to ?? a.from));
  return sorted.reduce((text, c) => text.slice(0, c.from) + (c.insert ?? "") + text.slice(c.to ?? c.from), doc);
}

/** A stable name for a heading, for remembering it across visits: its text, and which one of that text it is. */
export function headingKeys(headings: Heading[]): string[] {
  const seen = new Map<string, number>();
  return headings.map((h) => {
    const base = `${h.level}:${h.text}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}#${n}` : base;
  });
}

function lineStarts(doc: string): number[] {
  const starts = [0];
  for (let i = doc.indexOf("\n"); i >= 0; i = doc.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

type InlineToken = { type: string; content: string; children: InlineToken[] | null };

function plainText(children: InlineToken[]): string {
  return children
    .map((c) => (c.type === "text" || c.type === "code_inline" ? c.content : c.type === "softbreak" ? " " : c.type === "image" ? plainText(c.children ?? []) : ""))
    .join("");
}
