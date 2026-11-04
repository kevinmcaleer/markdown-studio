import { type EditorState, Facet } from "@codemirror/state";
import MarkdownIt from "markdown-it";
import { cardsPlugin } from "../cards";
import { isPageBreak, pageBreaksOn } from "../pageBreaks";

// Places in the text itself that a link can go to: its headings, and its
// pages when the host splits the text into pages. The link form lists them
// under the URL field as the writer types (or straight away, while the URL is
// empty), the way Google Docs offers "Headings" there, so linking to another
// section is a click rather than guessing its #id.
//
// Ids follow the host's published page: kevsrobots gives each heading the id
// slug(text), with -2, -3 for repeats, and #page-N opens page N.

export type LinkTarget = {
  kind: "heading" | "page";
  /** The id the link goes to, without the "#". */
  id: string;
  /** The heading's text, or "Page N". */
  text: string;
  /** The heading's level; 0 for a page. */
  level: number;
  /** The page it's on (1 when the text has no pages). */
  page: number;
  /** For a page, the text of its first heading. */
  title?: string;
  /** Where it starts in the text. */
  from: number;
};

/** Turns the list of headings (and pages) on in the link form (any `true` wins). */
export const linkTargetsOn = Facet.define<boolean, boolean>({ combine: (values) => values.some(Boolean) });

/** A heading's id, as kevsrobots' project pages make it. */
export function headingSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// Card titles in a `::: cards` block are the cards' own, not the text's
// sections; html on, so the page-break comments come through as blocks.
const md = new MarkdownIt({ html: true }).use(cardsPlugin);

type InlineToken = { type: string; content: string; children: InlineToken[] | null };

const plainText = (children: InlineToken[]): string =>
  children
    .map((c) => (c.type === "text" || c.type === "code_inline" ? c.content : c.type === "softbreak" ? " " : c.type === "image" ? plainText(c.children ?? []) : ""))
    .join("");

/** The text's headings in order, with its pages before their headings when `pages` is on and it has page breaks. */
export function findLinkTargets(doc: string, pages = false): LinkTarget[] {
  const tokens = md.parse(doc, {});
  const starts = [0];
  for (let i = doc.indexOf("\n"); i >= 0; i = doc.indexOf("\n", i + 1)) starts.push(i + 1);
  const offset = (line: number) => (line < starts.length ? starts[line] : doc.length);

  const headings: LinkTarget[] = [];
  const breaks: number[] = [];
  const seen = new Map<string, number>();
  let page = 1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.level !== 0 || !t.map) continue;
    if (t.type === "html_block" && isPageBreak(t.content)) {
      page += 1;
      breaks.push(offset(t.map[0]));
      continue;
    }
    if (t.type !== "heading_open") continue;
    const inline = tokens[i + 1];
    const text = (plainText((inline?.children ?? []) as InlineToken[]) || inline?.content || "").trim();
    if (!text) continue;
    const base = headingSlug(text) || "section";
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    headings.push({ kind: "heading", id: n > 1 ? `${base}-${n}` : base, text, level: Number(t.tag.slice(1)), page, from: offset(t.map[0]) });
  }
  if (!pages || !breaks.length) return headings;

  const out: LinkTarget[] = [];
  for (let n = 1; n <= breaks.length + 1; n++) {
    const own = headings.filter((h) => h.page === n);
    out.push({ kind: "page", id: `page-${n}`, text: `Page ${n}`, level: 0, page: n, title: own[0]?.text, from: n === 1 ? 0 : breaks[n - 2] });
    out.push(...own);
  }
  return out;
}

/** The targets for the editor's text, or none when the host hasn't turned them on. */
export function linkTargets(state: EditorState): LinkTarget[] {
  if (!state.facet(linkTargetsOn)) return [];
  return findLinkTargets(state.doc.toString(), state.facet(pageBreaksOn));
}

/**
 * What to look for among the targets, from what's in the URL field: "" for
 * everything (an empty field, or just "#"), the words after a "#", or plain
 * words. Null for something that is already a URL or a path, so the list
 * keeps out of the way of a pasted link.
 */
export function targetQuery(url: string): string | null {
  const value = url.trim();
  if (value.startsWith("#")) return value.slice(1).trim();
  if (/[/:@]|^www\.|\.[a-z]{2,}(?:$|[/?#])/i.test(value)) return null;
  return value;
}

/** The targets matching `query`: every word in it starts a word of the target's text (or id); a match at the start comes first. */
export function filterTargets(targets: LinkTarget[], query: string): LinkTarget[] {
  const words = query.toLowerCase().split(/[\s-]+/).filter(Boolean);
  if (!words.length) return targets;
  const scored = targets.flatMap((t, i) => {
    const hay = `${t.text} ${t.title ?? ""}`.toLowerCase();
    const starts = hay.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const all = words.every((w) => starts.some((s) => s.startsWith(w)) || t.id.includes(w));
    if (!all) return [];
    return [{ t, i, first: hay.startsWith(words[0]) ? 0 : 1 }];
  });
  return scored.sort((a, b) => a.first - b.first || a.i - b.i).map((s) => s.t);
}

/** The target a `#id` link goes to, if the text has it. */
export function targetFor(targets: LinkTarget[], url: string): LinkTarget | null {
  if (!url.startsWith("#")) return null;
  let id = url.slice(1);
  try {
    id = decodeURIComponent(id);
  } catch {
    /* keep it as written */
  }
  return targets.find((t) => t.id === id) ?? null;
}
