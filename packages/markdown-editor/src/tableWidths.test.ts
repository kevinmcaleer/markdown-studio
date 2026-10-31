import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";
import { columnWidths, delimiterDashes, widthsToDashes } from "./tableWidths";

describe("delimiterDashes", () => {
  it("counts each cell's dashes, leaving out the colons", () => {
    expect(delimiterDashes("| :----- | ---------------: |")).toEqual([5, 15]);
    expect(delimiterDashes("--- | :-:")).toEqual([3, 1]);
  });
  it("reads a delimiter line in a quote or callout", () => {
    expect(delimiterDashes("> | -- | ------ |")).toEqual([2, 6]);
  });
  it("is null for a line that isn't a delimiter row", () => {
    expect(delimiterDashes("| a | b |")).toBeNull();
  });
});

describe("columnWidths", () => {
  it("shares out the width by dash count", () => {
    expect(columnWidths([5, 15])).toEqual([25, 75]);
  });
  it("is null when the counts are all the same", () => {
    expect(columnWidths([3, 3, 3])).toBeNull();
    expect(columnWidths(undefined)).toBeNull();
  });
});

describe("widthsToDashes", () => {
  it("writes one dash per 5%, at least one a column", () => {
    expect(widthsToDashes([25, 75])).toEqual([5, 15]);
    expect(widthsToDashes([1, 99])).toEqual([1, 19]);
  });
  it("rounds to a total of 20 dashes", () => {
    expect(widthsToDashes([100, 120, 160])).toEqual([5, 6, 9]);
    expect(widthsToDashes([1, 1, 1, 1])).toEqual([5, 5, 5, 5]);
  });
});

describe("tableWidthsPlugin", () => {
  it("draws uneven dashes as a colgroup", () => {
    const html = renderMarkdown("| Part | Notes |\n| ----- | --------------- |\n| Servo | Two |");
    expect(html).toContain('<table class="has-widths">');
    expect(html).toContain('<colgroup><col style="width: 25%"><col style="width: 75%"></colgroup>');
  });
  it("leaves a table with even dashes alone", () => {
    const html = renderMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(html).not.toContain("colgroup");
    expect(html).not.toContain("has-widths");
  });
  it("works for a table in a quote", () => {
    const html = renderMarkdown("> | a | b |\n> | -- | ------ |\n> | 1 | 2 |");
    expect(html).toContain('<col style="width: 25%">');
  });
});
