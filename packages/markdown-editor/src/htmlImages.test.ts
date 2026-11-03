// @vitest-environment happy-dom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { applyFix, diagnosticsOf } from "./diagnostics";
import { convertHtmlImages, findHtmlImages, htmlImageChanges, htmlImages, imgTagToMarkdown, sizeForWidth } from "./htmlImages";

const GH = "https://github.com/user-attachments/assets/31c031b7-58b8-4c4c-a3fa-1f14a310c2f2";

const convert = (doc: string) => {
  const changes = htmlImageChanges(doc);
  let out = doc;
  for (const c of [...changes].reverse()) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  return out;
};

describe("imgTagToMarkdown", () => {
  it("writes GitHub's pasted picture as Markdown, width as the nearest size", () => {
    expect(imgTagToMarkdown(`<img src="${GH}" alt="1" width="500px" >`)).toBe(`![1](${GH}){half}`);
  });

  it("keeps the title, escapes brackets, and wraps addresses with spaces", () => {
    expect(imgTagToMarkdown(`<img alt='a [b]' src="my pic.png" title='The "arm"'/>`)).toBe(`![a \\[b\\]](<my pic.png> "The \\"arm\\"")`);
  });

  it("decodes entities and ignores tags without a src", () => {
    expect(imgTagToMarkdown(`<img src="a.png?x=1&amp;y=2" alt="R&amp;D">`)).toBe("![R&D](a.png?x=1&y=2)");
    expect(imgTagToMarkdown(`<img alt="nothing">`)).toBeNull();
  });
});

describe("sizeForWidth", () => {
  it("maps pixels and percentages to the editor's sizes", () => {
    expect(sizeForWidth("800")).toBeNull();
    expect(sizeForWidth("100%")).toBeNull();
    expect(sizeForWidth("500px")).toBe("half");
    expect(sizeForWidth("50%")).toBe("half");
    expect(sizeForWidth("200")).toBe("small");
    expect(sizeForWidth("25%")).toBe("small");
    expect(sizeForWidth("auto")).toBeNull();
    expect(sizeForWidth(undefined)).toBeNull();
  });

  it("reads a width from the style too", () => {
    expect(imgTagToMarkdown(`<img src="a.png" style="width: 30%">`)).toBe("![](a.png){small}");
  });
});

describe("findHtmlImages", () => {
  it("finds every tag, in order", () => {
    const doc = `Intro\n\n<img src="a.png" alt="A">\n\nText <img src="b.png" width="200"> more`;
    expect(convert(doc)).toBe("Intro\n\n![A](a.png)\n\nText ![](b.png){small} more");
  });

  it("turns a picture inside a link into a linked picture", () => {
    expect(convert(`<a href="https://kevsrobots.com"><img src="logo.png" alt="Logo"></a>`)).toBe("[![Logo](logo.png)](https://kevsrobots.com)");
  });

  it("takes away a wrapper that only holds pictures", () => {
    const doc = `<p align="center">\n  <img src="a.png" alt="A" width="50%">\n  <img src="b.png" alt="B" width="50%">\n</p>`;
    expect(convert(doc)).toBe("![A](a.png){half}\n![B](b.png){half}");
    expect(findHtmlImages(doc)[0].count).toBe(2);
    expect(convert(`<div><img src="a.png"><br><img src="b.png"></div>`)).toBe("![](a.png)\n\n![](b.png)");
  });

  it("keeps a wrapper with words in it, changing only its pictures", () => {
    expect(convert(`<p>Look: <img src="a.png"></p>`)).toBe("<p>Look: ![](a.png)</p>");
  });

  it("leaves HTML in code and comments alone", () => {
    const doc = "```html\n<img src=\"a.png\">\n```\n\n`<img src=\"b.png\">`\n\n<!-- <img src=\"c.png\"> -->";
    expect(findHtmlImages(doc)).toEqual([]);
  });

  it("changes only the one at a position when asked", () => {
    const doc = `<img src="a.png"> <img src="b.png">`;
    expect(htmlImageChanges(doc, 20)).toEqual([{ from: 18, to: 35, insert: "![](b.png)" }]);
  });
});

describe("htmlImages extension", () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("marks each tag and offers one fix and a fix-all", async () => {
    let heard = -1;
    const view = new EditorView({
      state: EditorState.create({ doc: `<img src="a.png"> and <img src="b.png" width="500">`, extensions: htmlImages((f) => (heard = f.length)) }),
      parent: document.body,
    });
    await wait(10);
    const found = diagnosticsOf(view.state, "markup");
    expect(found).toHaveLength(2);
    expect(heard).toBe(2);
    expect(found[0].fixes?.map((f) => f.label)).toEqual(["Change to Markdown", "Fix all 2 in this document"]);
    applyFix(view, found[0].fixes![1]);
    expect(view.state.doc.toString()).toBe("![](a.png) and ![](b.png){half}");
    await wait(350);
    expect(diagnosticsOf(view.state, "markup")).toHaveLength(0);
    expect(heard).toBe(0);
    view.destroy();
  });

  it("converts just the one clicked", () => {
    const view = new EditorView({ state: EditorState.create({ doc: `<img src="a.png"> <img src="b.png">` }), parent: document.body });
    expect(convertHtmlImages(view, 2)).toBe(1);
    expect(view.state.doc.toString()).toBe(`![](a.png) <img src="b.png">`);
    view.destroy();
  });
});
