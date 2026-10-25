import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { lineRange, pinsAt } from "./pin";

function at(doc: string, from: number, to = from) {
  return pinsAt(EditorState.create({ doc, selection: EditorSelection.single(from, to) }));
}

describe("pinsAt", () => {
  it("pins to the selection when there is one", () => {
    expect(at("Ship it soon", 5, 12)).toEqual([{ from: 5, to: 12, text: "it soon", kind: "selection" }]);
  });

  it("offers the word at the cursor, then its line", () => {
    const doc = "# Plan\n- Ship it soon";
    expect(at(doc, 10)).toEqual([
      { from: 9, to: 13, text: "Ship", kind: "word" },
      { from: 9, to: 21, text: "Ship it soon", kind: "line" },
    ]);
  });

  it("pins to the line when the cursor isn't in a word", () => {
    expect(at("Ship it — soon", 8)).toEqual([{ from: 0, to: 14, text: "Ship it — soon", kind: "line" }]);
  });

  it("offers just the word when it is the whole line", () => {
    expect(at("## Plan", 4)).toEqual([{ from: 3, to: 7, text: "Plan", kind: "word" }]);
  });

  it("pins to nothing on a blank line", () => {
    expect(at("one\n\ntwo", 4)).toEqual([]);
  });
});

describe("lineRange", () => {
  it("drops list, task, heading and quote markers", () => {
    expect(lineRange({ from: 10, text: "  - [x] Done it  " })).toEqual({ from: 18, to: 25, text: "Done it" });
    expect(lineRange({ from: 0, text: "> ## Quoted" })).toEqual({ from: 5, to: 11, text: "Quoted" });
    expect(lineRange({ from: 0, text: "1. First" })).toEqual({ from: 3, to: 8, text: "First" });
  });

  it("keeps a line that only looks like a marker", () => {
    expect(lineRange({ from: 0, text: "#hashtag" })).toEqual({ from: 0, to: 8, text: "#hashtag" });
    expect(lineRange({ from: 0, text: "-   " })).toBeNull();
  });
});
