import { describe, expect, it } from "vitest";
import { columnNames, decode, fromClipboard, hasHeader, readTable, sniffDelimiter, toTsv } from "./csv";

describe("reading CSV", () => {
  it("finds the delimiter most lines agree on", () => {
    expect(sniffDelimiter(["a;b;c", "1;2,5;3", "4;5;6"])?.delimiter).toBe(";");
    expect(sniffDelimiter(["a\tb", "1\t2"])?.delimiter).toBe("\t");
    expect(sniffDelimiter(['"x, y",b', "1,2"])?.delimiter).toBe(",");
  });

  it("reads quotes, doubled quotes and new lines in quotes", () => {
    const parsed = readTable('Name,Note\r\n"Smith, J","said ""hi""\nthen left"\r\n\r\nAda,\n');
    expect(parsed.columns).toEqual(["Name", "Note"]);
    expect(parsed.rows).toEqual([
      ["Smith, J", 'said "hi"\nthen left'],
      ["Ada", ""],
    ]);
  });

  it("pads short rows and names missing columns", () => {
    const parsed = readTable("a,b\n1,2,3\n4\n");
    expect(parsed.columns).toEqual(["a", "b", "Field 3"]);
    expect(parsed.rows).toEqual([
      ["1", "2", "3"],
      ["4", "", ""],
    ]);
  });

  it("sees when there's no header row", () => {
    expect(hasHeader([["1", "x"], ["2", "y"], ["3", "z"]])).toBe(false);
    expect(hasHeader([["Qty", "x"], ["2", "y"], ["3", "z"]])).toBe(true);
    expect(readTable("1,2\n3,4\n5,6").columns).toEqual(["Field 1", "Field 2"]);
  });

  it("makes column names unique, and never ID", () => {
    expect(columnNames(["Name", "name", " ", "ID"], 4)).toEqual(["Name", "name 2", "Field 3", "ID 2"]);
  });

  it("falls back to Windows-1252 for old files", () => {
    expect(decode(new Uint8Array([0x63, 0x61, 0x66, 0xe9]))).toBe("café");
    expect(decode(new TextEncoder().encode("café"))).toBe("café");
  });
});

describe("the clipboard", () => {
  it("round-trips a block of cells", () => {
    const cells = [
      ["a", "b\tc"],
      ["", 'say "x"'],
    ];
    expect(fromClipboard(toTsv(cells))).toEqual(cells);
  });

  it("treats plain text as one value", () => {
    expect(fromClipboard("hello, world\n")).toEqual([["hello, world"]]);
  });

  it("keeps blank rows in a pasted block", () => {
    expect(fromClipboard("a\n\nb")).toEqual([["a"], [""], ["b"]]);
  });
});
