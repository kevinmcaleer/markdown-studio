// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { Highlight } from "./highlightSyntax";
import { codeEditors, codeRenderers, findRenderedCode, renderedCodeField, type CodeEditorContext } from "./codeRenderers";
import { buildDecorations, closedCallouts, fencedCodeText, livePreview } from "./livePreview";
import { diagnostics, setDiagnostics } from "./diagnostics";

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

  it("shows a link whose text is itself a URL", () => {
    // GFM parses the bare URL in the label as a URL node too; only the target is hidden.
    expect(hiddenText("[https://x.y/a](https://x.y/a)")).toEqual(["[", "]", "(", "https://x.y/a", ")"]);
  });

  it("marks a link's text with where it goes", () => {
    const doc = "a [Pico](/parts/view.html?slug=pico) and [https://x.y/a](https://x.y/b)";
    const state = EditorState.create({ doc, extensions: markdown({ base: markdownLanguage, extensions: [Highlight] }) });
    ensureSyntaxTree(state, state.doc.length, 5000);
    const hrefs: string[] = [];
    buildDecorations(state, [{ from: 0, to: doc.length }], new Set()).between(0, doc.length, (from, to, deco) => {
      if (deco.spec.class === "cm-md-link") hrefs.push(state.sliceDoc(from, to) + " -> " + deco.spec.attributes["data-href"]);
    });
    expect(hrefs).toEqual(["Pico -> /parts/view.html?slug=pico", "https://x.y/a -> https://x.y/b"]);
  });

  it("keeps a link's text in one element when a word in it is underlined", () => {
    const doc = "intro\n\nsee [Raspbery Pi](/parts/view.html?slug=pi) now";
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      state: EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage, extensions: [Highlight] }), livePreview(), diagnostics()] }),
      parent,
    });
    const from = doc.indexOf("Raspbery");
    view.dispatch({ effects: setDiagnostics.of({ source: "spelling", items: [{ from, to: from + 8, source: "spelling", rule: "s", title: "t", message: "m" }] }) });
    const links = view.dom.querySelectorAll(".cm-md-link");
    expect([...links].map((el) => el.textContent)).toEqual(["Raspbery Pi"]);
    expect(links[0].querySelector(".cm-diag-spelling")?.textContent).toBe("Raspbery");
    view.destroy();
  });

  it("draws an image with its size modifier, and shows both on the cursor's line", () => {
    expect(hiddenText("![Chassis](/c.jpg){small} after")).toEqual(["![Chassis](/c.jpg){small}"]);
    expect(hiddenText("![Chassis](/c.jpg){huge}")).toEqual(["![Chassis](/c.jpg)"]);
    expect(hiddenText("![Chassis](/c.jpg){small}", [1])).toEqual([]);
  });

  it("swaps bullets and task markers for widgets", () => {
    // Each covers the item's whole prefix, nested spaces too; in a quote, just the marker.
    expect(hiddenText("- one\n- [x] done")).toEqual(["- ", "- [x] "]);
    expect(hiddenText("- one\n- [x] done", [2])).toEqual(["- "]);
    expect(hiddenText("- one\n  - two")).toEqual(["- ", "  - "]);
    expect(hiddenText("> - quoted")).toEqual(["> ", "-"]);
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

  it("hangs a list item's wrapped lines under its words", () => {
    const doc = "1. one\n   1. nested\n- [ ] task\n> - quoted";
    const state = EditorState.create({ doc, extensions: markdown({ base: markdownLanguage, extensions: [Highlight] }) });
    ensureSyntaxTree(state, state.doc.length, 5000);
    const set = buildDecorations(state, [{ from: 0, to: doc.length }], new Set([1]));
    const hangs: string[] = [];
    const markers: string[] = [];
    set.between(0, doc.length, (from, to, deco) => {
      if (deco.spec.class === "cm-md-list-item") hangs.push(deco.spec.attributes.style);
      if (deco.spec.class === "cm-md-list-marker") markers.push(state.sliceDoc(from, to));
    });
    // Quoted lists are left alone; the cursor's line hangs too, so it doesn't jump.
    expect(hangs).toEqual(["--mde-hang: 1.3em", "--mde-hang: 2.6em", "--mde-hang: 1.3em"]);
    // The cursor's line keeps its spaces in the box; a nested number's are a widget
    // before it; a task's checkbox widget is its own box.
    expect(markers).toEqual(["1. ", "1. "]);
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

describe("code block editors", () => {
  const doc = "intro\n\n```mermaid\ngraph TD\n  A-->B\n```\n\nafter";

  function setup(cursor: number) {
    const mounted: CodeEditorContext[] = [];
    const destroyed: string[] = [];
    const state = EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: [
        markdown({ base: markdownLanguage, extensions: [Highlight] }),
        codeRenderers.of({ mermaid: () => {} }),
        codeEditors.of({
          mermaid: (context) => {
            mounted.push(context);
            return { setSource: () => {}, destroy: () => destroyed.push(context.source) };
          },
        }),
        renderedCodeField,
      ],
    });
    ensureSyntaxTree(state, state.doc.length, 5000);
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state, parent });
    return { view, mounted, destroyed };
  }

  it("shows the block as its editor while the cursor is in it", () => {
    const { view, mounted } = setup(doc.indexOf("A-->B"));
    expect(mounted.map((m) => m.source)).toEqual(["graph TD\n  A-->B"]);
    expect(view.dom.querySelector(".cm-md-code-editor-mermaid")).not.toBeNull();
    view.destroy();
  });

  it("writes the editor's changes into the block", () => {
    const { view, mounted } = setup(doc.indexOf("A-->B"));
    mounted[0].onChange("graph TD\n  A-->B\n  B-->C");
    expect(view.state.doc.toString()).toBe("intro\n\n```mermaid\ngraph TD\n  A-->B\n  B-->C\n```\n\nafter");
    view.destroy();
  });

  it("hands the cursor back and closes the editor", () => {
    const { view, mounted, destroyed } = setup(doc.indexOf("A-->B"));
    mounted[0].onExit("after");
    expect(view.state.doc.lineAt(view.state.selection.main.head).text).toBe("");
    expect(view.state.selection.main.head).toBe(doc.indexOf("```\n\n") + 4);
    expect(destroyed).toEqual(["graph TD\n  A-->B"]);
    expect(view.dom.querySelector(".cm-md-code-editor")).toBeNull();
    view.destroy();
  });

  it("draws the block while the cursor is elsewhere", () => {
    const { view, mounted } = setup(0);
    expect(mounted).toEqual([]);
    view.destroy();
  });
});
