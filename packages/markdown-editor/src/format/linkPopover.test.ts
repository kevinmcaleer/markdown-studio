import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { linkAtCursor, linkDraft, linkInText, linkMarkdown, shortUrl } from "./linkPopover";

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

  it("names a bare URL the cursor is in", () => {
    expect(linkDraft(at("buy https://x.org/a?b=1 now", 10))).toEqual({ from: 4, to: 23, text: "", url: "https://x.org/a?b=1" });
  });

  it("goes after a selection that spans lines", () => {
    expect(linkDraft(at("one\ntwo", 0, 7))).toEqual({ from: 7, to: 7, text: "", url: "" });
  });

  it("takes a selected site-relative link as the URL", () => {
    expect(linkDraft(at("see /projects/new", 4, 17))).toEqual({ from: 4, to: 17, text: "", url: "/projects/new" });
    expect(linkDraft(at("see ./notes.md", 4, 14))).toEqual({ from: 4, to: 14, text: "", url: "./notes.md" });
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

describe("linkAtCursor", () => {
  it("finds a link, keeping its text's Markdown for removing it", () => {
    expect(linkAtCursor(at("a [x \\[1\\]](https://x.org) b", 4))).toEqual({
      from: 2,
      to: 26,
      text: "x [1]",
      label: "x \\[1\\]",
      url: "https://x.org",
      bare: false,
    });
  });

  it("finds bare URLs and autolinks", () => {
    expect(linkAtCursor(at("see https://x.org.", 8))).toMatchObject({ from: 4, to: 17, url: "https://x.org", bare: true });
    expect(linkAtCursor(at("see <https://x.org> ok", 8))).toMatchObject({ from: 4, to: 19, url: "https://x.org", bare: true });
  });

  it("finds nothing in plain text or an image", () => {
    expect(linkAtCursor(at("just words", 3))).toBeNull();
    expect(linkAtCursor(at("![alt](https://x.org/a.png)", 3))).toBeNull();
  });

  it("finds a link whose text is its URL", () => {
    expect(linkAtCursor(at("[https://x.org](https://x.org)", 5))).toMatchObject({ from: 0, to: 30, bare: false });
  });
});

describe("linkInText", () => {
  it("finds the link the offset touches", () => {
    const text = "see [docs](/docs) and https://x.org/a_(b).";
    expect(linkInText(text, 6)).toMatchObject({ from: 4, to: 17, text: "docs", url: "/docs", bare: false });
    expect(linkInText(text, 30)).toMatchObject({ from: 22, to: 41, url: "https://x.org/a_(b)", bare: true });
    expect(linkInText(text, 1)).toBeNull();
  });

  it("leaves images alone and reads www. as https", () => {
    expect(linkInText("![a](https://x.org/a.png)", 8)).toBeNull();
    expect(linkInText("www.x.org/p, then", 3)).toMatchObject({ from: 0, to: 11, url: "https://www.x.org/p", label: "www.x.org/p" });
  });

  it("drops a closing bracket the URL didn't open", () => {
    expect(linkInText("(see https://x.org/a)", 8)).toMatchObject({ url: "https://x.org/a" });
  });
});

describe("shortUrl", () => {
  it("drops the scheme and www, and shortens long ones", () => {
    expect(shortUrl("https://www.x.org/a")).toBe("x.org/a");
    expect(shortUrl(`https://x.org/${"a".repeat(60)}`)).toHaveLength(41);
  });
});
