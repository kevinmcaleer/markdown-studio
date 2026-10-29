import { syntaxTree } from "@codemirror/language";
import { Facet, StateField, type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, runScopeHandlers, ViewPlugin, WidgetType, type DecorationSet } from "@codemirror/view";
import { renderInline } from "./markdown";
import { applyCommand, commandsOf, filterCommands, hasSlashMenu, type SlashCommand } from "./slashMenu";
import {
  deleteColumn,
  deleteRow,
  diff,
  escapeCell,
  formatTable,
  insertColumn,
  insertRow,
  parseTable,
  pasteCells,
  setCell,
  spreadsheetCells,
  type Table,
} from "./markdownTable";

// In the live view a table is drawn as a table, like Claude docs: type in its
// cells, add a row or column from the bars below and to the right, and insert
// or delete rows and columns from the handle on each one. Every change is an
// edit to the Markdown underneath, so co-editing and undo work as for text.

//
// A host can draw a table some other way (`tableRenderer`): a Videos table as
// a gallery of thumbnails, say. It shows as that drawing until it's clicked or
// the caret moves into it, then as the grid, and goes back once the focus
// leaves it.

type TableRange = { from: number; to: number };

/** What a table renderer is given. */
export type TableRendererContext = {
  /** The header row first, then the body rows, as each cell's Markdown. */
  rows: string[][];
  /** The text of the heading the table sits under, if there is one. */
  heading: string | null;
};

/** Draws a table some other way, or returns null to keep the grid. */
export type TableRenderer = (table: TableRendererContext) => HTMLElement | null;

/** The table renderers; the first to draw a table wins. */
export const tableRenderers = Facet.define<TableRenderer>();

/** The table blocks in the note: each one's Markdown drawn as a table widget. */
export const tableField = StateField.define<DecorationSet>({
  create: (state) => findTables(state),
  update(tables, tr) {
    if (tr.docChanged || syntaxTree(tr.state) !== syntaxTree(tr.startState) || tr.state.readOnly !== tr.startState.readOnly)
      return findTables(tr.state);
    return tables;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function findTables(state: EditorState): DecorationSet {
  const tables: Range<Decoration>[] = [];
  let heading: string | null = null;
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === "Document") return true;
      if (/^(ATX|Setext)Heading/.test(node.name)) heading = headingText(state.sliceDoc(node.from, node.to));
      // Only top-level tables: one inside a quote or list has its markers on every line.
      if (node.name === "Table" && node.node.parent?.name === "Document") {
        const from = state.doc.lineAt(node.from).from;
        const to = state.doc.lineAt(Math.max(node.from, node.to - 1)).to;
        const source = state.sliceDoc(from, to);
        if (parseTable(source))
          tables.push(Decoration.replace({ widget: new TableWidget(source, !state.readOnly, heading), block: true }).range(from, to));
      }
      return false;
    },
  });
  return Decoration.set(tables);
}

function headingText(source: string): string {
  return source
    .split("\n")[0]
    .replace(/^\s*#{1,6}\s*/, "")
    .replace(/\s+#+\s*$/, "")
    .trim();
}

/** Whether `pos` is inside a table drawn as a grid (in one of its cells), where only inline Markdown fits. */
export function inTable(state: EditorState, pos: number): boolean {
  let found = false;
  state.field(tableField, false)?.between(pos, pos, (from, to) => {
    if (pos > from && pos <= to) found = true;
  });
  return found;
}

/** Where the caret is when it's in one of this editor's table cells, to anchor a popup to. */
export function cellCaretRect(view: EditorView): { left: number; top: number; bottom: number } | null {
  const active = view.dom.ownerDocument.activeElement as HTMLElement | null;
  if (!active || !isCell(active) || !view.contentDOM.contains(active)) return null;
  const selection = window.getSelection();
  const rect = selection?.rangeCount ? selection.getRangeAt(0).getClientRects()[0] : undefined;
  // A caret at the end of a cell can measure as an empty box.
  const box = rect?.height ? rect : active.getBoundingClientRect();
  return { left: box.left, top: box.top, bottom: box.bottom };
}

/** The table that starts at `pos`, if there is one. */
function tableAt(state: EditorState, pos: number): TableRange | null {
  let found: TableRange | null = null;
  state.field(tableField, false)?.between(pos, pos, (from, to) => {
    if (from === pos) found = { from, to };
  });
  return found;
}

const views = new WeakMap<HTMLElement, TableView>();

class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly editable: boolean,
    readonly heading: string | null = null,
  ) {
    super();
  }

  eq(other: TableWidget) {
    return other.source === this.source && other.editable === this.editable && other.heading === this.heading;
  }

  toDOM(view: EditorView) {
    const dom = document.createElement("div");
    views.set(dom, new TableView(dom, view, this));
    return dom;
  }

  updateDOM(dom: HTMLElement) {
    const table = views.get(dom);
    if (!table) return false;
    table.update(this);
    return true;
  }

  get estimatedHeight() {
    return this.source.split("\n").length * 40;
  }

  // The table handles its own clicks and typing.
  ignoreEvent() {
    return true;
  }

  destroy(dom: HTMLElement) {
    views.get(dom)?.destroy();
  }
}

const ICONS = {
  colLeft: "M6 2.5v11M2.5 6.5v3M1 8h3M9 2.5h4.5v11H9",
  colRight: "M10 2.5v11M13.5 6.5v3M12 8h3M7 2.5H2.5v11H7",
  rowAbove: "M2.5 6h11M6.5 2.5h3M8 1v3M2.5 9v4.5h11V9",
  rowBelow: "M2.5 10h11M6.5 13.5h3M8 12v3M2.5 7V2.5h11V7",
  delete: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 9h6l.5-9",
  copy: "M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3",
};

type MenuItem = { label: string; icon: string; run: () => void; disabled?: boolean };

/** The "/" menu in a cell: where its slash is in the cell's text, and what it offers. */
type CellSlash = { cell: HTMLElement; at: number; query: string; selected: number; items: SlashCommand[]; dom: HTMLElement };

/** The DOM for one table, kept across edits so typing in a cell isn't interrupted. */
class TableView {
  private table: Table;
  private source: string;
  private editable: boolean;
  private heading: string | null;
  /** The host's drawing of the table (see `tableRenderer`), shown while it isn't being edited. */
  private readonly preview = el("div", "cm-md-table-preview");
  private editing = false;
  private readonly scroller = el("div", "cm-md-table-scroll");
  private readonly colHandle = button("cm-md-table-handle cm-md-table-colhandle", "Column options");
  private readonly rowHandle = button("cm-md-table-handle cm-md-table-rowhandle", "Row options");
  private readonly addCol = button("cm-md-table-add cm-md-table-addcol", "Add column");
  private readonly addRow = button("cm-md-table-add cm-md-table-addrow", "Add row");
  private readonly more = button("cm-md-table-more", "Table options");
  private menu: HTMLElement | null = null;
  private slash: CellSlash | null = null;
  private hover = { row: 0, col: 0 };
  private closeMenuListener = (event: Event) => {
    if (this.menu && !this.menu.contains(event.target as Node)) this.closeMenu();
  };

  constructor(
    readonly dom: HTMLElement,
    readonly view: EditorView,
    widget: TableWidget,
  ) {
    this.source = widget.source;
    this.editable = widget.editable;
    this.heading = widget.heading;
    this.table = parseTable(this.source)!;
    dom.className = "cm-md-table";
    dom.contentEditable = "false";
    this.addCol.innerHTML = this.addRow.innerHTML = plusIcon();
    this.more.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8h.01M8 8h.01M12 8h.01"/></svg>';
    this.colHandle.innerHTML = '<svg viewBox="0 0 16 8" aria-hidden="true"><path d="M4 4h.01M8 4h.01M12 4h.01"/></svg>';
    this.rowHandle.innerHTML = '<svg viewBox="0 0 8 16" aria-hidden="true"><path d="M4 4h.01M4 8h.01M4 12h.01"/></svg>';
    dom.append(this.scroller, this.colHandle, this.rowHandle, this.addCol, this.addRow, this.more, this.preview);
    this.render();

    // Clicking the drawing edits the table (its links aren't followed while editing).
    this.preview.addEventListener("click", (e) => {
      if (!this.editable) return;
      e.preventDefault();
      this.focusCell(this.table.rows.length > 1 ? 1 : 0, 0);
    });
    dom.addEventListener("focusout", () => window.setTimeout(() => this.redraw()));

    dom.addEventListener("mouseover", (e) => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>("th, td");
      if (cell && !this.menu) this.setHover(Number(cell.dataset.row), Number(cell.dataset.col));
    });
    dom.addEventListener("focusin", (e) => {
      const cell = e.target as HTMLElement;
      if (!isCell(cell)) return;
      cell.textContent = cell.dataset.raw ?? "";
      this.setHover(Number(cell.dataset.row), Number(cell.dataset.col));
    });
    dom.addEventListener("focusout", (e) => {
      const cell = e.target as HTMLElement;
      if (!isCell(cell)) return;
      if (this.slash?.cell === cell) this.closeSlash();
      cell.innerHTML = renderInline(cell.dataset.raw ?? "");
    });
    dom.addEventListener("input", (e) => {
      const cell = e.target as HTMLElement;
      if (!isCell(cell)) return;
      const text = (cell.textContent ?? "").replace(/\n/g, " ");
      cell.dataset.raw = escapeCell(text);
      const row = Number(cell.dataset.row);
      const col = Number(cell.dataset.col);
      this.change((source) => setCell(source, row, col, text));
      this.updateSlash(cell, e as InputEvent);
    });
    dom.addEventListener("paste", (e) => {
      const cell = e.target as HTMLElement;
      if (!isCell(cell)) return;
      e.preventDefault();
      const text = e.clipboardData?.getData("text/plain") ?? "";
      // Cells from a spreadsheet fill the table from this cell, growing it if they need to.
      const cells = spreadsheetCells(text, e.clipboardData?.getData("text/html"));
      if (cells) {
        const row = Number(cell.dataset.row);
        const col = Number(cell.dataset.col);
        const range = this.change((source) => pasteCells(source, row, col, cells));
        const view = range ? (tableViewAt(this.view, range.from) ?? this) : this;
        view.focusCell(Math.min(row + cells.length - 1, view.table.rows.length - 1), Math.min(col + cells[0].length - 1, view.table.align.length - 1));
        return;
      }
      document.execCommand("insertText", false, text.replace(/\r?\n/g, " "));
    });
    dom.addEventListener("keydown", (e) => this.keydown(e));
    // Clicking a control shouldn't take the caret out of the cell first.
    dom.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).closest("button")) e.preventDefault();
    });

    this.addRow.addEventListener("click", () => this.structure((t) => insertRow(t, t.rows.length), this.table.rows.length, 0));
    this.addCol.addEventListener("click", () => this.structure((t) => insertColumn(t, t.align.length), 0, this.table.align.length));
    this.colHandle.addEventListener("click", () => this.columnMenu());
    this.rowHandle.addEventListener("click", () => this.rowMenu());
    this.more.addEventListener("click", () => this.tableMenu());
  }

  update(widget: TableWidget) {
    this.source = widget.source;
    this.editable = widget.editable;
    this.heading = widget.heading;
    this.table = parseTable(this.source)!;
    this.render();
  }

  destroy() {
    this.closeMenu();
    this.closeSlash();
  }

  /** Back to the host's drawing once the focus has left the table. */
  private redraw() {
    if (!this.editing || this.menu || this.slash) return;
    if (this.dom.contains(this.dom.ownerDocument.activeElement)) return;
    this.editing = false;
    this.render();
  }

  /** Draws the host's version of the table in place of the grid; false if there isn't one. */
  private renderPreview(): boolean {
    let drawing: HTMLElement | null = null;
    if (!this.editing) {
      const context = { rows: this.table.rows.map((row) => [...row]), heading: this.heading };
      for (const render of this.view.state.facet(tableRenderers)) {
        drawing = render(context);
        if (drawing) break;
      }
    }
    this.dom.classList.toggle("previewing", !!drawing);
    this.preview.replaceChildren(...(drawing ? [drawing] : []));
    return !!drawing;
  }

  /** Draws the table, reusing the cells when its shape hasn't changed. */
  private render() {
    if (this.renderPreview()) return;
    const { rows, align } = this.table;
    this.dom.classList.toggle("editable", this.editable);
    let table = this.scroller.querySelector("table");
    const sameShape =
      table && table.rows.length === rows.length && Array.from(table.rows).every((tr) => tr.cells.length === align.length);
    const focused = this.focusedCell();
    if (!table || !sameShape) {
      table = document.createElement("table");
      const head = table.createTHead().insertRow();
      const body = table.createTBody();
      rows.forEach((cells, r) => {
        const tr = r === 0 ? head : body.insertRow();
        cells.forEach((_, c) => {
          const cell = document.createElement(r === 0 ? "th" : "td");
          cell.dataset.row = String(r);
          cell.dataset.col = String(c);
          tr.append(cell);
        });
      });
      this.scroller.replaceChildren(table);
    }
    for (const tr of Array.from(table.rows)) {
      for (const cell of Array.from(tr.cells)) {
        const r = Number(cell.dataset.row);
        const c = Number(cell.dataset.col);
        const raw = rows[r][c];
        cell.contentEditable = this.editable ? "true" : "false";
        cell.style.textAlign = align[c] ?? "";
        if (cell.dataset.raw === raw) continue;
        const editing = sameShape && focused?.row === r && focused.col === c;
        cell.dataset.raw = raw;
        if (editing) {
          // Someone else (or undo) changed the cell being typed in.
          cell.textContent = raw;
          caretAtEnd(cell);
        } else cell.innerHTML = renderInline(raw);
      }
    }
    if (focused && !sameShape) this.focusCell(Math.min(focused.row, rows.length - 1), Math.min(focused.col, align.length - 1));
    this.setHover(Math.min(this.hover.row, rows.length - 1), Math.min(this.hover.col, align.length - 1));
  }

  private cell(row: number, col: number): HTMLElement | null {
    return this.scroller.querySelector(`[data-row="${row}"][data-col="${col}"]`);
  }

  private focusedCell(): { row: number; col: number } | null {
    const active = this.dom.ownerDocument.activeElement as HTMLElement | null;
    if (!active || !isCell(active) || !this.dom.contains(active)) return null;
    return { row: Number(active.dataset.row), col: Number(active.dataset.col) };
  }

  /** Swaps the host's drawing for the grid. */
  private edit() {
    if (this.editing) return;
    this.editing = true;
    if (this.dom.classList.contains("previewing")) this.render();
  }

  /** Puts the caret in a cell; `select` selects its text instead. */
  focusCell(row: number, col: number, select = false) {
    if (!this.editable) return;
    this.edit();
    const cell = this.cell(row, col);
    if (!cell || !this.editable) return;
    cell.focus();
    if (select) {
      const range = document.createRange();
      range.selectNodeContents(cell);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    } else caretAtEnd(cell);
  }

  /** Puts the caret in a cell, selecting from..to of its Markdown text. */
  focusCellAt(row: number, col: number, from: number, to: number) {
    if (!this.editable) return;
    this.edit();
    const cell = this.cell(row, col);
    if (!cell || !this.editable) return;
    cell.focus();
    const node = cell.firstChild;
    if (!node || node.nodeType !== 3) return caretAtEnd(cell);
    const length = (node.textContent ?? "").length;
    const range = document.createRange();
    range.setStart(node, Math.max(0, Math.min(from, length)));
    range.setEnd(node, Math.max(0, Math.min(to, length)));
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  private setHover(row: number, col: number) {
    this.hover = { row, col };
    const cell = this.cell(row, col);
    if (!cell) return;
    const base = this.dom.getBoundingClientRect();
    const box = cell.getBoundingClientRect();
    const table = this.scroller.getBoundingClientRect();
    this.colHandle.style.left = `${box.left - base.left + box.width / 2}px`;
    this.colHandle.style.top = `${table.top - base.top}px`;
    this.rowHandle.style.left = `${table.left - base.left}px`;
    this.rowHandle.style.top = `${box.top - base.top + box.height / 2}px`;
  }

  /** Applies an edit to the table's Markdown as the smallest change to the note. */
  private change(edit: (source: string) => string): TableRange | null {
    let pos: number;
    try {
      pos = this.view.posAtDOM(this.dom);
    } catch {
      return null;
    }
    const range = tableAt(this.view.state, pos);
    if (!range) return null;
    const current = this.view.state.sliceDoc(range.from, range.to);
    const change = diff(current, edit(current));
    if (change)
      this.view.dispatch({
        changes: { from: range.from + change.from, to: range.from + change.to, insert: change.insert },
        userEvent: "input.type.table",
      });
    return range;
  }

  /** Adds or removes rows or columns, then puts the caret in the given cell. */
  private structure(edit: (table: Table) => Table, row: number, col: number) {
    this.closeMenu();
    const range = this.change((source) => {
      const table = parseTable(source);
      return table ? formatTable(edit(table)) : source;
    });
    if (!range) return;
    // The edit can redraw the table as a new widget; find whichever holds it now.
    const view = tableViewAt(this.view, range.from) ?? this;
    const { rows, align } = view.table;
    view.focusCell(Math.max(0, Math.min(row, rows.length - 1)), Math.max(0, Math.min(col, align.length - 1)));
  }

  private keydown(e: KeyboardEvent) {
    if (this.slash && this.slashKey(e)) return;
    const cell = e.target as HTMLElement;
    if (!isCell(cell)) {
      if (e.key === "Escape") this.closeMenu();
      return;
    }
    const row = Number(cell.dataset.row);
    const col = Number(cell.dataset.col);
    const lastRow = this.table.rows.length - 1;
    const lastCol = this.table.align.length - 1;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && /^[zy]$/i.test(e.key)) {
      // Undo and redo are the note's, not the cell's.
      e.preventDefault();
      runScopeHandlers(this.view, e, "editor");
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (row < lastRow) this.focusCell(row + 1, col);
      else this.structure((t) => insertRow(t, t.rows.length), row + 1, col);
    } else if (e.key === "Tab") {
      e.preventDefault();
      if (e.shiftKey) {
        if (col > 0) this.focusCell(row, col - 1);
        else if (row > 0) this.focusCell(row - 1, lastCol);
      } else if (col < lastCol) this.focusCell(row, col + 1);
      else if (row < lastRow) this.focusCell(row + 1, 0);
      else this.structure((t) => insertRow(t, t.rows.length), row + 1, 0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (row > 0) this.focusCell(row - 1, col);
      else this.leave(-1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (row < lastRow) this.focusCell(row + 1, col);
      else this.leave(1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.leave(1);
    }
  }

  // ------------------------------------------------------------ "/" in a cell

  /**
   * Typing "/" at the start of a cell, or after a space, opens the editor's
   * "/" menu with the commands that fit in a cell (not the block ones).
   */
  private updateSlash(cell: HTMLElement, e: InputEvent) {
    const caret = caretOffset(cell);
    const text = cell.textContent ?? "";
    if (!this.slash || this.slash.cell !== cell) {
      this.closeSlash();
      if (caret === null || e.inputType !== "insertText" || e.data !== "/" || !hasSlashMenu(this.view.state)) return;
      const at = caret - 1;
      if (text[at] !== "/" || (at > 0 && !/\s/.test(text[at - 1]))) return;
      const dom = el("div", "cm-tooltip cm-slash-menu cm-md-table-slash");
      dom.setAttribute("role", "listbox");
      dom.setAttribute("aria-label", "Insert");
      dom.addEventListener("mousedown", (event) => event.preventDefault());
      this.dom.append(dom);
      this.slash = { cell, at, query: "", selected: 0, items: [], dom };
    }
    const slash = this.slash;
    if (caret === null || caret <= slash.at || text[slash.at] !== "/") return this.closeSlash();
    const query = text.slice(slash.at + 1, caret);
    const items = filterCommands(query, commandsOf(this.view.state).filter((c) => !c.block && (c.insert || c.run) && !c.hidden?.(this.view.state)));
    // A space after a query nothing matches means you've moved on.
    if (query.length > 24 || (/\s$/.test(query) && !items.length)) return this.closeSlash();
    if (query !== slash.query) slash.selected = 0;
    slash.query = query;
    slash.items = items;
    this.renderSlash();
  }

  private renderSlash() {
    const slash = this.slash;
    if (!slash) return;
    const { dom, items, query } = slash;
    dom.replaceChildren();
    if (!items.length) {
      dom.append(Object.assign(el("div", "cm-slash-empty"), { textContent: "No matches" }));
    }
    items.forEach((command, i) => {
      if (i > 0 && !query.trim() && command.group !== items[i - 1].group) {
        const hr = el("div", "cm-slash-divider");
        hr.setAttribute("role", "separator");
        dom.append(hr);
      }
      const item = el("div", "cm-slash-item");
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(i === slash.selected));
      item.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="${command.icon}" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      item.append(command.label);
      item.addEventListener("mousemove", () => {
        if (slash.selected === i) return;
        slash.selected = i;
        this.renderSlash();
      });
      item.addEventListener("click", () => this.pickSlash(i));
      dom.append(item);
    });
    dom.querySelector<HTMLElement>("[aria-selected=true]")?.scrollIntoView?.({ block: "nearest" });
    // Under the slash.
    const base = this.dom.getBoundingClientRect();
    const range = document.createRange();
    const node = slash.cell.firstChild;
    if (node && node.nodeType === 3 && slash.at < (node.textContent ?? "").length) range.setStart(node, slash.at);
    else range.selectNodeContents(slash.cell);
    const box = range.getClientRects()[0] ?? slash.cell.getBoundingClientRect();
    dom.style.left = `${Math.max(0, box.left - base.left)}px`;
    dom.style.top = `${box.bottom - base.top + 4}px`;
  }

  /** Arrows, Enter or Tab and Escape while the menu is open; true when the key was the menu's. */
  private slashKey(e: KeyboardEvent): boolean {
    const slash = this.slash!;
    const count = slash.items.length;
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && count) {
      slash.selected = (slash.selected + (e.key === "ArrowDown" ? 1 : -1) + count) % count;
      this.renderSlash();
    } else if ((e.key === "Enter" || e.key === "Tab") && count) {
      this.pickSlash(slash.selected);
    } else if (e.key === "Escape") {
      this.closeSlash();
    } else return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  }

  /** Swaps "/query" in the cell for the command, through the note's Markdown. */
  private pickSlash(index: number) {
    const slash = this.slash;
    const command = slash?.items[index];
    if (!slash || !command) return;
    const { cell, at } = slash;
    const text = cell.textContent ?? "";
    const caret = caretOffset(cell) ?? at + 1 + slash.query.length;
    this.closeSlash();
    const start = this.cellStart(cell);
    if (start === null) return;
    // The cell's text is in the Markdown trimmed, with its pipes escaped.
    const toSource = (prefix: string) => prefix.replace(/\r?\n/g, " ").replace(/(?<!\\)\|/g, "\\|").replace(/^\s+/, "").length;
    const from = start + toSource(text.slice(0, at));
    const spec = applyCommand(this.view.state, { ...command, block: false, blankBefore: false }, from, start + toSource(text.slice(0, caret)));
    if (command.run) {
      // The host's picker takes over from here, at this place in the note,
      // with the caret back in the cell for it to open beside.
      this.view.dispatch(spec);
      this.focusCellAt(Number(cell.dataset.row), Number(cell.dataset.col), from - start, from - start);
      command.run(this.view);
    } else {
      // With the editor focused, tableCursor carries on in this cell, with
      // any placeholder selected.
      this.view.focus();
      this.view.dispatch(spec);
    }
  }

  private closeSlash() {
    if (!this.slash) return;
    this.slash.dom.remove();
    this.slash = null;
  }

  /** Where a cell's text starts in the note. */
  private cellStart(cell: HTMLElement): number | null {
    let pos: number;
    try {
      pos = this.view.posAtDOM(this.dom);
    } catch {
      return null;
    }
    const range = tableAt(this.view.state, pos);
    if (!range) return null;
    const row = Number(cell.dataset.row);
    const lines = this.view.state.sliceDoc(range.from, range.to).split("\n");
    const index = row === 0 ? 0 : row + 1;
    if (lines[index] === undefined) return null;
    const lineFrom = range.from + lines.slice(0, index).reduce((n, line) => n + line.length + 1, 0);
    const offset = cellContentOffset(lines[index], Number(cell.dataset.col));
    return offset === null ? null : lineFrom + offset;
  }

  /** Moves the caret out of the table, to the line above or below it. */
  private leave(dir: -1 | 1) {
    let pos: number;
    try {
      pos = this.view.posAtDOM(this.dom);
    } catch {
      return;
    }
    const range = tableAt(this.view.state, pos);
    if (!range) return;
    const { doc } = this.view.state;
    this.view.focus();
    if (dir < 0) {
      if (range.from > 0) this.view.dispatch({ selection: { anchor: range.from - 1 }, scrollIntoView: true });
      else this.view.dispatch({ changes: { from: 0, insert: "\n" }, selection: { anchor: 0 }, scrollIntoView: true });
      return;
    }
    // Below: onto an empty line with a blank line between it and the table,
    // since a line of text right under a table would become one of its rows.
    const next = range.to < doc.length ? doc.lineAt(range.to + 1) : null;
    if (next && next.text.trim()) {
      this.view.dispatch({ selection: { anchor: next.from }, scrollIntoView: true });
    } else if (next && next.number < doc.lines && !doc.line(next.number + 1).text.trim()) {
      this.view.dispatch({ selection: { anchor: doc.line(next.number + 1).from }, scrollIntoView: true });
    } else if (next) {
      const atEnd = next.number === doc.lines;
      this.view.dispatch({ changes: { from: next.to, insert: atEnd ? "\n" : "\n\n" }, selection: { anchor: next.to + 1 }, scrollIntoView: true });
    } else {
      this.view.dispatch({ changes: { from: range.to, insert: "\n\n" }, selection: { anchor: range.to + 2 }, scrollIntoView: true });
    }
  }

  private columnMenu() {
    const { col } = this.hover;
    this.openMenu(this.colHandle, [
      { label: "Insert column left", icon: ICONS.colLeft, run: () => this.structure((t) => insertColumn(t, col), this.hover.row, col) },
      { label: "Insert column right", icon: ICONS.colRight, run: () => this.structure((t) => insertColumn(t, col + 1), this.hover.row, col + 1) },
      {
        label: "Delete column",
        icon: ICONS.delete,
        disabled: this.table.align.length < 2,
        run: () => this.structure((t) => deleteColumn(t, col), this.hover.row, col),
      },
    ]);
    this.select((cell) => Number(cell.dataset.col) === col);
  }

  private rowMenu() {
    const { row } = this.hover;
    this.openMenu(this.rowHandle, [
      // The header is always the first row, so nothing goes above it.
      { label: "Insert row above", icon: ICONS.rowAbove, disabled: row === 0, run: () => this.structure((t) => insertRow(t, row), row, this.hover.col) },
      { label: "Insert row below", icon: ICONS.rowBelow, run: () => this.structure((t) => insertRow(t, row + 1), row + 1, this.hover.col) },
      {
        label: "Delete row",
        icon: ICONS.delete,
        disabled: row === 0,
        run: () => this.structure((t) => deleteRow(t, row), row - 1, this.hover.col),
      },
    ]);
    this.select((cell) => Number(cell.dataset.row) === row);
  }

  private tableMenu() {
    this.openMenu(this.more, [
      {
        label: "Copy as Markdown",
        icon: ICONS.copy,
        run: () => {
          this.closeMenu();
          void navigator.clipboard?.writeText(this.source);
        },
      },
      {
        label: "Delete table",
        icon: ICONS.delete,
        run: () => {
          this.closeMenu();
          const range = tableAt(this.view.state, this.view.posAtDOM(this.dom));
          if (!range) return;
          const { doc } = this.view.state;
          const to = range.to < doc.length ? range.to + 1 : range.to;
          this.view.focus();
          this.view.dispatch({ changes: { from: range.from, to }, selection: { anchor: range.from }, userEvent: "delete.table" });
        },
      },
    ]);
  }

  private select(test: (cell: HTMLElement) => boolean) {
    this.scroller.querySelectorAll<HTMLElement>("th, td").forEach((cell) => cell.classList.toggle("selected", test(cell)));
  }

  private openMenu(anchor: HTMLElement, items: MenuItem[]) {
    this.closeMenu();
    if (!this.editable) return;
    const menu = el("div", "cm-md-table-menu");
    menu.setAttribute("role", "menu");
    for (const item of items) {
      const entry = button("", item.label);
      entry.setAttribute("role", "menuitem");
      entry.disabled = !!item.disabled;
      entry.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${item.icon}"/></svg><span></span>`;
      entry.querySelector("span")!.textContent = item.label;
      entry.removeAttribute("title");
      entry.addEventListener("click", item.run);
      menu.append(entry);
    }
    const base = this.dom.getBoundingClientRect();
    const box = anchor.getBoundingClientRect();
    menu.style.top = `${box.bottom - base.top + 4}px`;
    menu.style.left = `${Math.max(0, box.left - base.left)}px`;
    this.dom.append(menu);
    this.dom.classList.add("menu-open");
    this.menu = menu;
    window.setTimeout(() => document.addEventListener("mousedown", this.closeMenuListener));
  }

  private closeMenu() {
    if (!this.menu) return;
    this.menu.remove();
    this.menu = null;
    this.dom.classList.remove("menu-open");
    this.select(() => false);
    document.removeEventListener("mousedown", this.closeMenuListener);
    window.setTimeout(() => this.redraw());
  }
}

function tableViewAt(view: EditorView, from: number): TableView | null {
  for (const dom of Array.from(view.contentDOM.querySelectorAll<HTMLElement>(".cm-md-table"))) {
    try {
      if (view.posAtDOM(dom) === from) return views.get(dom) ?? null;
    } catch {
      /* not in the document any more */
    }
  }
  return null;
}

/**
 * When the editor's cursor lands inside a table (the / menu just made one,
 * say, or a command inserted text in a cell), carries on in the matching
 * cell, at the same place in its text (or with the same text selected).
 */
export const tableCursor = ViewPlugin.define(() => ({
  update(update) {
    if (!(update.selectionSet || update.docChanged) || !update.view.hasFocus) return;
    const { state, view } = update;
    const head = state.selection.main.head;
    const { anchor } = state.selection.main;
    let target: { from: number; row: number; col: number; start: number; end: number } | null = null;
    state.field(tableField, false)?.between(head, head, (from, to) => {
      if (head <= from || head > to) return;
      const line = state.doc.lineAt(head);
      const index = line.number - state.doc.lineAt(from).number;
      const before = line.text.slice(0, head - line.from);
      const pipes = (before.match(/(?<!\\)\|/g) ?? []).length;
      const col = Math.max(0, line.text.trimStart().startsWith("|") ? pipes - 1 : pipes);
      // The selection as offsets into the cell's text (on the delimiter line, its start).
      const content = index === 1 ? null : cellContentOffset(line.text, col);
      const offset = (pos: number) => (content === null || pos < line.from ? 0 : Math.max(0, pos - line.from - content));
      target = { from, row: index < 2 ? 0 : index - 1, col, start: offset(Math.min(anchor, head)), end: offset(Math.max(anchor, head)) };
    });
    if (!target) return;
    const { from, row, col, start, end } = target;
    window.setTimeout(() => tableViewAt(view, from)?.focusCellAt(row, col, start, end));
  },
}));

function isCell(node: HTMLElement): boolean {
  return node.nodeType === 1 && (node.tagName === "TD" || node.tagName === "TH");
}

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function button(className: string, label: string): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.title = label;
  node.setAttribute("aria-label", label);
  return node;
}

function plusIcon(): string {
  return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 4v8M4 8h8"/></svg>';
}

/** Where the text of cell `col` starts in a table row's line, past its pipe and padding. */
function cellContentOffset(line: string, col: number): number | null {
  const pipes: number[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\") i++;
    else if (line[i] === "|") pipes.push(i);
  }
  const bounds = [...(line.trimStart().startsWith("|") ? [] : [-1]), ...pipes];
  if (col >= bounds.length) return null;
  let i = bounds[col] + 1;
  while (i < line.length && line[i] === " ") i++;
  return i;
}

/** The caret's offset in a cell's text, or null when it isn't in the cell. */
function caretOffset(cell: HTMLElement): number | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!cell.contains(range.endContainer)) return null;
  const before = document.createRange();
  before.selectNodeContents(cell);
  before.setEnd(range.endContainer, range.endOffset);
  return before.toString().length;
}

function caretAtEnd(cell: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(cell);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}
