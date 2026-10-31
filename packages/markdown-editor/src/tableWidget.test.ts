// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { selectionToolbar } from "./format/selectionToolbar";
import { tableColumnActions, tableField, tableSteppers, type TableColumnAction, type TableStepper } from "./tableWidget";

function tableView(doc: string): EditorView {
  return new EditorView({
    state: EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage }), tableField] }),
    parent: document.body,
  });
}

function tableDom(doc: string): HTMLElement {
  return tableView(doc).dom.querySelector<HTMLElement>(".cm-md-table")!;
}

function stepperView(doc: string, stepper: TableStepper): EditorView {
  return new EditorView({
    state: EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage }), tableField, tableSteppers.of(stepper)] }),
    parent: document.body,
  });
}

const qty: TableStepper = ({ header, row }) => /^qty$/i.test(header) && !/total/i.test(row[0]);

function hoverCell(view: EditorView, row: number, col: number) {
  view.dom.querySelector<HTMLElement>(`.cm-md-table [data-row="${row}"][data-col="${col}"]`)!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
}

function stepButtons(view: EditorView) {
  const stepper = view.dom.querySelector<HTMLElement>(".cm-md-table-stepper")!;
  const [up, down] = Array.from(stepper.querySelectorAll<HTMLButtonElement>("button"));
  return { on: stepper.classList.contains("on"), up, down };
}

describe("table steppers", () => {
  const doc = "| Part | Qty | Notes |\n|---|---|---|\n| Servo | 2 | ears |\n| Pico |  | |\n| **Total** |  | |\n";

  it("steps a number cell up and down, writing a plain number", () => {
    const view = stepperView(doc, qty);
    hoverCell(view, 1, 1);
    expect(stepButtons(view).on).toBe(true);
    stepButtons(view).up.click();
    expect(view.state.doc.toString()).toContain("| Servo | 3 | ears |");
    stepButtons(view).down.click();
    stepButtons(view).down.click();
    expect(view.state.doc.toString()).toContain("| Servo | 1 | ears |");
  });

  it("stops at the minimum, and an empty cell steps up to 1", () => {
    const view = stepperView(doc, qty);
    hoverCell(view, 2, 1);
    expect(stepButtons(view).down.disabled).toBe(true);
    stepButtons(view).up.click();
    expect(view.state.doc.toString()).toMatch(/\| Pico \| 1 \|/);
    stepButtons(view).down.click();
    expect(view.state.doc.toString()).toMatch(/\| Pico \| 0 \|/);
    expect(stepButtons(view).down.disabled).toBe(true);
  });

  it("shows only where the host asks, and not on text or the header", () => {
    const view = stepperView(doc, qty);
    hoverCell(view, 1, 2);
    expect(stepButtons(view).on).toBe(false);
    hoverCell(view, 0, 1);
    expect(stepButtons(view).on).toBe(false);
    hoverCell(view, 3, 1);
    expect(stepButtons(view).on).toBe(false);
    const words = stepperView("| Part | Qty |\n|---|---|\n| Servo | a few |\n", qty);
    hoverCell(words, 1, 1);
    expect(stepButtons(words).on).toBe(false);
  });

  it("steps a focused cell with Alt+Up and Alt+Down, and honours the host's step", () => {
    const view = stepperView(doc, () => ({ step: 5, max: 10 }));
    const cell = view.dom.querySelector<HTMLElement>('.cm-md-table td[data-row="1"][data-col="1"]')!;
    const key = (key: string, altKey: boolean) => cell.dispatchEvent(new KeyboardEvent("keydown", { key, altKey, bubbles: true }));
    key("ArrowUp", true);
    expect(view.state.doc.toString()).toContain("| Servo | 7 | ears |");
    key("ArrowUp", true);
    expect(view.state.doc.toString()).toContain("| Servo | 7 | ears |");
    key("ArrowDown", true);
    expect(view.state.doc.toString()).toContain("| Servo | 2 | ears |");
  });

  it("has no stepper without a host stepper", () => {
    const view = tableView(doc);
    hoverCell(view, 1, 1);
    expect(stepButtons(view).on).toBe(false);
  });
});

describe("column actions", () => {
  const currency: TableColumnAction = ({ header }) =>
    /^price/i.test(header)
      ? {
          label: "Currency",
          options: ["£", "$"].map((symbol) => ({
            label: symbol,
            checked: header.includes(symbol),
            apply: (rows) => rows.map((row, r) => row.map((cell, c) => (c !== 1 ? cell : r === 0 ? `Price (${symbol})` : `${symbol}${Number(cell).toFixed(2)}`))),
          })),
        }
      : null;

  function actionView(doc: string): EditorView {
    return new EditorView({
      state: EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage }), tableField, tableColumnActions.of(currency)] }),
      parent: document.body,
    });
  }

  function openColumnMenu(view: EditorView, col: number) {
    view.dom.querySelector<HTMLElement>(`.cm-md-table [data-row="1"][data-col="${col}"]`)!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    view.dom.querySelector<HTMLElement>(".cm-md-table-colhandle")!.click();
    return Array.from(view.dom.querySelectorAll<HTMLButtonElement>(".cm-md-table-menu button"));
  }

  it("adds the host's entry to the column's menu, and only where it answers", () => {
    const doc = "| Part | Price (£) |\n|---|---|\n| Servo | 4 |\n";
    expect(openColumnMenu(actionView(doc), 0).some((b) => b.textContent === "Currency")).toBe(false);
    expect(openColumnMenu(actionView(doc), 1).some((b) => b.textContent === "Currency")).toBe(true);
  });

  it("lists the choices with the current one ticked, and applies one as an edit", () => {
    const view = actionView("| Part | Price (£) |\n|---|---|\n| Servo | 4 |\n");
    openColumnMenu(view, 1).find((b) => b.textContent === "Currency")!.click();
    const options = Array.from(view.dom.querySelectorAll<HTMLButtonElement>(".cm-md-table-menu [role=menuitemradio]"));
    expect(options.map((b) => [b.textContent, b.getAttribute("aria-checked")])).toEqual([["£", "true"], ["$", "false"]]);
    options[1].click();
    expect(view.state.doc.toString()).toBe("| Part | Price ($) |\n| --- | --- |\n| Servo | $4.00 |\n");
  });
});

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

  it("splits a table at a row from its menu, the row starting a second table", () => {
    const view = tableView("| Part | Qty |\n|---|:---:|\n| Servo | 4 |\n| Wheel | 2 |\n| Nut | 8 |\n");
    const table = view.dom.querySelector<HTMLElement>(".cm-md-table")!;
    const item = () =>
      Array.from(view.dom.querySelectorAll<HTMLButtonElement>(".cm-md-table-menu [role=menuitem]")).find((b) => b.textContent === "Split table here")!;
    table.querySelector<HTMLElement>('td[data-row="2"]')!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    table.querySelector<HTMLElement>(".cm-md-table-rowhandle")!.click();
    item().click();
    expect(view.state.doc.toString()).toBe(
      "| Part | Qty |\n| --- | :---: |\n| Servo | 4 |\n\n| Part | Qty |\n| --- | :---: |\n| Wheel | 2 |\n| Nut | 8 |\n",
    );
    expect(view.dom.querySelectorAll(".cm-md-table").length).toBe(2);
    // The first body row can't split off: the first table would have no body.
    const second = view.dom.querySelectorAll<HTMLElement>(".cm-md-table")[1];
    second.querySelector<HTMLElement>('td[data-row="1"]')!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    second.querySelector<HTMLElement>(".cm-md-table-rowhandle")!.click();
    expect(item().disabled).toBe(true);
  });

  it("splits a table in a callout, keeping the quote markers", () => {
    const view = tableView("> [!info] Parts\n> | Part | Qty |\n> |---|---|\n> | Servo | 4 |\n> | Wheel | 2 |\n");
    const table = view.dom.querySelector<HTMLElement>(".cm-md-table")!;
    table.querySelector<HTMLElement>('td[data-row="2"]')!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    table.querySelector<HTMLElement>(".cm-md-table-rowhandle")!.click();
    Array.from(view.dom.querySelectorAll<HTMLButtonElement>(".cm-md-table-menu [role=menuitem]")).find((b) => b.textContent === "Split table here")!.click();
    expect(view.state.doc.toString()).toBe(
      "> [!info] Parts\n> | Part | Qty |\n> | --- | --- |\n> | Servo | 4 |\n>\n> | Part | Qty |\n> | --- | --- |\n> | Wheel | 2 |\n",
    );
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

  it("shows the formatting toolbar over text selected in a cell, and bolds it", async () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "| Part | Qty |\n|---|---|\n| Power cell | 2 |\n",
        extensions: [markdown({ base: markdownLanguage }), tableField, selectionToolbar()],
      }),
      parent: document.body,
    });
    const cell = view.dom.querySelector<HTMLElement>(".cm-md-table td")!;
    cell.focus();
    cell.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    const range = document.createRange();
    range.setStart(cell.firstChild!, 0);
    range.setEnd(cell.firstChild!, 5);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    const bar = view.dom.querySelector<HTMLElement>(".cm-md-table-format")!;
    expect(bar).not.toBeNull();
    // Only what a cell can hold: no lists, headings or quotes.
    const labels = Array.from(bar.querySelectorAll("button"), (b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(["Bold", "Italic", "Strikethrough", "Highlight", "Inline code", "Link", "Clear formatting"]);
    bar.querySelector<HTMLElement>("[aria-label=Bold]")!.click();
    expect(view.state.doc.toString()).toBe("| Part | Qty |\n|---|---|\n| **Power** cell | 2 |\n");
    const again = view.dom.querySelector<HTMLElement>(".cm-md-table-format [aria-label=Bold]")!;
    expect(again.getAttribute("aria-pressed")).toBe("true");
    again.click();
    expect(view.state.doc.toString()).toBe("| Part | Qty |\n|---|---|\n| Power cell | 2 |\n");
    view.destroy();
  });

  it("leaves the toolbar out of cells when the editor has none", () => {
    const view = tableView("| Part | Qty |\n|---|---|\n| Power cell | 2 |\n");
    const cell = view.dom.querySelector<HTMLElement>(".cm-md-table td")!;
    cell.focus();
    const range = document.createRange();
    range.selectNodeContents(cell);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    expect(view.dom.querySelector(".cm-md-table-format")).toBeNull();
    view.destroy();
  });
});

describe("picking a block of cells", () => {
  const doc = "| Part | Qty | Notes |\n| --- | --- | --- |\n| Servo | 2 | ears |\n| Pico | 1 | brain |\n";

  function pickView(text = doc): EditorView {
    return new EditorView({
      state: EditorState.create({ doc: text, extensions: [markdown({ base: markdownLanguage }), tableField, selectionToolbar()] }),
      parent: document.body,
    });
  }

  const cellOf = (view: EditorView, row: number, col: number) =>
    view.dom.querySelector<HTMLElement>(`.cm-md-table [data-row="${row}"][data-col="${col}"]`)!;

  function dragAcross(view: EditorView, from: [number, number], to: [number, number]) {
    cellOf(view, ...from).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, buttons: 1 }));
    cellOf(view, ...to).dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons: 1 }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }

  const picked = (view: EditorView) =>
    Array.from(view.dom.querySelectorAll<HTMLElement>(".cm-md-table .selected"), (c) => `${c.dataset.row},${c.dataset.col}`);
  const bar = (view: EditorView) => view.dom.querySelector<HTMLElement>(".cm-md-table-rangebar");

  it("picks the cells a drag runs across and bolds them all from the bar", () => {
    const view = pickView();
    dragAcross(view, [1, 0], [2, 1]);
    expect(picked(view)).toEqual(["1,0", "1,1", "2,0", "2,1"]);
    bar(view)!.querySelector<HTMLElement>("[data-action=bold]")!.click();
    expect(view.state.doc.toString()).toBe("| Part | Qty | Notes |\n| --- | --- | --- |\n| **Servo** | **2** | ears |\n| **Pico** | **1** | brain |\n");
    // Still picked, and Bold now shows as on; again takes it off.
    expect(picked(view)).toHaveLength(4);
    const again = bar(view)!.querySelector<HTMLElement>("[data-action=bold]")!;
    expect(again.getAttribute("aria-pressed")).toBe("true");
    again.click();
    expect(view.state.doc.toString()).toBe(doc);
    view.destroy();
  });

  it("picks from the caret's cell with Shift+click, and italicises with Mod-I", () => {
    const view = pickView();
    cellOf(view, 1, 1).focus();
    cellOf(view, 2, 2).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, shiftKey: true }));
    expect(picked(view)).toEqual(["1,1", "1,2", "2,1", "2,2"]);
    const table = view.dom.querySelector<HTMLElement>(".cm-md-table")!;
    table.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "i", ctrlKey: true }));
    expect(view.state.doc.toString()).toContain("| Servo | *2* | *ears* |");
    // Delete empties them; Escape goes back to typing in a cell.
    table.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Delete" }));
    expect(view.state.doc.toString()).toContain("| Servo |  |  |\n| Pico |  |  |");
    table.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    expect(picked(view)).toEqual([]);
    view.destroy();
  });

  it("aligns the columns a block covers", () => {
    const view = pickView();
    dragAcross(view, [1, 1], [1, 2]);
    bar(view)!.querySelector<HTMLElement>("[data-action=align-center]")!.click();
    expect(view.state.doc.line(2).text).toBe("| --- | :---: | :---: |");
    view.destroy();
  });

  it("Shift+clicks row handles to pick rows, then deletes them", () => {
    const view = pickView("| A |  B |\n| --- | --- |\n| 1 | x |\n| 2 | y |\n| 3 | z |\n");
    hoverCell(view, 1, 0);
    const handle = view.dom.querySelector<HTMLElement>(".cm-md-table-rowhandle")!;
    handle.click();
    // The menu opens for the row; Shift+click on another row's handle picks the rows between.
    expect(view.dom.querySelector(".cm-md-table-menu")).not.toBeNull();
    cellOf(view, 2, 0).dispatchEvent(new MouseEvent("mouseover", { bubbles: true, shiftKey: true }));
    handle.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    expect(picked(view)).toEqual(["1,0", "1,1", "2,0", "2,1"]);
    const rows = bar(view)!.querySelector<HTMLButtonElement>("[data-action=delete-rows]")!;
    expect(rows.hidden).toBe(false);
    expect(bar(view)!.querySelector<HTMLButtonElement>("[data-action=delete-cols]")!.hidden).toBe(true);
    rows.click();
    expect(view.state.doc.toString()).toBe("| A | B |\n| --- | --- |\n| 3 | z |\n");
    view.destroy();
  });

  it("opens the row menu for every picked row", () => {
    const view = pickView();
    dragAcross(view, [1, 0], [2, 2]);
    hoverCell(view, 2, 0);
    view.dom.querySelector<HTMLElement>(".cm-md-table-rowhandle")!.click();
    const labels = Array.from(view.dom.querySelectorAll(".cm-md-table-menu button"), (b) => b.textContent);
    expect(labels).toContain("Delete 2 rows");
    expect(labels).toContain("Clear 2 rows");
    view.destroy();
  });

  it("keeps the handles on a dragged block, so one click deletes all its rows or columns", () => {
    const view = pickView("| A | B | C |\n| --- | --- | --- |\n| 1 | x | p |\n| 2 | y | q |\n| 3 | z | r |\n");
    dragAcross(view, [1, 0], [2, 1]);
    expect(view.dom.querySelector(".cm-md-table")!.classList.contains("handles-pinned")).toBe(true);
    // Hovering elsewhere doesn't move the handle off the block.
    hoverCell(view, 3, 2);
    view.dom.querySelector<HTMLElement>(".cm-md-table-rowhandle")!.click();
    const rows = Array.from(view.dom.querySelectorAll<HTMLButtonElement>(".cm-md-table-menu button")).find((b) => b.textContent === "Delete 2 rows")!;
    rows.click();
    expect(view.state.doc.toString()).toBe("| A | B | C |\n| --- | --- | --- |\n| 3 | z | r |\n");
    dragAcross(view, [0, 1], [1, 2]);
    view.dom.querySelector<HTMLElement>(".cm-md-table-colhandle")!.click();
    const cols = Array.from(view.dom.querySelectorAll<HTMLButtonElement>(".cm-md-table-menu button")).find((b) => b.textContent === "Delete 2 columns")!;
    cols.click();
    expect(view.state.doc.toString()).toBe("| A |\n| --- |\n| 3 |\n");
    view.destroy();
  });

  it("copies a block as tab-separated text", () => {
    const view = pickView();
    dragAcross(view, [0, 0], [1, 1]);
    const data = new DataTransfer();
    const event = new Event("copy", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, "clipboardData", { value: data });
    document.dispatchEvent(event);
    expect(data.getData("text/plain")).toBe("Part\tQty\nServo\t2");
    view.destroy();
  });
});
