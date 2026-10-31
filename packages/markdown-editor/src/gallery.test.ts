// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { findGalleries, galleryHtml, galleryImages, parseGalleryOpen, wireGallery } from "./gallery";
import { galleryField } from "./galleryWidget";
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

  it("shows its lines with the cursor in it", () => {
    const view = setup(doc.indexOf("![Back]"));
    expect(view.dom.querySelector(".cm-md-gallery")).toBeNull();
    expect(view.dom.querySelectorAll(".cm-md-gallery-line")).toHaveLength(4);
    view.destroy();
  });

  it("changes the layout from its buttons", () => {
    const view = setup(0);
    const button = Array.from(view.dom.querySelectorAll<HTMLButtonElement>(".cm-md-gallery-bar button")).find((b) => b.textContent === "Lightbox");
    button?.click();
    expect(view.state.doc.toString()).toBe(doc.replace("::: gallery bento", "::: gallery lightbox"));
    view.destroy();
  });
});
