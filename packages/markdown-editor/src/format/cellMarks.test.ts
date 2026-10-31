import { describe, expect, it } from "vitest";
import { cellMarkActive, clearCellFormatting, toggleCellMark } from "./cellMarks";

const pick = (text: string, word: string) => [text.indexOf(word), text.indexOf(word) + word.length] as const;

describe("cell marks", () => {
  it("wraps the selected words in a mark and keeps them selected", () => {
    const text = "18650 battery cell";
    const [from, to] = pick(text, "battery");
    expect(toggleCellMark(text, from, to, "bold")).toEqual({ text: "18650 **battery** cell", from: 8, to: 15 });
    expect(toggleCellMark(text, from, to, "highlight")!.text).toBe("18650 ==battery== cell");
    expect(toggleCellMark(text, from, to, "code")!.text).toBe("18650 `battery` cell");
  });

  it("leaves the spaces at the ends of a selection outside the mark", () => {
    expect(toggleCellMark("a word b", 1, 7, "italic")!.text).toBe("a *word* b");
  });

  it("takes a mark off when the words already have it", () => {
    const text = "18650 **battery** cell";
    const [from, to] = pick(text, "battery");
    expect(cellMarkActive(text, from, to, "bold")).toBe(true);
    expect(cellMarkActive(text, from, to, "italic")).toBe(false);
    expect(toggleCellMark(text, from, to, "bold")).toEqual({ text: "18650 battery cell", from: 6, to: 13 });
  });

  it("takes a mark off when its markers were selected too", () => {
    const text = "a ~~gone~~ b";
    const [from, to] = pick(text, "~~gone~~");
    expect(cellMarkActive(text, from, to, "strike")).toBe(true);
    expect(toggleCellMark(text, from, to, "strike")!.text).toBe("a gone b");
  });

  it("tells italic from bold in a run of stars", () => {
    const text = "***both***";
    const [from, to] = pick(text, "both");
    expect(cellMarkActive(text, from, to, "italic")).toBe(true);
    expect(cellMarkActive(text, from, to, "bold")).toBe(true);
    expect(toggleCellMark(text, from, to, "bold")!.text).toBe("*both*");
    expect(toggleCellMark(text, from, to, "italic")!.text).toBe("**both**");
  });

  it("wraps each line of a cell on its own", () => {
    expect(toggleCellMark("one\ntwo", 0, 7, "bold")!.text).toBe("**one**\n**two**");
  });

  it("clears marks and links but keeps the words", () => {
    const text = "Buy **[cells](https://x.com/a)** now";
    const [from, to] = pick(text, "cells");
    expect(clearCellFormatting(text, from, to)).toEqual({ text: "Buy cells now", from: 4, to: 9 });
    expect(clearCellFormatting("plain", 0, 5)).toBeNull();
  });
});
