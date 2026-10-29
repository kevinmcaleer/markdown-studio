// @vitest-environment happy-dom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { insertDictation, setInterim, speechEditor } from "./speechEditor";

let view: EditorView | null = null;
afterEach(() => view?.destroy());

function editor(doc: string, extensions = speechEditor()) {
  view = new EditorView({ state: EditorState.create({ doc, selection: { anchor: doc.length }, extensions }), parent: document.body });
  return view;
}

describe("dictating into the editor", () => {
  it("inserts at the cursor as typed input, and clears the ghost", () => {
    let input = false;
    const v = editor("Hello", [speechEditor(), EditorView.updateListener.of((u) => (input ||= u.transactions.some((tr) => tr.isUserEvent("input"))))]);
    v.dispatch({ effects: setInterim.of("world") });
    expect(v.dom.querySelector(".cm-dictation-ghost")?.textContent).toBe(" world");
    insertDictation(v, "world full stop");
    expect(v.state.doc.toString()).toBe("Hello world.");
    expect(v.state.selection.main.head).toBe(12);
    expect(input).toBe(true);
    expect(v.dom.querySelector(".cm-dictation-ghost")).toBeNull();
  });

  it("undo that removes the last phrase, even after other edits move it", () => {
    const v = editor("Start.");
    insertDictation(v, "one two");
    v.dispatch({ changes: { from: 0, insert: "> " } });
    insertDictation(v, "undo that");
    expect(v.state.doc.toString()).toBe("> Start.");
    // Nothing more to take back.
    insertDictation(v, "undo that");
    expect(v.state.doc.toString()).toBe("> Start.");
  });
});
