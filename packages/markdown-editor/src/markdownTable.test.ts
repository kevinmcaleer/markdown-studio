import { describe, expect, it } from "vitest";
import {
  cellAt,
  deleteColumn,
  deleteRow,
  diff,
  formatTable,
  insertColumn,
  insertRow,
  parseTable,
  pasteCells,
  setCell,
  splitRow,
  spreadsheetCells,
  tableFromCells,
} from "./markdownTable";

const source = ["| Name | Qty |", "| :--- | ---: |", "| Apple | 3 |", "| Pear | 5 |"].join("\n");

describe("parseTable", () => {
  it("reads the header, body rows and alignment", () => {
    expect(parseTable(source)).toEqual({
      rows: [
        ["Name", "Qty"],
        ["Apple", "3"],
        ["Pear", "5"],
      ],
      align: ["left", "right"],
    });
  });

  it("pads short rows and keeps escaped pipes in a cell", () => {
    expect(parseTable("a | b\n--|--\nx \\| y")!.rows).toEqual([
      ["a", "b"],
      ["x \\| y", ""],
    ]);
  });

  it("isn't fooled by text without a delimiter row", () => {
    expect(parseTable("| a | b |\n| c | d |")).toBeNull();
  });

  it("splits rows with or without outer pipes", () => {
    expect(splitRow("| a | b |")).toEqual(["a", "b"]);
    expect(splitRow("a|b")).toEqual(["a", "b"]);
  });
});

describe("table edits", () => {
  const table = parseTable(source)!;

  it("adds and removes rows, never the header", () => {
    expect(insertRow(table, 3).rows).toHaveLength(4);
    expect(insertRow(table, 0).rows[1]).toEqual(["", ""]);
    expect(deleteRow(table, 1).rows).toEqual([
      ["Name", "Qty"],
      ["Pear", "5"],
    ]);
    expect(deleteRow(table, 0)).toBe(table);
  });

  it("adds and removes columns, keeping at least one", () => {
    const wider = insertColumn(table, 1);
    expect(wider.rows[0]).toEqual(["Name", "", "Qty"]);
    expect(wider.align).toEqual(["left", null, "right"]);
    expect(deleteColumn(wider, 0).rows[1]).toEqual(["", "3"]);
    const one = deleteColumn(table, 1);
    expect(deleteColumn(one, 0)).toBe(one);
  });

  it("writes tables back as Markdown", () => {
    expect(formatTable(insertColumn(table, 2))).toBe(
      ["| Name | Qty |  |", "| :--- | ---: | --- |", "| Apple | 3 |  |", "| Pear | 5 |  |"].join("\n"),
    );
  });
});

describe("setCell", () => {
  it("changes only that cell's text", () => {
    const padded = "| Name    | Qty |\n| ------- | --- |\n| Apple   | 3   |";
    expect(setCell(padded, 1, 1, "12")).toBe("| Name    | Qty |\n| ------- | --- |\n| Apple   | 12 |");
    expect(setCell(padded, 0, 0, "Fruit")).toBe("| Fruit | Qty |\n| ------- | --- |\n| Apple   | 3   |");
  });

  it("escapes pipes and flattens new lines", () => {
    expect(setCell(source, 2, 0, "a|b\nc")).toContain("| a\\|b c |");
  });

  it("works without outer pipes and on short rows", () => {
    expect(setCell("a | b\n--|--\nx | y", 1, 1, "z")).toBe("a | b\n--|--\nx | z ");
    expect(setCell("| a | b |\n|---|---|\n| x |", 1, 1, "z")).toBe("| a | b |\n|---|---|\n| x | z |");
  });
});

describe("diff", () => {
  it("finds the smallest replacement", () => {
    expect(diff("| a | b |", "| a | bc |")).toEqual({ from: 7, to: 7, insert: "c" });
    expect(diff("same", "same")).toBeNull();
  });
});

describe("pasting cells", () => {
  it("reads spreadsheet cells, quoted new lines and all", () => {
    expect(spreadsheetCells('a\t"two\nlines"\nc\td\n', "<table>")).toEqual([["a", "two\nlines"], ["c", "d"]]);
    expect(spreadsheetCells("just text")).toBeNull();
    expect(spreadsheetCells("one\ttwo\nthree")).toBeNull();
  });

  it("makes a table from cells", () => {
    expect(tableFromCells([["a", "b|c"], ["1", "2"]])).toBe("| a | b\\|c |\n| --- | --- |\n| 1 | 2 |");
  });

  it("fills cells in place, keeping the other lines exactly", () => {
    const source = "|A|B|\n|-|-|\n|1|2|";
    expect(pasteCells(source, 1, 1, [["x"]])).toBe("|A|B|\n|-|-|\n|1| x |");
  });

  it("grows the table when cells run past its edge", () => {
    const source = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    expect(pasteCells(source, 1, 1, [["x", "y"], ["z", "w"]])).toBe(
      "| A | B |  |\n| --- | --- | --- |\n| 1 | x | y |\n|  | z | w |",
    );
  });

  it("finds the cell at an offset", () => {
    const source = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    expect(cellAt(source, source.indexOf("B"))).toEqual([0, 1]);
    expect(cellAt(source, source.indexOf("1"))).toEqual([1, 0]);
  });
});
