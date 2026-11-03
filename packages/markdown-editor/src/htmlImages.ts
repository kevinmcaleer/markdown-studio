import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { diagnostics, setDiagnostics, type Diagnostic } from "./diagnostics";
import { imageSizeMarkdown, type ImageSize } from "./imageSize";
import { maskCode } from "./lint/rules";

// HTML pictures in Markdown: `<img src="…" alt="…" width="500px">`, the way
// GitHub writes a pasted screenshot (github.com/user-attachments/…). The
// editor's Markdown leaves HTML out, so these show as code, not pictures, and
// none of the picture tools work on them. This finds them, marks each one,
// and offers to write it as Markdown, `![alt](src){size}`, one at a time or
// all at once. A `<p align="center">` or `<div>` holding only pictures goes
// too (Markdown inside an HTML block isn't read as Markdown), and a picture
// inside `<a href>` becomes a linked picture. HTML in code is left alone.

export type HtmlImage = {
  /** The whole span that is replaced: the tag, or its link, or its wrapper. */
  from: number;
  to: number;
  /** What it becomes. */
  markdown: string;
  /** How many pictures it holds (a wrapper can hold several). */
  count: number;
};

const IMG = /<img\b((?:[^>"']|"[^"]*"|'[^']*')*?)\/?\s*>/gi;
const ATTR = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const WRAPPER = /<(p|div|center|figure|span)\b(?:[^>"']|"[^"]*"|'[^']*')*>([\s\S]*?)<\/\1\s*>/gi;
const LINKED = /<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>\s*(<img\b(?:[^>"']|"[^"]*"|'[^']*')*?\/?\s*>)\s*<\/a\s*>/gi;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** The attributes of a tag's inside (`src="…" alt="…"`), names in lower case. */
export function parseAttributes(inside: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR.lastIndex = 0;
  for (let m = ATTR.exec(inside); m; m = ATTR.exec(inside)) {
    const name = m[1].toLowerCase();
    if (!(name in out)) out[name] = decode(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

/**
 * The size modifier nearest a tag's width. Half and small are a half and a
 * quarter of the text's width (about 700px); anything wider shows at its own
 * size, no wider than the text, which needs no modifier.
 */
export function sizeForWidth(width: string | undefined): ImageSize | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(px|%)?\s*$/i.exec(width ?? "");
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (m[2] === "%") return n >= 75 ? null : n >= 37.5 ? "half" : "small";
  return n >= 600 ? null : n >= 260 ? "half" : "small";
}

function widthOf(attrs: Record<string, string>): string | undefined {
  if (attrs.width) return attrs.width;
  return /(?:^|;)\s*(?:max-)?width\s*:\s*([^;]+)/i.exec(attrs.style ?? "")?.[1];
}

const escapeAlt = (s: string) => s.replace(/\s+/g, " ").trim().replace(/([\\[\]])/g, "\\$1");
const destination = (src: string) => (/[\s()<>]/.test(src) ? `<${src.replace(/[<>]/g, encodeURIComponent)}>` : src);

/** `![alt](src "title"){size}` for one `<img>` tag; null when it has no src. */
export function imgTagToMarkdown(tag: string, href?: string): string | null {
  const inside = /^<img\b([\s\S]*?)\/?\s*>$/i.exec(tag)?.[1];
  if (inside === undefined) return null;
  const attrs = parseAttributes(inside);
  const src = attrs.src?.trim();
  if (!src) return null;
  const title = attrs.title?.trim();
  const image = `![${escapeAlt(attrs.alt ?? "")}](${destination(src)}${title ? ` "${title.replace(/"/g, '\\"')}"` : ""})`;
  const sized = image + imageSizeMarkdown(sizeForWidth(widthOf(attrs)));
  return href ? `[${sized}](${destination(href)})` : sized;
}

/** What a link's or picture's tag becomes, if the whole thing can be written in Markdown. */
function convertOne(source: string): { markdown: string; count: number } | null {
  LINKED.lastIndex = 0;
  const linked = LINKED.exec(source);
  if (linked && linked.index === 0 && linked[0].length === source.length) {
    const href = parseAttributes(linked[1]).href?.trim();
    const md = imgTagToMarkdown(linked[2], href || undefined);
    return md ? { markdown: md, count: 1 } : null;
  }
  const md = imgTagToMarkdown(source);
  return md ? { markdown: md, count: 1 } : null;
}

/** The pictures in a wrapper's inside, if pictures (and line breaks) are all it holds. */
function convertWrapperInside(inside: string): { markdown: string; count: number } | null {
  const parts: string[] = [];
  const pieces = /<a\b(?:[^>"']|"[^"]*"|'[^']*')*>\s*<img\b(?:[^>"']|"[^"]*"|'[^']*')*?\/?\s*>\s*<\/a\s*>|<img\b(?:[^>"']|"[^"]*"|'[^']*')*?\/?\s*>|<br\s*\/?>|\s+/gi;
  let at = 0;
  let gap = "";
  for (let m = pieces.exec(inside); m; m = pieces.exec(inside)) {
    if (m.index !== at) return null;
    at = m.index + m[0].length;
    const piece = m[0];
    if (/^\s+$/.test(piece)) {
      if (!gap) gap = piece.includes("\n") ? "\n" : " ";
    } else if (/^<br/i.test(piece)) gap = "\n\n";
    else {
      const one = convertOne(piece);
      if (!one) return null;
      if (parts.length) parts.push(gap || " ");
      parts.push(one.markdown);
      gap = "";
    }
  }
  if (at !== inside.length) return null;
  const count = parts.filter((_, i) => i % 2 === 0).length;
  return count ? { markdown: parts.join(""), count } : null;
}

/** Every HTML picture in the Markdown, in order, with what each becomes. */
export function findHtmlImages(doc: string): HtmlImage[] {
  if (!/<img\b/i.test(doc)) return [];
  const masked = maskCode(doc);
  const found: HtmlImage[] = [];
  const taken = (from: number, to: number) => found.some((f) => from < f.to && to > f.from);
  const add = (from: number, to: number, result: { markdown: string; count: number } | null) => {
    if (!result || taken(from, to)) return;
    // Something blanked inside (a comment, code) means it isn't one plain tag.
    if (masked.slice(from, to) !== doc.slice(from, to)) return;
    found.push({ from, to, ...result });
  };

  WRAPPER.lastIndex = 0;
  for (let m = WRAPPER.exec(masked); m; m = WRAPPER.exec(masked)) {
    if (!/<img\b/i.test(m[2])) continue;
    const insideFrom = m.index + m[0].lastIndexOf("<") - m[2].length;
    add(m.index, m.index + m[0].length, convertWrapperInside(doc.slice(insideFrom, insideFrom + m[2].length)));
  }
  LINKED.lastIndex = 0;
  for (let m = LINKED.exec(masked); m; m = LINKED.exec(masked)) add(m.index, m.index + m[0].length, convertOne(doc.slice(m.index, m.index + m[0].length)));
  IMG.lastIndex = 0;
  for (let m = IMG.exec(masked); m; m = IMG.exec(masked)) add(m.index, m.index + m[0].length, convertOne(doc.slice(m.index, m.index + m[0].length)));
  return found.sort((a, b) => a.from - b.from);
}

/** The changes that write every HTML picture in ``doc`` as Markdown. */
export function htmlImageChanges(doc: string, only?: number) {
  const all = findHtmlImages(doc);
  const pick = only === undefined ? all : all.filter((f) => f.from <= only && only <= f.to).slice(0, 1);
  return pick.map((f) => ({ from: f.from, to: f.to, insert: f.markdown }));
}

/** Writes the HTML picture at ``pos`` (or every one, with no ``pos``) as Markdown; how many it changed. */
export function convertHtmlImages(view: EditorView, pos?: number): number {
  const changes = htmlImageChanges(view.state.doc.toString(), pos);
  if (!changes.length) return 0;
  view.dispatch({ changes, userEvent: "input.fix" });
  view.focus();
  return changes.length;
}

// Long GitHub addresses cut down to their ends, so the card stays small.
const short = (s: string) => s.replace(/\]\((<?)([^)\s>]{40,})/g, (_, lt: string, url: string) => `](${lt}${url.slice(0, 22)}…${url.slice(-8)}`);

function toDiagnostics(images: HtmlImage[]): Diagnostic[] {
  const pictures = images.reduce((n, f) => n + f.count, 0);
  return images.map((f) => ({
    from: f.from,
    to: f.to,
    source: "markup",
    rule: "html-image",
    title: f.count > 1 ? `${f.count} pictures written in HTML` : "Picture written in HTML",
    message: `As Markdown it shows as a picture, with the editor's size and caption tools: ${short(f.markdown)}`,
    fixes: [
      { label: "Change to Markdown", from: f.from, to: f.to, insert: f.markdown, apply: (view) => void convertHtmlImages(view, f.from) },
      ...(images.length > 1 ? [{ label: `Fix all ${pictures} in this document`, from: f.from, to: f.to, insert: f.markdown, apply: (view: EditorView) => void convertHtmlImages(view) }] : []),
    ],
  }));
}

const DELAY = 300;

/**
 * Marks HTML pictures and offers to change them. ``onFound`` hears the list
 * whenever it changes (for the hints panel).
 */
export function htmlImages(onFound?: (images: HtmlImage[]) => void): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      timer = 0;
      last = "";
      constructor(readonly view: EditorView) {
        this.timer = window.setTimeout(() => this.run(), 0);
      }
      update(u: ViewUpdate) {
        if (!u.docChanged) return;
        clearTimeout(this.timer);
        this.timer = window.setTimeout(() => this.run(), DELAY);
      }
      run() {
        const images = findHtmlImages(this.view.state.doc.toString());
        const key = images.map((f) => `${f.from}:${f.to}:${f.markdown}`).join("|");
        if (key === this.last) return;
        this.last = key;
        this.view.dispatch({ effects: setDiagnostics.of({ source: "markup", items: toDiagnostics(images) }) });
        onFound?.(images);
      }
      destroy() {
        clearTimeout(this.timer);
      }
    },
  );
  return [diagnostics(), plugin];
}
