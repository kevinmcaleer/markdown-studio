import type { EditorState, Text } from "@codemirror/state";
import type { Diagnostic, DiagnosticFix, DiagnosticSuggest } from "../diagnostics";
import { languageFeatures, rewriteSentence } from "../proofing/languageApi";

// "Rewrite as active" on the passive-voice hint. The server (the host's
// language API) asks an AI for the sentence in the active voice; the hover
// card shows it beside the original, and nothing changes until "Use this".

let available = false;

/** Asks the server once whether it can rewrite, so the card knows whether to offer it. */
export function watchRewrite(): void {
  languageFeatures().then(
    (f) => (available = !!f.rewrite),
    () => (available = false),
  );
}

// Block markers at the start of a line that aren't part of the sentence:
// quotes and callouts, list bullets and numbers, task boxes, headings.
const LINE_PREFIX = /^\s*(?:>\s?)*\s*(?:\[![\w-]+\][+-]?\s*)?(?:[-*+]\s+|\d+[.)]\s+)?(?:\[[ xX]\]\s+)?(?:#{1,6}\s+)?/;
// The end of a sentence: . ! or ? (and any closing quotes or brackets) before a space or the end.
const SENTENCE_END = /[.!?]+["'”’)\]*_]*(?=\s|$)/g;

/** The sentence around `from`–`to`, or null when it runs across lines or table cells. */
export function sentenceAround(doc: Text, from: number, to: number): { from: number; to: number; text: string } | null {
  const line = doc.lineAt(from);
  if (to > line.to) return null;
  let start = line.from + (LINE_PREFIX.exec(line.text)?.[0].length ?? 0);
  let end = line.to;
  // A table row: the sentence stays in its own cell.
  if (line.text.includes("|")) {
    const before = line.text.lastIndexOf("|", from - line.from - 1);
    const after = line.text.indexOf("|", to - line.from);
    if (before >= 0) start = Math.max(start, line.from + before + 1);
    if (after >= 0) end = line.from + after;
  }
  while (start < from && /\s/.test(doc.sliceString(start, start + 1))) start++;
  if (from < start) return null;
  const base = start;
  const text = doc.sliceString(base, end);
  for (const m of text.matchAll(SENTENCE_END)) {
    const stop = base + m.index! + m[0].length;
    if (stop <= from) {
      // That sentence ended before the hint: the next one starts here.
      const rest = doc.sliceString(stop, from);
      start = stop + (rest.length - rest.trimStart().length);
    } else if (stop >= to) {
      end = stop;
      break;
    }
  }
  const sentence = doc.sliceString(start, end);
  const trimmed = sentence.trimEnd();
  if (!trimmed.trim()) return null;
  return { from: start, to: start + trimmed.length, text: trimmed };
}

export async function activeRewrite(state: EditorState, d: Diagnostic): Promise<DiagnosticFix | string> {
  const sentence = sentenceAround(state.doc, d.from, d.to);
  if (!sentence) return "Couldn't find the whole sentence to rewrite.";
  const phrase = state.sliceDoc(d.from, d.to);
  let insert: string;
  try {
    insert = await rewriteSentence(sentence.text, phrase);
  } catch (err) {
    const status = (err as { status?: number } | null)?.status;
    if (status === 429) return "That's a lot of rewrites in a minute. Try again shortly.";
    if (status === 401 || status === 403) return "Sign in to get rewrites.";
    return "Couldn't get a suggestion just now. Try again in a moment.";
  }
  if (!insert.trim() || insert.trim() === sentence.text.trim()) return "There's no clear active version of this one. It may read best as it is.";
  return { label: "Use this", from: sentence.from, to: sentence.to, insert: insert.trim() };
}

export const rewriteAsActive: DiagnosticSuggest = {
  label: "Rewrite as active",
  busy: "Rewriting…",
  available: () => available,
  run: activeRewrite,
};
