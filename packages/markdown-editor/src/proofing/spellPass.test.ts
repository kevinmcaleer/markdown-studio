// @vitest-environment happy-dom
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { markdownExtensions } from "../Editor";
import { tableField } from "../tableWidget";
import { personalDictionary } from "./dictionary";
import { proofing } from "./proofing";
import { changeAll, checkSpelling, checking, findWordRange, nextFrom, spellCount } from "./spellPass";
import type { SpellChecker } from "./speller";

const WRONG: Record<string, string[]> = { teh: ["the", "ten"], wrold: ["world"], zork: [] };

const fake: SpellChecker = {
  known: (w) => !(w.toLowerCase() in WRONG),
  check: async () => {},
  suggest: async (w) => WRONG[w.toLowerCase()] ?? [],
};

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
  document.body.innerHTML = "";
  personalDictionary.clear();
});

function editor(doc: string, cursor = 0, more: Extension = []) {
  const parent = document.body.appendChild(document.createElement("div"));
  view = new EditorView({
    parent,
    state: EditorState.create({ doc, selection: { anchor: cursor }, extensions: [markdownExtensions(), proofing({ speller: () => fake }), more] }),
  });
  return view;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const dialog = () => document.querySelector<HTMLElement>(".spell-pass");
const press = (label: string) => [...dialog()!.querySelectorAll("button")].find((b) => b.textContent === label)!.click();
const selected = (v: EditorView) => v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to);

describe("finding the next word", () => {
  const w = (word: string, from: number) => ({ word, from, to: from + word.length });

  it("goes on from the cursor and wraps round to the top", () => {
    const wrong = [w("teh", 0), w("wrold", 10)];
    expect(nextFrom(wrong, 0)?.word).toBe("teh");
    expect(nextFrom(wrong, 5)?.word).toBe("wrold");
    expect(nextFrom(wrong, 20)?.word).toBe("teh");
    expect(nextFrom([], 0)).toBeNull();
  });

  it("changes every place a word is misspelt that way", () => {
    expect(changeAll([w("teh", 0), w("wrold", 4), w("teh", 10)], "teh", "the")).toEqual([
      { from: 0, to: 3, insert: "the" },
      { from: 10, to: 13, insert: "the" },
    ]);
  });
});

describe("check spelling", () => {
  it("selects each misspelt word in turn and changes it", async () => {
    const v = editor("Hello teh wrold, and `teh` in code.");
    expect(checkSpelling(v)).toBe(true);
    await tick();
    expect(selected(v)).toBe("teh");
    expect(dialog()!.querySelector(".spell-pass-word")!.textContent).toBe("teh");
    expect([...dialog()!.querySelectorAll(".spell-pass-option")].map((b) => b.textContent)).toEqual(["the", "ten"]);
    expect(dialog()!.querySelector<HTMLInputElement>(".spell-pass-input")!.value).toBe("the");

    press("Change");
    await tick();
    expect(v.state.doc.toString()).toBe("Hello the wrold, and `teh` in code.");
    expect(selected(v)).toBe("wrold");

    press("Change");
    await tick();
    expect(v.state.doc.toString()).toBe("Hello the world, and `teh` in code.");
    expect(dialog()!.textContent).toContain("complete");
  });

  it("starts at the cursor and keeps capitals", async () => {
    const v = editor("teh one. Teh two.", 5);
    checkSpelling(v);
    await tick();
    expect(selected(v)).toBe("Teh");
    expect(dialog()!.querySelector<HTMLInputElement>(".spell-pass-input")!.value).toBe("The");
  });

  it("changes all, ignores once, ignores all and adds to the dictionary", async () => {
    const v = editor("teh a teh b wrold c zork d wrold");
    checkSpelling(v);
    await tick();
    press("Change all");
    await tick();
    expect(v.state.doc.toString()).toBe("the a the b wrold c zork d wrold");
    expect(selected(v)).toBe("wrold");

    press("Ignore");
    await tick();
    expect(selected(v)).toBe("zork");
    expect(dialog()!.textContent).toContain("No suggestions");

    press("Add to dictionary");
    await tick();
    expect(personalDictionary.has("zork")).toBe(true);
    // The second "wrold"; the first was ignored once.
    expect(v.state.selection.main.from).toBe(27);

    press("Ignore all");
    await tick();
    expect(dialog()!.textContent).toContain("complete");
  });

  it("uses what you type in place of a suggestion", async () => {
    const v = editor("zork here");
    checkSpelling(v);
    await tick();
    const input = dialog()!.querySelector<HTMLInputElement>(".spell-pass-input")!;
    input.value = "fork";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await tick();
    expect(v.state.doc.toString()).toBe("fork here");
  });

  it("closes with Escape", async () => {
    const v = editor("teh");
    checkSpelling(v);
    await tick();
    dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dialog()).toBeNull();
  });
});

describe("marking the word being checked", () => {
  const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

  it("marks the word in the note, moves on with the check, and clears when it closes", async () => {
    const v = editor("Hello teh and zork.");
    checkSpelling(v);
    await tick();
    expect(v.state.field(checking)).toEqual({ from: 6, to: 9 });
    expect(v.contentDOM.querySelector(".cm-spell-pass-current")?.textContent).toBe("teh");
    press("Ignore");
    await tick();
    expect(v.contentDOM.querySelector(".cm-spell-pass-current")?.textContent).toBe("zork");
    dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(v.state.field(checking)).toBeNull();
    expect(v.contentDOM.querySelector(".cm-spell-pass-current")).toBeNull();
  });

  it("marks a word in a table in the drawn table's cell", async () => {
    const v = editor("Intro.\n\n| Part | Link |\n| --- | --- |\n| teh one | [fine teh](https://example.com/teh) |\n", 0, tableField);
    checkSpelling(v);
    await tick();
    await frame();
    expect(v.contentDOM.querySelector(".cm-spell-pass-current")).toBeNull();
    expect(v.contentDOM.querySelector(".cm-spell-pass-cell")?.textContent).toBe("teh one");
    press("Ignore");
    await tick();
    await frame();
    // The second "teh" in the note (the one in the URL isn't prose): the link's.
    expect(v.contentDOM.querySelector(".cm-spell-pass-cell")?.textContent).toBe("fine teh");
    expect(v.contentDOM.querySelectorAll(".cm-spell-pass-cell")).toHaveLength(1);
    dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(v.contentDOM.querySelector(".cm-spell-pass-cell")).toBeNull();
  });

  it("finds the nth time a word stands on its own in drawn text", () => {
    const root = document.body.appendChild(document.createElement("div"));
    root.innerHTML = "<p>tehx teh</p><p><b>te</b>h and teh</p><p>teh</p>";
    const at = (n: number) => {
      const r = findWordRange(root, "teh", n)!;
      return [r.startContainer.textContent, r.startOffset, r.endContainer.textContent, r.endOffset];
    };
    expect(at(0)).toEqual(["tehx teh", 5, "tehx teh", 8]);
    expect(at(1)).toEqual(["te", 0, "h and teh", 1]);
    expect(at(2)).toEqual(["h and teh", 6, "h and teh", 9]);
    expect(at(9)).toEqual(["teh", 0, "teh", 3]);
    expect(findWordRange(root, "nope", 0)).toBeNull();
  });
});

describe("the status count", () => {
  it("counts the whole note's misspelt words and follows the dictionary", async () => {
    // ("wrold" was ignored for the session above.)
    const v = editor("teh zork and teh end");
    await new Promise((r) => setTimeout(r, 20));
    expect(v.state.field(spellCount)).toBe(3);
    personalDictionary.add("zork");
    await new Promise((r) => setTimeout(r, 20));
    expect(v.state.field(spellCount)).toBe(2);
  });
});
