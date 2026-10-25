/// <reference types="node" />
import { Presentation, setTemplateLoader } from "@kevsmac/keynotejs";
import JSZip from "jszip";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDeck, STARTER_DECK } from "./deck";
import { deckToKeynote } from "./keynote";
import { deckToPptx } from "./pptx";

const noImages = async () => null;
const templates = join(dirname(createRequire(import.meta.url).resolve("@kevsmac/keynotejs")), "../templates");
const template = readFileSync(join(templates, "basic-white-16x9.key"));
// keynote.ts fetches the bundled files from Vite's URLs; tests read them from disk.
setTemplateLoader(async (file) => new Uint8Array(readFileSync(join(templates, file))));

// A 2 x 1 red PNG.
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAEElEQVR4nGP4z8DAwMDAAAAfAQH/kRNqXwAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);
const oneImage = async () => ({ bytes: PNG, mime: "image/png", width: 2, height: 1 });

describe("Keynote export", () => {
  it("writes one Keynote slide per deck slide, with titles, bodies and notes", async () => {
    const deck = parseDeck(STARTER_DECK + "\n---\n<!-- transition: dissolve 2s -->\n<!-- skipped -->\n## Last\n\n- one\n  - two\n");
    const blob = await deckToKeynote(deck, { loadImage: noImages, template: new Uint8Array(template) });
    const pres = Presentation.fromBytes(new Uint8Array(await blob.arrayBuffer()));
    expect(pres.length).toBe(deck.slides.length);
    expect(pres.slides.map((s) => s.layout)).toEqual(["Title", "Title & Bullets", "Section", "Quote", "Title Only", "Title & Bullets"]);
    expect(pres.slide(0).title).toBe("Untitled deck");
    expect(pres.slide(0).body).toBe("A subtitle goes here");
    expect(pres.slide(1).notes).toContain("presenter view");
    // Code goes in a text box and the table is a real Keynote table.
    const kinds = pres
      .slide(4)
      .toJSON()
      .drawables.filter((d) => d.text !== "")
      .map((d) => d.type);
    expect(kinds).toHaveLength(2);
    expect(kinds.some((k) => /table/i.test(k))).toBe(true);
    const last = pres.slide(5);
    expect(last.paragraphs.map((p) => [p.text, p.level])).toEqual([["one", 0], ["two", 1]]);
    expect(last.transition.effect).toBe("dissolve");
    expect(last.transition.duration).toBe(2);
    expect(last.skipped).toBe(true);
  });
});

describe("Keynote export with images", () => {
  it("puts one image in the photo placeholder and several in a column", async () => {
    const deck = parseDeck("## One\n\n- text\n\n![a](/api/files/1/content)\n---\n## Two\n\n- text\n\n![a](/x.png)\n\n![b](/y.png)");
    const blob = await deckToKeynote(deck, { loadImage: oneImage });
    const pres = Presentation.fromBytes(new Uint8Array(await blob.arrayBuffer()));
    expect(pres.slide(0).layout).toBe("Title, Bullets & Photo");
    const withData = (i: number) => pres.slide(i).images.filter((img) => img.data !== null);
    expect(withData(0)).toHaveLength(1);
    expect(withData(1)).toHaveLength(2);
    expect(withData(1).map((img) => img.description)).toEqual(["a", "b"]);
  });
});

describe("PowerPoint export", () => {
  it("writes a .pptx with every slide and its notes", async () => {
    const deck = parseDeck(STARTER_DECK);
    const blob = await deckToPptx(deck, { title: "Untitled deck", loadImage: noImages });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // A zip, with one slide part per slide.
    expect(String.fromCharCode(bytes[0], bytes[1])).toBe("PK");
    const text = new TextDecoder("latin1").decode(bytes);
    for (let i = 1; i <= deck.slides.length; i++) expect(text).toContain(`ppt/slides/slide${i}.xml`);
    expect(text).not.toContain(`ppt/slides/slide${deck.slides.length + 1}.xml`);
    expect(text).toContain("ppt/notesSlides/notesSlide2.xml");
  });

  it("keeps inline formatting inside one bullet", async () => {
    const deck = parseDeck("## T\n\n- one `code` and **bold**\n- two");
    const zip = await JSZip.loadAsync(await (await deckToPptx(deck, { title: "T", loadImage: noImages })).arrayBuffer());
    const xml = await zip.file("ppt/slides/slide1.xml")!.async("string");
    // The title, then one paragraph per bullet.
    expect(xml.match(/<a:p>/g)?.length).toBe(3);
    expect(xml).toContain("Menlo");
  });
});
