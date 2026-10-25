import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { findSpot, makeSpot } from "./fileState";

const doc = (s: string) => Text.of(s.split("\n"));

/** Two people's copies of a note, kept in sync. */
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

describe("spots", () => {
  it("follow their text through someone else's edits", () => {
    const { a, b, sync } = pair("# Plan\nShip it\n## Later\nMaybe");
    const at = a.toString().indexOf("## Later");
    const spot = makeSpot(doc(a.toString()), at, a);
    expect(spot.quote).toBe("## Later");
    b.insert(0, "Intro line\n\n");
    sync();
    const now = findSpot(doc(a.toString()), spot, a);
    expect(a.toString().slice(now, now + 8)).toBe("## Later");
  });

  it("fall back to the line's text when there's no shared text", () => {
    const spot = makeSpot(doc("one\ntwo\nthree"), 8);
    expect(spot).toEqual({ offset: 8, quote: "three" });
    const edited = doc("zero\none\ntwo\nthree");
    expect(findSpot(edited, spot)).toBe(edited.line(4).from);
  });

  it("pick the copy of the line nearest where it was", () => {
    const spot = { offset: 22, quote: "same" };
    const text = doc("same\nx\nx\nx\nx\nx\nx\nsame\nx");
    expect(findSpot(text, spot)).toBe(text.line(8).from);
  });

  it("fall back to the offset, kept inside the text", () => {
    expect(findSpot(doc("short"), { offset: 99, quote: "gone" })).toBe(5);
    expect(findSpot(doc("short"), { offset: 2 })).toBe(2);
  });

  it("ignore a Yjs position from a different note", () => {
    const { a } = pair("first note");
    const other = pair("another note, longer").a;
    const spot = makeSpot(doc(other.toString()), 8, other, false);
    expect(findSpot(doc(a.toString()), spot, a)).toBe(8);
  });
});
