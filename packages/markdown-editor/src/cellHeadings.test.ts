import { describe, expect, it } from "vitest";
import { cellHeading } from "./cellHeadings";
import { renderCell, renderMarkdown } from "./markdown";

describe("headings in table cells", () => {
  it("spots a cell that starts with #'s", () => {
    expect(cellHeading("## Open Duck Mini")).toEqual({ level: 2, text: "Open Duck Mini" });
    expect(cellHeading("### Microduck ###")).toEqual({ level: 3, text: "Microduck" });
    expect(cellHeading("#Hashtag")).toBeNull();
    expect(cellHeading("##")).toBeNull();
    expect(cellHeading("####### Seven")).toBeNull();
    expect(cellHeading("Issue #4")).toBeNull();
  });

  it("renders a heading cell in the preview", () => {
    const html = renderMarkdown("| ## Open Duck Mini | ### **Microduck** ## |\n|---|---|\n| Big | Small |\n");
    expect(html).toContain('<th><h2 class="cell-heading">Open Duck Mini</h2></th>');
    expect(html).toContain('<th><h3 class="cell-heading"><strong>Microduck</strong></h3></th>');
    expect(html).toContain("<td>Big</td>");
  });

  it("keeps an image grid with headings over its columns", () => {
    const html = renderMarkdown("| ## Open Duck Mini | ## Microduck |\n|---|---|\n| ![a](/a.jpg) | ![b](/b.jpg) |\n");
    expect(html).toContain('<table class="image-grid">');
    expect(html).toContain('<th><h2 class="cell-heading">Open Duck Mini</h2></th>');
    expect(html).toContain('<td class="image-card"><img src="/a.jpg" alt="a"></td>');
  });

  it("renders a cell for the live table", () => {
    expect(renderCell("## Open *Duck*")).toBe('<h2 class="cell-heading">Open <em>Duck</em></h2>');
    expect(renderCell("Plain")).toBe("Plain");
  });

  it("leaves headings outside tables alone", () => {
    expect(renderMarkdown("## Title\n")).toBe("<h2>Title</h2>\n");
  });
});
