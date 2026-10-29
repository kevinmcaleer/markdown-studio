import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { linkDraft, linkMarkdown } from "./linkPopover";

function at(doc: string, anchor: number, head = anchor) {
  const state = EditorState.create({ doc, selection: EditorSelection.single(anchor, head), extensions: markdown({ base: markdownLanguage }) });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
}

describe("linkDraft", () => {
  it("starts from the selected text", () => {
    expect(linkDraft(at("see the docs here", 8, 12))).toEqual({ from: 8, to: 12, text: "docs", url: "" });
  });

  it("puts a selected URL in the URL field", () => {
    expect(linkDraft(at("go https://kevsrobots.com now", 3, 25))).toEqual({ from: 3, to: 25, text: "", url: "https://kevsrobots.com" });
  });

  it("edits the link the cursor is in", () => {
    const doc = "a [robot](https://x.org/r) b";
    expect(linkDraft(at(doc, 5))).toEqual({ from: 2, to: 26, text: "robot", url: "https://x.org/r" });
  });

  it("goes after a selection that spans lines", () => {
    expect(linkDraft(at("one\ntwo", 0, 7))).toEqual({ from: 7, to: 7, text: "", url: "" });
  });
});

describe("linkMarkdown", () => {
  it("escapes brackets in the text and spaces in the URL", () => {
    expect(linkMarkdown("a [b]", "https://x.org/a b")).toBe("[a \\[b\\]](https://x.org/a%20b)");
  });

  it("uses the URL as the text when there's none", () => {
    expect(linkMarkdown("", " https://x.org ")).toBe("[https://x.org](https://x.org)");
  });
});
