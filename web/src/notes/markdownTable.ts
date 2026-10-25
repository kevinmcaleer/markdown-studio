// A GFM table as rows of cells, and the edits the table controls make to it
// (add or remove a row or column, change a cell). Edits hand back the new
// Markdown; `diff` turns that into the smallest change, so an edit to one
// cell doesn't rewrite the whole table under someone typing elsewhere in it.

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
  return text.replace(/\r?\n/g, " ").replace(/(?<!\\)\|/g, "\\|").trim();
}

export function insertRow(table: Table, index: number): Table {
  const rows = table.rows.slice();
  rows.splice(Math.max(1, index), 0, table.align.map(() => ""));
  return { ...table, rows };
}

export function deleteRow(table: Table, index: number): Table {
  if (index < 1 || table.rows.length < 2) return table;
  return { ...table, rows: table.rows.filter((_, i) => i !== index) };
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
