import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { Highlight } from "./highlightSyntax";
import { codeRenderers, findRenderedCode } from "./codeRenderers";
import { buildDecorations, closedCallouts, fencedCodeText } from "./livePreview";

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

  it("draws an image with its size modifier, and shows both on the cursor's line", () => {
    expect(hiddenText("![Chassis](/c.jpg){small} after")).toEqual(["![Chassis](/c.jpg){small}"]);
    expect(hiddenText("![Chassis](/c.jpg){huge}")).toEqual(["![Chassis](/c.jpg)"]);
    expect(hiddenText("![Chassis](/c.jpg){small}", [1])).toEqual([]);
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

  it("copies a fenced block's code without its fences", () => {
    const code = (doc: string) => {
      const state = EditorState.create({ doc, extensions: markdown({ base: markdownLanguage, extensions: [Highlight] }) });
      ensureSyntaxTree(state, state.doc.length, 5000);
      return fencedCodeText(state, doc.indexOf("```"));
    };
    expect(code("text\n\n```python\nx = 1\n  y = 2\n```\nafter")).toBe("x = 1\n  y = 2");
    expect(code("```\n```")).toBe("");
    // Unclosed: the rest of the document.
    expect(code("```js\nlet a\nlet b")).toBe("let a\nlet b");
    // Inside a list or a quote, without the markers each line carries.
    expect(code("- item\n\n  ```sh\n  ls -l\n  ```")).toBe("ls -l");
    expect(code("> ```sh\n> ls -l\n> ```")).toBe("ls -l");
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
