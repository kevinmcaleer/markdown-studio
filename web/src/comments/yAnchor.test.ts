import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { place } from "./anchor";
import { createYAnchor, resolveYAnchor } from "./yAnchor";

/** Two people's copies of a document, kept in sync. */
function pair(initial: string) {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.getText("content").insert(0, initial);
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const sync = () => {
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
  };
  return { a: a.getText("content"), b: b.getText("content"), sync };
}

describe("Yjs anchors", () => {
  it("follow the passage through someone else's concurrent edits", () => {
    const { a, b, sync } = pair("Ship it soon");
    const anchor = createYAnchor(a, 5, 7); // "it"
    b.insert(0, "Plan: "); // made at the same time, on another device
    b.insert(b.length, "!");
    sync();
    expect(resolveYAnchor(a, anchor, true)).toEqual({ from: 11, to: 13 });
    expect(resolveYAnchor(b, anchor, true)).toEqual({ from: 11, to: 13 });
    expect(b.toString().slice(11, 13)).toBe("it");
  });

  it("don't grow when someone types right before or after the passage", () => {
    const { a } = pair("Ship it soon");
    const anchor = createYAnchor(a, 5, 7);
    a.insert(7, "XX");
    a.insert(5, "YY");
    expect(resolveYAnchor(a, anchor, true)).toEqual({ from: 7, to: 9 });
  });

  it("stretch over text typed inside the passage", () => {
    const { a } = pair("Ship it soon");
    const anchor = createYAnchor(a, 0, 7);
    a.insert(4, " fast");
    const placed = place(a.toString(), { anchor_from: 0, anchor_to: 7, quote: "Ship it", anchor }, (x, q) => resolveYAnchor(a, x, q));
    expect(placed).toEqual({ range: { from: 0, to: 12 }, status: "edited" });
  });

  it("report the passage as deleted rather than pinning it somewhere else", () => {
    const { a, b, sync } = pair("the cat and the dog");
    const anchor = createYAnchor(a, 12, 15); // the second "the"
    b.delete(12, 4);
    sync();
    expect(resolveYAnchor(a, anchor, true)).toBe("deleted");
    const placed = place(a.toString(), { anchor_from: 12, anchor_to: 15, quote: "the", anchor }, (x, q) => resolveYAnchor(a, x, q));
    expect(placed).toEqual({ range: null, status: "removed" });
  });

  it("are ignored when they can't be read, so the quote is used instead", () => {
    const { a } = pair("Ship it soon");
    expect(resolveYAnchor(a, "not json", true)).toBeNull();
    expect(resolveYAnchor(a, JSON.stringify({ other: 1 }), true)).toBeNull();
    const other = new Y.Doc().getText("content");
    other.insert(0, "Ship it soon");
    const foreign = createYAnchor(other, 5, 7);
    expect(resolveYAnchor(a, foreign, true)).toBeNull();
  });
});
