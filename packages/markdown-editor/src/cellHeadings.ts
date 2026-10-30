import type { MarkdownItInstance } from "./markdown";

// Headings in table cells: GFM tables only hold inline Markdown, so a cell
// can't hold a real `## Heading` block. A cell that starts with #'s is drawn
// as a heading instead, which suits a table used for layout (an image grid
// with a heading over each column, say).
//
//   | ## Open Duck Mini | ## Microduck |
//   | --- | --- |
//   | ![Open Duck Mini](/odm.jpg) | ![Microduck](/md.jpg) |
//
// The live view (tableWidget.ts) and the preview (cellHeadingPlugin) both
// read cellHeading; image-grid.css styles `.cell-heading` for pages that
// render the Markdown themselves too (kevsrobots' project pages).

const HEADING_RE = /^\s*(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

/** A cell's heading: its level and the Markdown after the #'s, or null when it isn't one. */
export function cellHeading(cell: string): { level: number; text: string } | null {
  const match = HEADING_RE.exec(cell);
  return match && match[2].trim() ? { level: match[1].length, text: match[2] } : null;
}

/** A heading cell's inline HTML wrapped as its heading. */
export function headingHtml(level: number, inner: string): string {
  return `<h${level} class="cell-heading">${inner}</h${level}>`;
}

/** markdown-it: draws a table cell that starts with #'s as a heading (`<th><h2 class="cell-heading">…</h2></th>`). */
export function cellHeadingPlugin(md: MarkdownItInstance): void {
  // After inline parsing (and image_grids, which reads each cell's inline
  // token), so the #'s come off the cell's first and last bits of text.
  md.core.ruler.push("cell_headings", (state) => {
    const tokens = state.tokens;
    let inTable = false;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.type === "table_open") inTable = true;
      else if (token.type === "table_close") inTable = false;
      if (!inTable || (token.type !== "th_open" && token.type !== "td_open")) continue;
      const inline = tokens[i + 1];
      const heading = inline?.type === "inline" ? cellHeading(inline.content) : null;
      const children = inline?.children ?? [];
      const first = children[0];
      const last = children[children.length - 1];
      if (!heading || first?.type !== "text" || last?.type !== "text") continue;
      first.content = first.content.replace(/^\s*#{1,6}[ \t]+/, "");
      last.content = last.content.replace(/(?:[ \t]+#+)?[ \t]*$/, "");
      const open = new state.Token("heading_open", `h${heading.level}`, 1);
      open.attrSet("class", "cell-heading");
      const close = new state.Token("heading_close", `h${heading.level}`, -1);
      // Inside the cell's inline tokens, so it's drawn snug in the cell, as `<th><h2 …>`.
      children.unshift(open);
      children.push(close);
    }
  });
}
