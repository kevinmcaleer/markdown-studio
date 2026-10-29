// @vitest-environment happy-dom
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { markdownExtensions } from "./Editor";
import { accepts, formatBytes, imageProblem, planPaste, type Clip } from "./smartPaste";

/** Pastes into a doc where "‸" marks the cursor, or "«...»" the selection; returns the new doc. */
function paste(doc: string, clip: Partial<Clip>) {
  const sel = /«([^»]*)»|‸/.exec(doc)!;
  const text = doc.slice(0, sel.index) + (sel[1] ?? "") + doc.slice(sel.index + sel[0].length);
  const from = sel.index;
  const to = from + (sel[1]?.length ?? 0);
  const state = EditorState.create({ doc: text, selection: { anchor: from, head: to }, extensions: markdownExtensions() });
  ensureSyntaxTree(state, state.doc.length, 5000);
  const plan = planPaste(state, { text: "", html: "", ...clip });
  if (!plan) return { doc: null, plan };
  return { doc: text.slice(0, plan.from) + plan.insert + text.slice(plan.to), plan };
}

describe("planPaste", () => {
  it("turns a URL pasted over selected text into a link", () => {
    expect(paste("Read «the docs» now", { text: "https://example.com" }).doc).toBe("Read [the docs](https://example.com) now");
  });

  it("pastes a bare URL as it is, offering to look up its title", () => {
    const { doc, plan } = paste("See ‸", { text: "https://example.com/page" });
    expect(doc).toBe("See https://example.com/page");
    expect(plan?.titleFor).toBe("https://example.com/page");
  });

  it("leaves a URL alone inside a link's brackets", () => {
    expect(paste("[text](‸)", { text: "https://example.com" }).plan).toBeNull();
  });

  it("makes spreadsheet cells a table on lines of their own", () => {
    const { doc, plan } = paste("Intro‸", { text: "Name\tAge\nAda\t36\n", html: "<table><tr><td>Name</td></tr></table>" });
    expect(doc).toBe("Intro\n\n| Name | Age |\n| --- | --- |\n| Ada | 36 |");
    expect(plan?.label).toBe("Pasted as a table");
  });

  it("fills cells when pasting into a table", () => {
    const table = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    const at = table.indexOf("1");
    const { doc } = paste(`${table.slice(0, at)}‸${table.slice(at)}`, { text: "x\ty\nz\tw", html: "<table></table>" });
    expect(doc).toBe("| A | B |\n| --- | --- |\n| x | y |\n| z | w |");
  });

  it("doesn't take tab-indented code for cells", () => {
    expect(paste("‸", { text: "\tfoo();\n\tbar();" }).plan).toBeNull();
  });

  it("converts rich text and keeps the plain text to switch back to", () => {
    const { doc, plan } = paste("‸", { text: "Title\nHello world", html: "<h1>Title</h1><p>Hello <b>world</b></p>" });
    expect(doc).toBe("# Title\n\nHello **world**");
    expect(plan?.label).toBe("Pasted as Markdown");
    expect(plan?.plain).toBe("Title\nHello world");
  });

  it("pastes rich text with no formatting as plain text", () => {
    expect(paste("‸", { text: "Just words", html: "<p>Just words</p>" }).plan).toBeNull();
  });

  it("inserts a converted phrase inline", () => {
    expect(paste("Say ‸ now", { text: "hi there", html: "<b>hi</b> there" }).doc).toBe("Say **hi** there now");
  });

  it("fences code from VS Code with its language", () => {
    const { doc } = paste("‸", { text: "const a = 1;\nconst b = 2;\n", vscode: JSON.stringify({ mode: "typescriptreact" }) });
    expect(doc).toBe("```tsx\nconst a = 1;\nconst b = 2;\n```");
  });

  it("pastes into a code block as it is", () => {
    expect(paste("```\n‸\n```", { text: "a\tb\nc\td", html: "<b>x</b>" }).plan).toBeNull();
  });
});

describe("image limits", () => {
  const file = (name: string, type: string, size: number) => new File([new Uint8Array(size)], name, { type });

  it("matches an accept list by type, wildcard or extension", () => {
    expect(accepts(file("a.png", "image/png", 1))).toBe(true);
    expect(accepts(file("a.pdf", "application/pdf", 1))).toBe(false);
    expect(accepts(file("a.png", "image/png", 1), "image/jpeg, .png")).toBe(true);
    expect(accepts(file("a.gif", "image/gif", 1), "image/jpeg,.png")).toBe(false);
  });

  it("turns away an image over the limit, saying why", () => {
    expect(imageProblem(file("big.png", "image/png", 3 * 1024 * 1024), { maxBytes: 2 * 1024 * 1024 })).toBe("big.png is 3 MB; the most is 2 MB.");
    expect(imageProblem(file("ok.png", "image/png", 1024), {})).toBeNull();
    expect(formatBytes(25 * 1024 * 1024)).toBe("25 MB");
  });
});
