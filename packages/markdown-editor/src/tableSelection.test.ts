import { describe, expect, it } from "vitest";
import { parseTable } from "./markdownTable";
import {
  alignBlock,
  blockClipboard,
  blockHasMark,
  blockOf,
  cellHasMark,
  clearBlock,
  clearBlockFormatting,
  deleteBlockRows,
  deleteColumnsIn,
  deleteRowsIn,
  setCellMark,
  toggleBlockMark,
  wholeColumns,
  wholeRows,
} from "./tableSelection";

const doc = "| Part | Qty | Notes |\n| --- | --- | --- |\n| Servo | 2 | *ears* |\n| Pico | 1 | brain |";
const block = (top: number, left: number, bottom: number, right: number) => ({ top, left, bottom, right });

describe("cell marks", () => {
  it("wraps a whole cell, keeping a heading's marker outside", () => {
    expect(setCellMark("Servo", "bold", true)).toBe("**Servo**");
    expect(setCellMark("## Title", "bold", true)).toBe("## **Title**");
    expect(setCellMark("one\ntwo", "italic", true)).toBe("*one*\n*two*");
  });

  it("merges marks already inside instead of nesting them", () => {
    expect(setCellMark("**a** and **b**", "bold", true)).toBe("**a and b**");
    expect(setCellMark("*x*", "bold", true)).toBe("***x***");
    expect(setCellMark("**x**", "italic", true)).toBe("***x***");
  });

  it("takes one mark off and keeps the others", () => {
    expect(setCellMark("***x***", "bold", false)).toBe("*x*");
    expect(setCellMark("***x***", "italic", false)).toBe("**x**");
    expect(setCellMark("~~gone~~ and ==lit==", "strike", false)).toBe("gone and ==lit==");
  });

  it("knows a cell that's all marked", () => {
    expect(cellHasMark("**x**", "bold")).toBe(true);
    expect(cellHasMark("***x***", "italic")).toBe(true);
    expect(cellHasMark("**a** and **b**", "bold")).toBe(false);
    expect(cellHasMark("", "bold")).toBe(false);
  });

  it("leaves code with backticks in it alone", () => {
    expect(setCellMark("a `b`", "code", true)).toBe("a `b`");
  });
});

describe("blocks", () => {
  it("bolds every cell with text, then unbolds them", () => {
    const bold = toggleBlockMark(doc, block(1, 0, 2, 1), "bold");
    expect(bold).toBe("| Part | Qty | Notes |\n| --- | --- | --- |\n| **Servo** | **2** | *ears* |\n| **Pico** | **1** | brain |");
    expect(blockHasMark(bold, block(1, 0, 2, 1), "bold")).toBe(true);
    expect(toggleBlockMark(bold, block(1, 0, 2, 1), "bold")).toBe(doc);
  });

  it("bolds the rest when some cells are bold already", () => {
    const some = doc.replace("Servo", "**Servo**");
    expect(toggleBlockMark(some, block(1, 0, 2, 0), "bold")).toContain("| **Pico** |");
    expect(toggleBlockMark(some, block(1, 0, 2, 0), "bold")).toContain("| **Servo** |");
  });

  it("skips empty cells", () => {
    const sparse = "| a | b |\n| --- | --- |\n| x |  |";
    expect(toggleBlockMark(sparse, block(1, 0, 1, 1), "bold")).toBe("| a | b |\n| --- | --- |\n| **x** |  |");
  });

  it("clears formatting and contents", () => {
    expect(clearBlockFormatting(doc, block(1, 2, 1, 2))).toContain("| Servo | 2 | ears |");
    expect(clearBlock(doc, block(2, 0, 2, 2))).toBe("| Part | Qty | Notes |\n| --- | --- | --- |\n| Servo | 2 | *ears* |\n|  |  |  |");
  });

  it("aligns every column in the block", () => {
    expect(alignBlock(doc, block(1, 1, 2, 2), "right").split("\n")[1]).toBe("| --- | ---: | ---: |");
  });

  it("knows whole rows and whole columns", () => {
    const table = parseTable(doc)!;
    expect(wholeRows(table, block(1, 0, 2, 2))).toBe(true);
    expect(wholeRows(table, block(1, 0, 2, 1))).toBe(false);
    expect(wholeColumns(table, block(0, 1, 2, 1))).toBe(true);
    expect(wholeColumns(table, block(1, 1, 2, 1))).toBe(false);
  });

  it("deletes rows and columns, never all of them", () => {
    expect(deleteRowsIn(doc, block(1, 0, 2, 2))).toBe("| Part | Qty | Notes |\n| --- | --- | --- |");
    expect(deleteColumnsIn(doc, block(0, 1, 2, 2))).toBe("| Part |\n| --- |\n| Servo |\n| Pico |");
    expect(deleteBlockRows(parseTable(doc)!, block(0, 0, 2, 2))).toBeNull();
    expect(deleteColumnsIn(doc, block(0, 0, 2, 2))).toBe(doc);
  });

  it("copies as tab-separated Markdown and an HTML table", () => {
    const { text, html } = blockClipboard(parseTable(doc)!, blockOf({ anchor: { row: 2, col: 2 }, head: { row: 0, col: 1 } }));
    expect(text).toBe("Qty\tNotes\n2\t*ears*\n1\tbrain");
    expect(html).toContain("<th>Qty</th>");
    expect(html).toContain("<em>ears</em>");
  });
});
