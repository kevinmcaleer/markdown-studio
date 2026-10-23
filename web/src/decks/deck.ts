import MarkdownIt from "markdown-it";
import mark from "markdown-it-mark";

// A deck is a Markdown file whose name ends in .deck.md. Slides are separated
// by a line holding only `---`, slide settings go in HTML comments, and
// presenter notes follow a line holding only `???`. This is the same format
// keynotejs (and pykeynote) read and write, so a deck round-trips with them:
//
//     <!-- layout: section -->
//     <!-- transition: dissolve 1.5s -->
//     # Slide title
//
//     - A bullet
//       - An indented bullet
//
//     ???
//     Presenter notes
//
// parseDeck() turns the text into a plain model that the preview, the
// presenter and both exporters (PowerPoint and Keynote) work from.

export const DECK_SUFFIX = ".deck.md";

export type Layout = "title" | "section" | "content" | "quote" | "statement" | "blank";
export const LAYOUTS: Layout[] = ["title", "section", "content", "quote", "statement", "blank"];

/** A stretch of text with the same formatting. */
export type Run = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  mark?: boolean;
  link?: string;
};

export type Block =
  | { type: "paragraph"; runs: Run[] }
  | { type: "bullets"; items: { runs: Run[]; level: number; ordered: boolean }[] }
  | { type: "code"; lang: string; code: string }
  | { type: "image"; src: string; alt: string }
  | { type: "table"; header: Run[][]; rows: Run[][][]; align: ("left" | "center" | "right" | null)[] }
  | { type: "quote"; runs: Run[] };

export type Transition = { effect: string; duration: number | null };

export type Slide = {
  index: number;
  /** First and last line of the slide in the deck's text (0-based, inclusive). */
  startLine: number;
  endLine: number;
  layout: Layout;
  /** The `layout` comment as written, if any. Keynote layout names are kept for Keynote export. */
  layoutName: string | null;
  title: string | null;
  titleRuns: Run[];
  /** The slide's Markdown without its title, settings and notes: what the preview renders. */
  body: string;
  blocks: Block[];
  notes: string;
  transition: Transition | null;
  /** Hidden slides are kept in the file and exports but skipped when presenting. */
  skipped: boolean;
};

export type Deck = { slides: Slide[] };

const SEPARATOR = "---";
const NOTES_MARKER = "???";
const COMMENT = /^<!--\s*(.*?)\s*-->$/;
const HEADING = /^(#{1,2})\s+(.*?)\s*#*\s*$/;
const TRANSITION = /^(.*?)(?:\s+([\d.]+)\s*s)?$/;

const md = new MarkdownIt({ html: false, linkify: true, typographer: true }).use(mark);

/** Split a deck's text into slides. Blank slides (only whitespace) are left out. */
export function parseDeck(text: string): Deck {
  const lines = text.split(/\r\n|\r|\n/);
  const chunks: { start: number; lines: string[] }[] = [{ start: 0, lines: [] }];
  let fence: string | null = null;
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    const opener = /^(`{3,}|~{3,})/.exec(trimmed)?.[1];
    if (opener && (fence === null || (opener[0] === fence[0] && opener.length >= fence.length))) fence = fence === null ? opener : null;
    if (fence === null && trimmed === SEPARATOR) chunks.push({ start: i + 1, lines: [] });
    else chunks[chunks.length - 1].lines.push(line);
  });

  const slides: Slide[] = [];
  for (const chunk of chunks) {
    if (!chunk.lines.some((l) => l.trim())) continue;
    slides.push(parseSlide(chunk.lines, chunk.start, slides.length));
  }
  return { slides };
}

function parseSlide(lines: string[], start: number, index: number): Slide {
  let layoutName: string | null = null;
  let transition: Transition | null = null;
  let skipped = false;
  let title: string | null = null;
  let titleLevel = 0;
  const body: string[] = [];
  let notes: string[] | null = null;
  let fenced = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (notes !== null) {
      notes.push(line);
      continue;
    }
    if (/^(`{3,}|~{3,})/.test(trimmed)) fenced = !fenced;
    if (!fenced && trimmed === NOTES_MARKER) {
      notes = [];
      continue;
    }
    const comment = fenced ? null : COMMENT.exec(trimmed);
    if (comment) {
      const [key, value] = splitSetting(comment[1]);
      if (key === "layout") layoutName = value || null;
      else if (key === "transition") {
        const m = TRANSITION.exec(value)!;
        transition = m[1].trim() && m[1].trim() !== "none" ? { effect: m[1].trim(), duration: m[2] ? parseFloat(m[2]) : null } : null;
      } else if (key === "skipped" || key === "hidden") skipped = !["false", "no", "0"].includes(value.toLowerCase());
      continue;
    }
    const heading = fenced ? null : HEADING.exec(trimmed);
    if (heading && title === null && !body.some((l) => l.trim())) {
      title = heading[2];
      titleLevel = heading[1].length;
      continue;
    }
    body.push(line);
  }

  const bodyText = trimBlankLines(body).join("\n");
  const blocks = parseBlocks(bodyText);
  const titleRuns = title === null ? [] : inlineRuns(title);
  return {
    index,
    startLine: start,
    endLine: start + lines.length - 1,
    layout: resolveLayout(layoutName, title, titleLevel, blocks),
    layoutName,
    title: title === null ? null : plainText(titleRuns),
    titleRuns,
    body: bodyText,
    blocks,
    notes: notes ? trimBlankLines(notes).join("\n") : "",
    transition,
    skipped,
  };
}

function splitSetting(text: string): [string, string] {
  const colon = text.indexOf(":");
  if (colon < 0) return [text.trim().toLowerCase(), ""];
  return [text.slice(0, colon).trim().toLowerCase(), text.slice(colon + 1).trim()];
}

function trimBlankLines(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
}

// Keynote's layout names, mapped to the look Decks gives them.
const KEYNOTE_LAYOUTS: Record<string, Layout> = {
  "title": "title",
  "title & subtitle": "title",
  "section": "section",
  "title only": "section",
  "title & bullets": "content",
  "bullets": "content",
  "title, bullets & photo": "content",
  "title & photo": "content",
  "photo": "content",
  "agenda": "content",
  "content": "content",
  "quote": "quote",
  "statement": "statement",
  "big fact": "statement",
  "blank": "blank",
};

/**
 * The layout named in the slide's `layout` comment, or one picked from its
 * content: a top-level title with at most a line or two under it is a title
 * slide, a heading alone a section, a lone quote a quote, and so on.
 */
function resolveLayout(name: string | null, title: string | null, level: number, blocks: Block[]): Layout {
  const named = name ? KEYNOTE_LAYOUTS[name.trim().toLowerCase()] : undefined;
  // The big-text layouts only have room for text; anything else needs a content slide.
  if (named && (named === "content" || named === "blank" || blocks.every((b) => b.type === "paragraph" || b.type === "quote"))) return named;
  if (named) return "content";
  if (title !== null && blocks.length === 0) return level === 1 ? "title" : "section";
  if (title !== null && level === 1 && blocks.length <= 2 && blocks.every((b) => b.type === "paragraph")) return "title";
  if (title === null && blocks.length === 1 && blocks[0].type === "quote") return "quote";
  if (title === null && blocks.length > 0 && blocks.every((b) => b.type === "paragraph")) return "statement";
  if (title === null && blocks.length === 0) return "blank";
  return "content";
}

// ------------------------------------------------------------------ blocks

type Token = ReturnType<typeof md.parse>[number];

/** The slide body as blocks of formatted text, for the exporters. */
export function parseBlocks(source: string): Block[] {
  const tokens = md.parse(source, {});
  const blocks: Block[] = [];
  let listDepth = 0;
  const ordered: boolean[] = [];
  let bullets: Extract<Block, { type: "bullets" }> | null = null;
  let quote: Run[][] | null = null;
  let table: { header: Run[][]; rows: Run[][][]; align: ("left" | "center" | "right" | null)[]; row: Run[][] | null; inHead: boolean } | null = null;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token.type) {
      case "bullet_list_open":
      case "ordered_list_open":
        if (listDepth === 0) {
          bullets = { type: "bullets", items: [] };
          blocks.push(bullets);
        }
        ordered.push(token.type === "ordered_list_open");
        listDepth++;
        break;
      case "bullet_list_close":
      case "ordered_list_close":
        listDepth--;
        ordered.pop();
        if (listDepth === 0) bullets = null;
        break;
      case "blockquote_open":
        if (!quote) quote = [];
        break;
      case "blockquote_close":
        if (quote && token.level === 0) {
          blocks.push({ type: "quote", runs: joinLines(quote) });
          quote = null;
        }
        break;
      case "fence":
      case "code_block":
        blocks.push({ type: "code", lang: token.info.trim().split(/\s+/)[0] ?? "", code: token.content.replace(/\n$/, "") });
        break;
      case "table_open":
        table = { header: [], rows: [], align: [], row: null, inHead: false };
        break;
      case "thead_open":
        if (table) table.inHead = true;
        break;
      case "thead_close":
        if (table) table.inHead = false;
        break;
      case "tr_open":
        if (table) table.row = [];
        break;
      case "tr_close":
        if (table?.row) {
          if (table.inHead) table.header = table.row;
          else table.rows.push(table.row);
          table.row = null;
        }
        break;
      case "th_open":
      case "td_open":
        if (table?.inHead) table.align.push(alignOf(token));
        break;
      case "table_close":
        if (table) blocks.push({ type: "table", header: table.header, rows: table.rows, align: table.align });
        table = null;
        break;
      case "heading_open": {
        const inline = tokens[i + 1];
        blocks.push({ type: "paragraph", runs: runsOf(inline.children ?? []).map((r) => ({ ...r, bold: true })) });
        i += 2;
        break;
      }
      case "inline": {
        const children = token.children ?? [];
        if (table?.row) {
          table.row.push(runsOf(children));
          break;
        }
        // Images become their own blocks; any text around them stays a paragraph.
        for (const child of children) {
          if (child.type === "image") blocks.push({ type: "image", src: String(child.attrGet("src") ?? ""), alt: child.content });
        }
        const runs = runsOf(children.filter((c) => c.type !== "image"));
        if (!runs.some((r) => r.text.trim())) break;
        if (bullets) bullets.items.push({ runs, level: listDepth - 1, ordered: ordered[ordered.length - 1] ?? false });
        else if (quote) quote.push(runs);
        else blocks.push({ type: "paragraph", runs });
        break;
      }
    }
  }
  return blocks;
}

function alignOf(token: Token): "left" | "center" | "right" | null {
  const style = String(token.attrGet("style") ?? "");
  const m = /text-align:\s*(left|center|right)/.exec(style);
  return (m?.[1] as "left" | "center" | "right" | undefined) ?? null;
}

function joinLines(paragraphs: Run[][]): Run[] {
  return paragraphs.flatMap((runs, i) => (i === 0 ? runs : [{ text: "\n" }, ...runs]));
}

/** Formatted runs for a line of inline Markdown (a title, say). */
export function inlineRuns(text: string): Run[] {
  const children = md.parseInline(text, {})[0]?.children ?? [];
  return runsOf(children);
}

function runsOf(children: Token[]): Run[] {
  const runs: Run[] = [];
  const style: Omit<Run, "text"> = {};
  for (const child of children) {
    switch (child.type) {
      case "text":
        push(runs, { ...style, text: child.content });
        break;
      case "code_inline":
        push(runs, { ...style, code: true, text: child.content });
        break;
      case "softbreak":
        push(runs, { ...style, text: " " });
        break;
      case "hardbreak":
        push(runs, { ...style, text: "\n" });
        break;
      case "strong_open":
        style.bold = true;
        break;
      case "strong_close":
        delete style.bold;
        break;
      case "em_open":
        style.italic = true;
        break;
      case "em_close":
        delete style.italic;
        break;
      case "s_open":
        style.strike = true;
        break;
      case "s_close":
        delete style.strike;
        break;
      case "mark_open":
        style.mark = true;
        break;
      case "mark_close":
        delete style.mark;
        break;
      case "link_open":
        style.link = String(child.attrGet("href") ?? "") || undefined;
        break;
      case "link_close":
        delete style.link;
        break;
    }
  }
  return runs;
}

/** Add a run, merging it into the last one when the formatting matches. */
function push(runs: Run[], run: Run): void {
  const last = runs[runs.length - 1];
  if (last && sameStyle(last, run)) last.text += run.text;
  else runs.push(run);
}

function sameStyle(a: Run, b: Run): boolean {
  return !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.strike === !!b.strike && !!a.code === !!b.code && !!a.mark === !!b.mark && a.link === b.link;
}

export function plainText(runs: Run[]): string {
  return runs.map((r) => r.text).join("");
}

/** The slide that line `line` of the deck's text belongs to. */
export function slideAtLine(deck: Deck, line: number): number {
  let found = 0;
  for (const slide of deck.slides) {
    if (slide.startLine <= line) found = slide.index;
    else break;
  }
  return found;
}

export function isDeck(file: { name: string }): boolean {
  return file.name.toLowerCase().endsWith(DECK_SUFFIX);
}

/** The deck's name for display and downloads: its file name without .deck.md. */
export function deckTitle(file: { name: string }): string {
  return isDeck(file) ? file.name.slice(0, -DECK_SUFFIX.length) : file.name.replace(/\.[^.]+$/, "");
}

export const STARTER_DECK = `# Untitled deck

A subtitle goes here

---

## A slide with bullets

- Separate slides with a line holding only \`---\`
- Indent for sub-points
  - Like this
- Use **bold**, *italic* and ==highlights==

???
Presenter notes go after a line holding only ???.
They show in presenter view, and go into PowerPoint and Keynote.

---

<!-- layout: section -->
## A section

---

> Anything you can write in Markdown can go on a slide.

---

## Code and tables

\`\`\`js
console.log("Hello, Decks");
\`\`\`

| Format | Export |
| --- | --- |
| PowerPoint | .pptx |
| Keynote | .key |
`;
