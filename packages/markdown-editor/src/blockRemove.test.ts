import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { blockRemoval, closingFence, sectionBinsField, sectionEnd, sectionRemovers } from "./blockRemove";

function state(text: string, remove?: (h: string, level: number) => string | null) {
  const s = EditorState.create({
    doc: text,
    extensions: [markdown({ base: markdownLanguage }), remove ? sectionRemovers.of(remove) : [], sectionBinsField],
  });
  ensureSyntaxTree(s, s.doc.length, 5000);
  return s;
}

function without(s: EditorState, range: { from: number; to: number }) {
  return s.sliceDoc(0, range.from) + s.sliceDoc(range.to);
}

describe("blockRemoval", () => {
  it("takes the block's lines and the blank line after them", () => {
    const s = state(["Intro.", "", "::: videos", "https://youtu.be/abc", ":::", "", "After."].join("\n"));
    const open = s.doc.line(3);
    const range = blockRemoval(s, open.from, closingFence(s, 3));
    expect(without(s, range)).toBe(["Intro.", "", "After."].join("\n"));
  });

  it("takes the blank line before a block that's followed by text", () => {
    const s = state(["Intro.", "", "```mermaid", "graph TD", "```", "After."].join("\n"));
    const range = blockRemoval(s, s.doc.line(3).from, closingFence(s, 3));
    expect(without(s, range)).toBe(["Intro.", "After."].join("\n"));
  });

  it("leaves no trailing gap at the end of the text", () => {
    const s = state(["Intro.", "", "::: cards", "### A", ":::"].join("\n"));
    const range = blockRemoval(s, s.doc.line(3).from, closingFence(s, 3));
    expect(without(s, range)).toBe("Intro.");
  });

  it("finds a fenced block's own closing fence", () => {
    const s = state(["~~~mermaid", "```", "~~~", ":::"].join("\n"));
    expect(closingFence(s, 1)).toBe(s.doc.line(3).to);
  });
});

describe("sections", () => {
  const doc = [
    "# My robot",
    "",
    "Intro.",
    "",
    "# Bill of Materials",
    "",
    "| Part | Qty |",
    "| - | - |",
    "| Pico | 1 |",
    "",
    "## Notes",
    "",
    "```python",
    "# not a heading",
    "```",
    "",
    "# Wiring",
    "",
    "![wiring](w.png)",
    "",
  ].join("\n");

  it("ends before the next heading at its level or above", () => {
    const s = state(doc);
    expect(sectionEnd(s, 5)).toBe(s.doc.line(15).to);
    expect(sectionEnd(s, 11)).toBe(s.doc.line(15).to);
    expect(sectionEnd(s, 17)).toBe(s.doc.line(19).to);
  });

  it("removes a whole section, leaving one blank line between its neighbours", () => {
    const s = state(doc);
    const range = blockRemoval(s, s.doc.line(5).from, sectionEnd(s, 5));
    expect(without(s, range)).toBe(["# My robot", "", "Intro.", "", "# Wiring", "", "![wiring](w.png)", ""].join("\n"));
  });

  it("puts a bin only on the headings the host names", () => {
    const named = (h: string) => (["Bill of Materials", "Wiring"].includes(h) ? h : null);
    const s = state(doc, named);
    const lines: number[] = [];
    s.field(sectionBinsField).between(0, s.doc.length, (from) => {
      lines.push(s.doc.lineAt(from).number);
    });
    expect(lines).toEqual([5, 17]);
    expect(state(doc).field(sectionBinsField).size).toBe(0);
  });
});
