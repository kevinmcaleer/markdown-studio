import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { diagnostics, diagnosticsAt, diagnosticsOf, setDiagnostics, type Diagnostic } from "./diagnostics";

const hint = (from: number, to: number, source: Diagnostic["source"] = "lint"): Diagnostic => ({
  from,
  to,
  source,
  rule: "r",
  title: "T",
  message: "m",
  fixes: [{ label: "fix", from, to, insert: "x" }],
});

describe("diagnostics layer", () => {
  it("keeps each source's list apart", () => {
    let state = EditorState.create({ doc: "the the cat", extensions: [diagnostics(), diagnostics()] });
    state = state.update({ effects: [setDiagnostics.of({ source: "lint", items: [hint(0, 7)] }), setDiagnostics.of({ source: "spelling", items: [hint(8, 11, "spelling")] })] }).state;
    expect(diagnosticsAt(state, 9).map((d) => d.source)).toEqual(["spelling"]);
    state = state.update({ effects: setDiagnostics.of({ source: "spelling", items: [] }) }).state;
    expect(diagnosticsOf(state, "lint")).toHaveLength(1);
    expect(diagnosticsOf(state, "spelling")).toHaveLength(0);
  });

  it("maps marks and their fixes through edits, and drops ones typed over", () => {
    let state = EditorState.create({ doc: "abc def", extensions: diagnostics() });
    state = state.update({ effects: setDiagnostics.of({ source: "lint", items: [hint(4, 7), hint(0, 3)] }) }).state;
    state = state.update({ changes: { from: 0, insert: "XX" } }).state;
    const [first, second] = diagnosticsOf(state, "lint");
    expect([first.from, first.to]).toEqual([2, 5]);
    expect([second.from, second.to, second.fixes![0].from]).toEqual([6, 9, 6]);
    state = state.update({ changes: { from: 2, to: 5, insert: "" } }).state;
    expect(diagnosticsOf(state, "lint")).toHaveLength(1);
  });
});
