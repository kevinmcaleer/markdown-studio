import { describe, expect, it } from "vitest";
import { isLayersUrl, layersUrl } from "./layersFacet";
import { graphicFileName, graphicsIn, newGraphicInsert } from "./layersBlock";

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
