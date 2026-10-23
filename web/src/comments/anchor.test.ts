import { describe, expect, it } from "vitest";
import { inDocumentOrder, locate } from "./anchor";

describe("locate", () => {
  it("keeps the original offsets while the text is still there", () => {
    expect(locate("Ship it soon", { anchor_from: 0, anchor_to: 4, quote: "Ship" })).toEqual({ from: 0, to: 4 });
  });

  it("follows the text when something is inserted before it", () => {
    expect(locate("# Plan\nShip it soon", { anchor_from: 0, anchor_to: 4, quote: "Ship" })).toEqual({ from: 7, to: 11 });
  });

  it("picks the copy nearest the original position", () => {
    const doc = "cat ... cat ... cat";
    expect(locate(doc, { anchor_from: 9, anchor_to: 12, quote: "cat" })).toEqual({ from: 8, to: 11 });
  });

  it("returns null when the passage was deleted", () => {
    expect(locate("Something else", { anchor_from: 0, anchor_to: 4, quote: "Ship" })).toBeNull();
  });

  it("clamps a point comment to the document", () => {
    expect(locate("abc", { anchor_from: 10, anchor_to: 10, quote: "" })).toEqual({ from: 3, to: 3 });
  });
});

describe("inDocumentOrder", () => {
  it("sorts by current position and puts detached threads last", () => {
    const threads = [
      { id: 1, anchor_from: 0, anchor_to: 3, quote: "gone" },
      { id: 2, anchor_from: 0, anchor_to: 3, quote: "two" },
      { id: 3, anchor_from: 0, anchor_to: 3, quote: "one" },
    ];
    expect(inDocumentOrder("one two", threads).map((t) => t.thread.id)).toEqual([3, 2, 1]);
  });
});
