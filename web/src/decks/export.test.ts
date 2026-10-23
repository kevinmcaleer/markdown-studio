/// <reference types="node" />
import { Presentation } from "@kevsmac/keynotejs";
import JSZip from "jszip";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDeck, STARTER_DECK } from "./deck";
import { deckToKeynote } from "./keynote";
import { deckToPptx } from "./pptx";

const noImages = async () => null;
const template = readFileSync(join(dirname(createRequire(import.meta.url).resolve("@kevsmac/keynotejs")), "../templates/basic-white-16x9.key"));

describe("Keynote export", () => {
  it("writes one Keynote slide per deck slide, with titles, bodies and notes", async () => {
    const deck = parseDeck(STARTER_DECK + "\n---\n<!-- transition: dissolve 2s -->\n<!-- skipped -->\n## Last\n\n- one\n  - two\n");
    const blob = await deckToKeynote(deck, { loadImage: noImages, template: new Uint8Array(template) });
    const pres = Presentation.fromBytes(new Uint8Array(await blob.arrayBuffer()));
    expect(pres.length).toBe(deck.slides.length);
    expect(pres.slides.map((s) => s.layout)).toEqual(["Title", "Title & Bullets", "Section", "Quote", "Title & Bullets", "Title & Bullets"]);
    expect(pres.slide(0).title).toBe("Untitled deck");
    expect(pres.slide(0).body).toBe("A subtitle goes here");
    expect(pres.slide(1).notes).toContain("presenter view");
    expect(pres.slide(4).body).toContain('console.log("Hello, Decks");');
    const last = pres.slide(5);
    expect(last.paragraphs.map((p) => [p.text, p.level])).toEqual([["one", 0], ["two", 1]]);
    expect(last.transition.effect).toBe("dissolve");
    expect(last.transition.duration).toBe(2);
    expect(last.skipped).toBe(true);
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
