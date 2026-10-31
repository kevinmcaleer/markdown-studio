import { syntaxTree } from "@codemirror/language";
import { Facet, StateField, type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, runScopeHandlers, ViewPlugin, WidgetType, type DecorationSet } from "@codemirror/view";
import { parseCalloutHeader } from "./callouts";
import { clearCellFormatting, cellMarkActive, toggleCellMark, type CellEdit } from "./format/cellMarks";
import type { Mark } from "./format/formatting";
import type { FormatItem } from "./format/items";
import { CELL_TOOLBAR, ITEMS, iconSvg, itemTitle } from "./format/items";
import { hasLinkPopover, linkCard, linkForm, linkInText, type LinkAt } from "./format/linkPopover";
import { hasSelectionToolbar } from "./format/selectionToolbar";
import { cellHasImage, isImageGrid } from "./imageGrid";
import { renderCell } from "./markdown";
import { columnWidths, fitColumnDashes, widthsToDashes } from "./tableWidths";
import {
  alignBlock,
  blockAlign,
  blockClipboard,
  blockHasMark,
  blockOf,
  blockSize,
  clearBlock,
  clearBlockFormatting,
  deleteBlockColumns,
  deleteBlockRows,
  inBlock,
  toggleBlockMark,
  wholeColumns,
  wholeRows,
  type Block,
  type CellRange,
} from "./tableSelection";
import { applyCommand, commandsOf, filterCommands, hasSlashMenu, type SlashCommand } from "./slashMenu";
import { rememberedHeight, rememberHeight, sizePictures } from "./steadyScroll";
import {
  deleteColumn,
  clearRow,
  splitTable,
  deleteRow,
  diff,
  cellText,
  escapeCell,
  formatTable,
  insertColumn,
  insertRow,
  moveColumn,
  moveRow,
  parseTable,
  pasteCells,
  rawOffset,
  setAlign,
  setCell,
  setWidths,
  spreadsheetCells,
  textOffset,
  type Align,
  type Table,
} from "./markdownTable";

// In the live view a table is drawn as a table, like Claude docs: type in its
// cells, add a row or column from the bars below and to the right, and insert
// or delete rows and columns from the handle on each one, and drag a handle
// to move its row or column (or use the menu's Move items). Every change is an
// edit to the Markdown underneath, so co-editing and undo work as for text.
// Dragging the edge between two columns sets their widths, as the dashes on
// the delimiter row (tableWidths.ts); "Reset column widths" clears them.
//
// Dragging across cells, Shift+clicking one, Shift+arrows, or clicking (and
// Shift+clicking) the row and column handles picks a block of cells. A bar
// over it applies bold, italic and the other marks, alignment, clearing and
// deleting to the whole block, and it copies, cuts and pastes as a block
// (tableSelection.ts).

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

/**
 * A note to show above a table, or null for none: a tip on how the host
 * fills in a Bill of Materials, say. It's given what a renderer is given.
 */
export type TableNote = (table: TableRendererContext) => HTMLElement | null;

/** The table notes; each one's element shows above the table, in order. */
export const tableNotes = Facet.define<TableNote>();

/** What a stepper is asked about: one body cell, with its column's header. */
export type TableStepperContext = {
  /** The column's header, as plain text. */
  header: string;
  /** The cell's row, as each cell's Markdown. */
  row: string[];
  /** The row's place in the table: 1 is the first body row (0 is the header). */
  rowIndex: number;
  col: number;
  /** The cell's number as written, or "" when it's empty. */
  value: string;
  /** The text of the heading the table sits under, if there is one. */
  heading: string | null;
};

/** The bounds of a cell's stepper; each defaults (0, no limit, 1). */
export type TableStepperSpec = { min?: number; max?: number; step?: number };

/**
 * Up and down buttons on a whole-number cell (a Bill of Materials' Qty, say):
 * true or the bounds to show them, null or false for none. Only asked about
 * body cells that are empty or a whole number.
 */
export type TableStepper = (cell: TableStepperContext) => TableStepperSpec | boolean | null;

/** The table steppers; the first to answer for a cell wins. */
export const tableSteppers = Facet.define<TableStepper>();

/** What a cell action is asked about: one body cell, as for a stepper, with its Markdown. */
export type TableCellActionContext = {
  /** The column's header, as plain text. */
  header: string;
  /** The cell's row, as each cell's Markdown. */
  row: string[];
  /** The row's place in the table: 1 is the first body row (0 is the header). */
  rowIndex: number;
  col: number;
  /** The cell's Markdown. */
  value: string;
  /** The text of the heading the table sits under, if there is one. */
  heading: string | null;
};

/** A cell's button: its label, a tooltip, an SVG icon (markup), and what a click does. */
export type TableCellActionSpec = {
  label: string;
  title?: string;
  icon?: string;
  /** Runs on a click, given the cell and the button (to open a dialog beside it, say). */
  run: (cell: TableCellActionContext, button: HTMLElement) => void;
};

/**
 * A small button at the right of a body cell, shown on hover or focus: "New
 * part" on a Bill of Materials row not yet linked to a catalog part, say. It's
 * given each body cell and returns the button, or null for none. What the
 * click does is the host's (it can edit the document as it likes).
 */
export type TableCellAction = (cell: TableCellActionContext) => TableCellActionSpec | null;

/** The table cell actions; the first to answer for a cell wins. */
export const tableCellActions = Facet.define<TableCellAction>();

/** What a column action is asked about: one column of a table. */
export type TableColumnContext = {
  /** The column's header, as plain text. */
  header: string;
  col: number;
  /** The table's rows, header first, as each cell's Markdown. */
  rows: string[][];
  /** The text of the heading the table sits under, if there is one. */
  heading: string | null;
};

/** One choice in a column action's list, and the table it makes. */
export type TableColumnOption = {
  label: string;
  /** The column's current choice, shown ticked. */
  checked?: boolean;
  /** The rows (header first, each cell's Markdown) once it's chosen. */
  apply: (rows: string[][]) => string[][];
};

/**
 * An extra entry in a column's menu that opens a list of choices: a Bill of
 * Materials' Price column offering currencies, say. Null for none.
 * `icon` is an SVG path on a 16 × 16 grid, drawn like the menu's own icons.
 */
export type TableColumnAction = (
  column: TableColumnContext,
) => { label: string; icon?: string; options: TableColumnOption[] } | null;

/** The column actions; each one that answers adds an entry to the column menu. */
export const tableColumnActions = Facet.define<TableColumnAction>();

/** A host's note, as a block above its table. */
class TableNoteWidget extends WidgetType {
  constructor(readonly element: HTMLElement) {
    super();
  }

  // The same note again keeps the one on screen (and its listeners).
  eq(other: TableNoteWidget) {
    return other.element.outerHTML === this.element.outerHTML;
  }

  toDOM() {
    const dom = el("div", "cm-md-table-note");
    dom.contentEditable = "false";
    dom.append(this.element);
    return dom;
  }

  // Its buttons are the host's, not the editor's.
  ignoreEvent() {
    return true;
  }
}

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
        const table = parseTable(source);
        if (table) {
          for (const note of state.facet(tableNotes)) {
            const element = note({ rows: table.rows.map((row) => [...row]), heading });
            if (element) tables.push(Decoration.widget({ widget: new TableNoteWidget(element), block: true, side: -1 }).range(from));
          }
          tables.push(Decoration.replace({ widget: new TableWidget(source, !state.readOnly, heading, prefix, box), block: true }).range(from, to));
        }
      }
      return false;
    },
  });
  return Decoration.set(tables, true);
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
    rememberHeight(dom, this.heightKey);
    return dom;
  }

  updateDOM(dom: HTMLElement) {
    const table = views.get(dom);
    if (!table) return false;
    table.update(this);
    rememberHeight(dom, this.heightKey);
    return true;
  }

  /** What it was drawn as, for steadyScroll.ts to remember its height by. */
  get heightKey() {
    return `table\n${this.prefix}\n${this.box?.callout ?? ""}\n${this.heading ?? ""}\n${this.source}`;
  }

  get estimatedHeight() {
    return rememberedHeight(this.heightKey) ?? this.source.split("\n").length * 40;
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
  eraser: "M6.5 13.5h7M3 10.5 9.5 4l3.5 3.5-6 6H4.5zM6 7.5l3.5 3.5",
  deleteRows: "M2.5 3.5h11v4h-11zM2.5 9.5h4M10.5 9.5l3 3M13.5 9.5l-3 3",
  deleteCols: "M3.5 2.5h4v11h-4zM9.5 2.5v4M10 9.5l3 3M13 9.5l-3 3",
  alignLeft: "M2.5 3.5h11M2.5 6.5h7M2.5 9.5h11M2.5 12.5h7",
  alignCenter: "M2.5 3.5h11M4.5 6.5h7M2.5 9.5h11M4.5 12.5h7",
  alignRight: "M2.5 3.5h11M6.5 6.5h7M2.5 9.5h11M6.5 12.5h7",
  resetWidths: "M2.5 3v10M13.5 3v10M5 8h6M6.5 6 4.5 8l2 2M9.5 6l2 2-2 2",
  choose: "M2.5 4h11M2.5 8h11M2.5 12h7",
  check: "M3 8.5 6.5 12 13 4.5",
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
  private readonly scroller = el("div", "cm-md-table-scroll cm-md-select-box");
  private readonly colHandle = button("cm-md-table-handle cm-md-table-colhandle", "Column options");
  private readonly rowHandle = button("cm-md-table-handle cm-md-table-rowhandle", "Row options");
  private readonly addCol = button("cm-md-table-add cm-md-table-addcol", "Add column");
  private readonly addRow = button("cm-md-table-add cm-md-table-addrow", "Add row");
  private readonly more = button("cm-md-table-more", "Table options");
  /** Up and down buttons on a number cell (see `tableStepper`), and the cell they're on. */
  private readonly stepper = el("div", "cm-md-table-stepper");
  private readonly stepUp = button("cm-md-table-step", "Increase (Alt+\u2191)");
  private readonly stepDown = button("cm-md-table-step", "Decrease (Alt+\u2193)");
  private stepperCell: { row: number; col: number } | null = null;
  /** The host's button on a cell (see `tableCellAction`), and what it's for. */
  private readonly action = button("cm-md-table-action", "");
  private actionAt: { context: TableCellActionContext; spec: TableCellActionSpec } | null = null;
  private menu: HTMLElement | null = null;
  /** The edges between columns, dragged to set their widths. */
  private grips: HTMLElement[] = [];
  /** A column edge being dragged, and the label showing the two widths. */
  private resizing: { label: HTMLElement; stop: () => void } | null = null;
  private slash: CellSlash | null = null;
  private link: { cell: HTMLElement; at: LinkAt; dom: HTMLElement; form: boolean } | null = null;
  /** The formatting toolbar over a selection in a cell, and the selection it's for. */
  private format: { cell: HTMLElement; from: number; to: number; dom: HTMLElement; buttons: [HTMLButtonElement, FormatItem][] } | null = null;
  /** A mouse button is down in a cell: the toolbar waits until it's let go, as in the note. */
  private selecting = false;
  private readonly selectionListener = () => this.updateFormat();
  private hover = { row: 0, col: 0 };
  /** A row or column being dragged by its handle, and the line showing where it will go. */
  private drag: { axis: "row" | "col"; from: number; to: number | null; line: HTMLElement } | null = null;
  /** Set for the click that ends a drag, so it doesn't open the handle's menu. */
  private dragged = false;
  /** The block of cells picked (see tableSelection.ts), and the bar of actions over it. */
  private range: CellRange | null = null;
  private rangeBar: { dom: HTMLElement; buttons: Map<string, HTMLButtonElement> } | null = null;
  /** Shift is held over the cells: the handles follow the mouse again, to Shift+click another row's or column's. */
  private followShift = false;
  /** Clicking outside the table puts the block down. */
  private readonly outsideListener = (event: Event) => {
    if (this.range && !this.dom.contains(event.target as Node)) this.setRange(null);
  };
  /** Copy, cut and paste of a block: with nothing selected, they go to the document, not the table. */
  private readonly clipboardListener = (event: Event) => this.clipboard(event as ClipboardEvent);
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
    this.stepUp.innerHTML = '<svg viewBox="0 0 16 10" aria-hidden="true"><path d="M4 7l4-4 4 4"/></svg>';
    this.stepDown.innerHTML = '<svg viewBox="0 0 16 10" aria-hidden="true"><path d="M4 3l4 4 4-4"/></svg>';
    this.stepper.append(this.stepUp, this.stepDown);
    dom.append(this.scroller, this.colHandle, this.rowHandle, this.addCol, this.addRow, this.more, this.stepper, this.action, this.preview);
    this.render();

    // Clicking the drawing edits the table (its links aren't followed while editing).
    this.preview.addEventListener("click", (e) => {
      if (!this.editable) return;
      e.preventDefault();
      this.focusCell(this.table.rows.length > 1 ? 1 : 0, 0);
    });
    dom.addEventListener("focusout", () =>
      window.setTimeout(() => {
        if (this.range && !this.dom.contains(this.dom.ownerDocument.activeElement)) this.setRange(null);
        this.redraw();
      }),
    );

    dom.addEventListener("mouseover", (e) => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>("th, td");
      // With Shift held, the handles follow the mouse even while a menu is open, to Shift+click another.
      this.followShift = e.shiftKey;
      if (cell && (!this.menu || e.shiftKey) && !this.drag) this.setHover(Number(cell.dataset.row), Number(cell.dataset.col));
    });
    dom.addEventListener("focusin", (e) => {
      const cell = e.target as HTMLElement;
      if (!isCell(cell)) return;
      setCellText(cell, cellText(cell.dataset.raw ?? ""));
      this.setHover(Number(cell.dataset.row), Number(cell.dataset.col));
    });
    dom.addEventListener("focusout", (e) => {
      const cell = e.target as HTMLElement;
      if (!isCell(cell)) return;
      if (this.slash?.cell === cell) this.closeSlash();
      // Into the link's card or form keeps it open; anywhere else closes it.
      if (this.link?.cell === cell && !this.link.dom.contains((e as FocusEvent).relatedTarget as Node)) this.closeLink();
      if (this.format?.cell === cell) this.closeFormat();
      cell.innerHTML = renderCell(cell.dataset.raw ?? "");
      sizePictures(cell);
    });
    dom.addEventListener("input", (e) => {
      const cell = e.target as HTMLElement;
      if (!isCell(cell)) return;
      const text = cell.textContent ?? "";
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
      const cell = (e.target as HTMLElement).closest<HTMLElement>("th, td");
      if (e.button !== 0 || !cell || !this.scroller.contains(cell)) return;
      const at = { row: Number(cell.dataset.row), col: Number(cell.dataset.col) };
      if (e.shiftKey && this.editable) {
        // Shift+click picks the cells from the caret's cell (or the block's first) to this one.
        const anchor = this.range?.anchor ?? this.focusedCell();
        if (anchor && (anchor.row !== at.row || anchor.col !== at.col || this.range)) {
          e.preventDefault();
          this.closeMenu();
          // Whole rows (or columns) picked from their handles stay whole.
          const block = this.range ? blockOf(this.range) : null;
          if (block && wholeRows(this.table, block) && !wholeColumns(this.table, block)) this.setRange(this.line("row", anchor.row, at.row));
          else if (block && wholeColumns(this.table, block) && !wholeRows(this.table, block)) this.setRange(this.line("col", anchor.col, at.col));
          else this.setRange({ anchor, head: at });
          return;
        }
      }
      // A plain click goes back to typing in a cell.
      if (this.range) this.setRange(null, false);
      // Selecting text in a cell: the toolbar shows once the mouse is let go.
      this.selecting = true;
      this.closeFormat();
      // Dragging out of the cell into another picks the cells between.
      const move = (ev: MouseEvent) => {
        if (!(ev.buttons & 1) || !this.editable) return;
        const over = (ev.target as HTMLElement).closest?.<HTMLElement>("th, td");
        if (!over || !this.scroller.contains(over)) return;
        const head = { row: Number(over.dataset.row), col: Number(over.dataset.col) };
        if (!this.range && head.row === at.row && head.col === at.col) return;
        if (this.range && this.range.head.row === head.row && this.range.head.col === head.col) return;
        this.dom.classList.add("range-selecting");
        this.setRange({ anchor: at, head });
      };
      const up = () => {
        document.removeEventListener("mouseup", up);
        document.removeEventListener("mousemove", move);
        this.dom.classList.remove("range-selecting");
        this.selecting = false;
        window.setTimeout(() => this.updateFormat());
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
    document.addEventListener("selectionchange", this.selectionListener);
    document.addEventListener("mousedown", this.outsideListener);
    for (const type of ["copy", "cut", "paste"]) document.addEventListener(type, this.clipboardListener);

    this.addRow.addEventListener("click", () => this.structure((t) => insertRow(t, t.rows.length), this.table.rows.length, 0));
    this.addCol.addEventListener("click", () => this.structure((t) => insertColumn(t, t.align.length), 0, this.table.align.length));
    this.colHandle.addEventListener("click", (e) => this.dragged || this.handleClick("col", e.shiftKey));
    this.rowHandle.addEventListener("click", (e) => this.dragged || this.handleClick("row", e.shiftKey));
    this.colHandle.addEventListener("pointerdown", (e) => this.startDrag(e, "col"));
    this.rowHandle.addEventListener("pointerdown", (e) => this.startDrag(e, "row"));
    this.more.addEventListener("click", () => this.tableMenu());
    this.stepUp.addEventListener("click", () => this.stepperCell && this.step(this.stepperCell.row, this.stepperCell.col, 1));
    this.stepDown.addEventListener("click", () => this.stepperCell && this.step(this.stepperCell.row, this.stepperCell.col, -1));
    // Keeps the caret where it is: the host's dialog, say, takes the focus itself.
    this.action.addEventListener("mousedown", (e) => e.preventDefault());
    this.action.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const at = this.actionAt;
      if (at) at.spec.run(at.context, this.action);
    });
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
    this.resizing?.stop();
    this.closeMenu();
    this.closeSlash();
    this.closeLink();
    this.closeFormat();
    this.closeRangeBar();
    document.removeEventListener("selectionchange", this.selectionListener);
    document.removeEventListener("mousedown", this.outsideListener);
    for (const type of ["copy", "cut", "paste"]) document.removeEventListener(type, this.clipboardListener);
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
    sizePictures(this.preview);
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
          setCellText(cell, cellText(raw));
          caretAtEnd(cell);
        } else {
          cell.innerHTML = renderCell(raw);
          sizePictures(cell);
        }
      }
    }
    if (!this.resizing) setColumnWidths(table, columnWidths(this.table.dashes));
    this.makeGrips(align.length);
    if (focused && !sameShape) this.focusCell(Math.min(focused.row, rows.length - 1), Math.min(focused.col, align.length - 1));
    this.setHover(Math.min(this.hover.row, rows.length - 1), Math.min(this.hover.col, align.length - 1));
    if (this.range) {
      const clamp = ({ row, col }: { row: number; col: number }) => ({ row: Math.min(row, rows.length - 1), col: Math.min(col, align.length - 1) });
      this.range = { anchor: clamp(this.range.anchor), head: clamp(this.range.head) };
    }
    this.paint();
    this.updateRangeBar();
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
    if (this.range) this.setRange(null, false);
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

  /** Puts the caret in a cell, selecting from..to of its Markdown (offsets in the Markdown, where a line break is `<br>`). */
  focusCellAt(row: number, col: number, from: number, to: number) {
    if (!this.editable) return;
    this.edit();
    if (this.range) this.setRange(null, false);
    const cell = this.cell(row, col);
    if (!cell || !this.editable) return;
    cell.focus();
    const raw = cell.dataset.raw ?? "";
    from = textOffset(raw, from);
    to = textOffset(raw, to);
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
    this.placeGrips();
    this.placeStepper(row, col, cell, base);
    this.placeAction(row, col, cell, base);
    this.pinHandles();
  }

  /**
   * While a block is picked, the row and column handles stay on it (at the
   * middle of its rows and of its columns) instead of following the mouse, so
   * one click opens the menu for all its rows or columns.
   */
  private pinHandles() {
    const pinned = !!this.range && !this.followShift;
    this.dom.classList.toggle("handles-pinned", pinned);
    if (!pinned) return;
    const block = blockOf(this.range!);
    const first = this.cell(block.top, block.left);
    const last = this.cell(block.bottom, block.right);
    if (!first || !last) return;
    const base = this.dom.getBoundingClientRect();
    const a = first.getBoundingClientRect();
    const b = last.getBoundingClientRect();
    this.colHandle.style.left = `${(a.left + b.right) / 2 - base.left}px`;
    this.rowHandle.style.top = `${(a.top + b.bottom) / 2 - base.top}px`;
  }

  // ------------------------------------------------------------ number steppers

  /** The bounds of a cell's stepper, or null when it hasn't one (see `tableStepper`). */
  private stepperAt(row: number, col: number): Required<TableStepperSpec> | null {
    if (!this.editable || row < 1) return null;
    const steppers = this.view.state.facet(tableSteppers);
    const cells = this.table.rows[row];
    if (!steppers.length || !cells || col >= cells.length) return null;
    const value = cellText(cells[col]).trim();
    if (value && !/^-?\d+$/.test(value)) return null;
    const context: TableStepperContext = {
      header: cellText(this.table.rows[0][col] ?? "").trim(),
      row: [...cells],
      rowIndex: row,
      col,
      value,
      heading: this.heading,
    };
    for (const stepper of steppers) {
      const answer = stepper(context);
      if (!answer) continue;
      const spec = answer === true ? {} : answer;
      return { min: spec.min ?? 0, max: spec.max ?? Infinity, step: spec.step && spec.step > 0 ? spec.step : 1 };
    }
    return null;
  }

  /** The cell's number, an empty cell counting as nothing yet. */
  private stepValue(row: number, col: number): number | null {
    const value = cellText(this.table.rows[row]?.[col] ?? "").trim();
    return value ? Number(value) : null;
  }

  /** Shows the stepper at the right of a number cell, or hides it. */
  private placeStepper(row: number, col: number, cell: HTMLElement, base: DOMRect) {
    const spec = this.stepperAt(row, col);
    this.stepperCell = spec ? { row, col } : null;
    this.stepper.classList.toggle("on", !!spec);
    if (!spec) return;
    const value = this.stepValue(row, col);
    this.stepUp.disabled = (value ?? spec.min - spec.step) + spec.step > spec.max;
    this.stepDown.disabled = value === null || value - spec.step < spec.min;
    const box = cell.getBoundingClientRect();
    this.stepper.style.left = `${box.right - base.left - 4}px`;
    this.stepper.style.top = `${box.top - base.top + box.height / 2}px`;
  }

  // ------------------------------------------------------------ cell actions

  /** The host's button for a body cell, or null (see `tableCellAction`). */
  cellActionAt(row: number, col: number): { context: TableCellActionContext; spec: TableCellActionSpec } | null {
    if (!this.editable || row < 1) return null;
    const actions = this.view.state.facet(tableCellActions);
    const cells = this.table.rows[row];
    if (!actions.length || !cells || col >= cells.length) return null;
    const context: TableCellActionContext = {
      header: cellText(this.table.rows[0][col] ?? "").trim(),
      row: [...cells],
      rowIndex: row,
      col,
      value: cells[col],
      heading: this.heading,
    };
    for (const action of actions) {
      const spec = action(context);
      if (spec) return { context, spec };
    }
    return null;
  }

  /** Shows the host's button at the right of a cell (left of a stepper there), or hides it. */
  private placeAction(row: number, col: number, cell: HTMLElement, base: DOMRect) {
    const at = this.cellActionAt(row, col);
    this.actionAt = at;
    this.action.classList.toggle("on", !!at);
    if (!at) return;
    const { spec } = at;
    this.action.innerHTML = spec.icon ?? "";
    const label = document.createElement("span");
    label.textContent = spec.label;
    this.action.append(label);
    this.action.title = spec.title ?? spec.label;
    this.action.setAttribute("aria-label", spec.title ?? spec.label);
    const box = cell.getBoundingClientRect();
    const right = box.right - base.left - 4 - (this.stepperCell ? 22 : 0);
    this.action.style.left = `${right}px`;
    this.action.style.top = `${box.top - base.top + box.height / 2}px`;
  }

  /** Adds `step` to a number cell (or takes it away); false when the cell has no stepper. */
  private step(row: number, col: number, direction: 1 | -1): boolean {
    const spec = this.stepperAt(row, col);
    if (!spec) return false;
    const value = this.stepValue(row, col);
    // An empty cell goes up to the first number it can hold, and no lower.
    let next = value === null ? (direction > 0 ? Math.max(spec.min, spec.step) : null) : value + direction * spec.step;
    if (next === null || next < spec.min || next > spec.max) return true;
    next = Math.round(next);
    this.change((source) => setCell(source, row, col, String(next)));
    return true;
  }

  /** One grip on each edge between two columns. */
  private makeGrips(columns: number) {
    const wanted = this.editable ? Math.max(0, columns - 1) : 0;
    while (this.grips.length > wanted) this.grips.pop()!.remove();
    while (this.grips.length < wanted) {
      const col = this.grips.length;
      const grip = el("div", "cm-md-table-grip");
      grip.title = "Drag to change the column widths; double-click to fit the column to its content";
      grip.addEventListener("mousedown", (e) => e.preventDefault());
      grip.addEventListener("pointerdown", (e) => this.startResize(e, col));
      grip.addEventListener("dblclick", (e) => {
        e.preventDefault();
        this.fitColumn(col);
      });
      this.grips.push(grip);
      this.dom.append(grip);
    }
  }

  /** Puts each grip on its column edge, the height of the table. */
  private placeGrips() {
    const table = this.scroller.querySelector("table");
    const last = table?.rows[table.rows.length - 1];
    if (!table || !last) return;
    const base = this.dom.getBoundingClientRect();
    const bounds = table.getBoundingClientRect();
    this.grips.forEach((grip, col) => {
      const cell = last.cells[col];
      if (!cell) return;
      const { style } = grip;
      style.left = `${cell.getBoundingClientRect().right - base.left}px`;
      style.top = `${bounds.top - base.top}px`;
      style.height = `${bounds.height}px`;
    });
  }

  /**
   * Dragging the edge after column `col` moves width between it and the next
   * column, in steps of 5% (each keeps at least 10%); letting go writes every column's width as dashes
   * on the delimiter row. Ending with all the columns the same width clears
   * them, which leaves the widths to the browser again.
   */
  private startResize(e: PointerEvent, col: number) {
    if (!this.editable || e.button !== 0 || this.resizing || this.drag) return;
    const table = this.scroller.querySelector("table");
    const last = table?.rows[table.rows.length - 1];
    if (!table || !last) return;
    e.preventDefault();
    e.stopPropagation();
    this.closeMenu();
    const measured = Array.from(last.cells).map((cell) => cell.getBoundingClientRect().width);
    const px = measured.reduce((sum, w) => sum + w, 0);
    if (!px || measured.length < col + 2) return;
    const start = widthsToDashes(columnWidths(this.table.dashes) ?? measured.map((w) => (w / px) * 100));
    const total = start.reduce((sum, n) => sum + n, 0);
    const pair = start[col] + start[col + 1];
    if (pair < 2) return;
    // A column keeps at least 10% (two dashes) while dragging, where there's room.
    const least = pair >= 4 ? 2 : 1;
    let units = start;
    const startX = e.clientX;
    const grip = this.grips[col];
    const label = el("div", "cm-md-table-widthlabel");
    const percent = (n: number) => `${Math.round((n / total) * 100)}%`;
    const show = () => {
      setColumnWidths(table, units.map((n) => (n / total) * 100));
      label.textContent = `${percent(units[col])} · ${percent(units[col + 1])}`;
      this.placeGrips();
      const base = this.dom.getBoundingClientRect();
      label.style.left = `${grip.getBoundingClientRect().left - base.left + grip.offsetWidth / 2}px`;
      label.style.top = grip.style.top;
    };
    const doc = this.dom.ownerDocument;
    const move = (ev: PointerEvent) => {
      ev.preventDefault();
      const left = Math.max(least, Math.min(pair - least, start[col] + Math.round(((ev.clientX - startX) / px) * total)));
      if (left === units[col]) return;
      units = start.slice();
      units[col] = left;
      units[col + 1] = pair - left;
      if (!label.isConnected) {
        this.dom.classList.add("resizing");
        this.dom.append(label);
      }
      show();
    };
    const stop = () => {
      doc.removeEventListener("pointermove", move);
      doc.removeEventListener("pointerup", up);
      doc.removeEventListener("pointercancel", up);
      label.remove();
      grip.classList.remove("active");
      this.dom.classList.remove("resizing");
      this.resizing = null;
    };
    const up = () => {
      stop();
      if (units.every((n, i) => n === start[i])) {
        setColumnWidths(table, columnWidths(this.table.dashes));
        return;
      }
      const dashes = units;
      this.change((source) => setWidths(source, columnWidths(dashes) ? dashes : null));
    };
    // Nothing changes until the pointer moves, so a click (or a double-click) leaves the columns be.
    this.resizing = { label, stop };
    grip.classList.add("active");
    doc.addEventListener("pointermove", move);
    doc.addEventListener("pointerup", up);
    doc.addEventListener("pointercancel", up);
  }

  /**
   * Double-clicking the edge after column `col` fits that column to its
   * content: as wide as its longest line, so nothing in it wraps where
   * there's room, rounded up to 5%. The other columns share the rest in
   * proportion, each keeping at least 10%.
   */
  private fitColumn(col: number) {
    if (!this.editable) return;
    const table = this.scroller.querySelector("table");
    const last = table?.rows[table.rows.length - 1];
    if (!table || !last) return;
    const measured = Array.from(last.cells).map((cell) => cell.getBoundingClientRect().width);
    const px = measured.reduce((sum, w) => sum + w, 0);
    if (!px || col >= measured.length - 1) return;
    const current = columnWidths(this.table.dashes) ?? measured.map((w) => (w / px) * 100);
    const dashes = fitColumnDashes(current, col, (contentWidth(table, col) / px) * 100);
    this.change((source) => setWidths(source, columnWidths(dashes) ? dashes : null));
  }

  /** Clears the widths: every delimiter cell back to `---`. */
  private resetWidths() {
    this.closeMenu();
    this.change((source) => setWidths(source, null));
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
    if (e.target === this.dom && this.range && !this.menu) return this.rangeKey(e);
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
    const shortcut = mod && !e.altKey ? cellShortcut(e) : null;
    if (shortcut) {
      // The note's formatting keys, on the cell's text (not the browser's own <b> and <i>).
      e.preventDefault();
      this.formatCell(cell, shortcut);
      return;
    }
    if (this.format && e.key === "Escape") {
      // Puts the toolbar away; the selection stays.
      e.preventDefault();
      this.closeFormat();
      return;
    }
    if (e.key === "Enter" && e.shiftKey && !mod) {
      // A new line in the cell: a <br> in the Markdown, a line break while typing.
      e.preventDefault();
      insertLineBreak(cell);
      cell.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertLineBreak" }));
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
    } else if (e.shiftKey && !mod && !e.altKey && this.shiftArrowOut(cell, e.key, row, col)) {
      // Shift+arrow out of a cell's text picks it and the next cell.
      e.preventDefault();
    } else if (e.altKey && !mod && (e.key === "ArrowUp" || e.key === "ArrowDown") && this.stepperAt(row, col)) {
      // Alt+Up and Alt+Down step a number cell, as its stepper's buttons do.
      e.preventDefault();
      this.step(row, col, e.key === "ArrowUp" ? 1 : -1);
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

  // ------------------------------------------------------------ formatting in a cell

  /** Shows the formatting toolbar over the selection in a cell, or puts it away when there isn't one. */
  private updateFormat() {
    if (this.selecting) return;
    if (this.range) return this.closeFormat();
    const picked = this.editable && !this.menu && !this.slash && !this.link?.form && hasSelectionToolbar(this.view.state) ? cellSelection(this.dom) : null;
    if (!picked || !(picked.cell.textContent ?? "").slice(picked.from, picked.to).trim()) return this.closeFormat();
    const { cell, from, to, rect } = picked;
    let open = this.format;
    if (!open || open.cell !== cell) {
      this.closeFormat();
      const dom = el("div", "cm-tooltip cm-format-mini cm-md-table-format");
      dom.setAttribute("role", "toolbar");
      dom.setAttribute("aria-label", "Format selection");
      // Clicking a button keeps the selection and the focus in the cell.
      dom.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      const buttons: [HTMLButtonElement, FormatItem][] = [];
      CELL_TOOLBAR.forEach((group, i) => {
        if (i > 0) dom.append(el("span", "cm-format-mini-sep"));
        for (const item of group) {
          const entry = document.createElement("button");
          entry.type = "button";
          entry.className = "cm-format-mini-btn";
          entry.title = itemTitle(item);
          entry.setAttribute("aria-label", item.label);
          entry.innerHTML = iconSvg(item.icon);
          entry.addEventListener("click", () => this.format && this.formatCell(this.format.cell, item.id));
          dom.append(entry);
          buttons.push([entry, item]);
        }
      });
      this.dom.append(dom);
      open = this.format = { cell, from, to, dom, buttons };
    }
    open.from = from;
    open.to = to;
    const text = cell.textContent ?? "";
    for (const [entry, item] of open.buttons) {
      const mark = "mark" in item.action ? item.action.mark : null;
      if (mark) entry.setAttribute("aria-pressed", String(cellMarkActive(text, from, to, mark)));
    }
    // Above the selection, or under it when that would go behind the toolbar at the top.
    const base = this.dom.getBoundingClientRect();
    const { dom } = open;
    const width = dom.offsetWidth;
    const height = dom.offsetHeight;
    const left = Math.min(rect.left - base.left, Math.max(0, base.width - width));
    dom.style.left = `${Math.max(0, left)}px`;
    const below = rect.top - 6 - height < this.menuRoom().top;
    dom.style.top = below ? `${rect.bottom - base.top + 6}px` : `${rect.top - base.top - 6 - height}px`;
  }

  /** Bold, italic and so on for the selection in a cell; "link" opens the link form for it. */
  private formatCell(cell: HTMLElement, id: string) {
    const picked = cellSelection(this.dom);
    if (!picked || picked.cell !== cell) return;
    const text = cell.textContent ?? "";
    const { from, to } = picked;
    if (id === "link") {
      if (to <= from || !hasLinkPopover(this.view.state)) return;
      this.closeFormat();
      const label = text.slice(from, to);
      return this.newLink(cell, { from, to, text: label, url: "", label, bare: false });
    }
    let edit: CellEdit | null = null;
    if (id === "clear") edit = clearCellFormatting(text, from, to);
    else {
      const mark = CELL_MARKS[id];
      if (mark) edit = toggleCellMark(text, from, to, mark);
    }
    if (!edit) return;
    const row = Number(cell.dataset.row);
    const col = Number(cell.dataset.col);
    const range = this.change((source) => setCell(source, row, col, edit.text));
    const view = range ? (tableViewAt(this.view, range.from) ?? this) : this;
    view.focusCellAt(row, col, rawOffset(edit.text, edit.from), rawOffset(edit.text, edit.to));
    view.updateFormat();
  }

  private closeFormat() {
    if (!this.format) return;
    this.format.dom.remove();
    this.format = null;
  }

  // ------------------------------------------------------------ links in a cell

  /** The link form for the selected text in a cell, to make it a link. */
  private newLink(cell: HTMLElement, at: LinkAt) {
    const done = (end: number) => {
      this.closeLink();
      const offset = rawOffset(cellText(cell.dataset.raw ?? ""), end);
      this.focusCellAt(Number(cell.dataset.row), Number(cell.dataset.col), offset, offset);
    };
    const form = linkForm(at, (markdown) => this.replaceLink(markdown), () => done(at.to));
    form.addEventListener("focusout", (e) => {
      if (this.link?.dom === form && !form.contains(e.relatedTarget as Node)) this.closeLink();
    });
    this.placeLink(cell, at, form, true);
    form.querySelectorAll("input")[1]?.focus();
  }

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
      const to = rawOffset(cellText(cell.dataset.raw ?? ""), at.to);
      this.focusCellAt(Number(cell.dataset.row), Number(cell.dataset.col), to, to);
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
    const text = cellText(cell.dataset.raw ?? "");
    this.closeLink();
    const range = this.change((source) => setCell(source, row, col, text.slice(0, at.from) + markdown + text.slice(at.to)));
    const view = range ? (tableViewAt(this.view, range.from) ?? this) : this;
    const end = rawOffset(text.slice(0, at.from) + markdown, at.from + markdown.length);
    view.focusCellAt(row, col, end, end);
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
    // Under the slash, or above it when the room below (above the sticky
    // status bar) is too short and there's more room above.
    const base = this.dom.getBoundingClientRect();
    const range = document.createRange();
    const node = slash.cell.firstChild;
    if (node && node.nodeType === 3 && slash.at < (node.textContent ?? "").length) range.setStart(node, slash.at);
    else range.selectNodeContents(slash.cell);
    const box = range.getClientRects()[0] ?? slash.cell.getBoundingClientRect();
    dom.style.left = `${Math.max(0, box.left - base.left)}px`;
    const { top, bottom } = this.menuRoom();
    const height = dom.offsetHeight;
    const up = box.bottom + 4 + height > bottom && box.top - top > bottom - box.bottom;
    dom.style.top = up ? `${box.top - base.top - 4 - height}px` : `${box.bottom - base.top + 4}px`;
    // Only the menu scrolls to its highlighted command: scrollIntoView would
    // scroll the page as well, taking the cell being typed in out of sight.
    const selected = dom.querySelector<HTMLElement>("[aria-selected=true]");
    if (selected) scrollWithin(dom, selected);
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
    // The cell's text is in the Markdown trimmed, with its pipes escaped and its line breaks as <br>.
    const from = start + rawOffset(text, at);
    const spec = applyCommand(this.view.state, { ...command, block: false, blankBefore: false }, from, start + rawOffset(text, caret));
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
    const block = this.pickedBlock("col", col);
    if (block) return this.columnsMenu(block);
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
      {
        label: "Reset column widths",
        icon: ICONS.resetWidths,
        disabled: !columnWidths(this.table.dashes),
        run: () => this.resetWidths(),
      },
      ...this.columnActions(col),
    ], {
      label: "Align column",
      // Choosing the column's current alignment again sets it back to the default.
      choices: ALIGNMENTS.map(({ align, label, icon }) => {
        const pressed = this.table.align[col] === align;
        return { label, icon, pressed, run: () => this.align(col, pressed ? null : align) };
      }),
    });
  }

  /** The host's entries for a column's menu (see `tableColumnAction`): each opens its list of choices. */
  private columnActions(col: number): MenuItem[] {
    const actions = this.view.state.facet(tableColumnActions);
    if (!actions.length) return [];
    const context: TableColumnContext = {
      header: cellText(this.table.rows[0][col] ?? "").trim(),
      col,
      rows: this.table.rows.map((row) => [...row]),
      heading: this.heading,
    };
    const items: MenuItem[] = [];
    for (const action of actions) {
      const answer = action(context);
      if (!answer || !answer.options.length) continue;
      items.push({ label: answer.label, icon: answer.icon ?? ICONS.choose, run: () => this.columnOptions(col, answer.options) });
    }
    return items;
  }

  /** A column action's choices, in place of the column menu; one click applies it. */
  private columnOptions(col: number, options: TableColumnOption[]) {
    const { row } = this.hover;
    this.openMenu(
      this.colHandle,
      options.map((option) => ({
        label: option.label,
        icon: option.checked ? ICONS.check : "",
        run: () =>
          this.structure((table) => {
            const width = table.align.length;
            const rows = option.apply(table.rows.map((cells) => [...cells]));
            if (!rows.length) return table;
            // Keep the table's shape whatever the host hands back.
            const fit = rows.map((cells) => Array.from({ length: width }, (_, i) => cells[i] ?? ""));
            return { ...table, rows: fit };
          }, row, col),
      })),
    );
    this.menu?.querySelectorAll<HTMLElement>("button").forEach((entry, i) => {
      entry.setAttribute("role", "menuitemradio");
      entry.setAttribute("aria-checked", String(!!options[i]?.checked));
    });
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
    const block = this.pickedBlock("row", row);
    if (block) return this.rowsMenu(block);
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
    this.paint();
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

  // ------------------------------------------------------------ a block of cells

  /** Picks a block of cells (or puts it down, for null); `focus` moves the keys to the table for it. */
  private setRange(range: CellRange | null, focus = true) {
    this.range = range;
    this.dom.classList.toggle("has-range", !!range);
    if (range) {
      this.closeFormat();
      this.closeSlash();
      this.closeLink();
      if (focus) {
        // The keys go to the table, not a cell, while a block is picked.
        this.dom.tabIndex = -1;
        if (this.dom.ownerDocument.activeElement !== this.dom) this.dom.focus({ preventScroll: true });
        this.dom.ownerDocument.getSelection()?.removeAllRanges();
      }
    } else this.dom.removeAttribute("tabindex");
    this.paint();
    this.updateRangeBar();
    this.pinHandles();
  }

  /** Shades the picked cells. */
  private paint() {
    const block = this.range ? blockOf(this.range) : null;
    this.select((cell) => !!block && inBlock(block, Number(cell.dataset.row), Number(cell.dataset.col)));
  }

  /** A whole row (or column), as a block. */
  private line(axis: "row" | "col", index: number, to = index): CellRange {
    const lastRow = this.table.rows.length - 1;
    const lastCol = this.table.align.length - 1;
    return axis === "row"
      ? { anchor: { row: index, col: 0 }, head: { row: to, col: lastCol } }
      : { anchor: { row: 0, col: index }, head: { row: lastRow, col: to } };
  }

  /** The picked block when it's whole rows (or columns), more than one, and takes in `index`. */
  private pickedBlock(axis: "row" | "col", index: number): Block | null {
    if (!this.range) return null;
    const block = blockOf(this.range);
    // Any block of several rows (or columns): their menu acts on the whole rows (or columns).
    const lastRow = this.table.rows.length - 1;
    const lastCol = this.table.align.length - 1;
    if (axis === "row") return block.bottom > block.top && index >= block.top && index <= block.bottom ? { ...block, left: 0, right: lastCol } : null;
    return block.right > block.left && index >= block.left && index <= block.right ? { ...block, top: 0, bottom: lastRow } : null;
  }

  /**
   * A handle's click picks its row or column and opens its menu. Shift+click
   * picks every row (or column) from the one picked before to this one; a
   * click inside rows already picked opens the menu for all of them.
   */
  private handleClick(axis: "row" | "col", shift: boolean) {
    if (!this.editable) return;
    const index = axis === "row" ? this.hover.row : this.hover.col;
    if (shift) {
      const block = this.range ? blockOf(this.range) : null;
      const focused = this.focusedCell();
      let from = index;
      if (block && (axis === "row" ? wholeRows(this.table, block) : wholeColumns(this.table, block)))
        from = axis === "row" ? this.range!.anchor.row : this.range!.anchor.col;
      else if (focused) from = axis === "row" ? focused.row : focused.col;
      this.closeMenu();
      this.setRange(this.line(axis, from, index));
      return;
    }
    if (this.range && !this.followShift) {
      // The handle is pinned to the picked block: its menu is for the block's rows (or columns).
      const block = blockOf(this.range);
      const at = axis === "row" ? block.top : block.left;
      this.hover = axis === "row" ? { ...this.hover, row: at } : { ...this.hover, col: at };
      if (!this.pickedBlock(axis, at)) this.setRange(this.line(axis, at));
    } else if (!this.pickedBlock(axis, index)) this.setRange(this.line(axis, index));
    if (axis === "row") this.rowMenu();
    else this.columnMenu();
  }

  /** The menu for several picked rows. */
  private rowsMenu(block: Block) {
    const count = block.bottom - block.top + 1;
    const { col } = this.hover;
    this.openMenu(this.rowHandle, [
      { label: "Insert row above", icon: ICONS.rowAbove, disabled: block.top === 0, run: () => this.structure((t) => insertRow(t, block.top), block.top, col) },
      { label: "Insert row below", icon: ICONS.rowBelow, run: () => this.structure((t) => insertRow(t, block.bottom + 1), block.bottom + 1, col) },
      { label: `Clear ${count} rows`, icon: ICONS.clear, run: () => this.rangeEdit((source) => clearBlock(source, block)) },
      {
        label: `Delete ${count} rows`,
        icon: ICONS.delete,
        disabled: !deleteBlockRows(this.table, block),
        run: () => this.deleteRows(block),
      },
    ]);
  }

  /** The menu for several picked columns. */
  private columnsMenu(block: Block) {
    const count = block.right - block.left + 1;
    const { row } = this.hover;
    const current = blockAlign(this.table, block);
    this.openMenu(
      this.colHandle,
      [
        { label: "Insert column left", icon: ICONS.colLeft, run: () => this.structure((t) => insertColumn(t, block.left), row, block.left) },
        { label: "Insert column right", icon: ICONS.colRight, run: () => this.structure((t) => insertColumn(t, block.right + 1), row, block.right + 1) },
        { label: `Clear ${count} columns`, icon: ICONS.clear, run: () => this.rangeEdit((source) => clearBlock(source, block)) },
        {
          label: `Delete ${count} columns`,
          icon: ICONS.delete,
          disabled: !deleteBlockColumns(this.table, block),
          run: () => this.deleteColumns(block),
        },
      ],
      {
        label: "Align columns",
        choices: ALIGNMENTS.map(({ align, label, icon }) => {
          const pressed = current === align;
          return { label, icon, pressed, run: () => this.rangeEdit((source) => alignBlock(source, block, pressed ? null : align)) };
        }),
      },
    );
  }

  /**
   * Applies an edit to the picked block's cells, keeping the block picked
   * (in whichever view holds the table afterwards).
   */
  private rangeEdit(edit: (source: string) => string) {
    const range = this.range;
    this.closeMenu();
    if (!range) return;
    const at = this.change(edit);
    const view = at ? (tableViewAt(this.view, at.from) ?? this) : this;
    view.setRange(range);
  }

  private deleteRows(block: Block) {
    this.structure((t) => deleteBlockRows(t, block) ?? t, Math.max(0, block.top - 1), block.left);
  }

  private deleteColumns(block: Block) {
    this.structure((t) => deleteBlockColumns(t, block) ?? t, block.top, Math.max(0, block.left - 1));
  }

  /** Bold, italic and the other marks, or clearing them, on every picked cell. */
  private formatRange(id: string) {
    if (!this.range) return;
    const block = blockOf(this.range);
    if (id === "clear") return this.rangeEdit((source) => clearBlockFormatting(source, block));
    const mark = CELL_MARKS[id];
    if (mark) this.rangeEdit((source) => toggleBlockMark(source, block, mark));
  }

  /** Keys while a block is picked: marks, clearing, Shift+arrows to grow it, arrows and Escape to go back to a cell. */
  private rangeKey(e: KeyboardEvent) {
    const range = this.range!;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && /^[zy]$/i.test(e.key)) {
      e.preventDefault();
      runScopeHandlers(this.view, e, "editor");
      return;
    }
    const shortcut = mod && !e.altKey ? cellShortcut(e) : null;
    if (shortcut) {
      e.preventDefault();
      if (shortcut !== "link") this.formatRange(shortcut);
      return;
    }
    if (mod) return; // Copy, cut and paste come as their own events.
    const lastRow = this.table.rows.length - 1;
    const lastCol = this.table.align.length - 1;
    const step = ARROWS[e.key];
    if (step) {
      e.preventDefault();
      const { head } = range;
      const next = { row: Math.max(0, Math.min(lastRow, head.row + step[0])), col: Math.max(0, Math.min(lastCol, head.col + step[1])) };
      if (e.shiftKey) this.setRange({ anchor: range.anchor, head: next });
      else this.focusCell(next.row, next.col);
    } else if (e.key === "Escape" || e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      this.focusCell(range.head.row, range.head.col);
    } else if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      const block = blockOf(range);
      this.rangeEdit((source) => clearBlock(source, block));
    } else if (e.key === "Tab") {
      e.preventDefault();
      this.focusCell(range.head.row, range.head.col);
    }
  }

  /**
   * Shift+arrow in a cell picks it and the next cell over, once the caret has
   * nowhere further to go in the cell's text: up and down always, left at the
   * start of the text and right at its end. True when it picked them.
   */
  private shiftArrowOut(cell: HTMLElement, key: string, row: number, col: number): boolean {
    const step = ARROWS[key];
    if (!step || !this.editable) return false;
    if (step[1]) {
      const selection = window.getSelection();
      if (!selection?.isCollapsed) return false;
      const caret = caretOffset(cell);
      const length = (cell.textContent ?? "").length;
      if (caret === null || (step[1] < 0 ? caret > 0 : caret < length)) return false;
    }
    const next = { row: row + step[0], col: col + step[1] };
    if (next.row < 0 || next.col < 0 || next.row >= this.table.rows.length || next.col >= this.table.align.length) return false;
    this.setRange({ anchor: { row, col }, head: next });
    return true;
  }

  /** Copies the picked block (as tab-separated Markdown and an HTML table), cuts it, or pastes over it. */
  private clipboard(e: ClipboardEvent) {
    if (!this.range || this.dom.ownerDocument.activeElement !== this.dom) return;
    const block = blockOf(this.range);
    e.preventDefault();
    if (e.type === "paste") {
      const text = e.clipboardData?.getData("text/plain") ?? "";
      const cells = spreadsheetCells(text, e.clipboardData?.getData("text/html"));
      if (cells) {
        // A block of cells goes in from the block's top-left corner, growing the table if it needs to.
        const at = this.change((source) => pasteCells(source, block.top, block.left, cells));
        const view = at ? (tableViewAt(this.view, at.from) ?? this) : this;
        view.setRange({
          anchor: { row: block.top, col: block.left },
          head: { row: block.top + cells.length - 1, col: block.left + Math.max(...cells.map((r) => r.length)) - 1 },
        });
      } else {
        // Plain text fills every picked cell.
        const value = text.replace(/\r?\n/g, " ").trim();
        this.rangeEdit((source) => {
          let next = source;
          for (let row = block.top; row <= block.bottom; row++)
            for (let col = block.left; col <= block.right; col++) next = setCell(next, row, col, value);
          return next;
        });
      }
      return;
    }
    const { text, html } = blockClipboard(this.table, block);
    e.clipboardData?.setData("text/plain", text);
    e.clipboardData?.setData("text/html", html);
    if (e.type === "cut") this.rangeEdit((source) => clearBlock(source, block));
  }

  /** The bar's Copy: the same as ⌘C. */
  private copyRange() {
    if (!this.range) return;
    const { text, html } = blockClipboard(this.table, blockOf(this.range));
    const clipboard = navigator.clipboard;
    if (!clipboard) return;
    if (typeof ClipboardItem !== "undefined" && clipboard.write) {
      const item = new ClipboardItem({ "text/plain": new Blob([text], { type: "text/plain" }), "text/html": new Blob([html], { type: "text/html" }) });
      void clipboard.write([item]).catch(() => clipboard.writeText(text));
    } else void clipboard.writeText(text);
  }

  /** Shows the bar of actions over the picked block (not while a menu is open), or puts it away. */
  private updateRangeBar() {
    const range = this.range;
    // Like the cell toolbar, it comes with the editor's selection toolbar; the keys work either way.
    if (!range || this.menu || !this.editable || !hasSelectionToolbar(this.view.state) || blockSize(blockOf(range)) < 1) return this.closeRangeBar();
    const block = blockOf(range);
    let bar = this.rangeBar;
    if (!bar) {
      const dom = el("div", "cm-tooltip cm-format-mini cm-md-table-format cm-md-table-rangebar");
      dom.setAttribute("role", "toolbar");
      dom.setAttribute("aria-label", "Format cells");
      dom.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      const buttons = new Map<string, HTMLButtonElement>();
      const add = (id: string, label: string, icon: string, run: () => void) => {
        const entry = document.createElement("button");
        entry.type = "button";
        entry.className = "cm-format-mini-btn";
        entry.title = label;
        entry.setAttribute("aria-label", label.replace(/ \(.*\)$/, ""));
        entry.innerHTML = iconSvg(icon);
        entry.dataset.action = id;
        entry.addEventListener("click", run);
        dom.append(entry);
        buttons.set(id, entry);
      };
      const sep = () => dom.append(el("span", "cm-format-mini-sep"));
      for (const item of [ITEMS.bold, ITEMS.italic, ITEMS.strike, ITEMS.highlight, ITEMS.code])
        add(item.id, itemTitle(item), item.icon, () => this.formatRange(item.id));
      add("clear", itemTitle(ITEMS.clear), ITEMS.clear.icon, () => this.formatRange("clear"));
      sep();
      for (const { align, label, icon } of ALIGNMENTS)
        add(`align-${align}`, `${label} (the whole column)`, icon, () => {
          if (!this.range) return;
          const picked = blockOf(this.range);
          const pressed = blockAlign(this.table, picked) === align;
          this.rangeEdit((source) => alignBlock(source, picked, pressed ? null : align));
        });
      sep();
      add("copy", "Copy cells", ICONS.copy, () => this.copyRange());
      add("empty", "Clear cells (Delete)", ICONS.eraser, () => {
        if (!this.range) return;
        const picked = blockOf(this.range);
        this.rangeEdit((source) => clearBlock(source, picked));
      });
      add("delete-rows", "Delete rows", ICONS.deleteRows, () => this.range && this.deleteRows(blockOf(this.range)));
      add("delete-cols", "Delete columns", ICONS.deleteCols, () => this.range && this.deleteColumns(blockOf(this.range)));
      this.dom.append(dom);
      bar = this.rangeBar = { dom, buttons };
    }
    const { dom, buttons } = bar;
    for (const id of Object.keys(CELL_MARKS)) buttons.get(id)?.setAttribute("aria-pressed", String(blockHasMark(this.source, block, CELL_MARKS[id]!)));
    const align = blockAlign(this.table, block);
    for (const { align: a } of ALIGNMENTS) buttons.get(`align-${a}`)?.setAttribute("aria-pressed", String(align === a));
    // Deleting is for whole rows or columns, and never all of them.
    const rows = buttons.get("delete-rows")!;
    const cols = buttons.get("delete-cols")!;
    rows.hidden = !wholeRows(this.table, block);
    rows.disabled = !deleteBlockRows(this.table, block);
    cols.hidden = !wholeColumns(this.table, block);
    cols.disabled = !deleteBlockColumns(this.table, block);
    const count = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
    rows.title = `Delete ${count(block.bottom - block.top + 1, "row")}`;
    cols.title = `Delete ${count(block.right - block.left + 1, "column")}`;
    // Over the block's top-left cell, or under the block when that would go behind the toolbar at the top.
    const first = this.cell(block.top, block.left);
    const last = this.cell(block.bottom, block.left);
    if (!first || !last) return;
    const base = this.dom.getBoundingClientRect();
    const top = first.getBoundingClientRect();
    const bottom = last.getBoundingClientRect();
    const width = dom.offsetWidth;
    const height = dom.offsetHeight;
    dom.style.left = `${Math.max(0, Math.min(top.left - base.left, base.width - width))}px`;
    const below = top.top - 6 - height < this.menuRoom().top;
    dom.style.top = below ? `${bottom.bottom - base.top + 6}px` : `${top.top - base.top - 6 - height}px`;
  }

  private closeRangeBar() {
    if (!this.rangeBar) return;
    this.rangeBar.dom.remove();
    this.rangeBar = null;
  }

  private select(test: (cell: HTMLElement) => boolean) {
    this.scroller.querySelectorAll<HTMLElement>("th, td").forEach((cell) => cell.classList.toggle("selected", test(cell)));
  }

  private openMenu(anchor: HTMLElement, items: MenuItem[], choices?: MenuChoices) {
    this.closeMenu();
    this.closeFormat();
    this.closeRangeBar();
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
    this.paint();
    document.removeEventListener("mousedown", this.closeMenuListener);
    this.updateRangeBar();
    window.setTimeout(() => this.redraw());
  }
}

/** Scrolls a list just enough to show one of its rows, leaving the page where it is. */
export function scrollWithin(list: HTMLElement, row: HTMLElement) {
  const r = row.getBoundingClientRect();
  const b = list.getBoundingClientRect();
  if (r.top < b.top) list.scrollTop -= b.top - r.top;
  else if (r.bottom > b.bottom) list.scrollTop += r.bottom - b.bottom;
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

/**
 * The width column `col` needs for nothing in it to wrap: its cells copied
 * into a hidden table beside it, unwrapped, and the widest measured
 * (padding and borders included; a `<br>` still breaks a line).
 */
function contentWidth(table: HTMLTableElement, col: number): number {
  const probe = document.createElement("table");
  probe.className = "cm-md-table-measure";
  probe.setAttribute("aria-hidden", "true");
  const body = probe.createTBody();
  for (const tr of Array.from(table.rows)) {
    const cell = tr.cells[col];
    if (!cell) continue;
    const copy = cell.cloneNode(true) as HTMLElement;
    copy.removeAttribute("contenteditable");
    copy.classList.remove("selected");
    body.insertRow().append(copy);
  }
  table.parentElement!.append(probe);
  const width = Math.max(0, ...Array.from(probe.rows, (tr) => tr.cells[0].getBoundingClientRect().width));
  probe.remove();
  return Math.ceil(width);
}

/** Sets a table's column widths (in percent) as a <colgroup>, or takes it away for null. */
function setColumnWidths(table: HTMLTableElement, widths: number[] | null) {
  table.querySelector(":scope > colgroup")?.remove();
  table.classList.toggle("has-widths", !!widths);
  if (!widths) return;
  const colgroup = document.createElement("colgroup");
  for (const width of widths) {
    const col = document.createElement("col");
    col.style.width = `${+width.toFixed(2)}%`;
    colgroup.append(col);
  }
  table.prepend(colgroup);
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

/**
 * Puts a cell's typed text in it as one text node, its line breaks as "\n"
 * (cells are white-space: pre-wrap while typed in). A trailing line break
 * needs a <br> after it to show its empty line; textContent leaves it out.
 */
function setCellText(cell: HTMLElement, text: string) {
  cell.textContent = text;
  if (text.endsWith("\n")) cell.append(document.createElement("br"));
}

/** Types a line break at the caret, keeping the cell one text node. */
function insertLineBreak(cell: HTMLElement) {
  const text = cell.textContent ?? "";
  const selection = window.getSelection();
  let from = text.length;
  let to = text.length;
  if (selection?.rangeCount && cell.contains(selection.getRangeAt(0).startContainer)) {
    const range = selection.getRangeAt(0);
    const offset = (node: Node, at: number) => {
      const before = document.createRange();
      before.selectNodeContents(cell);
      before.setEnd(node, at);
      return before.toString().length;
    };
    from = offset(range.startContainer, range.startOffset);
    to = cell.contains(range.endContainer) ? offset(range.endContainer, range.endOffset) : from;
  }
  setCellText(cell, text.slice(0, from) + "\n" + text.slice(to));
  const node = cell.firstChild!;
  const caret = document.createRange();
  caret.setStart(node, from + 1);
  caret.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(caret);
}

function caretAtEnd(cell: HTMLElement) {
  const range = document.createRange();
  const node = cell.firstChild;
  // At the end of the text, not after a trailing line break's <br>.
  if (node && node.nodeType === 3) range.setStart(node, node.textContent?.length ?? 0);
  else {
    range.selectNodeContents(cell);
    range.collapse(false);
  }
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** Which way each arrow key moves, as [rows, columns]. */
const ARROWS: Record<string, [number, number] | undefined> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };

/** The note's mark for each of the cell toolbar's mark buttons. */
const CELL_MARKS: Record<string, Mark | undefined> = { bold: "bold", italic: "italic", strike: "strike", highlight: "highlight", code: "code" };

/** The formatting a key does in a cell, by toolbar id: ⌘B, ⌘I, ⌘E, ⌘K, ⌘⇧X, ⌘⇧H and ⌘\\. */
function cellShortcut(e: KeyboardEvent): string | null {
  const key = e.key.toLowerCase();
  if (e.shiftKey) return key === "x" ? "strike" : key === "h" ? "highlight" : null;
  return ({ b: "bold", i: "italic", e: "code", k: "link", "\\": "clear" } as Record<string, string>)[key] ?? null;
}

/** The selection, when it's inside one cell of the table: its cell, its offsets in the cell's text and where it is on screen. */
function cellSelection(table: HTMLElement): { cell: HTMLElement; from: number; to: number; rect: DOMRect } | null {
  const selection = table.ownerDocument.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const start = range.startContainer;
  const cell = (start.nodeType === 1 ? (start as HTMLElement) : start.parentElement)?.closest<HTMLElement>("th, td");
  if (!cell || !table.contains(cell) || !cell.contains(range.endContainer) || !isCell(cell)) return null;
  const offset = (node: Node, at: number) => {
    const before = document.createRange();
    before.selectNodeContents(cell);
    before.setEnd(node, at);
    return before.toString().length;
  };
  const rects = range.getClientRects();
  const rect = rects[0] ?? range.getBoundingClientRect();
  return { cell, from: offset(range.startContainer, range.startOffset), to: offset(range.endContainer, range.endOffset), rect };
}
