import type { MarkdownItInstance } from "./markdown";

// Column widths, kept in plain GFM the way Pandoc does it: the number of
// dashes in each delimiter cell is that column's share of the table's width.
//
//   | Part | Notes |
//   | ----- | --------------- |      ← 5 and 15 dashes: 25% and 75%
//
// When every cell has the same number of dashes (`| --- | --- |`, as tables
// usually are) nothing is set and the browser sizes the columns as before.
// Dragging a column's edge in the live view (tableWidget.ts) writes the dashes,
// one per 5%; the preview (tableWidthsPlugin) and hosts that render the
// Markdown themselves (kevsrobots' project pages) draw them as a <colgroup>.

/** One dash per this many percent, when the editor writes widths. */
export const WIDTH_STEP = 5;

/** The dash count of each cell on a delimiter line (quote markers allowed), or null if it isn't one. */
export function delimiterDashes(line: string): number[] | null {
  let text = line.replace(/^\s*(?:>\s?)*/, "").trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|")) text = text.slice(0, -1);
  const cells = text.split("|").map((cell) => cell.trim());
  if (!cells.length || !cells.every((cell) => /^:?-+:?$/.test(cell))) return null;
  return cells.map((cell) => cell.replace(/:/g, "").length);
}

/** Each column's width in percent, or null when the dash counts are all the same (no widths set). */
export function columnWidths(dashes: number[] | undefined | null): number[] | null {
  if (!dashes || dashes.length < 2 || dashes.every((n) => n === dashes[0])) return null;
  const total = dashes.reduce((sum, n) => sum + n, 0);
  return dashes.map((n) => (n / total) * 100);
}

/** A `<colgroup>` for the widths, or "" when there are none. */
export function colgroupHtml(widths: number[] | null): string {
  if (!widths) return "";
  return `<colgroup>${widths.map((w) => `<col style="width: ${+w.toFixed(2)}%">`).join("")}</colgroup>`;
}

/**
 * Widths (in percent, or any proportions) as dash counts, one per WIDTH_STEP
 * percent, at least one each, adding up to 20 where they can. Equal widths
 * come out as equal counts, which reads as no widths set.
 */
export function widthsToDashes(widths: number[]): number[] {
  const total = widths.reduce((sum, w) => sum + w, 0) || 1;
  const steps = Math.round(100 / WIDTH_STEP);
  const exact = widths.map((w) => (w / total) * steps);
  const dashes = exact.map((n) => Math.max(1, Math.floor(n)));
  // Round so they add up to 100% (20 dashes), the biggest remainders first.
  const order = exact.map((n, i) => [n - Math.floor(n), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0, sum = dashes.reduce((a, b) => a + b, 0); sum < steps && k < order.length; k++, sum++) dashes[order[k][1]]++;
  return dashes;
}

/**
 * The dash counts that give column `col` `target` percent of the width (rounded
 * up to the next 5%, so its content still fits) and share what's left among
 * the other columns in proportion to `widths`, their current widths. Every
 * other column keeps at least 10% where there's room, so `col` can't take
 * the whole table.
 */
export function fitColumnDashes(widths: number[], col: number, target: number): number[] {
  const n = widths.length;
  const steps = Math.max(Math.round(100 / WIDTH_STEP), n * 2);
  const least = steps >= n * 2 ? 2 : 1;
  // A twentieth of a step over (about 1.5px across a 600px table) still rounds down.
  const want = Math.ceil(target / (100 / steps) - 0.05);
  const mine = Math.max(least, Math.min(steps - least * (n - 1), want));
  const rest = steps - mine;
  const others = widths.map((w, i) => (i === col ? 0 : Math.max(w, 0.0001)));
  const total = others.reduce((sum, w) => sum + w, 0);
  const exact = others.map((w, i) => (i === col ? 0 : (w / total) * rest));
  const dashes = exact.map((x, i) => (i === col ? mine : Math.max(least, Math.floor(x))));
  let sum = dashes.reduce((a, b) => a + b, 0);
  // Too many (the 10% floors): take from the widest others first.
  while (sum > steps) {
    const i = dashes.reduce((best, d, j) => (j !== col && d > least && (best < 0 || d > dashes[best]) ? j : best), -1);
    if (i < 0) break;
    dashes[i]--;
    sum--;
  }
  // Too few: the biggest remainders get one more.
  const order = exact.map((x, i) => [x - Math.floor(x), i]).filter(([, i]) => i !== col).sort((a, b) => b[0] - a[0]);
  for (let k = 0; sum < steps && order.length; k = (k + 1) % order.length, sum++) dashes[order[k][1]]++;
  return dashes;
}

/** markdown-it: a table whose delimiter row sets widths gets a `<colgroup>` and the `has-widths` class. */
export function tableWidthsPlugin(md: MarkdownItInstance): void {
  md.core.ruler.push("table_widths", (state) => {
    const lines = state.src.split("\n");
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.type !== "table_open" || !token.map) continue;
      const dashes = delimiterDashes(lines[token.map[0] + 1] ?? "");
      // The header row's cell count must match, or the line isn't this table's.
      let columns = 0;
      for (let j = i + 1; j < tokens.length && tokens[j].type !== "tr_close"; j++) if (tokens[j].type === "th_open") columns++;
      if (!dashes || dashes.length !== columns) continue;
      const widths = columnWidths(dashes);
      if (!widths) continue;
      token.attrJoin("class", "has-widths");
      const colgroup = new state.Token("html_block", "", 0);
      colgroup.content = colgroupHtml(widths);
      tokens.splice(i + 1, 0, colgroup);
    }
  });
}
