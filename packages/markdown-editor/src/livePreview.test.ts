import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { Highlight } from "./highlightSyntax";
import { codeRenderers, findRenderedCode } from "./codeRenderers";
import { buildDecorations } from "./livePreview";

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
});

describe("rendered code blocks", () => {
  /** The source of each block drawn by a renderer, with the cursor at `cursor`. */
  function drawn(doc: string, cursor: number, renderers: Record<string, () => void> = { mermaid: () => {} }): string[] {
    const state = EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: [markdown({ base: markdownLanguage, extensions: [Highlight] }), codeRenderers.of(renderers)],
    });
    ensureSyntaxTree(state, state.doc.length, 5000);
    const out: string[] = [];
    findRenderedCode(state).between(0, doc.length, (from, to) => {
      out.push(state.sliceDoc(from, to));
    });
    return out;
  }
  const doc = "intro\n\n```mermaid\ngraph TD\n  A-->B\n```\n\n```python\nx = 1\n```\n";

  it("draws blocks in a language with a renderer while the cursor is elsewhere", () => {
    expect(drawn(doc, 0)).toEqual(["```mermaid\ngraph TD\n  A-->B\n```"]);
  });

  it("shows the source while the cursor is in the block", () => {
    expect(drawn(doc, doc.indexOf("A-->B"))).toEqual([]);
    expect(drawn(doc, doc.indexOf("```mermaid"))).toEqual([]);
  });

  it("draws nothing without renderers, or for an unclosed block", () => {
    expect(drawn(doc, 0, {})).toEqual([]);
    expect(drawn("```mermaid\ngraph TD", 0)).toEqual([]);
  });
});
