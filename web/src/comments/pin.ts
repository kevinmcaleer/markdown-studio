import type { EditorState } from "@codemirror/state";

// What a new comment gets pinned to. A selection wins; with just a cursor,
// it's the word the cursor is in, or else the line it's on (without the list,
// heading or quote markers in front). A blank line pins to nothing, so the
// comment is on the whole document.

export type PinKind = "selection" | "word" | "line" | "slide";

export type Pin = { from: number; to: number; text: string; kind: PinKind };

const MARKERS = /^\s*(?:(?:#{1,6}|[-*+]|\d+[.)]|>)\s+(?:\[[ xX]\]\s+)?)*/;

/** The passage for each kind of pin, in order of preference. */
export function pinsAt(state: EditorState): Pin[] {
  const { from, to, head } = state.selection.main;
  if (from !== to) return [{ from, to, text: state.sliceDoc(from, to), kind: "selection" }];

  const pins: Pin[] = [];
  const word = state.wordAt(head);
  if (word && word.to > word.from) pins.push({ from: word.from, to: word.to, text: state.sliceDoc(word.from, word.to), kind: "word" });
  const line = lineRange(state.doc.lineAt(head));
  if (line && !pins.some((p) => p.from === line.from && p.to === line.to)) pins.push({ ...line, kind: "line" });
  return pins;
}

/** A line's text without leading markers or surrounding spaces; null when that leaves nothing. */
export function lineRange(line: { from: number; text: string }): Omit<Pin, "kind"> | null {
  const start = MARKERS.exec(line.text)?.[0].length ?? 0;
  const text = line.text.slice(start).trimEnd();
  if (!text.trim()) return null;
  return { from: line.from + start, to: line.from + start + text.length, text };
}

export const PIN_LABELS: Record<PinKind, string> = {
  selection: "Selection",
  word: "Word",
  line: "Line",
  slide: "Slide",
};
