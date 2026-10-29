// @vitest-environment happy-dom
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { markdownExtensions } from "./Editor";
import { draggedImages, snapGap } from "./imageDrop";

function state(doc: string) {
  const s = EditorState.create({ doc, extensions: markdownExtensions() });
  ensureSyntaxTree(s, s.doc.length, 5000);
  return s;
}

describe("snapGap", () => {
  it("leaves a gap between paragraph lines alone", () => {
    const s = state("One\n\nTwo\n");
    expect(snapGap(s, { pos: 5, side: "before" })).toEqual({ pos: 5, side: "before" });
  });

  it("moves a gap inside a code fence to its nearer end", () => {
    const doc = "Intro\n\n```js\na()\nb()\nc()\n```\n\nAfter";
    const s = state(doc);
    const fenceStart = doc.indexOf("```js");
    const fenceEnd = doc.lastIndexOf("```") + 3;
    expect(snapGap(s, { pos: doc.indexOf("a()"), side: "before" })).toEqual({ pos: fenceStart, side: "before" });
    expect(snapGap(s, { pos: doc.indexOf("c()") + 3, side: "after" })).toEqual({ pos: fenceEnd, side: "after" });
  });

  it("keeps a table whole", () => {
    const doc = "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n\nText";
    const s = state(doc);
    expect(snapGap(s, { pos: doc.indexOf("| 3"), side: "before" }).pos).toBe(doc.indexOf("| 3 | 4 |") + 9);
    expect(snapGap(s, { pos: doc.indexOf("| ---"), side: "before" })).toEqual({ pos: 0, side: "before" });
  });
});

function transfer(types: string[], items: { kind: string; type: string }[]) {
  return { types, items } as unknown as DataTransfer;
}

describe("draggedImages", () => {
  it("counts dragged images", () => {
    expect(draggedImages(transfer(["Files"], [{ kind: "file", type: "image/png" }]))).toBe(1);
    expect(draggedImages(transfer(["Files"], [{ kind: "file", type: "image/png" }, { kind: "file", type: "image/jpeg" }]))).toBe(2);
  });

  it("ignores text and other files", () => {
    expect(draggedImages(transfer(["text/plain"], [{ kind: "string", type: "text/plain" }]))).toBe(0);
    expect(draggedImages(transfer(["Files"], [{ kind: "file", type: "model/stl" }]))).toBe(0);
  });

  it("counts files of unknown type as images", () => {
    expect(draggedImages(transfer(["Files"], [{ kind: "file", type: "" }]))).toBe(1);
    expect(draggedImages(transfer(["Files"], []))).toBe(1);
  });
});
