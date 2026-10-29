import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { Highlight } from "../highlightSyntax";
import { activeFormats, insertBlock, insertLink, lineBlock, setBlock, shiftLines, toggleMark } from "./formatting";

/** A state from a doc where "[" and "]" mark the selection, or "|" the cursor. */
function at(doc: string) {
  let anchor: number;
  let head: number;
  if (doc.includes("|")) {
    anchor = head = doc.indexOf("|");
    doc = doc.replace("|", "");
  } else {
    anchor = doc.indexOf("[");
    doc = doc.replace("[", "");
    head = doc.indexOf("]");
    doc = doc.replace("]", "");
  }
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    extensions: markdown({ base: markdownLanguage, extensions: [Highlight] }),
  });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
}

/** The doc after the change, with the selection marked the same way. */
function after(state: EditorState, spec: (s: EditorState) => TransactionSpec) {
  const next = state.update(spec(state)).state;
  const { from, to } = next.selection.main;
  const doc = next.doc.toString();
  return from === to ? doc.slice(0, from) + "|" + doc.slice(from) : doc.slice(0, from) + "[" + doc.slice(from, to) + "]" + doc.slice(to);
}

describe("toggleMark", () => {
  it("wraps the selection and keeps it selected", () => {
    expect(after(at("a [word] b"), (s) => toggleMark(s, "bold"))).toBe("a **[word]** b");
    expect(after(at("a [word] b"), (s) => toggleMark(s, "highlight"))).toBe("a ==[word]== b");
  });

  it("leaves spaces at the edges of the selection outside the marks", () => {
    expect(after(at("a[ word ]b"), (s) => toggleMark(s, "italic"))).toBe("a *[word]* b");
  });

  it("takes the mark off when it's already there", () => {
    expect(after(at("a **[word]** b"), (s) => toggleMark(s, "bold"))).toBe("a [word] b");
    expect(after(at("a [**word**] b"), (s) => toggleMark(s, "bold"))).toBe("a [word] b");
    expect(after(at("a ~~wo|rd~~ b"), (s) => toggleMark(s, "strike"))).toBe("a wo|rd b");
  });

  it("wraps the word under the cursor", () => {
    expect(after(at("say hel|lo now"), (s) => toggleMark(s, "bold"))).toBe("say **hel|lo** now");
  });

  it("inserts empty marks with the cursor between them", () => {
    expect(after(at("say |"), (s) => toggleMark(s, "code"))).toBe("say `|`");
  });

  it("wraps each line's text on its own, past list markers", () => {
    expect(after(at("- [one\n- two]"), (s) => toggleMark(s, "bold"))).toBe("- **[one**\n- **two]**");
  });
});

describe("setBlock", () => {
  it("turns lines into list items and back", () => {
    expect(after(at("[one\ntwo]"), (s) => setBlock(s, "bullet"))).toBe("- [one\n- two]");
    expect(after(at("[- one\n- two]"), (s) => setBlock(s, "bullet"))).toBe("[one\ntwo]");
  });

  it("swaps one style for another", () => {
    expect(after(at("- [ ] ta|sk"), (s) => setBlock(s, "numbered"))).toBe("1. ta|sk");
    expect(after(at("## Ti|tle"), (s) => setBlock(s, "h1"))).toBe("# Ti|tle");
    expect(after(at("# Ti|tle"), (s) => setBlock(s, "paragraph"))).toBe("Ti|tle");
  });

  it("numbers lines, carrying on from the list above", () => {
    expect(after(at("[a\nb\nc]"), (s) => setBlock(s, "numbered"))).toBe("1. [a\n2. b\n3. c]");
    expect(after(at("1. a\n|b"), (s) => setBlock(s, "numbered"))).toBe("1. a\n2. |b");
  });

  it("puts the cursor after the new marker on an empty line", () => {
    expect(after(at("|"), (s) => setBlock(s, "checklist"))).toBe("- [ ] |");
  });

  it("keeps a nested item's indentation", () => {
    expect(after(at("- a\n  - |b"), (s) => setBlock(s, "checklist"))).toBe("- a\n  - [ ] |b");
  });
});

describe("shiftLines", () => {
  it("nests a list item under the one above", () => {
    expect(after(at("- a\n- |b"), (s) => shiftLines(s, 1))).toBe("- a\n  - |b");
    expect(after(at("1. a\n2. |b"), (s) => shiftLines(s, 1))).toBe("1. a\n   2. |b");
  });

  it("outdents to the parent item", () => {
    expect(after(at("1. a\n   - |b"), (s) => shiftLines(s, -1))).toBe("1. a\n- |b");
  });
});

describe("inserts", () => {
  it("puts a table below the current line", () => {
    const out = after(at("He|llo"), (s) => insertBlock(s, "table"));
    expect(out.startsWith("Hello\n\n| [Column 1] | Column 2 | Column 3 |")).toBe(true);
  });

  it("fences the selected lines", () => {
    expect(after(at("[x = 1\ny = 2]"), (s) => insertBlock(s, "code"))).toBe("```|\nx = 1\ny = 2\n```");
  });

  it("links the selection and selects the URL", () => {
    expect(after(at("see [docs]"), insertLink)).toBe("see [docs]([https://])");
  });
});

describe("activeFormats", () => {
  it("reports marks and the line's style around the cursor", () => {
    const active = activeFormats(at("- **bo|ld** and ==hi=="));
    expect(active.block).toBe("bullet");
    expect(active.marks.bold).toBe(true);
    expect(active.marks.highlight).toBe(false);
  });

  it("knows each line style", () => {
    expect(["# a", "### a", "- a", "* a", "1. a", "- [x] a", "> a", "a"].map(lineBlock)).toEqual([
      "h1",
      "h3",
      "bullet",
      "bullet",
      "numbered",
      "checklist",
      "quote",
      "paragraph",
    ]);
  });
});
