import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import { describe, expect, it } from "vitest";
import { codeLanguageDescriptions } from "./codeLanguages";

// A tiny stream parser, as a host bundle would pass it: no CodeMirror classes.
const shout = {
  token(stream: { eatSpace(): boolean; match(re: RegExp): unknown; next(): unknown }) {
    if (stream.eatSpace()) return null;
    if (stream.match(/^[A-Z]+\b/)) return "keyword";
    stream.next();
    return null;
  },
};

describe("codeLanguageDescriptions", () => {
  it("highlights a fence in a host's language", async () => {
    const [shoutLang] = codeLanguageDescriptions({ Shout: shout });
    expect(shoutLang.name).toBe("shout");
    await shoutLang.load();
    const state = EditorState.create({
      doc: "Text\n\n```shout\nHELLO there\n```\n",
      extensions: markdown({ base: markdownLanguage, codeLanguages: [shoutLang] }),
    });
    const tree = ensureSyntaxTree(state, state.doc.length, 5000) ?? syntaxTree(state);
    const styled: string[] = [];
    highlightTree(tree, classHighlighter, (from, to, classes) => void styled.push(state.sliceDoc(from, to) + ":" + classes));
    expect(styled).toContain("HELLO:tok-keyword");
  });

  it("loads a parser the first time a fence uses it", async () => {
    let loads = 0;
    const [lazy] = codeLanguageDescriptions({ shout: async () => (loads++, shout) });
    expect(loads).toBe(0);
    await lazy.load();
    expect(loads).toBe(1);
    const state = EditorState.create({
      doc: "```shout\nHI\n```\n",
      extensions: markdown({ base: markdownLanguage, codeLanguages: [lazy] }),
    });
    const tree = ensureSyntaxTree(state, state.doc.length, 5000) ?? syntaxTree(state);
    const styled: string[] = [];
    highlightTree(tree, classHighlighter, (from, to, classes) => void styled.push(state.sliceDoc(from, to) + ":" + classes));
    expect(styled).toContain("HI:tok-keyword");
  });

  it("is empty without languages", () => {
    expect(codeLanguageDescriptions(undefined)).toEqual([]);
  });
});
