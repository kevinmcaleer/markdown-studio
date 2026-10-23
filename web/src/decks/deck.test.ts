import { describe, expect, it } from "vitest";
import { deckTitle, isDeck, parseDeck, slideAtLine, STARTER_DECK } from "./deck";

describe("parseDeck", () => {
  it("splits slides on --- lines, but not inside code fences", () => {
    const deck = parseDeck("# One\n\n---\n\n## Two\n\n```\n---\n```\n\n---\n\n## Three");
    expect(deck.slides.map((s) => s.title)).toEqual(["One", "Two", "Three"]);
    expect(deck.slides[1].blocks).toEqual([{ type: "code", lang: "", code: "---" }]);
  });

  it("skips empty slides and records line ranges", () => {
    const deck = parseDeck("# One\n---\n\n---\n## Two\n");
    expect(deck.slides).toHaveLength(2);
    expect(deck.slides[1]).toMatchObject({ index: 1, startLine: 4, title: "Two" });
    expect(slideAtLine(deck, 0)).toBe(0);
    expect(slideAtLine(deck, 5)).toBe(1);
  });

  it("reads settings comments and presenter notes", () => {
    const [slide] = parseDeck("<!-- layout: Title & Bullets -->\n<!-- transition: dissolve 1.5s -->\n<!-- skipped -->\n# Hi\n\n- a\n\n???\nSay hello\n\nslowly").slides;
    expect(slide.layout).toBe("content");
    expect(slide.layoutName).toBe("Title & Bullets");
    expect(slide.transition).toEqual({ effect: "dissolve", duration: 1.5 });
    expect(slide.skipped).toBe(true);
    expect(slide.notes).toBe("Say hello\n\nslowly");
    expect(slide.body).toBe("- a");
  });

  it("picks a layout from the content", () => {
    const layouts = parseDeck("# Talk\n\nBy Kev\n---\n## Part one\n---\n> Be kind\n---\nOne big idea\n---\n## List\n\n- a\n- b").slides.map((s) => s.layout);
    expect(layouts).toEqual(["title", "section", "quote", "statement", "content"]);
  });

  it("turns the body into blocks with formatted runs", () => {
    const [slide] = parseDeck("## T\n\nSome **bold** and ==marked== `code`\n\n- one\n  - two\n1. first\n\n![A robot](/api/files/3/content)\n\n| a | b |\n| - | :-: |\n| 1 | 2 |").slides;
    expect(slide.blocks).toEqual([
      {
        type: "paragraph",
        runs: [{ text: "Some " }, { text: "bold", bold: true }, { text: " and " }, { text: "marked", mark: true }, { text: " " }, { text: "code", code: true }],
      },
      {
        type: "bullets",
        items: [
          { runs: [{ text: "one" }], level: 0, ordered: false },
          { runs: [{ text: "two" }], level: 1, ordered: false },
        ],
      },
      { type: "bullets", items: [{ runs: [{ text: "first" }], level: 0, ordered: true }] },
      { type: "image", src: "/api/files/3/content", alt: "A robot" },
      { type: "table", header: [[{ text: "a" }], [{ text: "b" }]], rows: [[[{ text: "1" }], [{ text: "2" }]]], align: [null, "center"] },
    ]);
  });

  it("parses the starter deck", () => {
    const deck = parseDeck(STARTER_DECK);
    expect(deck.slides.map((s) => s.layout)).toEqual(["title", "content", "section", "quote", "content"]);
    expect(deck.slides[1].notes).toContain("presenter view");
  });
});

describe("deck files", () => {
  it("recognises .deck.md names", () => {
    expect(isDeck({ name: "Talk.deck.md" })).toBe(true);
    expect(isDeck({ name: "Talk.md" })).toBe(false);
    expect(deckTitle({ name: "Robots 101.deck.md" })).toBe("Robots 101");
  });
});
