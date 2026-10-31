// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { cardPicturePicker } from "./cardsWidget";
import { findGalleries, galleryBlockMarkdown, galleryHtml, galleryImageMarkdown, galleryImages, parseGalleryOpen, wireGallery } from "./gallery";
import { galleryField, movePicture, openGalleryBlocks } from "./galleryWidget";
import { renderMarkdown } from "./markdown";

const doc = "Intro\n\n::: gallery bento\n![Front](/front.jpg)\n![Back](/back.jpg \"The back\")\n:::\n\nAfter";

describe("galleries", () => {
  it("reads the layout from the opening line", () => {
    expect(parseGalleryOpen("::: gallery filmstrip")).toBe("filmstrip");
    expect(parseGalleryOpen(":::gallery Bento")).toBe("bento");
    expect(parseGalleryOpen("::: gallery lightbox  ")).toBe("lightbox");
    // None, or one we don't know, is a filmstrip.
    expect(parseGalleryOpen("::: gallery")).toBe("filmstrip");
    expect(parseGalleryOpen("::: gallery carousel")).toBe("filmstrip");
    expect(parseGalleryOpen("::: cards")).toBeNull();
    expect(parseGalleryOpen("text ::: gallery")).toBeNull();
  });

  it("takes the images in their written order, leaving other text out", () => {
    expect(galleryImages('![A](/a.jpg){small}\nsome words\n![B \\[2\\]](<b c.png> "Bee")\n![](/c.jpg)')).toEqual([
      { src: "/a.jpg", alt: "A", title: "" },
      { src: "b c.png", alt: "B [2]", title: "Bee" },
      { src: "/c.jpg", alt: "", title: "" },
    ]);
  });

  it("keeps each picture's own Markdown, with its size", () => {
    expect(galleryImageMarkdown('![A](/a.jpg){small}\nsome words\n![B](<b c.png> "Bee") ![C](/c.jpg)')).toEqual([
      "![A](/a.jpg){small}",
      '![B](<b c.png> "Bee")',
      "![C](/c.jpg)",
    ]);
    expect(galleryBlockMarkdown("bento", ["![A](/a.jpg)", "![B](/b.jpg)"])).toBe("::: gallery bento\n![A](/a.jpg)\n![B](/b.jpg)\n:::");
    expect(galleryBlockMarkdown("lightbox", [])).toBe("::: gallery lightbox\n:::");
  });

  it("captions with a title, or alt text that isn't a file name", () => {
    const html = galleryHtml("filmstrip", galleryImages("![IMG_2041](/a.jpg)\n![The arm](/b.jpg)"));
    expect(html).toContain("<figcaption hidden></figcaption>");
    expect(html).not.toContain('title="IMG_2041"');
    expect(html).toContain('title="The arm"');
  });

  it("finds closed blocks outside code", () => {
    const lines = ["```", "::: gallery", "![a](/a.jpg)", ":::", "```", "::: gallery lightbox", "![a](/a.jpg)", ":::", "::: gallery", "![b](/b.jpg)"];
    expect(findGalleries(lines)).toEqual([{ layout: "lightbox", open: 5, close: 7, images: [{ src: "/a.jpg", alt: "a", title: "" }] }]);
  });

  it("renders the filmstrip with its first picture large", () => {
    const html = galleryHtml("filmstrip", galleryImages("![Front](/front.jpg)\n![Back](/back.jpg)"));
    expect(html).toContain('<div class="md-gallery md-gallery-filmstrip" data-gallery-layout="filmstrip" data-gallery-count="2">');
    expect(html).toContain('<figure class="md-gallery-hero"><img src="/front.jpg" alt="Front"><figcaption>Front</figcaption></figure>');
    expect(html).toContain('class="md-gallery-item is-active" href="/front.jpg"');
    expect(html).toContain('class="md-gallery-item" href="/back.jpg"');
  });

  it("leaves out pictures that could run script, and escapes the rest", () => {
    const html = galleryHtml("lightbox", [
      { src: "javascript:alert(1)", alt: "x", title: "" },
      { src: '/a.jpg"onerror="x', alt: "<b>", title: "" },
    ]);
    expect(html).not.toContain("javascript");
    expect(html).toContain('src="/a.jpg&quot;onerror=&quot;x" alt="&lt;b&gt;"');
    expect(html).toContain('data-gallery-count="1"');
  });

  it("is a block in the preview", () => {
    const html = renderMarkdown(doc);
    expect(html).toContain("<p>Intro</p>\n<div class=\"md-gallery md-gallery-bento\"");
    expect(html).toContain('title="The back"');
    expect(html).not.toContain(":::");
    expect(html).toContain("<p>After</p>");
    // Straight after a paragraph, too.
    expect(renderMarkdown("Intro\n::: gallery\n![a](/a.jpg)\n:::\n")).toContain("<p>Intro</p>\n<div class=\"md-gallery");
    // An unclosed one is just text.
    expect(renderMarkdown("::: gallery\n![a](/a.jpg)\n")).toContain("<p>::: gallery");
  });

  it("swaps a filmstrip's large picture", () => {
    const host = document.createElement("div");
    host.innerHTML = galleryHtml("filmstrip", galleryImages('![Front](/front.jpg)\n![Back](/back.jpg "The back")'));
    const opened: number[] = [];
    wireGallery(host.firstElementChild as HTMLElement, (_images, i) => opened.push(i));
    const items = host.querySelectorAll<HTMLAnchorElement>(".md-gallery-item");
    items[1].click();
    expect(host.querySelector(".md-gallery-hero img")?.getAttribute("src")).toBe("/back.jpg");
    expect(host.querySelector(".md-gallery-hero figcaption")?.textContent).toBe("The back");
    expect(items[1].classList.contains("is-active")).toBe(true);
    (host.querySelector(".md-gallery-hero") as HTMLElement).click();
    expect(opened).toEqual([1]);
  });

  it("opens the viewer from the other layouts", () => {
    const host = document.createElement("div");
    host.innerHTML = galleryHtml("lightbox", galleryImages("![a](/a.jpg)\n![b](/b.jpg)"));
    const opened: string[] = [];
    wireGallery(host.firstElementChild as HTMLElement, (images, i) => opened.push(images[i].src));
    host.querySelectorAll<HTMLAnchorElement>(".md-gallery-item")[1].click();
    expect(opened).toEqual(["/b.jpg"]);
  });
});

describe("galleries in the live view", () => {
  function setup(cursor: number) {
    const state = EditorState.create({ doc, selection: { anchor: cursor }, extensions: [markdown({ base: markdownLanguage }), galleryField] });
    const parent = document.createElement("div");
    document.body.append(parent);
    return new EditorView({ state, parent });
  }

  it("draws the gallery while the cursor is outside it", () => {
    const view = setup(0);
    expect(view.dom.querySelectorAll(".cm-md-gallery .md-gallery-item")).toHaveLength(2);
    expect(view.dom.querySelector(".cm-md-gallery-bar [aria-pressed=true]")?.textContent).toBe("Bento");
    view.destroy();
  });

  it("shows its lines with the cursor in it, and a button back to the gallery", () => {
    const view = setup(doc.indexOf("![Back]"));
    expect(view.dom.querySelector(".cm-md-gallery")).toBeNull();
    expect(view.dom.querySelectorAll(".cm-md-gallery-line")).toHaveLength(4);
    expect(openGalleryBlocks(view.state)).toEqual([{ from: doc.indexOf(":::"), to: doc.indexOf(":::\n\nAfter") + 3 }]);
    view.dom.querySelector<HTMLButtonElement>(".cm-md-gallery-show")?.click();
    expect(view.dom.querySelector(".cm-md-gallery")).not.toBeNull();
    view.destroy();
  });

  it("shows its lines from the Markdown button, not from a click on a picture", () => {
    const view = setup(0);
    const item = view.dom.querySelector<HTMLElement>(".cm-md-gallery .md-gallery-item img");
    item?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    item?.click();
    expect(view.dom.querySelector(".cm-md-gallery")).not.toBeNull();
    // happy-dom's selection events re-enter the update that focusing starts.
    view.focus = () => {};
    view.dom.querySelector<HTMLButtonElement>(".cm-md-gallery-markdown")?.click();
    expect(view.dom.querySelector(".cm-md-gallery")).toBeNull();
    expect(view.state.selection.main.head).toBe(doc.indexOf("![Front]"));
    view.destroy();
  });

  it("moves and removes pictures from their buttons", () => {
    const view = setup(0);
    const tools = () => Array.from(view.dom.querySelectorAll(".cm-md-gallery .md-gallery-item")).map((i) => i.querySelectorAll("button"));
    tools()[0][1].click(); // Front: move later
    expect(view.state.doc.toString()).toBe(doc.replace('![Front](/front.jpg)\n![Back](/back.jpg "The back")', '![Back](/back.jpg "The back")\n![Front](/front.jpg)'));
    tools()[0][2].click(); // Back: remove
    expect(view.state.doc.toString()).toBe("Intro\n\n::: gallery bento\n![Front](/front.jpg)\n:::\n\nAfter");
    tools()[0][2].click();
    expect(view.state.doc.toString()).toBe("Intro\n\n::: gallery bento\n:::\n\nAfter");
    // An empty gallery offers to add pictures.
    expect(view.dom.querySelector(".cm-md-gallery-empty .cm-md-gallery-add")).not.toBeNull();
    view.destroy();
  });

  it("adds pictures from the host's picker, several at once", () => {
    const state = EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        galleryField,
        cardPicturePicker.of((_anchor, _done, options) =>
          options?.many?.([
            { src: "/side.jpg", alt: "side" },
            { src: "/top view.jpg", alt: "Top [view]" },
          ]),
        ),
      ],
    });
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state, parent });
    view.dom.querySelector<HTMLButtonElement>(".cm-md-gallery-bar .cm-md-gallery-add")?.click();
    expect(view.state.doc.toString()).toContain('![Back](/back.jpg "The back")\n![side](/side.jpg)\n![Top \\[view\\]](/top%20view.jpg)\n:::');
    view.destroy();
  });

  it("adds a picture's address without a picker", () => {
    const view = setup(0);
    view.dom.querySelector<HTMLButtonElement>(".cm-md-gallery-bar .cm-md-gallery-add")?.click();
    const form = view.dom.querySelector<HTMLFormElement>(".cm-md-gallery-url");
    const input = form?.querySelector("input");
    if (input) input.value = "https://x.test/a.png";
    form?.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(view.state.doc.toString()).toContain("![](https://x.test/a.png)\n:::");
    view.destroy();
  });

  it("moves a picture in a list", () => {
    expect(movePicture(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(movePicture(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(movePicture(["a", "b", "c"], 1, 9)).toEqual(["a", "c", "b"]);
  });

  it("changes the layout from its buttons", () => {
    const view = setup(0);
    const button = Array.from(view.dom.querySelectorAll<HTMLButtonElement>(".cm-md-gallery-bar button")).find((b) => b.textContent === "Lightbox");
    button?.click();
    expect(view.state.doc.toString()).toBe(doc.replace("::: gallery bento", "::: gallery lightbox"));
    view.destroy();
  });
});
