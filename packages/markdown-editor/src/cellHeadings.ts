import type { MarkdownItInstance } from "./markdown";

// Lines and headings in table cells: GFM tables only hold inline Markdown, so
// a cell can't hold a real `## Heading` block or a new paragraph. A table used
// for layout (an image grid with a title and a few words under each picture,
// say) needs both, so:
//
// - `<br>` in a cell starts a new line (Shift+Enter in the live table types it).
// - A line that starts with #'s is drawn as a heading.
// - A heading straight after a picture starts its own line, `<br>` or not.
//
//   | ## Open Duck Mini | ## Microduck |
//   | --- | --- |
//   | ![Open Duck Mini](/odm.jpg)<br>## Open Duck Mini<br>By Antoine | ![Microduck](/md.jpg) ## Microduck |
//
// The live view (tableWidget.ts, through renderCell) and the preview
// (cellHeadingPlugin) both go through cellLines; image-grid.css styles
// `.cell-heading` for pages that render the Markdown themselves too
// (kevsrobots' project pages, project-cell-headings.js).

const HEADING_RE = /^\s*(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const HASHES_RE = /^\s*(#{1,6})[ \t]+/;
const BR_RE = /^<br\s*\/?>/i;

/** A cell's heading: its level and the Markdown after the #'s, or null when it isn't one. */
export function cellHeading(cell: string): { level: number; text: string } | null {
  const match = HEADING_RE.exec(cell);
  return match && match[2].trim() ? { level: match[1].length, text: match[2] } : null;
}

/** A heading cell's inline HTML wrapped as its heading. */
export function headingHtml(level: number, inner: string): string {
  return `<h${level} class="cell-heading">${inner}</h${level}>`;
}

type Token = { type: string; content: string; attrSet(name: string, value: string): void };
export type TokenClass = new (type: string, tag: string, nesting: -1 | 0 | 1) => Token;

/**
 * A cell's inline tokens split into lines (at `<br>`, and before a heading
 * that follows a picture), with each line that starts with #'s wrapped as a
 * heading. A heading is a block, so the breaks either side of it go.
 */
export function cellLines<T extends Token>(children: T[], Token: TokenClass): T[] {
  const lines: T[][] = [[]];
  for (let i = 0; i < children.length; i++) {
    const token = children[i];
    if (token.type === "hardbreak" || token.type === "softbreak") lines.push([]);
    else {
      if (token.type === "text" && children[i - 1]?.type === "image" && HASHES_RE.test(token.content) && token.content.trim().replace(/^#+/, "")) lines.push([]);
      lines[lines.length - 1].push(token);
    }
  }
  const levelOf = (line: T[]) => {
    const first = line[0];
    const match = first?.type === "text" ? HASHES_RE.exec(first.content) : null;
    // Something after the #'s: in the same bit of text, or a **bold** one after it.
    return match && (first.content.slice(match[0].length).trim() || line.length > 1) ? match[1].length : 0;
  };
  if (lines.length === 1 && !levelOf(lines[0])) return children;

  const out: T[] = [];
  let lastHeading = true;
  lines.forEach((line, index) => {
    const first = line[0];
    const level = levelOf(line);
    if (level) {
      first.content = first.content.replace(HASHES_RE, "");
      const last = line[line.length - 1];
      if (last.type === "text") last.content = last.content.replace(/(?:[ \t]+#+)?[ \t]*$/, "");
      const open = new Token("heading_open", `h${level}`, 1);
      open.attrSet("class", "cell-heading");
      out.push(open as T, ...line, new Token("heading_close", `h${level}`, -1) as T);
      lastHeading = true;
    } else {
      if (first?.type === "text") first.content = first.content.replace(/^\s+/, "");
      const last = line[line.length - 1];
      if (last?.type === "text") last.content = last.content.replace(/\s+$/, "");
      if (index > 0 && !lastHeading) out.push(new Token("hardbreak", "br", 0) as T);
      out.push(...line);
      lastHeading = false;
    }
  });
  return out;
}

/** markdown-it: `<br>` (`<br/>`, `<br />`) is a line break, even with raw HTML off. */
export function brTagPlugin(md: MarkdownItInstance): void {
  md.inline.ruler.before("autolink", "br_tag", (state, silent) => {
    const match = BR_RE.exec(state.src.slice(state.pos, state.pos + 8));
    if (!match) return false;
    if (!silent) state.push("hardbreak", "br", 0);
    state.pos += match[0].length;
    return true;
  });
}

/** markdown-it: splits table cells into lines and draws the ones that start with #'s as headings (`<th><h2 class="cell-heading">…</h2></th>`). */
export function cellHeadingPlugin(md: MarkdownItInstance): void {
  // After inline parsing (and image_grids, which reads each cell's inline token).
  md.core.ruler.push("cell_headings", (state) => {
    const tokens = state.tokens;
    let inTable = false;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.type === "table_open") inTable = true;
      else if (token.type === "table_close") inTable = false;
      if (!inTable || (token.type !== "th_open" && token.type !== "td_open")) continue;
      const inline = tokens[i + 1];
      if (inline?.type === "inline" && inline.children) inline.children = cellLines(inline.children, state.Token);
    }
  });
}
