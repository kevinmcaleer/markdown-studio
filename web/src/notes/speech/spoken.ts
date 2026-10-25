// The text side of dictation and read-aloud, kept apart from the browser's
// speech APIs so it can be tested: turning what was said into Markdown, and
// turning Markdown into sentences worth saying.

// ------------------------------------------------------------------ dictation

/** What sits just before the cursor, which decides spacing and capitals. */
export type DictationContext = { before: string };

type Token = { kind: "word"; text: string } | { kind: "punct"; text: string } | { kind: "break"; text: string } | { kind: "block"; text: string };

const PUNCTUATION: [string, string][] = [
  ["full stop", "."],
  ["period", "."],
  ["comma", ","],
  ["question mark", "?"],
  ["exclamation mark", "!"],
  ["exclamation point", "!"],
  ["semicolon", ";"],
  ["colon", ":"],
];

const BREAKS: [string, string][] = [
  ["new paragraph", "\n\n"],
  ["new line", "\n"],
];

const NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

/** "Undo that" on its own takes back the last thing dictated. */
export function isUndoCommand(transcript: string): boolean {
  return /^\s*(undo that|scratch that)[.!]?\s*$/i.test(transcript);
}

function tokenize(transcript: string): Token[] {
  const words = transcript.trim().split(/\s+/).filter(Boolean);
  const tokens: Token[] = [];
  const lower = words.map((w) => w.toLowerCase().replace(/[.,!?]$/, ""));
  let i = 0;
  const phrase = (p: string) => {
    const parts = p.split(" ");
    return parts.every((part, k) => lower[i + k] === part) ? parts.length : 0;
  };
  // A block (heading, bullet, numbered list) only starts a dictated phrase or follows a new line.
  const atBlockStart = () => tokens.length === 0 || tokens[tokens.length - 1].kind === "break";
  outer: while (i < words.length) {
    for (const [p, text] of [...PUNCTUATION, ...BREAKS]) {
      const n = phrase(p);
      if (n) {
        tokens.push({ kind: text.startsWith("\n") ? "break" : "punct", text });
        i += n;
        continue outer;
      }
    }
    if (atBlockStart()) {
      if (lower[i] === "heading") {
        const level = NUMBERS[lower[i + 1]] ?? Number(lower[i + 1]);
        const valid = Number.isInteger(level) && level >= 1 && level <= 6;
        tokens.push({ kind: "block", text: `${"#".repeat(valid ? level : 1)} ` });
        i += valid ? 2 : 1;
        continue;
      }
      if (lower[i] === "bullet") {
        tokens.push({ kind: "block", text: "- " });
        i += lower[i + 1] === "point" ? 2 : 1;
        continue;
      }
      const n = phrase("numbered list") || phrase("numbered item");
      if (n) {
        tokens.push({ kind: "block", text: "1. " });
        i += n;
        continue;
      }
    }
    tokens.push({ kind: "word", text: words[i] });
    i++;
  }
  return tokens;
}

/** True when the next word starts a sentence, so it gets a capital. */
function sentenceStarts(before: string): boolean {
  const trimmed = before.replace(/[ \t]+$/, "");
  if (!trimmed || trimmed.endsWith("\n")) return true;
  // A list or heading marker on its own counts as the start of a line.
  if (/(^|\n)\s*(#{1,6}|[-*+]|\d+[.)])$/.test(trimmed)) return true;
  return /[.!?]["')\]”’]*$/.test(trimmed);
}

const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * Turns one final dictation result into the text to insert: spoken punctuation
 * becomes marks, "new line" becomes a line break, and "heading", "bullet" and
 * "numbered list" start a Markdown block.
 */
export function spokenToText(transcript: string, ctx: DictationContext): string {
  let out = "";
  const sofar = () => ctx.before + out;
  for (const token of tokenize(transcript)) {
    const prev = sofar();
    if (token.kind === "punct") {
      // A space already in the note before the cursor stays; it isn't ours to remove.
      out = out.replace(/[ \t]+$/, "") + token.text;
    } else if (token.kind === "break") {
      out = out.replace(/[ \t]+$/, "") + token.text;
    } else if (token.kind === "block") {
      const atLineStart = prev === "" || prev.endsWith("\n");
      out += (atLineStart ? "" : "\n") + token.text;
    } else {
      const needsSpace = prev !== "" && !/\s$/.test(prev) && !/(^|\n)(#{1,6} |- |\d+\. )$/.test(prev);
      const word = sentenceStarts(prev) ? capitalize(token.text) : token.text;
      out += (needsSpace ? " " : "") + word;
    }
  }
  return out;
}

// ------------------------------------------------------------------ read-aloud

/** A stretch of the note to say: where it is in the Markdown, and the words to say for it. */
export type Segment = { from: number; to: number; text: string };

const blank = (s: string) => s.replace(/[^\n]/g, " ");

/** The note with HTML comments blanked out, so offsets still line up. */
function maskComments(doc: string): string {
  return doc.replace(/<!--[\s\S]*?(-->|$)/g, blank);
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#{1,6}(\s|$)/;
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s+/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const isTableRow = (line: string) => line.trim().startsWith("|");

type Block = { from: number; to: number; kind: "prose" | "heading" | "code" | "row" };

function blocks(doc: string): Block[] {
  const out: Block[] = [];
  const lines = doc.split("\n");
  let pos = 0;
  let current: Block | null = null;
  const close = () => {
    if (current) out.push(current);
    current = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const from = pos;
    const to = pos + line.length;
    pos = to + 1;
    const fence = FENCE.exec(line);
    if (fence) {
      close();
      // Runs to the matching closing fence, or the end of the note.
      let end = to;
      for (let j = i + 1; j < lines.length; j++) {
        const lineStart = pos;
        pos += lines[j].length + 1;
        end = lineStart + lines[j].length;
        i = j;
        if (lines[j].trim().startsWith(fence[1][0].repeat(fence[1].length)) && !lines[j].trim().slice(fence[1].length).trim()) break;
      }
      out.push({ from, to: end, kind: "code" });
      continue;
    }
    if (!line.trim() || RULE.test(line)) {
      close();
      continue;
    }
    if (HEADING.test(line)) {
      close();
      out.push({ from, to, kind: "heading" });
      continue;
    }
    if (isTableRow(line)) {
      close();
      if (!TABLE_DIVIDER.test(line)) out.push({ from, to, kind: "row" });
      continue;
    }
    if (LIST_ITEM.test(line) || (current as Block | null)?.kind !== "prose") close();
    if (current) current.to = to;
    else current = { from, to, kind: "prose" };
  }
  close();
  return out;
}

const ABBREVIATIONS = /\b(e\.g|i\.e|etc|vs|mr|mrs|ms|dr|st|no)\.$/i;

/** Splits a run of prose at sentence ends, ignoring full stops inside link addresses and code. */
function sentences(doc: string, from: number, to: number): { from: number; to: number }[] {
  const slice = doc
    .slice(from, to)
    .replace(/\]\([^)]*\)/g, blank)
    .replace(/`[^`\n]*`/g, blank)
    .replace(/<[^>\n]*>/g, blank)
    .replace(/https?:\/\/\S+/g, blank);
  const out: { from: number; to: number }[] = [];
  let start = 0;
  const end = /[.!?…]+["')\]”’*_=~]*(?=\s)/g;
  for (let m = end.exec(slice); m; m = end.exec(slice)) {
    const stop = m.index + m[0].length;
    if (ABBREVIATIONS.test(slice.slice(Math.max(0, m.index - 4), m.index + 1))) continue;
    out.push({ from: from + start, to: from + stop });
    start = stop;
  }
  out.push({ from: from + start, to });
  // Trim each to its words.
  return out
    .map((r) => {
      const text = doc.slice(r.from, r.to);
      const lead = text.length - text.trimStart().length;
      const trail = text.length - text.trimEnd().length;
      return { from: r.from + lead, to: r.to - trail };
    })
    .filter((r) => r.to > r.from);
}

/** Markdown as it reads: no link addresses, emphasis marks or block markers. */
export function speakable(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*(>\s?)+/, "")
        .replace(/^ {0,3}#{1,6}\s+/, "")
        .replace(/\s+#+\s*$/, "")
        .replace(LIST_ITEM, "")
        .replace(/^\[[ xX]\]\s+/, ""),
    )
    .join(" ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt: string) => (alt.trim() ? `image: ${alt.trim()}.` : "image."))
    .replace(/\[\^[^\]]+\]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<https?:\/\/[^>]+>/g, "link")
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*+|==|~~/g, "")
    .replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A table row read as its cells, with a pause between each. */
function speakRow(row: string): string {
  return row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => speakable(cell))
    .filter(Boolean)
    .join(", ");
}

/** The whole note as sentences to say, in order. */
export function speechSegments(doc: string): Segment[] {
  const masked = maskComments(doc);
  const out: Segment[] = [];
  for (const block of blocks(masked)) {
    if (block.kind === "code") out.push({ from: block.from, to: block.to, text: "Code block." });
    else if (block.kind === "row") {
      const text = speakRow(masked.slice(block.from, block.to));
      if (text) out.push({ from: block.from, to: block.to, text });
    } else if (block.kind === "heading") {
      const text = speakable(masked.slice(block.from, block.to));
      if (text) out.push({ from: block.from, to: block.to, text });
    } else
      for (const s of sentences(masked, block.from, block.to)) {
        const text = speakable(masked.slice(s.from, s.to));
        if (text) out.push({ ...s, text });
      }
  }
  return out;
}

/**
 * What to read for a cursor or selection: everything from the sentence the
 * cursor is in, or just the sentences a selection touches.
 */
export function segmentsToRead(all: Segment[], from: number, to = from): Segment[] {
  if (to > from) return all.filter((s) => s.to > from && s.from < to);
  const start = all.findIndex((s) => s.to >= from);
  return start < 0 ? [] : all.slice(start);
}
