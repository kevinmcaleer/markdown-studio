import { syntaxTree } from "@codemirror/language";
import { Facet, StateField, type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, runScopeHandlers, ViewPlugin, WidgetType, type DecorationSet } from "@codemirror/view";
import { parseCalloutHeader } from "./callouts";
import { hasLinkPopover, linkCard, linkForm, linkInText, type LinkAt } from "./format/linkPopover";
import { cellHasImage, isImageGrid } from "./imageGrid";
import { renderCell } from "./markdown";
import { applyCommand, commandsOf, filterCommands, hasSlashMenu, type SlashCommand } from "./slashMenu";
import {
  deleteColumn,
  clearRow,
  splitTable,
  deleteRow,
  diff,
  escapeCell,
  formatTable,
  insertColumn,
  insertRow,
  moveColumn,
  moveRow,
  parseTable,
  pasteCells,
  setAlign,
  setCell,
  spreadsheetCells,
  type Align,
  type Table,
} from "./markdownTable";

// In the live view a table is drawn as a table, like Claude docs: type in its
// cells, add a row or column from the bars below and to the right, and insert
// or delete rows and columns from the handle on each one, and drag a handle
// to move its row or column (or use the menu's Move items). Every change is an
// edit to the Markdown underneath, so co-editing and undo work as for text.

//
// A host can draw a table some other way (`tableRenderer`): a Videos table as
// a gallery of thumbnails, say. It shows as that drawing until it's clicked or
// the caret moves into it, then as the grid, and goes back once the focus
// leaves it.
//
// A table in a quote or callout (`> | a | b |`) is drawn the same way, in the
// quote's box. The widget works on the table without its `> ` markers, and
// they're put back on every line it changes.

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
      // Into quotes and callouts, for the tables in them.
      if (node.name === "Blockquote") return true;
      // Top-level and quoted tables; one in a list is left as text.
      const quotes = node.name === "Table" ? quoteDepth(node.node) : null;
      if (quotes !== null) {
        const from = state.doc.lineAt(node.from).from;
        const to = state.doc.lineAt(Math.max(node.from, node.to - 1)).to;
        const quoted = state.sliceDoc(from, to);
        const prefix = quotes ? quotePrefix(quoted, quotes) : "";
        const source = quotes ? unquote(quoted, quotes) : quoted;
        const box = quotes ? quoteBox(state, node.node, to) : null;
        if (parseTable(source))
          tables.push(Decoration.replace({ widget: new TableWidget(source, !state.readOnly, heading, prefix, box), block: true }).range(from, to));
      }
      return false;
    },
  });
  return Decoration.set(tables);
}

type SyntaxNode = ReturnType<typeof syntaxTree>["topNode"];

/** How many quotes a table sits in, or null when it's somewhere else (in a list, say). */
function quoteDepth(node: SyntaxNode): number | null {
  let depth = 0;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.name === "Document") return depth;
    if (parent.name !== "Blockquote") return null;
    depth++;
  }
  return null;
}

/** `depth` quote markers at the start of a line: `> `, `>> `, `> > `. */
function quoteMarkers(depth: number): RegExp {
  return new RegExp(`^(?:[ \\t]{0,3}>[ \\t]?){${depth}}`);
}

/** The first line's quote markers, which go on every line the table changes. */
function quotePrefix(text: string, depth: number): string {
  const prefix = quoteMarkers(depth).exec(text)?.[0] ?? "";
  // `>` with no space after it (on an empty line) is written as `> `.
  return prefix.endsWith(">") ? `${prefix} ` : prefix;
}

/** A quoted table's lines without their quote markers. */
export function unquote(text: string, depth: number): string {
  const markers = quoteMarkers(depth);
  return text
    .split("\n")
    .map((line) => line.replace(markers, ""))
    .join("\n");
}

/** A table's lines with the quote markers put back. */
export function requote(text: string, prefix: string): string {
  // A blank line (between two tables) keeps the quote going as a bare `>`.
  return prefix ? text.split("\n").map((line) => (line ? prefix + line : prefix.trimEnd())).join("\n") : text;
}

/** The box a quoted table is drawn in: its outermost quote's (a callout's colour), and whether the table ends it. */
type QuoteBox = { callout: string | null; last: boolean };

function quoteBox(state: EditorState, table: SyntaxNode, to: number): QuoteBox {
  let quote = table.parent!;
  while (quote.parent?.name === "Blockquote") quote = quote.parent;
  const line = state.doc.lineAt(quote.from);
  const header = /^>[ \t]?\[!/.test(line.text.slice(quote.from - line.from))
    ? parseCalloutHeader(line.text.slice(quote.from - line.from).replace(/^>[ \t]?/, ""))
    : null;
  return { callout: header?.type ?? null, last: state.doc.lineAt(Math.max(quote.from, quote.to - 1)).to <= to };
}

/** How long the quote markers are at the start of a line of a quoted table. */
function markersLength(line: string, prefix: string): number {
  if (!prefix) return 0;
  const depth = (prefix.match(/>/g) ?? []).length;
  return quoteMarkers(depth).exec(line)?.[0].length ?? 0;
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
    /** The quote markers on each line (`> `), for a table in a quote or callout. */
    readonly prefix = "",
    readonly box: QuoteBox | null = null,
  ) {
    super();
  }

  eq(other: TableWidget) {
    return (
      other.source === this.source &&
      other.editable === this.editable &&
      other.heading === this.heading &&
      other.prefix === this.prefix &&
      other.box?.callout === this.box?.callout &&
      other.box?.last === this.box?.last
    );
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
  moveUp: "M8 13V3M4.5 6.5 8 3l3.5 3.5",
  moveDown: "M8 3v10M4.5 9.5 8 13l3.5-3.5",
  moveLeft: "M13 8H3M6.5 4.5 3 8l3.5 3.5",
  moveRight: "M3 8h10M9.5 4.5 13 8l-3.5 3.5",
  delete: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 9h6l.5-9",
  clear: "M2.5 5.5h11v5h-11zM6 3.5l4 9",
  split: "M2.5 2.5h11v4h-11zM2.5 9.5h11v4h-11zM1 8h2M5 8h2M9 8h2M13 8h2",
  copy: "M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3",
  alignLeft: "M2.5 3.5h11M2.5 6.5h7M2.5 9.5h11M2.5 12.5h7",
  alignCenter: "M2.5 3.5h11M4.5 6.5h7M2.5 9.5h11M4.5 12.5h7",
  alignRight: "M2.5 3.5h11M6.5 6.5h7M2.5 9.5h11M6.5 12.5h7",
};

type MenuItem = { label: string; icon: string; run: () => void; disabled?: boolean };
/** A row of icon buttons below a line, one of them pressed: the current choice. */
type MenuChoices = { label: string; choices: (MenuItem & { pressed: boolean })[] };

const ALIGNMENTS: { align: Exclude<Align, null>; label: string; icon: string }[] = [
  { align: "left", label: "Align left", icon: ICONS.alignLeft },
  { align: "center", label: "Align center", icon: ICONS.alignCenter },
  { align: "right", label: "Align right", icon: ICONS.alignRight },
];

/** The "/" menu in a cell: where its slash is in the cell's text, and what it offers. */
type CellSlash = { cell: HTMLElement; at: number; query: string; selected: number; items: SlashCommand[]; dom: HTMLElement };

/** The DOM for one table, kept across edits so typing in a cell isn't interrupted. */
class TableView {
  private table: Table;
  private source: string;
  private editable: boolean;
  private heading: string | null;
  private prefix: string;
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
  private link: { cell: HTMLElement; at: LinkAt; dom: HTMLElement; form: boolean } | null = null;
  private hover = { row: 0, col: 0 };
  /** A row or column being dragged by its handle, and the line showing where it will go. */
  private drag: { axis: "row" | "col"; from: number; to: number | null; line: HTMLElement } | null = null;
  /** Set for the click that ends a drag, so it doesn't open the handle's menu. */
  private dragged = false;
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
    this.prefix = widget.prefix;
    this.table = parseTable(this.source)!;
    dom.className = "cm-md-table";
    this.setBox(widget.box);
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
      if (cell && !this.menu && !this.drag) this.setHover(Number(cell.dataset.row), Number(cell.dataset.col));
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
      // Into the link's card or form keeps it open; anywhere else closes it.
      if (this.link?.cell === cell && !this.link.dom.contains((e as FocusEvent).relatedTarget as Node)) this.closeLink();
      cell.innerHTML = renderCell(cell.dataset.raw ?? "");
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
      this.showLink(cell);
    });
    // The caret on a link, or a bare URL, shows its card (as in the note).
    dom.addEventListener("click", (e) => {
      const cell = e.target as HTMLElement;
      if (isCell(cell)) this.showLink(cell);
    });
    dom.addEventListener("keyup", (e) => {
      const cell = e.target as HTMLElement;
      if (isCell(cell) && /^(Arrow|Home|End)/.test(e.key)) this.showLink(cell);
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
    this.colHandle.addEventListener("click", () => this.dragged || this.columnMenu());
    this.rowHandle.addEventListener("click", () => this.dragged || this.rowMenu());
    this.colHandle.addEventListener("pointerdown", (e) => this.startDrag(e, "col"));
    this.rowHandle.addEventListener("pointerdown", (e) => this.startDrag(e, "row"));
    this.more.addEventListener("click", () => this.tableMenu());
  }

  update(widget: TableWidget) {
    this.source = widget.source;
    this.editable = widget.editable;
    this.heading = widget.heading;
    this.prefix = widget.prefix;
    this.setBox(widget.box);
    this.table = parseTable(this.source)!;
    this.render();
  }

  /** A quoted table sits in its quote's box: a callout's colour, or a plain quote's rule. */
  private setBox(box: QuoteBox | null) {
    const { classList } = this.dom;
    for (const name of Array.from(classList)) if (name.startsWith("callout-")) classList.remove(name);
    classList.toggle("cm-md-table-quoted", !!box);
    classList.toggle("cm-md-table-callout", !!box?.callout);
    classList.toggle("cm-md-table-quote-last", !!box?.last);
    if (box?.callout) classList.add(`callout-${box.callout}`);
  }

  destroy() {
    this.endDrag();
    this.closeMenu();
    this.closeSlash();
    this.closeLink();
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
    const previewing = this.renderPreview();
    const { rows, align } = this.table;
    // A table of images is a layout: cards in a borderless grid (imageGrid.ts).
    const grid = !previewing && isImageGrid(rows);
    this.dom.classList.toggle("image-grid", grid);
    this.dom.classList.toggle("image-grid-nohead", grid && rows[0].every((cell) => !cell.trim()));
    if (previewing) return;
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
        cell.classList.toggle("image-card", grid && cellHasImage(raw));
        if (cell.dataset.raw === raw) continue;
        const editing = sameShape && focused?.row === r && focused.col === c;
        cell.dataset.raw = raw;
        if (editing) {
          // Someone else (or undo) changed the cell being typed in.
          cell.textContent = raw;
          caretAtEnd(cell);
        } else cell.innerHTML = renderCell(raw);
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
    const depth = (this.prefix.match(/>/g) ?? []).length;
    const next = this.prefix ? requote(edit(unquote(current, depth)), this.prefix) : edit(current);
    const change = diff(current, next);
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
    if (this.link && e.key === "Escape" && isCell(cell)) {
      e.preventDefault();
      this.closeLink();
      return;
    }
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

  // ------------------------------------------------------------ links in a cell

  /** Shows the card for the link at the caret in a cell, or closes it when there isn't one. */
  private showLink(cell: HTMLElement) {
    if (this.slash || !hasLinkPopover(this.view.state)) return this.closeLink();
    const caret = caretOffset(cell);
    const at = caret === null ? null : linkInText(cell.textContent ?? "", caret);
    if (!at) return this.closeLink();
    const open = this.link;
    if (open && open.cell === cell && !open.form && open.at.from === at.from && open.at.to === at.to && open.at.label === at.label && open.at.url === at.url)
      return;
    const card = linkCard(at, {
      edit: this.editable ? () => this.editLink() : undefined,
      remove: this.editable && !at.bare ? () => this.replaceLink(at.label) : undefined,
    });
    this.placeLink(cell, at, card, false);
  }

  /** Swaps the card for the form for the link's text and URL. */
  private editLink() {
    const open = this.link;
    if (!open) return;
    const { cell, at } = open;
    const form = linkForm(at, (markdown) => this.replaceLink(markdown), () => {
      this.closeLink();
      this.focusCellAt(Number(cell.dataset.row), Number(cell.dataset.col), at.to, at.to);
    });
    form.addEventListener("focusout", (e) => {
      if (this.link?.dom === form && !form.contains(e.relatedTarget as Node)) this.closeLink();
    });
    form.style.left = open.dom.style.left;
    form.style.top = open.dom.style.top;
    this.placeLink(cell, at, form, true);
  }

  private placeLink(cell: HTMLElement, at: LinkAt, dom: HTMLElement, form: boolean) {
    const left = dom.style.left;
    const top = dom.style.top;
    this.closeLink();
    dom.classList.add("cm-tooltip", "cm-md-table-link");
    if (left) {
      dom.style.left = left;
      dom.style.top = top;
    } else {
      // Under the start of the link.
      const base = this.dom.getBoundingClientRect();
      const range = document.createRange();
      const node = cell.firstChild;
      if (node && node.nodeType === 3 && at.from < (node.textContent ?? "").length) range.setStart(node, at.from);
      else range.selectNodeContents(cell);
      const box = range.getClientRects()[0] ?? cell.getBoundingClientRect();
      dom.style.left = `${Math.max(0, box.left - base.left)}px`;
      dom.style.top = `${box.bottom - base.top + 4}px`;
    }
    this.dom.append(dom);
    this.link = { cell, at, dom, form };
  }

  /** Puts `markdown` in place of the link in its cell, then the caret after it. */
  private replaceLink(markdown: string) {
    const open = this.link;
    if (!open) return;
    const { cell, at } = open;
    const row = Number(cell.dataset.row);
    const col = Number(cell.dataset.col);
    const raw = cell.dataset.raw ?? "";
    this.closeLink();
    const range = this.change((source) => setCell(source, row, col, raw.slice(0, at.from) + markdown + raw.slice(at.to)));
    const view = range ? (tableViewAt(this.view, range.from) ?? this) : this;
    view.focusCellAt(row, col, at.from + markdown.length, at.from + markdown.length);
  }

  private closeLink() {
    const open = this.link;
    if (!open) return;
    // Removing the form blurs its field, which comes back here: forget it first.
    this.link = null;
    open.dom.remove();
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
    const markers = markersLength(lines[index], this.prefix);
    const offset = cellContentOffset(lines[index].slice(markers), Number(cell.dataset.col));
    return offset === null ? null : lineFrom + markers + offset;
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
    if (this.prefix) return this.leaveQuote(range, next);
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

  /** Below a quoted table: the quote's next line of text, or a new one in the quote. */
  private leaveQuote(range: TableRange, next: ReturnType<EditorState["doc"]["lineAt"]> | null) {
    const { doc } = this.view.state;
    const text = (line: typeof next) => (line ? line.text.slice(markersLength(line.text, this.prefix)) : "");
    const quoted = (line: typeof next) => !!line && markersLength(line.text, this.prefix) > 0;
    if (quoted(next) && text(next).trim()) {
      this.view.dispatch({ selection: { anchor: next!.from + markersLength(next!.text, this.prefix) }, scrollIntoView: true });
      return;
    }
    const after = next && next.number < doc.lines ? doc.line(next.number + 1) : null;
    if (quoted(next) && quoted(after)) {
      this.view.dispatch({ selection: { anchor: after!.from + markersLength(after!.text, this.prefix) }, scrollIntoView: true });
      return;
    }
    // A blank quoted line, so the new one isn't a row of the table.
    const insert = `\n${this.prefix.trimEnd()}\n${this.prefix}`;
    this.view.dispatch({ changes: { from: range.to, insert }, selection: { anchor: range.to + insert.length }, scrollIntoView: true });
  }

  private columnMenu() {
    const { col } = this.hover;
    this.openMenu(this.colHandle, [
      { label: "Insert column left", icon: ICONS.colLeft, run: () => this.structure((t) => insertColumn(t, col), this.hover.row, col) },
      { label: "Insert column right", icon: ICONS.colRight, run: () => this.structure((t) => insertColumn(t, col + 1), this.hover.row, col + 1) },
      { label: "Move column left", icon: ICONS.moveLeft, disabled: col === 0, run: () => this.move("col", col, col - 1) },
      {
        label: "Move column right",
        icon: ICONS.moveRight,
        disabled: col === this.table.align.length - 1,
        run: () => this.move("col", col, col + 1),
      },
      {
        label: "Delete column",
        icon: ICONS.delete,
        disabled: this.table.align.length < 2,
        run: () => this.structure((t) => deleteColumn(t, col), this.hover.row, col),
      },
    ], {
      label: "Align column",
      // Choosing the column's current alignment again sets it back to the default.
      choices: ALIGNMENTS.map(({ align, label, icon }) => {
        const pressed = this.table.align[col] === align;
        return { label, icon, pressed, run: () => this.align(col, pressed ? null : align) };
      }),
    });
    this.select((cell) => Number(cell.dataset.col) === col);
  }

  /** Sets a column's alignment on the delimiter row, keeping the caret's cell. */
  private align(col: number, align: Align) {
    this.closeMenu();
    const { row } = this.hover;
    const range = this.change((source) => setAlign(source, col, align));
    if (!range) return;
    (tableViewAt(this.view, range.from) ?? this).focusCell(row, col);
  }

  private rowMenu() {
    const { row } = this.hover;
    this.openMenu(this.rowHandle, [
      // The header is always the first row, so nothing goes above it.
      { label: "Insert row above", icon: ICONS.rowAbove, disabled: row === 0, run: () => this.structure((t) => insertRow(t, row), row, this.hover.col) },
      { label: "Insert row below", icon: ICONS.rowBelow, run: () => this.structure((t) => insertRow(t, row + 1), row + 1, this.hover.col) },
      // Moving the first body row up makes it the header, and the header the first body row.
      { label: "Move row up", icon: ICONS.moveUp, disabled: row === 0, run: () => this.move("row", row, row - 1) },
      { label: "Move row down", icon: ICONS.moveDown, disabled: row === this.table.rows.length - 1, run: () => this.move("row", row, row + 1) },
      { label: "Clear row", icon: ICONS.clear, run: () => this.structure((t) => clearRow(t, row), row, this.hover.col) },
      // The row starts a second table under a copy of the header; the first keeps at least one body row.
      { label: "Split table here", icon: ICONS.split, disabled: row < 2, run: () => this.split(row) },
      {
        // Deleting the header moves the first body row up to become it.
        label: row === 0 ? "Delete header row" : "Delete row",
        icon: ICONS.delete,
        disabled: this.table.rows.length < 2,
        run: () => this.structure((t) => deleteRow(t, row), Math.max(0, row - 1), this.hover.col),
      },
    ]);
    this.select((cell) => Number(cell.dataset.row) === row);
  }

  /** Splits the table in two at a row, keeping the caret in that row's cell in the new table. */
  private split(row: number) {
    this.closeMenu();
    const { col } = this.hover;
    const range = this.change((source) => {
      const table = parseTable(source);
      const parts = table && splitTable(table, row);
      return parts ? `${formatTable(parts[0])}\n\n${formatTable(parts[1])}` : source;
    });
    if (!range) return;
    // The first table is its header, delimiter and `row - 1` body rows; a blank line follows.
    const { doc } = this.view.state;
    const line = doc.lineAt(range.from).number + row + 2;
    if (line > doc.lines) return;
    const view = tableViewAt(this.view, range.from - doc.lineAt(range.from).from + doc.line(line).from);
    view?.focusCell(1, Math.min(col, view.table.align.length - 1));
  }

  /** Moves a row or column to `to`, keeping the caret in the moved cell. */
  private move(axis: "row" | "col", from: number, to: number) {
    const { row, col } = this.hover;
    if (axis === "row") this.structure((t) => moveRow(t, from, to), to, col);
    else this.structure((t) => moveColumn(t, from, to), row, to);
  }

  /**
   * Dragging a handle moves its row or column: past a few pixels it becomes a
   * drag, a line shows where it will land, and letting go moves it there. A
   * press that doesn't move is a click, and opens the menu as before.
   */
  private startDrag(e: PointerEvent, axis: "row" | "col") {
    if (!this.editable || e.button !== 0 || this.drag) return;
    const from = axis === "row" ? this.hover.row : this.hover.col;
    const start = { x: e.clientX, y: e.clientY };
    const drag = { axis, from, to: null as number | null, line: el("div", `cm-md-table-dropline cm-md-table-dropline-${axis}`) };
    const doc = this.dom.ownerDocument;
    const move = (ev: PointerEvent) => {
      if (drag.to === null && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
      if (drag.to === null) {
        this.closeMenu();
        this.dom.classList.add("dragging");
        this.dom.append(drag.line);
        this.select((cell) => Number(axis === "row" ? cell.dataset.row : cell.dataset.col) === from);
      }
      ev.preventDefault();
      drag.to = this.dropAt(drag, ev.clientX, ev.clientY);
    };
    const up = () => {
      doc.removeEventListener("pointermove", move);
      doc.removeEventListener("pointerup", up);
      doc.removeEventListener("pointercancel", up);
      const to = drag.to;
      this.endDrag();
      if (to === null) return;
      // The click that follows the drag isn't a click on the handle.
      this.dragged = true;
      window.setTimeout(() => (this.dragged = false));
      if (to !== from) this.move(axis, from, to);
    };
    this.drag = drag;
    doc.addEventListener("pointermove", move);
    doc.addEventListener("pointerup", up);
    doc.addEventListener("pointercancel", up);
  }

  /**
   * Where a dragged row or column would land for the pointer at (x, y), as its
   * new index, and moves the drop line to the gap it would go into.
   */
  private dropAt(drag: NonNullable<TableView["drag"]>, x: number, y: number): number {
    const table = this.scroller.querySelector("table");
    if (!table) return drag.from;
    const base = this.dom.getBoundingClientRect();
    const bounds = table.getBoundingClientRect();
    // Columns are measured on the last row: an image grid can hide its header.
    const last = table.rows[table.rows.length - 1];
    const boxes = (drag.axis === "row" ? Array.from(table.rows) : Array.from(last?.cells ?? [])).map((node) =>
      node.getBoundingClientRect(),
    );
    if (!boxes.length) return drag.from;
    const row = drag.axis === "row";
    // The gap before the first box whose middle is past the pointer.
    let gap = boxes.findIndex((box) => (row ? y < box.top + box.height / 2 : x < box.left + box.width / 2));
    if (gap < 0) gap = boxes.length;
    const edge = gap < boxes.length ? (row ? boxes[gap].top : boxes[gap].left) : row ? boxes[gap - 1].bottom : boxes[gap - 1].right;
    const { style } = drag.line;
    if (row) {
      style.left = `${bounds.left - base.left}px`;
      style.width = `${bounds.width}px`;
      style.top = `${edge - base.top}px`;
    } else {
      style.top = `${bounds.top - base.top}px`;
      style.height = `${bounds.height}px`;
      style.left = `${edge - base.left}px`;
    }
    // Taking the row or column out shifts the gaps after it back by one.
    return gap > drag.from ? gap - 1 : gap;
  }

  private endDrag() {
    if (!this.drag) return;
    this.drag.line.remove();
    this.drag = null;
    this.dom.classList.remove("dragging");
    this.select(() => false);
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

  private openMenu(anchor: HTMLElement, items: MenuItem[], choices?: MenuChoices) {
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
    if (choices) {
      const row = el("div", "cm-md-table-menu-choices");
      row.setAttribute("role", "group");
      row.setAttribute("aria-label", choices.label);
      row.append(Object.assign(el("span", ""), { textContent: choices.label }));
      for (const choice of choices.choices) {
        const entry = button("", choice.label);
        entry.setAttribute("role", "menuitemradio");
        entry.setAttribute("aria-checked", String(choice.pressed));
        entry.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${choice.icon}"/></svg>`;
        entry.addEventListener("click", choice.run);
        row.append(entry);
      }
      menu.append(row);
    }
    const base = this.dom.getBoundingClientRect();
    const box = anchor.getBoundingClientRect();
    menu.style.left = `${Math.max(0, box.left - base.left)}px`;
    this.dom.append(menu);
    // The menu can't rise above the editor's scroller (CodeMirror makes it a
    // stacking context that clips), so it opens upward when the room below,
    // above the sticky status bar, is too short and there's more room above.
    const { top, bottom } = this.menuRoom();
    const height = menu.offsetHeight;
    const up = box.bottom + 4 + height > bottom && box.top - top > bottom - box.bottom;
    menu.style.top = up ? `${box.top - base.top - 4 - height}px` : `${box.bottom - base.top + 4}px`;
    this.dom.classList.add("menu-open");
    this.menu = menu;
    window.setTimeout(() => document.addEventListener("mousedown", this.closeMenuListener));
  }

  /** The band of the window a menu can show in: inside the editor's scroller, between its sticky bars. */
  private menuRoom(): { top: number; bottom: number } {
    let top = 0;
    let bottom = window.innerHeight;
    const scroller = this.view.scrollDOM.getBoundingClientRect();
    if (scroller.height) {
      top = Math.max(top, scroller.top);
      bottom = Math.min(bottom, scroller.bottom);
    }
    const editor = this.dom.closest(".mde");
    const toolbar = editor?.querySelector(".mde-toolbar")?.getBoundingClientRect();
    const status = editor?.querySelector(".mde-status")?.getBoundingClientRect();
    if (toolbar?.height) top = Math.max(top, toolbar.bottom);
    if (status?.height) bottom = Math.min(bottom, status.top);
    return { top, bottom };
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
      // A quoted table's markers aren't part of its cells.
      const first = state.doc.lineAt(from).text;
      const depth = (/^(?:[ \t]{0,3}>[ \t]?)*/.exec(first)?.[0].match(/>/g) ?? []).length;
      const markers = depth ? (quoteMarkers(depth).exec(line.text)?.[0].length ?? 0) : 0;
      const text = line.text.slice(markers);
      const lineFrom = line.from + markers;
      const before = text.slice(0, Math.max(0, head - lineFrom));
      const pipes = (before.match(/(?<!\\)\|/g) ?? []).length;
      const col = Math.max(0, text.trimStart().startsWith("|") ? pipes - 1 : pipes);
      // The selection as offsets into the cell's text (on the delimiter line, its start).
      const content = index === 1 ? null : cellContentOffset(text, col);
      const offset = (pos: number) => (content === null || pos < lineFrom ? 0 : Math.max(0, pos - lineFrom - content));
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
