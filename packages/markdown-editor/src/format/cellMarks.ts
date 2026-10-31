import type { Mark } from "./formatting";

// Inline formatting on a table cell's text. A cell is typed in as plain
// Markdown (one text node), not through the note's syntax tree, so the marks
// are found and changed by looking at the characters around the selection.

const MARKERS: Record<Mark, string> = { bold: "**", italic: "*", strike: "~~", highlight: "==", code: "`" };

export type CellEdit = { text: string; from: number; to: number };

/** How many `ch` run back from `at` (exclusive) and forward from `to`. */
function runs(text: string, from: number, to: number, ch: string): [number, number] {
  let before = 0;
  while (from - before - 1 >= 0 && text[from - before - 1] === ch) before++;
  let after = 0;
  while (to + after < text.length && text[to + after] === ch) after++;
  return [before, after];
}

/** Whether a run of `*`s this long holds the mark (`*` italic, `**` bold, `***` both). */
function runHas(run: number, mark: Mark): boolean {
  if (mark === "italic") return run === 1 || run === 3;
  if (mark === "bold") return run >= 2;
  if (mark === "code") return run >= 1;
  return run >= 2;
}

/** The selection without the spaces at its ends. */
function trimmed(text: string, from: number, to: number): [number, number] {
  while (from < to && /\s/.test(text[from])) from++;
  while (to > from && /\s/.test(text[to - 1])) to--;
  return [from, to];
}

/** Where the mark's markers sit around (or just inside) from..to, if they do. */
function around(text: string, from: number, to: number, mark: Mark): { open: number; close: number } | null {
  const marker = MARKERS[mark];
  const ch = marker[0];
  const [before, after] = runs(text, from, to, ch);
  if (runHas(before, mark) && runHas(after, mark)) return { open: from - marker.length, close: to };
  // The markers were selected too: `**word**` picked whole.
  if (before || after) return null;
  let lead = 0;
  while (from + lead < to && text[from + lead] === ch) lead++;
  let trail = 0;
  while (to - trail - 1 > from + lead && text[to - trail - 1] === ch) trail++;
  if (to - trail > from + lead && runHas(lead, mark) && runHas(trail, mark)) return { open: from + lead - marker.length, close: to - trail };
  return null;
}

/** Whether the selected text in a cell already has the mark. */
export function cellMarkActive(text: string, from: number, to: number, mark: Mark): boolean {
  [from, to] = trimmed(text, from, to);
  return to > from && around(text, from, to, mark) !== null;
}

/** Wraps the selected text in the mark, or takes it off when it's already there; the result keeps the same words selected. */
export function toggleCellMark(text: string, from: number, to: number, mark: Mark): CellEdit | null {
  [from, to] = trimmed(text, from, to);
  if (to <= from) return null;
  const marker = MARKERS[mark];
  const at = around(text, from, to, mark);
  if (at) {
    const next = text.slice(0, at.open) + text.slice(at.open + marker.length, at.close) + text.slice(at.close + marker.length);
    return { text: next, from: at.open, to: at.close - marker.length };
  }
  // Marks don't span line breaks: each line is wrapped on its own.
  const picked = text.slice(from, to);
  const wrapped = picked
    .split("\n")
    .map((line) => {
      const [a, b] = trimmed(line, 0, line.length);
      return b > a ? line.slice(0, a) + marker + line.slice(a, b) + marker + line.slice(b) : line;
    })
    .join("\n");
  const next = text.slice(0, from) + wrapped + text.slice(to);
  return picked.includes("\n")
    ? { text: next, from, to: from + wrapped.length }
    : { text: next, from: from + marker.length, to: from + marker.length + picked.length };
}

const LINK = /\[([^\]\n]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g;
const MARK_RUN = /\*+|~~|==|`+/g;

/** Takes the marks and links off the selected text (and markers just around it), keeping the words. */
export function clearCellFormatting(text: string, from: number, to: number): CellEdit | null {
  [from, to] = trimmed(text, from, to);
  if (to <= from) return null;
  // A link the selection sits in is taken whole.
  for (const m of text.matchAll(LINK)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (start < to && end > from) {
      from = Math.min(from, start);
      to = Math.max(to, end);
    }
  }
  // Take in markers that hug the selection: `**[word]**` clears the bold too.
  while (from > 0 && /[*~=`]/.test(text[from - 1])) from--;
  while (to < text.length && /[*~=`]/.test(text[to])) to++;
  const picked = text.slice(from, to);
  const plain = picked.replace(LINK, "$1").replace(MARK_RUN, "");
  if (plain === picked) return null;
  return { text: text.slice(0, from) + plain + text.slice(to), from, to: from + plain.length };
}
