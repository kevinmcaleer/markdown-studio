import { describe, expect, it } from "vitest";
import { isLayersUrl, layersUrl } from "./layersFacet";
import { GUIDE_HEADING, graphicFileName, graphicsIn, guideKey, guideKeyIn, guideSection, inventorySpot, isGuideMarker, newGraphicInsert } from "./layersBlock";

describe("layers links", () => {
  it("marks and recognises a graphic's link", () => {
    expect(isLayersUrl("https://x.test/images/3/view#layers")).toBe(true);
    expect(isLayersUrl("https://x.test/a.png")).toBe(false);
    expect(layersUrl("https://x.test/a.png#old")).toBe("https://x.test/a.png#layers");
    expect(layersUrl("/a.png")).toBe("/a.png#layers");
  });

  it("names the uploaded file from the title", () => {
    expect(graphicFileName("Wiring: the arm!")).toBe("wiring-the-arm.layers.png");
    expect(graphicFileName("")).toBe("graphic.layers.png");
  });

  it("puts a new graphic on a line of its own", () => {
    expect(newGraphicInsert("", 0, "![G](u#layers)")).toEqual({ from: 0, to: 0, insert: "![G](u#layers)\n" });
    const doc = "Some text\n\nMore";
    // On the empty line between paragraphs.
    expect(newGraphicInsert(doc, 10, "![G](u)")).toEqual({ from: 10, to: 10, insert: "![G](u)\n" });
    // At the end of a line with text: a new paragraph after it.
    expect(newGraphicInsert(doc, 9, "![G](u)")).toEqual({ from: 9, to: 9, insert: "\n\n![G](u)" });
    // Before a following paragraph: a blank line after, so it stays a picture of its own.
    expect(newGraphicInsert("A\nB", 1, "![G](u)")).toEqual({ from: 1, to: 1, insert: "\n\n![G](u)\n" });
  });
});

describe("graphicsIn", () => {
  it("lists the Layers graphics in order, with where each starts", () => {
    const text = "# A\n\n![Step 1](/a.png#layers)\n\n![photo](/p.jpg)\n\n![Two](</b.png#layers> \"t\")\n";
    expect(graphicsIn(text)).toEqual([
      { url: "/a.png#layers", at: text.indexOf("![Step 1]") },
      { url: "/b.png#layers", at: text.indexOf("![Two]") },
    ]);
  });
});

describe("guideSection", () => {
  it("goes at the end when there is no Assembly guide section yet", () => {
    const text = "# Robot\n\n## Step 3\n\n![Step 3](/c.png#layers)\n";
    expect(guideSection(text)).toEqual({ from: text.length, to: text.length, heading: true });
  });
  it("replaces the body of an existing section, up to the next heading of its level", () => {
    const text = "# Robot\n\n# Assembly guide\n\n![Old](/o.png#layers)\n\n## Note\n\nkept\n\n# Links\n\n- a\n";
    const s = guideSection(text);
    expect(s.heading).toBe(false);
    expect(s.level).toBe(1);
    expect(text.slice(s.from, s.to)).toBe("\n![Old](/o.png#layers)\n\n## Note\n\nkept\n\n");
  });
  it("finds a guide from when it sat under a heading two, to be made a heading one", () => {
    const text = "# Robot\n\n## Assembly guide\n\n![Old](/o.png#layers)\n\n### Note\n\nkept\n\n## Links\n\n- a\n";
    const s = guideSection(text);
    expect(s.level).toBe(2);
    expect(text.slice(s.headingAt!.from, s.headingAt!.to)).toBe("## Assembly guide");
    expect(text.slice(s.from, s.to)).toBe("\n![Old](/o.png#layers)\n\n### Note\n\nkept\n\n");
  });
  it("takes a section at the end to the end", () => {
    const text = "# Assembly guide\n\n![Old](/o.png#layers)";
    const s = guideSection(text);
    expect(text.slice(s.from, s.to)).toBe("\n![Old](/o.png#layers)");
  });
});

describe("inventorySpot", () => {
  const text = "# Robot\n\nIntro\n\n# Assembly instructions\n\n## Step 1\n\n![a](a.png#layers)\n\n## Step 2\n\nText\n\n```\n# not a heading\n```\n\n# Wiring\n\nWires\n";
  it("goes to the end of the heading-one section the cursor is in, past its sub-headings", () => {
    const pos = text.indexOf("Step 1");
    const at = inventorySpot(text, pos);
    expect(text.slice(0, at).endsWith("```")).toBe(true);
    expect(text.slice(at).trimStart().startsWith("# Wiring")).toBe(true);
  });
  it("goes to the end of the text in the last section, or with no headings", () => {
    expect(inventorySpot(text, text.indexOf("Wires"))).toBe(text.length - 1);
    expect(inventorySpot("Just text\n", 2)).toBe(9);
  });
});

describe("assembly guide key", () => {
  const model = { version: 1 as const, stamp: 5, parts: [] as unknown[], steps: [{ id: "s1", parts: ["a"] }] };
  it("changes with the steps, the tools and the model's version", () => {
    const k = guideKey(model);
    expect(k).toMatch(/^[0-9a-z]+$/);
    expect(guideKey({ ...model })).toBe(k);
    expect(guideKey({ ...model, steps: [{ id: "s1", parts: ["a", "b"] }] })).not.toBe(k);
    expect(guideKey({ ...model, guide: { tools: ["pliers"] } })).not.toBe(k);
    expect(guideKey({ ...model, stamp: 6 })).not.toBe(k);
  });
  it("reads the key a guide was drawn from", () => {
    expect(guideKeyIn("# Robot\n")).toBeNull();
    expect(guideKeyIn("## Assembly guide\n\n<!-- assembly guide: abc12 -->\n\n![Cover](/a.png#layers)\n")).toBe("abc12");
    // From before keys: behind.
    expect(guideKeyIn("## Assembly guide\n\n![Cover](/a.png#layers)\n")).toBe("");
    // Being drawn, or nothing drawn there: left alone.
    expect(guideKeyIn("## Assembly guide\n\n*Making the assembly guide: page 2 of 9, Parts…*\n")).toBeNull();
    expect(guideKeyIn("## Assembly guide\n\nSome words.\n")).toBeNull();
  });
  it("hides its marker in the live view", () => {
    expect(isGuideMarker("<!-- assembly guide: abc12 -->")).toBe(true);
    expect(isGuideMarker("<!-- a note -->")).toBe(false);
  });
});

describe("assembly guide heading", () => {
  it("is a section of its own", () => {
    expect(GUIDE_HEADING).toBe("# Assembly guide");
  });
});
