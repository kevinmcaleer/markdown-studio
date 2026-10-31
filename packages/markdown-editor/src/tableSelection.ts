import type { Mark } from "./format/formatting";
import { clearCellFormatting } from "./format/cellMarks";
import { renderCell } from "./markdown";
import {
  cellText,
  deleteColumn,
  deleteRow,
  formatTable,
  parseTable,
  setAlign,
  setCell,
  type Align,
  type Table,
} from "./markdownTable";

// A block of cells picked in a table drawn as a grid (tableWidget.ts): by
// dragging across cells, Shift+clicking one, or with the row and column
// handles. What can be done to one cell's selected words can be done to the
// whole block: bold, italic and so on, alignment (a column's, in GFM), clearing
// the formatting or the text, deleting the rows or columns, and copying.
// Each action is an edit to the table's Markdown, like every other.

/** Two corner cells; the block is every cell between them. */
export type CellRange = { anchor: { row: number; col: number }; head: { row: number; col: number } };

/** A block's rows and columns, top-left to bottom-right (inclusive). */
export type Block = { top: number; left: number; bottom: number; right: number };

export function blockOf(range: CellRange): Block {
  return {
    top: Math.min(range.anchor.row, range.head.row),
    bottom: Math.max(range.anchor.row, range.head.row),
    left: Math.min(range.anchor.col, range.head.col),
    right: Math.max(range.anchor.col, range.head.col),
  };
}

/** How many cells a block has. */
export function blockSize(block: Block): number {
  return (block.bottom - block.top + 1) * (block.right - block.left + 1);
}

export function inBlock(block: Block, row: number, col: number): boolean {
  return row >= block.top && row <= block.bottom && col >= block.left && col <= block.right;
}

/** Whether the block is whole rows: it runs across every column. */
export function wholeRows(table: Table, block: Block): boolean {
  return block.left === 0 && block.right === table.align.length - 1;
}

/** Whether the block is whole columns: it runs down every row, header included. */
export function wholeColumns(table: Table, block: Block): boolean {
  return block.top === 0 && block.bottom === table.rows.length - 1;
}

/** Each cell in the block, row by row. */
function cells(block: Block): [number, number][] {
  const out: [number, number][] = [];
  for (let row = block.top; row <= block.bottom; row++) for (let col = block.left; col <= block.right; col++) out.push([row, col]);
  return out;
}

/** Changes each cell in the block that `edit` gives new text for, leaving the rest of the Markdown as it was. */
function editCells(source: string, block: Block, edit: (text: string) => string | null): string {
  const table = parseTable(source);
  if (!table) return source;
  let next = source;
  for (const [row, col] of cells(block)) {
    const text = cellText(table.rows[row]?.[col] ?? "");
    const changed = edit(text);
    if (changed !== null && changed !== text) next = setCell(next, row, col, changed);
  }
  return next;
}

// ---------------------------------------------------------------- marks

const MARKERS: Record<Mark, string> = { bold: "**", italic: "*", strike: "~~", highlight: "==", code: "`" };

/** A heading's `## ` stays at the front of its line, outside any mark. */
const HEADING = /^#{1,6}\s+/;

/** A line's text without one kind of mark (keeping the other marks). */
function stripMark(line: string, mark: Mark): string {
  switch (mark) {
    case "bold":
      // `***x***` is bold and italic: it keeps the italic.
      return line.replace(/\*\*\*(?=\S)(.+?)(?<=\S)\*\*\*/g, "*$1*").replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "$1");
    case "italic":
      return line
        .replace(/\*\*\*(?=\S)(.+?)(?<=\S)\*\*\*/g, "**$1**")
        .replace(/(^|[^*])\*(?!\*)(?=\S)(.+?)(?<=[^\s*])\*(?!\*)/g, "$1$2");
    case "strike":
      return line.replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1");
    case "highlight":
      return line.replace(/==(?=\S)(.+?)(?<=\S)==/g, "$1");
    case "code":
      return line.replace(/`([^`]+)`/g, "$1");
  }
}

/** A line wrapped in the mark (inside any heading marker), or as it is when there's nothing to wrap. */
function wrapLine(line: string, mark: Mark): string {
  const heading = HEADING.exec(line)?.[0] ?? "";
  const body = line.slice(heading.length);
  const lead = /^\s*/.exec(body)![0];
  const trail = /\s*$/.exec(body)![0];
  const words = body.trim();
  if (!words) return line;
  // A code span can't hold its own backticks without longer fences; leave it.
  if (mark === "code" && words.includes("`")) return line;
  const marker = MARKERS[mark];
  return heading + lead + marker + stripMark(words, mark) + marker + trail;
}

/** A cell's text with the mark on every line (or off every line). */
export function setCellMark(text: string, mark: Mark, on: boolean): string {
  return text
    .split("\n")
    .map((line) => (on ? wrapLine(line, mark) : stripMark(line, mark)))
    .join("\n");
}

/** Whether all of a cell's text has the mark (an empty cell has nothing to mark). */
export function cellHasMark(text: string, mark: Mark): boolean {
  return !!text.trim() && setCellMark(text, mark, true) === text;
}

/** Whether every cell in the block with text in it has the mark. */
export function blockHasMark(source: string, block: Block, mark: Mark): boolean {
  const table = parseTable(source);
  if (!table) return false;
  const texts = cells(block).map(([row, col]) => cellText(table.rows[row]?.[col] ?? "")).filter((text) => text.trim());
  return texts.length > 0 && texts.every((text) => cellHasMark(text, mark));
}

/** Marks every cell in the block, or unmarks them all when they all have it already. */
export function toggleBlockMark(source: string, block: Block, mark: Mark): string {
  const on = !blockHasMark(source, block, mark);
  return editCells(source, block, (text) => (text.trim() ? setCellMark(text, mark, on) : null));
}

/** Takes the marks and links off every cell in the block, keeping the words. */
export function clearBlockFormatting(source: string, block: Block): string {
  return editCells(source, block, (text) => clearCellFormatting(text, 0, text.length)?.text ?? null);
}

/** Empties every cell in the block. */
export function clearBlock(source: string, block: Block): string {
  return editCells(source, block, (text) => (text ? "" : null));
}

// ---------------------------------------------------------------- columns and rows

/** The alignment every column in the block shares, or undefined when they differ. */
export function blockAlign(table: Table, block: Block): Align | undefined {
  const first = table.align[block.left] ?? null;
  for (let col = block.left; col <= block.right; col++) if ((table.align[col] ?? null) !== first) return undefined;
  return first;
}

/** Aligns each column the block covers (alignment is a whole column's, in GFM). */
export function alignBlock(source: string, block: Block, align: Align): string {
  let next = source;
  for (let col = block.left; col <= block.right; col++) next = setAlign(next, col, align);
  return next;
}

/** The table without the block's rows; null when that would leave no rows. */
export function deleteBlockRows(table: Table, block: Block): Table | null {
  if (block.top === 0 && block.bottom >= table.rows.length - 1) return null;
  let next = table;
  for (let row = block.bottom; row >= block.top; row--) next = deleteRow(next, row);
  return next;
}

/** The table without the block's columns; null when that would leave none. */
export function deleteBlockColumns(table: Table, block: Block): Table | null {
  if (block.left === 0 && block.right >= table.align.length - 1) return null;
  let next = table;
  for (let col = block.right; col >= block.left; col--) next = deleteColumn(next, col);
  return next;
}

/** `deleteBlockRows` on the Markdown. */
export function deleteRowsIn(source: string, block: Block): string {
  const table = parseTable(source);
  const next = table && deleteBlockRows(table, block);
  return next ? formatTable(next) : source;
}

/** `deleteBlockColumns` on the Markdown. */
export function deleteColumnsIn(source: string, block: Block): string {
  const table = parseTable(source);
  const next = table && deleteBlockColumns(table, block);
  return next ? formatTable(next) : source;
}

// ---------------------------------------------------------------- copying

/** The block's cells as their Markdown, row by row. */
export function blockCells(table: Table, block: Block): string[][] {
  const out: string[][] = [];
  for (let row = block.top; row <= block.bottom; row++) out.push(table.rows[row].slice(block.left, block.right + 1));
  return out;
}

/**
 * The block for the clipboard: tab-separated Markdown (which pastes back into
 * a table cell by cell, or into a spreadsheet) and an HTML table (which the
 * note's smart paste turns into a Markdown table, and documents keep as one).
 */
export function blockClipboard(table: Table, block: Block): { text: string; html: string } {
  const rows = blockCells(table, block);
  const text = rows.map((row) => row.join("\t")).join("\n");
  const html = `<table>${rows
    .map((row, r) => {
      const tag = r === 0 && block.top === 0 ? "th" : "td";
      return `<tr>${row.map((cell) => `<${tag}>${renderCell(cell)}</${tag}>`).join("")}</tr>`;
    })
    .join("")}</table>`;
  return { text, html };
}
