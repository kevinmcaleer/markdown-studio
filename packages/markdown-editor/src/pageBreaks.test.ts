import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { applyCommand } from "./slashMenu";
import { findPageBreaks, isPageBreak, PAGE_BREAK, pageBreakCommand, pageBreakRemoval, pageBreaksOn } from "./pageBreaks";

const doc = ["# Overview", "", "Intro.", "", PAGE_BREAK, "", "# Wiring", "", "<!-- my note -->", "", "<!-- page -->", "", "# Code", "", "Text <!-- page --> inline."].join("\n");

function state(text: string, on = true) {
  const s = EditorState.create({ doc: text, extensions: [markdown({ base: markdownLanguage }), on ? pageBreaksOn.of(true) : []] });
  ensureSyntaxTree(s, s.doc.length, 5000);
  return s;
}

function breaks(text: string, on = true) {
  const s = state(text, on);
  const out: { text: string; page: number }[] = [];
  findPageBreaks(s).between(0, s.doc.length, (from, to, deco) => {
    out.push({ text: s.sliceDoc(from, to), page: (deco.spec.widget as unknown as { page: number }).page });
  });
  return out;
}

describe("pageBreaks", () => {
  it("knows the marker", () => {
    expect(isPageBreak("<!-- page -->")).toBe(true);
    expect(isPageBreak("<!--page-->")).toBe(true);
    expect(isPageBreak("<!-- Page break -->")).toBe(true);
    expect(isPageBreak("<!-- page one -->")).toBe(false);
    expect(isPageBreak("<!-- my note -->")).toBe(false);
  });

  it("draws each block marker as the page it starts", () => {
    expect(breaks(doc)).toEqual([
      { text: PAGE_BREAK, page: 2 },
      { text: "<!-- page -->", page: 3 },
    ]);
  });

  it("draws nothing unless the host turned page breaks on", () => {
    expect(breaks(doc, false)).toEqual([]);
  });

  it("inserts the marker on its own line with blank lines around it", () => {
    const s = EditorState.create({ doc: "Intro.\n/page" });
    const tr = s.update(applyCommand(s, pageBreakCommand, 7, 12));
    expect(tr.state.doc.toString()).toBe(`Intro.\n\n${PAGE_BREAK}\n\n`);
  });

  it("removes a marker and the blank line after it", () => {
    const s = state(doc);
    const n = s.doc.lineAt(doc.indexOf(PAGE_BREAK)).number;
    const out = s.update({ changes: pageBreakRemoval(s, n) }).state.doc.toString();
    expect(out.startsWith("# Overview\n\nIntro.\n\n# Wiring")).toBe(true);
  });
});
