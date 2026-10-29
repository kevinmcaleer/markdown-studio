import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { checkable } from "./spellCore";

// Which parts of a note are prose. Spelling and grammar look only at those:
// code, URLs, HTML and the Markdown marks themselves are left alone.

/** A run of the note: prose (`text`), or Markdown and code (`markup`), which the checkers skip. */
export type Segment = { from: number; to: number; markup: boolean; interpretAs?: string };

export type Word = { from: number; to: number; word: string };

// Skipped whole, contents and all.
const SKIP = /^(FencedCode|CodeBlock|InlineCode|CodeText|CodeInfo|URL|Autolink|HTMLTag|HTMLBlock|Comment|CommentBlock|ProcessingInstruction|LinkLabel|LinkTitle)$/;
// Marks inside prose (#, **, -, |, ==).
const MARK = /(Mark|Marker|Delimiter)$/;

/** Whether `pos` sits in code, a URL or HTML, where words aren't prose. */
export function inCode(state: EditorState, pos: number): boolean {
  for (let node: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (SKIP.test(node.name)) return true;
  }
  return false;
}

/** The note between `from` and `to`, split into prose and markup, in order and without gaps. */
export function segments(state: EditorState, from: number, to: number): Segment[] {
  const skipped: Segment[] = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (SKIP.test(node.name)) {
        // Inline code and bare links stand for a word, so a sentence around them still reads.
        const word = node.name === "InlineCode" || node.name === "URL" || node.name === "Autolink";
        skipped.push({ from: node.from, to: node.to, markup: true, ...(word && !inLink(node.node) && { interpretAs: "code" }) });
        return false;
      }
      if (MARK.test(node.name)) {
        // Table pipes separate cells; read them as breaks so cells aren't run together.
        skipped.push({ from: node.from, to: node.to, markup: true, ...(node.name === "TableDelimiter" && { interpretAs: "\n\n" }) });
        return false;
      }
      return undefined;
    },
  });
  const out: Segment[] = [];
  let pos = from;
  for (const s of skipped) {
    const start = Math.max(s.from, from);
    const end = Math.min(s.to, to);
    if (end <= pos) continue;
    if (start > pos) out.push({ from: pos, to: start, markup: false });
    out.push({ ...s, from: Math.max(start, pos), to: end });
    pos = end;
  }
  if (pos < to) out.push({ from: pos, to, markup: false });
  return out;
}

function inLink(node: { parent: { name: string; parent: unknown } | null }): boolean {
  return node.parent?.name === "Link" || node.parent?.name === "Image";
}

const TOKEN = /[\p{L}\p{M}\p{N}_]+(?:['’][\p{L}\p{M}]+)*/gu;

/** The words worth spell-checking between `from` and `to`. */
export function words(state: EditorState, from: number, to: number): Word[] {
  const out: Word[] = [];
  for (const seg of segments(state, from, to)) {
    if (seg.markup) continue;
    const text = state.sliceDoc(seg.from, seg.to);
    for (const m of text.matchAll(TOKEN)) {
      const start = seg.from + m.index;
      const end = start + m[0].length;
      if (!checkable(m[0]) || looksLikeCode(state, start, end)) continue;
      out.push({ from: start, to: end, word: m[0] });
    }
  }
  return out;
}

/** The word under `pos`, if it's prose. */
export function wordAt(state: EditorState, pos: number): Word | null {
  const line = state.doc.lineAt(pos);
  for (const m of line.text.matchAll(TOKEN)) {
    const from = line.from + m.index;
    const to = from + m[0].length;
    if (from <= pos && pos <= to) return inCode(state, from) ? null : { from, to, word: m[0] };
  }
  return null;
}

/** Part of a path, an email, a handle or a file name: a/b, kev@x, @kev, #tag, notes.md. */
function looksLikeCode(state: EditorState, from: number, to: number): boolean {
  const before = state.sliceDoc(Math.max(0, from - 2), from);
  const after = state.sliceDoc(to, Math.min(state.doc.length, to + 2));
  return /[@#/\\$]$|\w\.$/.test(before) || /^([/\\@]|\.\w)/.test(after);
}
