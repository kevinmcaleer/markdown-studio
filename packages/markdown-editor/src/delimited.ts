/** Parse delimited text (RFC 4180: quotes, doubled quotes, new lines inside quotes). */
export function parseDelimited(text: string, delimiter: string, keepBlank = false): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = 0;
  const s = text.replace(/^﻿/, "");
  while (i < s.length) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else cell += ch;
      i++;
      continue;
    }
    if (ch === '"' && cell === "") quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      if (ch === "\r" && s[i + 1] === "\n") i++;
    } else cell += ch;
    i++;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  // Blank lines aren't rows (in a file; a pasted block keeps them, to clear cells).
  return keepBlank ? rows : rows.filter((r) => r.some((c) => c.trim() !== ""));
}
