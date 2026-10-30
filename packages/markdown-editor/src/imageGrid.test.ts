import { describe, expect, it } from "vitest";
import { cellHasImage, isImageGrid } from "./imageGrid";
import { renderMarkdown } from "./markdown";

describe("image grids", () => {
  it("spots an image in a cell", () => {
    expect(cellHasImage("![Lid](/lid.jpg)")).toBe(true);
    expect(cellHasImage("![Lid](/lid.jpg){small} The lid")).toBe(true);
    expect(cellHasImage("[Lid](/lid.jpg)")).toBe(false);
    expect(cellHasImage("Lid")).toBe(false);
  });

  it("is a table whose filled cells all hold images", () => {
    expect(isImageGrid([["", "", ""], ["![a](/a.jpg)", "![b](/b.jpg)", ""]])).toBe(true);
    expect(isImageGrid([["![a](/a.jpg)", "![b](/b.jpg)"]])).toBe(true);
    // A text header labels the columns.
    expect(isImageGrid([["Front", "Back"], ["![a](/a.jpg)", "![b](/b.jpg)"]])).toBe(true);
  });

  it("leaves data tables alone", () => {
    expect(isImageGrid([["Part", "Qty"], ["Servo", "4"]])).toBe(false);
    expect(isImageGrid([["Part", "Photo"], ["Servo", "![s](/s.jpg)"]])).toBe(false);
    expect(isImageGrid([["", ""], ["", ""]])).toBe(false);
  });

  it("renders as cards with the empty header hidden", () => {
    const html = renderMarkdown("| | | |\n|---|---|---|\n| ![Base](/base.jpg) | ![Lid](/lid.jpg) The lid | |\n");
    expect(html).toContain('<table class="image-grid image-grid-nohead">');
    expect(html).toContain('<td class="image-card"><img src="/base.jpg" alt="Base"></td>');
    expect(html).toContain('<td class="image-card"><img src="/lid.jpg" alt="Lid"> The lid</td>');
    expect(html).toContain("<td></td>");
  });

  it("keeps a header of images", () => {
    const html = renderMarkdown("| ![a](/a.jpg) | ![b](/b.jpg) |\n|---|---|\n");
    expect(html).toContain('<table class="image-grid">');
    expect(html).toContain('<th class="image-card"><img src="/a.jpg" alt="a"></th>');
  });

  it("doesn't touch an ordinary table", () => {
    expect(renderMarkdown("| Part | Qty |\n|---|---|\n| Servo | 4 |\n")).toContain("<table>");
  });
});
