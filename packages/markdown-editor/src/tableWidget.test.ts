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

  it("moves a row up from its menu, onto the header", () => {
    const view = tableView("| Part | Qty |\n|---|---|\n| Servo | 4 |\n| Wheel | 2 |\n");
    const table = view.dom.querySelector<HTMLElement>(".cm-md-table")!;
    table.querySelector<HTMLElement>('td[data-row="2"]')!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    table.querySelector<HTMLElement>(".cm-md-table-rowhandle")!.click();
    const item = (label: string) =>
      Array.from(view.dom.querySelectorAll<HTMLButtonElement>(".cm-md-table-menu [role=menuitem]")).find((b) => b.textContent === label)!;
    expect(item("Move row down").disabled).toBe(true);
    item("Move row up").click();
    expect(view.state.doc.toString()).toBe("| Part | Qty |\n| --- | --- |\n| Wheel | 2 |\n| Servo | 4 |\n");
    view.dom.querySelector<HTMLElement>(".cm-md-table-rowhandle")!.click();
    item("Move row up").click();
    expect(view.state.doc.toString()).toBe("| Wheel | 2 |\n| --- | --- |\n| Part | Qty |\n| Servo | 4 |\n");
  });

  it("moves a column right from its menu, taking its alignment", () => {
    const view = tableView("| Part | Qty |\n|:---:|---|\n| Servo | 4 |\n");
    view.dom.querySelector<HTMLElement>(".cm-md-table-colhandle")!.click();
    const items = Array.from(view.dom.querySelectorAll<HTMLButtonElement>(".cm-md-table-menu [role=menuitem]"));
    expect(items.find((b) => b.textContent === "Move column left")!.disabled).toBe(true);
    items.find((b) => b.textContent === "Move column right")!.click();
    expect(view.state.doc.toString()).toBe("| Qty | Part |\n| --- | :---: |\n| 4 | Servo |\n");
  });

  it("moves a row by dragging its handle, without opening the menu", () => {
    const view = tableView("| Part | Qty |\n|---|---|\n| Servo | 4 |\n| Wheel | 2 |\n");
    const table = view.dom.querySelector<HTMLElement>(".cm-md-table")!;
    // Lay the rows out 20px apart (happy-dom doesn't).
    Array.from(table.querySelectorAll("tr")).forEach((tr, i) => {
      tr.getBoundingClientRect = () => ({ top: i * 20, bottom: i * 20 + 20, left: 0, right: 100, width: 100, height: 20, x: 0, y: i * 20 }) as DOMRect;
    });
    table.querySelector<HTMLElement>('td[data-row="1"]')!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    const handle = table.querySelector<HTMLElement>(".cm-md-table-rowhandle")!;
    handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 0, clientY: 30 }));
    document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 0, clientY: 58 }));
    expect(table.querySelector(".cm-md-table-dropline")).not.toBeNull();
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 0, clientY: 58 }));
    handle.click();
    expect(view.state.doc.toString()).toBe("| Part | Qty |\n| --- | --- |\n| Wheel | 2 |\n| Servo | 4 |\n");
    expect(view.dom.querySelector(".cm-md-table-menu")).toBeNull();
    expect(view.dom.querySelector(".cm-md-table-dropline")).toBeNull();
  });

  it("draws a table in a callout, in the callout's box", () => {
    const doc = "> [!info] Ducks\n> Two robots\n>\n> | ## A | ## B |\n> | --- | --- |\n> | ![a](/a.jpg) | ![b](/b.jpg) |\n\nAfter";
    const table = tableDom(doc);
    expect(table.classList.contains("cm-md-table-callout")).toBe(true);
    expect(table.classList.contains("callout-info")).toBe(true);
    expect(table.classList.contains("cm-md-table-quote-last")).toBe(true);
    expect(table.classList.contains("image-grid")).toBe(true);
    expect(table.querySelector("th h2.cell-heading")?.textContent).toBe("A");
  });

  it("draws a table in a plain quote, and in a nested one", () => {
    expect(tableDom("> | a | b |\n> |---|---|\n> | 1 | 2 |\n> more\n").classList.contains("cm-md-table-quoted")).toBe(true);
    const nested = tableDom("> > | a |\n> > |---|\n> > | 1 |\n");
    expect(nested.querySelector("td")?.textContent).toBe("1");
  });

  it("leaves a table in a list as text", () => {
    expect(tableDom("- item\n\n  | a |\n  |---|\n  | 1 |\n")).toBeNull();
  });

  it("keeps a quoted table's markers when it changes", () => {
    const view = tableView("> [!note]\n> | Part | Qty |\n> |---|---|\n> | Servo | 4 |\n");
    const table = view.dom.querySelector<HTMLElement>(".cm-md-table")!;
    table.querySelector<HTMLElement>(".cm-md-table-addrow")!.click();
    expect(view.state.doc.toString()).toBe("> [!note]\n> | Part | Qty |\n> | --- | --- |\n> | Servo | 4 |\n> |  |  |\n");
    const cell = view.dom.querySelector<HTMLElement>('.cm-md-table td[data-row="1"][data-col="1"]')!;
    cell.textContent = "6";
    cell.dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(view.state.doc.line(4).text).toBe("> | Servo | 6 |");
  });
});
