// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { tableField } from "./tableWidget";

function tableDom(doc: string): HTMLElement {
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage }), tableField] }),
    parent: document.body,
  });
  return view.dom.querySelector<HTMLElement>(".cm-md-table")!;
}

describe("table widget", () => {
  it("draws a table of images as a grid of cards", () => {
    const table = tableDom("| | |\n|---|---|\n| ![a](/a.jpg) | |\n");
    expect(table.classList.contains("image-grid")).toBe(true);
    expect(table.classList.contains("image-grid-nohead")).toBe(true);
    expect(Array.from(table.querySelectorAll("td"), (td) => td.classList.contains("image-card"))).toEqual([true, false]);
  });

  it("leaves a table of text as a table", () => {
    const table = tableDom("| Part | Qty |\n|---|---|\n| Servo | 4 |\n");
    expect(table.classList.contains("image-grid")).toBe(false);
    expect(table.querySelector(".image-card")).toBeNull();
  });
});
