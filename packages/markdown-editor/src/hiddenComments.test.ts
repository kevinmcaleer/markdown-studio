import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { findHiddenComments, hiddenComments } from "./hiddenComments";

const marker = "<!-- pinout from the wiring diagram: 1a2b3c4d -->";
const doc = ["# Wiring", "", marker, "| MCU Pin | Part |", "| --- | --- |", "| GP0 | Servo |", "", "<!-- my own note -->", "", "Text <!-- pinout inline --> here."].join("\n");

function hidden(text: string, tests = [(c: string) => /^<!--\s*pinout\b/.test(c)]) {
  const state = EditorState.create({ doc: text, extensions: [markdown(), ...tests.map((t) => hiddenComments.of(t))] });
  ensureSyntaxTree(state, state.doc.length, 5000);
  const out: string[] = [];
  findHiddenComments(state).between(0, state.doc.length, (from, to) => {
    out.push(state.sliceDoc(from, to));
  });
  return out;
}

describe("hiddenComments", () => {
  it("hides the comment blocks the host's test accepts", () => {
    expect(hidden(doc)).toEqual([marker]);
  });

  it("leaves the writer's own comments and inline comments", () => {
    expect(hidden(doc).some((t) => t.includes("my own note") || t.includes("inline"))).toBe(false);
  });

  it("hides nothing without a test", () => {
    expect(hidden(doc, [])).toEqual([]);
  });

  it("keeps the table after the marker a table", () => {
    const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
    const tree = ensureSyntaxTree(state, state.doc.length, 5000)!;
    const names: string[] = [];
    for (let node = tree.topNode.firstChild; node; node = node.nextSibling) names.push(node.name);
    expect(names.slice(0, 3)).toEqual(["ATXHeading1", "CommentBlock", "Table"]);
  });
});
