import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { calloutChoices, calloutTypeAt } from "./calloutPicker";
import { calloutKinds } from "./callouts";

const at = (doc: string, pos: number) => EditorState.create({ doc, selection: EditorSelection.cursor(pos) });

describe("calloutTypeAt", () => {
  it("finds the type name the caret is on", () => {
    expect(calloutTypeAt(at("> [!tip] Rabbit holes", 5))).toEqual({ from: 4, to: 7, name: "tip" });
    expect(calloutTypeAt(at("> [!tip] Rabbit holes", 4))).toMatchObject({ name: "tip" });
    expect(calloutTypeAt(at("> [!tip] Rabbit holes", 7))).toMatchObject({ name: "tip" });
  });

  it("works for an empty name, so `> [!]` offers every type", () => {
    expect(calloutTypeAt(at("> [!]", 4))).toEqual({ from: 4, to: 4, name: "" });
  });

  it("is null off the name, in a quote's later lines, or in plain text", () => {
    expect(calloutTypeAt(at("> [!tip] Rabbit holes", 10))).toBeNull();
    expect(calloutTypeAt(at("> [!tip] Rabbit holes", 1))).toBeNull();
    expect(calloutTypeAt(at("> quote\n> [!tip]", 13))).toBeNull();
    expect(calloutTypeAt(at("see [!tip] here", 7))).toBeNull();
  });
});

describe("calloutChoices", () => {
  it("offers every type for a known name or none", () => {
    expect(calloutChoices("")).toBe(calloutKinds);
    expect(calloutChoices("tip")).toBe(calloutKinds);
    expect(calloutChoices("faq")).toBe(calloutKinds);
  });

  it("narrows to the types a part-typed name starts, aliases included", () => {
    expect(calloutChoices("wa").map((k) => k.type)).toEqual(["warning"]);
    expect(calloutChoices("in").map((k) => k.type)).toEqual(["info"]);
    expect(calloutChoices("e").map((k) => k.type)).toEqual(["danger", "example"]);
  });

  it("offers everything for a name nothing starts", () => {
    expect(calloutChoices("zzz")).toBe(calloutKinds);
  });
});
