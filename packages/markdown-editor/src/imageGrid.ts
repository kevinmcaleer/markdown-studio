import type { MarkdownItInstance } from "./markdown";

// Image grids: a table whose cells hold images is a layout, not data, so it
// shows as a borderless grid of image cards, one column per table column.
//
//   | ![Base](/base.jpg) | ![Lid](/lid.jpg) | ![Buttons](/buttons.jpg) |
//   | --- | --- | --- |
//
// Text beside an image in its cell is the card's caption. An empty header row
// is hidden; a header row of plain text labels the columns. The live view
// (tableWidget.ts) and the preview (imageGridPlugin) both read isImageGrid;
// image-grid.css styles the preview's classes, for pages that render the
// Markdown themselves too (kevsrobots' project pages).

const IMAGE_RE = /!\[[^\]]*\]\([^)]*\)|<img\b/i;

/** Whether a cell's Markdown holds an image. */
export function cellHasImage(cell: string): boolean {
  return IMAGE_RE.test(cell);
}

/**
 * Whether a table (header row first, as Markdown cells) lays out images: it
 * has an image, and every cell with something in it holds one, leaving out a
 * header row with no images in it (its column labels).
 */
export function isImageGrid(rows: string[][]): boolean {
  if (!rows.some((row) => row.some(cellHasImage))) return false;
  const [head = [], ...body] = rows;
  const checked = head.some(cellHasImage) ? rows : body;
  return checked.every((row) => row.every((cell) => !cell.trim() || cellHasImage(cell)));
}

/** markdown-it: gives an image-grid table the `image-grid` class, its image cells `image-card` and an empty header `image-grid-nohead`. */
export function imageGridPlugin(md: MarkdownItInstance): void {
  md.core.ruler.push("image_grids", (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== "table_open") continue;
      const rows: string[][] = [];
      const cells: { open: number; content: string }[] = [];
      let j = i + 1;
      for (; j < tokens.length && tokens[j].type !== "table_close"; j++) {
        const token = tokens[j];
        if (token.type === "tr_open") rows.push([]);
        else if ((token.type === "th_open" || token.type === "td_open") && tokens[j + 1]?.type === "inline") {
          const content = tokens[j + 1].content;
          rows[rows.length - 1]?.push(content);
          cells.push({ open: j, content });
        }
      }
      if (isImageGrid(rows)) {
        tokens[i].attrJoin("class", "image-grid");
        if (rows[0]?.every((cell) => !cell.trim())) tokens[i].attrJoin("class", "image-grid-nohead");
        for (const cell of cells) if (cellHasImage(cell.content)) tokens[cell.open].attrJoin("class", "image-card");
      }
      i = j;
    }
  });
}
