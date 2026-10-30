// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { tableField } from "./tableWidget";

function tableView(doc: string): EditorView {
  return new EditorView({
    state: EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage }), tableField] }),
    parent: document.body,
  });
}

function tableDom(doc: string): HTMLElement {
  return tableView(doc).dom.querySelector<HTMLElement>(".cm-md-table")!;
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

  it("aligns a column from its menu, and draws the cells that way", () => {
    const view = tableView("| Part | Qty |\n|---|---|\n| Servo | 4 |\n");
    const table = view.dom.querySelector<HTMLElement>(".cm-md-table")!;
    table.querySelector<HTMLElement>(".cm-md-table-colhandle")!.click();
    const items = Array.from(table.querySelectorAll<HTMLElement>(".cm-md-table-menu [role=menuitemradio]"));
    expect(items.map((item) => item.getAttribute("aria-label"))).toEqual(["Align left", "Align center", "Align right"]);
    expect(items.every((item) => item.getAttribute("aria-checked") === "false")).toBe(true);
    items[1].click();
    expect(view.state.doc.toString()).toBe("| Part | Qty |\n| :---: | --- |\n| Servo | 4 |\n");
    const drawn = view.dom.querySelector<HTMLElement>(".cm-md-table")!;
    expect(drawn.querySelector<HTMLElement>("td")!.style.textAlign).toBe("center");
    drawn.querySelector<HTMLElement>(".cm-md-table-colhandle")!.click();
    const center = drawn.querySelector<HTMLElement>(".cm-md-table-menu [aria-checked=true]")!;
    expect(center.getAttribute("aria-label")).toBe("Align center");
    center.click();
    expect(view.state.doc.toString()).toBe("| Part | Qty |\n| --- | --- |\n| Servo | 4 |\n");
  });
});
