import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { Highlight } from "./highlightSyntax";
import { buildDecorations, closedCallouts } from "./livePreview";

/** The text each hidden or replaced range covers, given which lines the cursor is on. */
function hiddenText(doc: string, activeLines: number[] = []): string[] {
  const state = EditorState.create({ doc, extensions: markdown({ base: markdownLanguage, extensions: [Highlight] }) });
  ensureSyntaxTree(state, state.doc.length, 5000);
  const set = buildDecorations(state, [{ from: 0, to: doc.length }], new Set(activeLines));
  const out: string[] = [];
  set.between(0, doc.length, (from, to, deco) => {
    if (to > from && !deco.spec.class) out.push(state.sliceDoc(from, to));
  });
  return out;
}

describe("live preview", () => {
  it("hides heading marks except on the cursor's line", () => {
    expect(hiddenText("# Title\n\ntext")).toEqual(["# "]);
    expect(hiddenText("# Title\n\ntext", [1])).toEqual([]);
  });

  it("hides emphasis, highlight and inline code marks", () => {
    expect(hiddenText("**bold** ==hi== `code`")).toEqual(["**", "**", "==", "==", "`", "`"]);
  });

  it("shows a link's text and hides its URL", () => {
    expect(hiddenText("see [docs](https://x.y) now")).toEqual(["[", "]", "(", "https://x.y", ")"]);
  });

  it("swaps bullets and task markers for widgets", () => {
    expect(hiddenText("- one\n- [x] done")).toEqual(["-", "- [x] "]);
    expect(hiddenText("- one\n- [x] done", [2])).toEqual(["-"]);
  });

  it("hides a code block's fences until the cursor is inside it", () => {
    const doc = "text\n\n```python\nx = 1\n```\n";
    expect(hiddenText(doc)).toEqual(["```python", "```"]);
    expect(hiddenText(doc, [4])).toEqual([]);
    expect(hiddenText(doc, [3])).toEqual([]);
    expect(hiddenText(doc, [5])).toEqual([]);
    // An unclosed block keeps the rest of the document visible.
    expect(hiddenText("```js\nlet a")).toEqual(["```js"]);
  });

  it("leaves numbered lists and tables to themselves", () => {
    expect(hiddenText("1. one\n\n| a | b |\n| - | - |\n| c | d |")).toEqual([]);
  });

  it("hides quote marks", () => {
    expect(hiddenText("> quoted")).toEqual(["> "]);
  });

  it("draws a callout's [!type] as a widget, except on its line", () => {
    expect(hiddenText("> [!warning] Hot\n> Don't touch")).toEqual(["> [!warning] ", "> "]);
    expect(hiddenText("> [!warning] Hot\n> Don't touch", [1])).toEqual(["> "]);
    expect(hiddenText("> [!tip]-\n> body")).toEqual(["> [!tip]-", "> "]);
  });

  it("classes a callout's lines by type", () => {
    const doc = "> [!faq]- Why?\n> Because.";
    const state = EditorState.create({ doc, extensions: markdown({ base: markdownLanguage, extensions: [Highlight] }) });
    ensureSyntaxTree(state, doc.length, 5000);
    const classes: string[] = [];
    buildDecorations(state, [{ from: 0, to: doc.length }], new Set()).between(0, doc.length, (_f, _t, deco) => {
      if (deco.spec.class) classes.push(deco.spec.class);
    });
    expect(classes).toEqual(expect.arrayContaining(["cm-md-callout cm-md-callout-first", "callout-question", "cm-md-callout-title", "cm-md-callout cm-md-callout-last"]));
    expect(classes).not.toContain("cm-md-quote");
  });

  it("finds callouts that start folded", () => {
    const doc = "> [!note]- Closed\n> one\n> two\n\n> [!note]+ Open\n> three\n\n> [!tip]-\n\ntext";
    const state = EditorState.create({ doc });
    expect(closedCallouts(state).map(({ from, to }) => state.sliceDoc(from, to))).toEqual(["\n> one\n> two"]);
  });
});
