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

describe("lines in table cells", () => {
  it("draws <br> as a line break, in cells and out", () => {
    expect(renderCell("One<br>Two<br/>Three<BR />Four")).toBe("One<br>\nTwo<br>\nThree<br>\nFour");
    expect(renderMarkdown("a<br>b\n")).toBe("<p>a<br>\nb</p>\n");
    expect(renderCell("<b>bold</b>")).toBe("&lt;b&gt;bold&lt;/b&gt;");
  });

  it("draws a heading on a line of its own under a picture", () => {
    expect(renderCell("![Duck](/d.jpg)<br>## Open Duck Mini<br>Created by *Antoine*")).toBe(
      '<img src="/d.jpg" alt="Duck"><h2 class="cell-heading">Open Duck Mini</h2>Created by <em>Antoine</em>',
    );
  });

  it("starts a heading straight after a picture on its own line", () => {
    expect(renderCell("![Duck](/d.jpg) ## Microduck")).toBe('<img src="/d.jpg" alt="Duck"><h2 class="cell-heading">Microduck</h2>');
  });

  it("keeps line breaks between plain lines", () => {
    expect(renderCell("![Duck](/d.jpg)<br>Line one<br>Line two")).toBe('<img src="/d.jpg" alt="Duck"><br>\nLine one<br>\nLine two');
  });

  it("does the same in the preview, keeping the image grid", () => {
    const html = renderMarkdown("| ![a](/a.jpg)<br>## A<br>By me | ![b](/b.jpg) ## B |\n|---|---|\n");
    expect(html).toContain('<table class="image-grid">');
    expect(html).toContain('<th class="image-card"><img src="/a.jpg" alt="a"><h2 class="cell-heading">A</h2>By me</th>');
    expect(html).toContain('<th class="image-card"><img src="/b.jpg" alt="b"><h2 class="cell-heading">B</h2></th>');
  });

  it("leaves # mid-text alone", () => {
    expect(renderCell("Issue #4 and ## not a heading")).toBe("Issue #4 and ## not a heading");
  });
});
