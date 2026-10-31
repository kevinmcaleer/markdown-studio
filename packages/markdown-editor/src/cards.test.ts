import { describe, expect, it } from "vitest";
import { cardMarkdown, cardsMarkdown, findCardBlocks, parseCard, parseCardsOpen, splitCards } from "./cards";
import { renderMarkdown } from "./markdown";
import { parseOutline } from "./outline";

const block = [
  "::: cards",
  "![Open Duck Mini](/odm.jpg)",
  "## Open Duck Mini",
  "Created by *Antoine*.",
  "",
  "---",
  "",
  "![Microduck](/md.jpg)",
  "## Microduck",
  "- small",
  "- commercial",
  ":::",
].join("\n");

describe("cards blocks", () => {
  it("reads the opening line", () => {
    expect(parseCardsOpen("::: cards")).toBe(0);
    expect(parseCardsOpen(":::cards 3")).toBe(3);
    expect(parseCardsOpen("::: cards 9")).toBe(6);
    expect(parseCardsOpen("::: gallery")).toBeNull();
    expect(parseCardsOpen("::: cardsy")).toBeNull();
  });

  it("splits cards at --- lines, but not inside code", () => {
    expect(splitCards("a\n---\nb")).toEqual(["a", "b"]);
    expect(splitCards("```\n---\n```\n---\nb")).toEqual(["```\n---\n```", "b"]);
    expect(splitCards("")).toEqual([""]);
  });

  it("reads a card's picture, title and words", () => {
    expect(parseCard('![Duck \\[1\\]](</a b.jpg> "Big")\n### Duck\nWords\n\nMore')).toEqual({
      picture: { src: "/a b.jpg", alt: "Duck [1]", title: "Big", size: "" },
      level: 3,
      title: "Duck",
      text: "Words\n\nMore",
    });
    expect(parseCard("Just words")).toEqual({ picture: null, level: 2, title: "", text: "Just words" });
  });

  it("writes a card back as Markdown", () => {
    const card = parseCard("![Duck](/d.jpg){cover}\n## Duck\nWords");
    expect(cardMarkdown(card)).toBe("![Duck](/d.jpg){cover}\n## Duck\nWords");
    expect(cardMarkdown({ picture: { src: "/a b.jpg", alt: "a]", title: "", size: "" }, level: 2, title: "T", text: "x\n---\n:::" })).toBe(
      "![a\\]](</a b.jpg>)\n## T\nx\n\\---\n\\:::",
    );
    expect(cardsMarkdown(2, [card, parseCard("## Two")])).toBe("::: cards 2\n![Duck](/d.jpg){cover}\n## Duck\nWords\n\n---\n\n## Two\n:::");
  });

  it("finds closed blocks outside code", () => {
    const lines = ["```", "::: cards", ":::", "```", "", ...block.split("\n"), "::: cards", "never closed"];
    const blocks = findCardBlocks(lines);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ columns: 0, open: 5, close: 16 });
    expect(blocks[0].cards).toHaveLength(2);
  });

  it("renders cards in the preview", () => {
    const html = renderMarkdown(`Intro\n\n${block}\n\nAfter\n`);
    expect(html).toContain('<div class="md-cards" data-cards-columns="0">');
    expect(html).toContain('<div class="md-card"><div class="md-card-media"><img src="/odm.jpg" alt="Open Duck Mini" loading="lazy"></div>');
    expect(html).toContain("<h2>Open Duck Mini</h2>\n<p>Created by <em>Antoine</em>.</p>");
    expect(html).toContain("<li>commercial</li>");
    expect(html).toContain("<p>After</p>");
    expect(html).not.toContain("<hr>");
    expect(renderMarkdown("::: cards 2\n## A\n:::\n")).toContain('class="md-cards md-cards-fixed" data-cards-columns="2" style="--md-cards-columns: 2"');
  });

  it("leaves an unclosed block as text", () => {
    expect(renderMarkdown("::: cards\n## A\n")).toContain("<h2>A</h2>");
  });

  it("keeps card titles out of the outline", () => {
    expect(parseOutline(`# Project\n\n${block}\n\n## Wiring\n`).map((h) => h.text)).toEqual(["Project", "Wiring"]);
  });

  it("drops unsafe pictures", () => {
    expect(renderMarkdown("::: cards\n![x](javascript:alert)\n:::\n")).not.toContain("src=\"javascript");
    expect(renderMarkdown("::: cards\n![x](javascript:alert)\n:::\n")).not.toContain("md-card-media");
  });
});

describe("cards block Markdown", () => {
  it("keeps empty cards tidy", async () => {
    const { cardsBlockMarkdown } = await import("./cards");
    expect(cardsBlockMarkdown(0, ["", ""])).toBe("::: cards\n\n---\n\n:::");
    expect(cardsBlockMarkdown(3, ["## A"])).toBe("::: cards 3\n## A\n:::");
  });
});
