// Reading CSV and pasted spreadsheet cells. The sniffing (which delimiter,
// whether the first row is a header, how text is encoded) is ported from
// puddle's src/sources/sniff.ts; the parser itself is new, since puddle hands
// files to DuckDB.

import { parseDelimited } from "@markdown-studio/markdown-editor";

const CANDIDATES = [",", "\t", ";", "|"] as const;
const LINES = 200;

/** How many of `delimiter` a line has outside double quotes. */
export function countOutsideQuotes(line: string, delimiter: string): number {
  let n = 0;
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === delimiter) n++;
  }
  return n;
}

export interface Delimited {
  delimiter: string;
  /** The share of lines with the delimiter's usual count. */
  share: number;
  /** Fields per line, at the usual count. */
  fields: number;
}

/** The delimiter whose count is the same on most lines, with the most lines agreeing (then the most fields) first. */
export function sniffDelimiter(lines: string[]): Delimited | undefined {
  let best: Delimited | undefined;
  for (const delimiter of CANDIDATES) {
    const counts = lines.map((l) => countOutsideQuotes(l, delimiter));
    const tally = new Map<number, number>();
    for (const c of counts) if (c > 0) tally.set(c, (tally.get(c) ?? 0) + 1);
    let mode = 0;
    let at = 0;
    for (const [c, n] of tally) if (n > at || (n === at && c > mode)) [mode, at] = [c, n];
    if (!at) continue;
    const share = at / lines.length;
    if (share < 0.6) continue;
    if (!best || share > best.share + 0.05 || (Math.abs(share - best.share) <= 0.05 && mode + 1 > best.fields))
      best = { delimiter, share, fields: mode + 1 };
  }
  return best;
}

const NUMBER = /^[-+(]?\s*[£$€]?\s*\d[\d,.\s]*%?\)?$/;
export const looksNumeric = (v: string) => NUMBER.test(v.trim()) && /\d/.test(v);

/**
 * Whether the first row is a header: not when a column is numbers in the rows below and the first row's value
 * there is a number too. Otherwise it is (most files have one).
 */
export function hasHeader(rows: string[][]): boolean {
  const first = rows[0];
  if (!first || rows.length < 3) return true;
  for (let c = 0; c < first.length; c++) {
    const below = rows
      .slice(1, LINES)
      .map((r) => r[c]?.trim() ?? "")
      .filter(Boolean);
    if (below.length < 2) continue;
    const numeric = below.filter(looksNumeric).length / below.length;
    if (numeric >= 0.8 && looksNumeric(first[c]!)) return false;
  }
  return true;
}

// The parser is shared with the Markdown editor, which turns pasted cells into tables.
export { parseDelimited };

/** Text from a file's bytes: UTF-8 when it is, otherwise Windows-1252 (old Excel exports). */
export function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/** Unique, non-empty column names: an empty one is "Field 3", a repeat "Name 2". */
export function columnNames(header: string[] | undefined, count: number): string[] {
  const seen = new Set<string>();
  return Array.from({ length: count }, (_, i) => {
    const base = header?.[i]?.trim().replace(/\s+/g, " ") || `Field ${i + 1}`;
    let name = base;
    for (let n = 2; seen.has(name.toLowerCase()) || name.toLowerCase() === "id"; n++) name = `${base} ${n}`;
    seen.add(name.toLowerCase());
    return name;
  });
}

export type Parsed = { columns: string[]; rows: string[][]; delimiter: string };

/** A CSV (or tab-separated, semicolon, pipe) file read into named columns and rows. */
export function readTable(text: string): Parsed {
  const lines = text
    .replace(/^﻿/, "")
    .split(/\r\n|\r|\n/)
    .filter((l) => l.trim())
    .slice(0, LINES);
  const delimiter = sniffDelimiter(lines)?.delimiter ?? ",";
  const all = parseDelimited(text, delimiter);
  const width = Math.max(0, ...all.map((r) => r.length));
  const header = hasHeader(all);
  const rows = (header ? all.slice(1) : all).map((r) => [...r, ...Array(width - r.length).fill("")]);
  return { columns: columnNames(header ? all[0] : undefined, width), rows, delimiter };
}

// --------------------------------------------------------------- clipboard

/** Cells as tab-separated text, the way spreadsheets copy them (quoted only when needed). */
export function toTsv(cells: string[][]): string {
  const quote = (v: string) => (/[\t\n\r"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return cells.map((r) => r.map(quote).join("\t")).join("\n");
}

/** Pasted text as a block of cells: tab-separated from a spreadsheet, or a single value. */
export function fromClipboard(text: string): string[][] {
  const trimmed = text.replace(/\r?\n$/, "");
  if (!trimmed.includes("\t") && !trimmed.includes("\n")) return [[trimmed]];
  const rows = parseDelimited(trimmed, "\t", true);
  return rows.length ? rows : [[""]];
}
