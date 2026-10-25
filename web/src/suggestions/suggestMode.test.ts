import { EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { draftField, foldEdit, setSuggesting, suggestMode, type Draft, type SuggestHandlers } from "./suggestMode";

const handlers = {
  current: { ownColor: () => "#000", onDraft: () => {}, onMarkClick: () => {}, card: () => null } as SuggestHandlers,
};

/** An editor state in Suggesting mode, with the cursor at `cursor`. */
function suggesting(doc: string, cursor: number) {
  let state = EditorState.create({ doc, selection: { anchor: cursor }, extensions: suggestMode(handlers) });
  state = state.update({ effects: setSuggesting.of(true) }).state;
  const run = (spec: TransactionSpec) => (state = state.update(spec).state);
  return {
    run,
    type: (text: string) => {
      const { from, to } = state.selection.main;
      run({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: "input.type" });
    },
    backspace: () => {
      const { from, to } = state.selection.main;
      run(from === to ? { changes: { from: from - 1, to: from }, userEvent: "delete.backward" } : { changes: { from, to }, userEvent: "delete.selection" });
    },
    forwardDelete: () => {
      const { head } = state.selection.main;
      run({ changes: { from: head, to: head + 1 }, userEvent: "delete.forward" });
    },
    get state() {
      return state;
    },
    get draft(): Draft | null {
      return state.field(draftField);
    },
  };
}

describe("folding edits into a draft", () => {
  const draft = { key: -1, from: 5, to: 7, insert: "ab" };

  it("adds typing right after the draft's new text", () => {
    expect(foldEdit(draft, { from: 7, to: 7, insert: "c" }, true)).toEqual({ draft: { ...draft, insert: "abc" }, cursor: 7 });
  });

  it("takes Backspace from the new text first, then strikes out more before it", () => {
    expect(foldEdit(draft, { from: 6, to: 7, insert: "" }, true).draft).toEqual({ ...draft, insert: "a" });
    const struck = { ...draft, insert: "" };
    expect(foldEdit(struck, { from: 6, to: 7, insert: "" }, true).draft).toEqual({ ...struck, from: 4 });
  });

  it("strikes out the text after it on Delete", () => {
    expect(foldEdit(draft, { from: 7, to: 8, insert: "" }, true)).toEqual({ draft: { ...draft, to: 8 }, cursor: 8 });
  });

  it("starts a new draft anywhere else", () => {
    const { draft: next, cursor } = foldEdit(draft, { from: 0, to: 2, insert: "X" }, false);
    expect(next).toMatchObject({ from: 0, to: 2, insert: "X" });
    expect(next!.key).not.toBe(draft.key);
    expect(cursor).toBe(2);
  });

  it("is null once it no longer changes anything", () => {
    const typed = { key: 1, from: 3, to: 3, insert: "a" };
    expect(foldEdit(typed, { from: 2, to: 3, insert: "" }, true).draft).toBeNull();
  });
});

describe("Suggesting mode in the editor", () => {
  it("leaves the document alone while typing", () => {
    const ed = suggesting("Ship it soon", 12);
    ed.type("!");
    ed.type("!");
    expect(ed.state.doc.toString()).toBe("Ship it soon");
    expect(ed.draft).toMatchObject({ from: 12, to: 12, insert: "!!" });
    expect(ed.state.selection.main.head).toBe(12);
  });

  it("turns a replaced selection into a replacement", () => {
    const ed = suggesting("Ship it soon", 8);
    ed.run({ selection: { anchor: 8, head: 12 } });
    ed.type("t");
    ed.type("oday");
    expect(ed.state.doc.toString()).toBe("Ship it soon");
    expect(ed.draft).toMatchObject({ from: 8, to: 12, insert: "today" });
  });

  it("turns Backspace into a deletion that grows to the left", () => {
    const ed = suggesting("Ship it soon", 7);
    ed.backspace();
    ed.backspace();
    expect(ed.draft).toMatchObject({ from: 5, to: 7, insert: "" });
    expect(ed.state.selection.main.head).toBe(7);
    ed.forwardDelete();
    expect(ed.draft).toMatchObject({ from: 5, to: 8, insert: "" });
  });

  it("finishes the draft when the cursor moves away", () => {
    const ed = suggesting("Ship it soon", 4);
    ed.type("s");
    ed.run({ selection: { anchor: 0 } });
    expect(ed.draft).toBeNull();
  });

  it("lets other people's edits through and follows them", () => {
    const ed = suggesting("Ship it soon", 12);
    ed.type("!");
    ed.run({ changes: { from: 0, insert: "Plan: " }, annotations: Transaction.remote.of(true) });
    expect(ed.state.doc.toString()).toBe("Plan: Ship it soon");
    expect(ed.draft).toMatchObject({ from: 18, to: 18, insert: "!" });
  });

  it("edits normally once switched off", () => {
    const ed = suggesting("Ship it", 7);
    ed.type("!");
    ed.run({ effects: setSuggesting.of(false) });
    expect(ed.draft).toBeNull();
    ed.type("?");
    expect(ed.state.doc.toString()).toBe("Ship it?");
  });
});
