import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { selectedLines } from "./livePreview";
import { mergeRows } from "./textSelection";

describe("mergeRows", () => {
  it("joins boxes on one visual line into one band", () => {
    const rows = mergeRows([
      { left: 10, top: 0, right: 40, bottom: 20 },
      { left: 40, top: 2, right: 60, bottom: 18 },
      { left: 10, top: 24, right: 30, bottom: 44 },
    ]);
    expect(rows).toEqual([
      { left: 10, top: 0, right: 60, bottom: 20 },
      { left: 10, top: 24, right: 30, bottom: 44 },
    ]);
  });

  it("drops empty boxes", () => {
    expect(mergeRows([{ left: 5, top: 0, right: 5, bottom: 20 }])).toEqual([]);
  });
});

describe("selectedLines", () => {
  const doc = "Text\n\n---\n\nMore";
  const lines = (anchor: number, head: number) =>
    [...selectedLines(EditorState.create({ doc, selection: EditorSelection.single(anchor, head) }))].sort((a, b) => a - b);

  it("leaves out a line the selection only ends at the start of", () => {
    // From the end of "Text" to the start of the `---` on line 3.
    expect(lines(4, 6)).toEqual([2]);
  });

  it("leaves out a line the selection only starts at the end of", () => {
    // From the end of `---` to the start of line 4.
    expect(lines(9, 10)).toEqual([]);
    expect(lines(9, 11)).toEqual([4]);
  });

  it("keeps lines whose text is picked, and the cursor's line", () => {
    expect(lines(2, 9)).toEqual([1, 2, 3]);
    expect(lines(6, 6)).toEqual([3]);
  });
});
