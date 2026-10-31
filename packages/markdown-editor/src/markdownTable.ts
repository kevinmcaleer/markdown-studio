// A GFM table as rows of cells, and the edits the table controls make to it
// (add or remove a row or column, change a cell). Edits hand back the new
// Markdown; `diff` turns that into the smallest change, so an edit to one
// cell doesn't rewrite the whole table under someone typing elsewhere in it.

import { parseDelimited } from "./delimited";

export type Align = "left" | "center" | "right" | null;

export type Table = {
  /** The header row first, then the body rows; every row has `align.length` cells. */
  rows: string[][];
  align: Align[];
};

/** Splits a table row on its unescaped pipes, without the outer ones. */
export function splitRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && text[i + 1] === "|") {
      cell += "\\|";
      i++;
    } else if (ch === "|") {
      cells.push(cell.trim());
      cell = "";
    } else cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

function parseAlign(cell: string): Align {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  return left && right ? "center" : right ? "right" : left ? "left" : null;
}

/** Reads a table, or returns null when the text isn't one (no delimiter row). */
export function parseTable(source: string): Table | null {
  const lines = source.split("\n").filter((line) => line.trim());
  if (lines.length < 2) return null;
  const delimiter = splitRow(lines[1]);
  if (!delimiter.every((cell) => /^:?-+:?$/.test(cell))) return null;
  const align = delimiter.map(parseAlign);
  const width = align.length;
  const rows = [lines[0], ...lines.slice(2)].map((line) => {
    const cells = splitRow(line).slice(0, width);
    while (cells.length < width) cells.push("");
    return cells;
  });
  return { rows, align };
}

function formatRow(cells: string[]): string {
  return `|${cells.map((cell) => ` ${cell} `).join("|")}|`;
}

function formatDelimiter(align: Align[]): string {
  const cell = (a: Align) => (a === "center" ? ":---:" : a === "right" ? "---:" : a === "left" ? ":---" : "---");
  return `| ${align.map(cell).join(" | ")} |`;
}

export function formatTable(table: Table): string {
  const [header, ...body] = table.rows;
  return [formatRow(header), formatDelimiter(table.align), ...body.map(formatRow)].join("\n");
}

/** A cell's text as it goes in the Markdown: one line, with its pipes escaped. */
export function escapeCell(text: string): string {
  return text.replace(/\r?\n/g, "<br>").replace(/(?<!\\)\|/g, "\\|").trim();
}

// A cell's new lines are `<br>`s in the Markdown (a table row is one line),
// and line breaks while it's being typed in.
const BR_TAG = /<br\s*\/?>/gi;

/** A cell's Markdown as the text to type in, its `<br>`s as line breaks. */
export function cellText(raw: string): string {
  return raw.replace(BR_TAG, "\n");
}

/** Where `offset` in a cell's typed text (cellText) falls in its Markdown. */
export function rawOffset(text: string, offset: number): number {
  return escapeCell(text.slice(0, offset) + "\u0000").length - 1;
}

/** Where `offset` in a cell's Markdown falls in its typed text (cellText). */
export function textOffset(raw: string, offset: number): number {
  return cellText(raw.slice(0, offset)).length;
}

export function insertRow(table: Table, index: number): Table {
  const rows = table.rows.slice();
  rows.splice(Math.max(1, index), 0, table.align.map(() => ""));
  return { ...table, rows };
}

/**
 * Removes a row. Removing the header moves the first body row up to take its
 * place; a table with only its header keeps it, as a table needs one.
 */
export function deleteRow(table: Table, index: number): Table {
  if (index < 0 || index >= table.rows.length || table.rows.length < 2) return table;
  return { ...table, rows: table.rows.filter((_, i) => i !== index) };
}

/** Empties a row's cells, keeping the row. */
export function clearRow(table: Table, index: number): Table {
  if (index < 0 || index >= table.rows.length) return table;
  return { ...table, rows: table.rows.map((cells, i) => (i === index ? cells.map(() => "") : cells)) };
}

export function insertColumn(table: Table, index: number): Table {
  const at = (cells: string[]) => [...cells.slice(0, index), "", ...cells.slice(index)];
  const align = [...table.align.slice(0, index), null, ...table.align.slice(index)];
  return { rows: table.rows.map(at), align };
}

export function deleteColumn(table: Table, index: number): Table {
  if (table.align.length < 2) return table;
  const without = <T,>(cells: T[]) => cells.filter((_, i) => i !== index);
  return { rows: table.rows.map(without), align: without(table.align) };
}

/** An array with the item at `from` taken out and put back at `to`. */
function moved<T>(items: T[], from: number, to: number): T[] {
  const next = items.slice();
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

/**
 * Moves a row so it ends up at `to`. The header is row 0, so moving a row to
 * the top makes it the header and the old header the first body row.
 */
export function moveRow(table: Table, from: number, to: number): Table {
  const last = table.rows.length - 1;
  if (from === to || from < 0 || from > last || to < 0 || to > last) return table;
  return { ...table, rows: moved(table.rows, from, to) };
}

/**
 * Splits a table in two at a body row: that row and the ones below it become a
 * second table under a copy of the header, and both keep the column alignment.
 * Returns null for the header or the first body row, which would leave the
 * first table with no body.
 */
export function splitTable(table: Table, index: number): [Table, Table] | null {
  if (index < 2 || index >= table.rows.length) return null;
  const [header] = table.rows;
  return [
    { rows: table.rows.slice(0, index), align: table.align.slice() },
    { rows: [header.slice(), ...table.rows.slice(index)], align: table.align.slice() },
  ];
}

/** Moves a column so it ends up at `to`, its alignment going with it. */
export function moveColumn(table: Table, from: number, to: number): Table {
  const last = table.align.length - 1;
  if (from === to || from < 0 || from > last || to < 0 || to > last) return table;
  return { rows: table.rows.map((cells) => moved(cells, from, to)), align: moved(table.align, from, to) };
}

/**
 * The table's Markdown with one column aligned (null for the default), as the
 * colons on its delimiter cell: `:---` left, `:---:` center, `---:` right. Only
 * the delimiter line changes, and every other column keeps its alignment.
 */
export function setAlign(source: string, col: number, align: Align): string {
  const lines = source.split("\n");
  const index = lines.findIndex((line) => line.trim());
  const delimiter = lines.findIndex((line, i) => i > index && line.trim());
  if (index < 0 || delimiter < 0) return source;
  const cells = splitRow(lines[delimiter]);
  if (!cells.every((cell) => /^:?-+:?$/.test(cell))) return source;
  while (cells.length <= col) cells.push("---");
  const dashes = cells[col].replace(/:/g, "") || "---";
  cells[col] = align === "center" ? `:${dashes}:` : align === "right" ? `${dashes}:` : align === "left" ? `:${dashes}` : dashes;
  lines[delimiter] = `| ${cells.join(" | ")} |`;
  return lines.join("\n");
}

/** The table's Markdown with one cell changed; everything else keeps its exact text. */
export function setCell(source: string, row: number, col: number, text: string): string {
  const lines = source.split("\n");
  // Row 0 is the header; body rows come after the delimiter line.
  const index = row === 0 ? 0 : row + 1;
  const line = lines[index];
  if (line === undefined) return source;
  // The cell's span: between the pipes either side of it.
  const pipes: number[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\") i++;
    else if (line[i] === "|") pipes.push(i);
  }
  const leading = line.trimStart().startsWith("|");
  const trailing = pipes.length > 0 && !line.slice(pipes[pipes.length - 1] + 1).trim();
  const bounds = [...(leading ? [] : [-1]), ...pipes, ...(trailing ? [] : [line.length])];
  const value = ` ${escapeCell(text)} `;
  if (col < bounds.length - 1) {
    lines[index] = line.slice(0, bounds[col] + 1) + value + line.slice(bounds[col + 1]);
  } else {
    // A short row: fill it out to this column.
    const cells = splitRow(line);
    while (cells.length < col) cells.push("");
    cells[col] = escapeCell(text);
    lines[index] = formatRow(cells);
  }
  return lines.join("\n");
}

/** The smallest single replacement turning `from` into `to`. */
export function diff(from: string, to: string): { from: number; to: number; insert: string } | null {
  if (from === to) return null;
  let start = 0;
  while (start < from.length && start < to.length && from[start] === to[start]) start++;
  let endA = from.length;
  let endB = to.length;
  while (endA > start && endB > start && from[endA - 1] === to[endB - 1]) {
    endA--;
    endB--;
  }
  return { from: start, to: endA, insert: to.slice(start, endB) };
}

// ---------------------------------------------------------------- pasting cells

/**
 * Cells copied from a spreadsheet (Excel, Numbers, Google Sheets, Tables), from
 * the clipboard's tab-separated text, or null when it isn't a block of cells.
 * Spreadsheets put an HTML table beside the text; without one, the text still
 * counts when every line has the same number of tabs and isn't just indented.
 */
export function spreadsheetCells(text: string, html = ""): string[][] | null {
  const fromSheet = /<table[\s>]/i.test(html);
  if (!text.includes("\t") && !fromSheet) return null;
  const rows = parseDelimited(text.replace(/\r?\n$/, ""), "\t", true);
  const width = rows[0]?.length ?? 0;
  if (width < 2 && rows.length < 2) return null;
  if (!rows.every((row) => row.length === width)) return null;
  if (!fromSheet) {
    if (html || rows.length < 2 || width < 2) return null;
    if (rows.every((row) => !row[0].trim())) return null;
  }
  return rows.map((row) => row.map((cell) => cell.trim()));
}

/** Cells as a new table, the first row its header. */
export function tableFromCells(cells: string[][]): string {
  const width = Math.max(...cells.map((row) => row.length));
  const rows = cells.map((row) => Array.from({ length: width }, (_, i) => escapeCell(row[i] ?? "")));
  return formatTable({ rows, align: rows[0].map(() => null) });
}

/**
 * The table's Markdown with `cells` pasted in from (row, col) across and down,
 * growing the table when they run past its edge. Cells that fit keep the rest
 * of each line exactly as it was.
 */
export function pasteCells(source: string, row: number, col: number, cells: string[][]): string {
  const table = parseTable(source);
  if (!table) return source;
  const width = Math.max(...cells.map((r) => r.length));
  let grown = table;
  while (grown.rows.length < row + cells.length) grown = insertRow(grown, grown.rows.length);
  while (grown.align.length < col + width) grown = insertColumn(grown, grown.align.length);
  let next = grown === table ? source : formatTable(grown);
  cells.forEach((cellsInRow, r) => cellsInRow.forEach((text, c) => (next = setCell(next, row + r, col + c, text))));
  return next;
}

/** The cell at `offset` in the table's Markdown, as [row, col]; on the delimiter line, the first body row. */
export function cellAt(source: string, offset: number): [number, number] {
  const before = source.slice(0, offset).split("\n");
  const index = before.length - 1;
  const line = before[index];
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\") i++;
    else if (line[i] === "|") col++;
  }
  if (line.trimStart().startsWith("|")) col--;
  const row = index === 0 ? 0 : Math.max(1, index - 1);
  return [row, Math.max(0, col)];
}
