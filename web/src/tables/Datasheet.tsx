import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ApiError } from "../api";
import { tablesApi, type Column, type Result, type Row, type Table, type TableField, type Value } from "./api";
import { fromClipboard, toTsv } from "./csv";
import { copyText, editText, formatNumber, formatValue, isNumeric } from "./fields";
import { RecordDialog } from "./RecordDialog";
import { ChoiceChip, choiceOptions, Icon, ICONS, linkOptions, MenuPopover, Picker, Popover } from "./ui";

// The datasheet: rows of a table (or of a query) in a spreadsheet-like grid.
// Only the rows on screen are drawn, and they're fetched a page at a time as
// you scroll, so a table of any size opens at once.
//
// Keys work as in a spreadsheet: arrows (with Shift to select), Tab, Enter or
// F2 to edit, typing to replace, Delete to clear, Escape to cancel, and the
// clipboard copies and pastes blocks of cells with other spreadsheets.

const ROW_H = 33;
const HEADER_H = 34;
const GUTTER = 64;
const PAGE = 100;
const OVERSCAN = 8;

const DEFAULT_WIDTH: Record<string, number> = {
  text: 180,
  long_text: 260,
  number: 110,
  currency: 120,
  date: 120,
  datetime: 160,
  checkbox: 84,
  choice: 150,
  email: 200,
  url: 200,
  link: 170,
};

type Cell = { r: number; c: number };
type Selection = { anchor: Cell; focus: Cell; rows?: boolean };
type Editing = { r: number; c: number; text: string; rect?: DOMRect };

export type HeaderActions = {
  sort?: (column: Column, dir: "asc" | "desc") => void;
  filter?: (column: Column, op?: string, value?: string) => void;
  design?: {
    edit: (field: TableField) => void;
    insert: (position: number) => void;
    move: (field: TableField, by: -1 | 1) => void;
    primary: (field: TableField) => void;
    remove: (field: TableField) => void;
  };
};

export function Datasheet({
  dbId,
  table,
  tables,
  load,
  reloadKey,
  canEdit,
  allowNewRows = true,
  header,
  onRevision,
  onRowsChanged,
  onWidth,
  toolbar,
  empty,
}: {
  dbId: number;
  table: Table;
  tables: Table[];
  /** Fetches a page of rows. A new function means a new view: the grid starts again from the top. */
  load: (offset: number, limit: number) => Promise<Result>;
  /** Bumped when the rows changed somewhere else, to fetch them again in place. */
  reloadKey: number;
  canEdit: boolean;
  allowNewRows?: boolean;
  header?: HeaderActions;
  onRevision: (revision: number) => void;
  onRowsChanged?: () => void;
  onWidth?: (field: TableField, width: number) => void;
  toolbar?: ReactNode;
  empty?: ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState<Column[]>([]);
  const [grouped, setGrouped] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [rows, setRows] = useState<Map<number, Row>>(() => new Map());
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [sel, setSel] = useState<Selection | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [menu, setMenu] = useState<{ kind: "header" | "cell"; column: number; rect: DOMRect } | null>(null);
  const [expanded, setExpanded] = useState<number | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  const loaded = useRef(new Set<number>());
  const pending = useRef(new Set<number>());
  const generation = useRef(0);
  const dragging = useRef(false);
  // The latest rows and count, for saves that wait on a row being created.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const totalRef = useRef(total);
  totalRef.current = total;
  const creating = useRef<Promise<void> | null>(null);

  const fieldsById = useMemo(() => new Map(table.fields.map((f) => [f.id, f])), [table.fields]);
  const editable = canEdit && !grouped;
  const newRowAt = editable && allowNewRows && total !== null ? total : null;
  const rowCount = (total ?? 0) + (newRowAt !== null ? 1 : 0);

  // ---------------------------------------------------------------- loading

  const fetchPage = useCallback(
    (page: number) => {
      if (loaded.current.has(page) || pending.current.has(page)) return;
      pending.current.add(page);
      const gen = generation.current;
      load(page * PAGE, PAGE).then(
        (result) => {
          pending.current.delete(page);
          if (gen !== generation.current) return;
          loaded.current.add(page);
          setColumns(result.columns);
          setGrouped(result.grouped);
          setTotal(result.total);
          setLoadError("");
          setRows((prev) => {
            const next = new Map(prev);
            result.rows.forEach((row, i) => next.set(page * PAGE + i, row));
            // Rows past the end are gone (deleted elsewhere).
            for (const key of next.keys()) if (key >= result.total) next.delete(key);
            return next;
          });
        },
        (err) => {
          pending.current.delete(page);
          if (gen !== generation.current) return;
          setLoadError(err instanceof ApiError ? err.message : "Couldn't load the rows.");
          setTotal((t) => t ?? 0);
        },
      );
    },
    [load],
  );

  // A new view: start again.
  useEffect(() => {
    generation.current++;
    loaded.current.clear();
    pending.current.clear();
    setRows(new Map());
    setTotal(null);
    setSel(null);
    setEditing(null);
    scroller.current?.scrollTo({ top: 0 });
    fetchPage(0);
  }, [fetchPage]);

  const refresh = useCallback(() => {
    generation.current++;
    loaded.current.clear();
    pending.current.clear();
    const first = Math.floor(viewport.top / ROW_H / PAGE);
    const last = Math.floor((viewport.top + viewport.height) / ROW_H / PAGE);
    for (let p = first; p <= last; p++) fetchPage(p);
  }, [fetchPage, viewport]);

  // Changed elsewhere: fetch what's on screen again, keeping the scroll place.
  const firstReload = useRef(true);
  useEffect(() => {
    if (firstReload.current) {
      firstReload.current = false;
      return;
    }
    refresh();
    // Only when the key moves.
  }, [reloadKey]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const update = () => setViewport({ top: el.scrollTop, height: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const firstRow = Math.max(0, Math.floor((viewport.top - HEADER_H) / ROW_H) - OVERSCAN);
  const lastRow = Math.min(rowCount - 1, Math.ceil((viewport.top + viewport.height) / ROW_H) + OVERSCAN);

  useEffect(() => {
    if (total === null) return;
    const end = Math.min(lastRow, total - 1);
    for (let p = Math.floor(firstRow / PAGE); p <= Math.floor(end / PAGE); p++) fetchPage(p);
  }, [firstRow, lastRow, total, fetchPage]);

  /** Make sure rows from..to are loaded (for pasting and copying); resolves when they are. */
  async function ensureRows(from: number, to: number): Promise<Map<number, Row>> {
    const result = new Map(rows);
    const missing: number[] = [];
    for (let p = Math.floor(from / PAGE); p <= Math.floor(to / PAGE); p++) {
      if (![...Array(PAGE).keys()].every((i) => p * PAGE + i > to || p * PAGE + i < from || result.has(p * PAGE + i))) missing.push(p);
    }
    for (const p of missing) {
      const page = await load(p * PAGE, PAGE);
      page.rows.forEach((row, i) => result.set(p * PAGE + i, row));
    }
    return result;
  }

  // ---------------------------------------------------------------- layout

  const widthOf = (col: Column) => {
    if (widths[col.key]) return widths[col.key]!;
    const field = col.field_id !== null ? fieldsById.get(col.field_id) : undefined;
    return field?.width ?? DEFAULT_WIDTH[col.type] ?? 160;
  };
  const template = `${GUTTER}px ${columns.map((c) => `${widthOf(c)}px`).join(" ")}${editable && header?.design ? " 44px" : ""}`;
  const totalWidth = GUTTER + columns.reduce((sum, c) => sum + widthOf(c), 0) + (editable && header?.design ? 44 : 0);

  function scrollIntoView(cell: Cell) {
    const el = scroller.current;
    if (!el) return;
    const top = HEADER_H + cell.r * ROW_H;
    if (top < el.scrollTop + HEADER_H) el.scrollTop = top - HEADER_H;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
    let left = GUTTER;
    for (let i = 0; i < cell.c; i++) left += widthOf(columns[i]!);
    const w = columns[cell.c] ? widthOf(columns[cell.c]!) : 0;
    if (left - GUTTER < el.scrollLeft) el.scrollLeft = left - GUTTER;
    else if (left + w > el.scrollLeft + el.clientWidth) el.scrollLeft = left + w - el.clientWidth;
  }

  const range = sel
    ? {
        r0: Math.min(sel.anchor.r, sel.focus.r),
        r1: Math.max(sel.anchor.r, sel.focus.r),
        c0: sel.rows ? 0 : Math.min(sel.anchor.c, sel.focus.c),
        c1: sel.rows ? columns.length - 1 : Math.max(sel.anchor.c, sel.focus.c),
      }
    : null;
  const inRange = (r: number, c: number) => range !== null && r >= range.r0 && r <= range.r1 && c >= range.c0 && c <= range.c1;

  function select(cell: Cell, extend = false, rowsMode = false) {
    // Counted from refs, so moving on from a row that's still being added lands on the next new row.
    const rows = (totalRef.current ?? 0) + (creating.current ? 1 : 0) + (editable && allowNewRows ? 1 : 0);
    const r = Math.max(0, Math.min(rows - 1, cell.r));
    const c = Math.max(0, Math.min(columns.length - 1, cell.c));
    setSel((prev) => (extend && prev ? { ...prev, focus: { r, c } } : { anchor: { r, c }, focus: { r, c }, rows: rowsMode }));
    scrollIntoView({ r, c });
  }

  const focusGrid = () => scroller.current?.focus({ preventScroll: true });

  // ---------------------------------------------------------------- writing

  function fail(err: unknown) {
    setError(err instanceof ApiError ? err.message : "Couldn't save that. Check your connection and try again.");
  }

  function canWrite(c: number) {
    const col = columns[c];
    return editable && !!col?.editable && col.field_id !== null;
  }

  /** Save one cell. `value` is what the server takes: text as typed, a row id for a link. */
  async function saveCell(r: number, c: number, value: unknown, label?: string) {
    const col = columns[c]!;
    const key = String(col.field_id);
    setError("");
    // Typing on in a row that's still being added: wait for it, then change it.
    if (creating.current) await creating.current;
    if (r >= (totalRef.current ?? 0)) {
      const create = (async () => {
        try {
          const res = await tablesApi.addRows(dbId, table.id, [{ [key]: value }]);
          onRevision(res.revision);
          const row = res.rows[0]!;
          rowsRef.current = new Map(rowsRef.current).set(r, row);
          totalRef.current = (totalRef.current ?? 0) + 1;
          setRows((prev) => new Map(prev).set(r, row));
          setTotal((t) => (t ?? 0) + 1);
          onRowsChanged?.();
        } catch (err) {
          fail(err);
        }
      })();
      creating.current = create;
      await create;
      if (creating.current === create) creating.current = null;
      return;
    }
    const row = rowsRef.current.get(r);
    if (!row?.id) return;
    // Show the new value straight away; the server's version replaces it.
    const optimistic: Row = { ...row, values: { ...row.values, [key]: value as Value }, labels: { ...row.labels, ...(label !== undefined ? { [key]: label } : {}) } };
    setRows((prev) => new Map(prev).set(r, optimistic));
    try {
      const res = await tablesApi.updateRows(dbId, table.id, [{ id: row.id, values: { [key]: value } }]);
      onRevision(res.revision);
      setRows((prev) => new Map(prev).set(r, res.rows[0] ?? row));
    } catch (err) {
      setRows((prev) => new Map(prev).set(r, row));
      fail(err);
    }
  }

  /** Write a block of text values from (r0, c0): pasting, clearing, filling down. */
  async function writeBlock(r0: number, c0: number, block: string[][]) {
    if (!editable) return;
    setBusy(true);
    setError("");
    try {
      const height = block.length;
      const existingEnd = Math.min((total ?? 0) - 1, r0 + height - 1);
      const loadedRows = existingEnd >= r0 ? await ensureRows(r0, existingEnd) : rows;
      const updates: { id: number; values: Record<string, string> }[] = [];
      const creates: Record<string, string>[] = [];
      block.forEach((cells, i) => {
        const values: Record<string, string> = {};
        cells.forEach((text, j) => {
          const c = c0 + j;
          if (canWrite(c)) values[String(columns[c]!.field_id)] = text;
        });
        if (!Object.keys(values).length) return;
        const r = r0 + i;
        if (r < (total ?? 0)) {
          const row = loadedRows.get(r);
          if (row?.id) updates.push({ id: row.id, values });
        } else if (allowNewRows) creates.push(values);
      });
      if (updates.length) onRevision((await tablesApi.updateRows(dbId, table.id, updates, true)).revision);
      if (creates.length) {
        onRevision((await tablesApi.addRows(dbId, table.id, creates, { add_choices: true })).revision);
        onRowsChanged?.();
      }
      refresh();
    } catch (err) {
      fail(err);
      refresh();
    } finally {
      setBusy(false);
    }
  }

  async function deleteRows(r0: number, r1: number) {
    const end = Math.min(r1, (total ?? 0) - 1);
    if (end < r0) return;
    const count = end - r0 + 1;
    if (!window.confirm(`Delete ${count === 1 ? "this row" : `these ${count} rows`}? This can't be undone.`)) return;
    setBusy(true);
    try {
      const loadedRows = await ensureRows(r0, end);
      const ids = [...Array(count).keys()].map((i) => loadedRows.get(r0 + i)?.id).filter((id): id is number => typeof id === "number");
      const res = await tablesApi.deleteRows(dbId, table.id, ids);
      onRevision(res.revision);
      setSel(null);
      generation.current++;
      loaded.current.clear();
      setRows(new Map());
      fetchPage(0);
      refresh();
      onRowsChanged?.();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function copySelection(): Promise<string> {
    if (!range) return "";
    const end = Math.min(range.r1, (total ?? 0) - 1);
    const loadedRows = end >= range.r0 ? await ensureRows(range.r0, end) : rows;
    const cells: string[][] = [];
    for (let r = range.r0; r <= end; r++) {
      const row = loadedRows.get(r);
      const line: string[] = [];
      for (let c = range.c0; c <= range.c1; c++) {
        const col = columns[c]!;
        line.push(row ? copyText(row.values[col.key] ?? null, col, row.labels?.[col.key]) : "");
      }
      cells.push(line);
    }
    return toTsv(cells);
  }

  function clearSelection() {
    if (!range) return;
    const height = Math.min(range.r1, (total ?? 0) - 1) - range.r0 + 1;
    if (height <= 0) return;
    const width = range.c1 - range.c0 + 1;
    writeBlock(range.r0, range.c0, Array.from({ length: height }, () => Array(width).fill("")));
  }

  async function fillDown() {
    if (!range || range.r1 === range.r0) return;
    const loadedRows = await ensureRows(range.r0, range.r0);
    const top = loadedRows.get(range.r0);
    if (!top) return;
    const line = columns.slice(range.c0, range.c1 + 1).map((col) => copyText(top.values[col.key] ?? null, col, top.labels?.[col.key]));
    const end = Math.min(range.r1, (total ?? 0) - 1);
    writeBlock(range.r0 + 1, range.c0, Array.from({ length: end - range.r0 }, () => line));
  }

  // ---------------------------------------------------------------- editing

  function startEdit(cell: Cell, initial?: string) {
    if (!canWrite(cell.c)) return;
    const col = columns[cell.c]!;
    if (col.type === "checkbox") {
      if (initial === undefined || initial === " ") toggle(cell);
      return;
    }
    const row = rows.get(cell.r);
    const text = initial ?? (row ? editText(row.values[col.key] ?? null, col.type) : "");
    const el = scroller.current?.querySelector<HTMLElement>(`[data-cell="${cell.r}:${cell.c}"]`);
    setEditing({ r: cell.r, c: cell.c, text, rect: el?.getBoundingClientRect() });
  }

  function toggle(cell: Cell) {
    if (!canWrite(cell.c)) return;
    const col = columns[cell.c]!;
    const row = rows.get(cell.r);
    saveCell(cell.r, cell.c, !(row?.values[col.key] === true));
  }

  function finishEdit(value: unknown, move: "down" | "right" | "left" | "none" = "none", label?: string) {
    if (!editing) return;
    const { r, c } = editing;
    const col = columns[c]!;
    const row = rows.get(r);
    const before = row ? editText(row.values[col.key] ?? null, col.type) : "";
    setEditing(null);
    const changed = col.type === "link" || col.type === "choice" ? (value ?? null) !== (row?.values[col.key] ?? null) : String(value ?? "") !== before;
    if (changed && (r !== newRowAt || (value !== "" && value !== null))) saveCell(r, c, value, label);
    focusGrid();
    if (move === "down") select({ r: r + 1, c });
    else if (move === "right") select({ r, c: c + 1 });
    else if (move === "left") select({ r, c: c - 1 });
  }

  function cancelEdit() {
    setEditing(null);
    focusGrid();
  }

  // --------------------------------------------------------------- keyboard

  function onKeyDown(e: React.KeyboardEvent) {
    if (editing || !columns.length) return;
    const mod = e.metaKey || e.ctrlKey;
    const focus = sel?.focus ?? { r: 0, c: 0 };
    const page = Math.max(1, Math.floor((scroller.current?.clientHeight ?? 400) / ROW_H) - 1);
    const moves: Record<string, Cell> = {
      ArrowUp: { r: mod ? 0 : focus.r - 1, c: focus.c },
      ArrowDown: { r: mod ? rowCount - 1 : focus.r + 1, c: focus.c },
      ArrowLeft: { r: focus.r, c: mod ? 0 : focus.c - 1 },
      ArrowRight: { r: focus.r, c: mod ? columns.length - 1 : focus.c + 1 },
      PageUp: { r: focus.r - page, c: focus.c },
      PageDown: { r: focus.r + page, c: focus.c },
      Home: { r: mod ? 0 : focus.r, c: 0 },
      End: { r: mod ? rowCount - 1 : focus.r, c: columns.length - 1 },
    };
    if (moves[e.key]) {
      e.preventDefault();
      select(moves[e.key]!, e.shiftKey);
      return;
    }
    if (!sel) {
      if (e.key.length === 1 || e.key === "Enter") select({ r: 0, c: 0 });
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const c = focus.c + (e.shiftKey ? -1 : 1);
      if (c >= columns.length) select({ r: focus.r + 1, c: 0 });
      else if (c < 0) select({ r: focus.r - 1, c: columns.length - 1 });
      else select({ r: focus.r, c });
    } else if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      if (e.key === "Enter" && e.shiftKey) select({ r: focus.r - 1, c: focus.c });
      else if (canWrite(focus.c)) startEdit(focus);
      else if (e.key === "Enter") select({ r: focus.r + 1, c: focus.c });
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      if (sel.rows && range) deleteRows(range.r0, range.r1);
      else clearSelection();
    } else if (e.key === "Escape") {
      setSel({ anchor: focus, focus });
    } else if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSel({ anchor: { r: 0, c: 0 }, focus: { r: Math.max(0, (total ?? 1) - 1), c: columns.length - 1 } });
    } else if (mod && e.key.toLowerCase() === "d") {
      e.preventDefault();
      fillDown();
    } else if (e.key === " " && columns[focus.c]?.type === "checkbox") {
      e.preventDefault();
      toggle(focus);
    } else if (!mod && !e.altKey && e.key.length === 1) {
      e.preventDefault();
      startEdit(focus, e.key);
    }
  }

  // ------------------------------------------------------------------ mouse

  useEffect(() => {
    const up = () => (dragging.current = false);
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, []);

  function cellDown(e: React.PointerEvent, cell: Cell) {
    if (e.button !== 0) return;
    // An open editor saves as it loses focus.
    if (editing) (document.activeElement as HTMLElement | null)?.blur();
    dragging.current = true;
    select(cell, e.shiftKey);
    focusGrid();
    e.preventDefault();
  }

  function startResize(e: React.PointerEvent, col: Column) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const start = widthOf(col);
    let width = start;
    const move = (ev: PointerEvent) => {
      width = Math.max(60, Math.min(1000, start + ev.clientX - startX));
      setWidths((w) => ({ ...w, [col.key]: width }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const field = col.field_id !== null ? fieldsById.get(col.field_id) : undefined;
      if (field && width !== start) onWidth?.(field, width);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // ---------------------------------------------------------------- summary

  const summary = useMemo(() => {
    if (!range || (range.r0 === range.r1 && range.c0 === range.c1)) return null;
    let count = 0;
    let sum = 0;
    let numbers = 0;
    let column: Column | null = null;
    for (let r = range.r0; r <= range.r1; r++) {
      const row = rows.get(r);
      if (!row) continue;
      for (let c = range.c0; c <= range.c1; c++) {
        const col = columns[c]!;
        const v = row.values[col.key];
        if (v === null || v === undefined || v === "") continue;
        count++;
        if (typeof v === "number" && isNumeric(col.type)) {
          sum += v;
          numbers++;
          column = column && column.type !== col.type ? null : col;
        }
      }
    }
    return { count, sum, numbers, column };
  }, [range?.r0, range?.r1, range?.c0, range?.c1, rows, columns]);

  // ----------------------------------------------------------------- render

  const focus = sel?.focus;
  const activeRow = focus ? rows.get(focus.r) : undefined;
  const visible: number[] = [];
  for (let r = firstRow; r <= lastRow; r++) visible.push(r);
  const menuColumn = menu ? columns[menu.column] : undefined;
  const menuField = menuColumn?.field_id != null ? fieldsById.get(menuColumn.field_id) : undefined;

  return (
    <div className="tb-sheet">
      {toolbar}
      {(error || loadError) && (
        <div className="tb-sheet-error" role="alert">
          <span>{error || loadError}</span>
          <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => (setError(""), setLoadError(""))}>
            <Icon d={ICONS.close} />
          </button>
        </div>
      )}
      <div
        ref={scroller}
        className={`tb-grid ${busy ? "busy" : ""}`}
        tabIndex={0}
        role="grid"
        aria-rowcount={rowCount}
        aria-colcount={columns.length}
        onScroll={(e) => setViewport({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
        onKeyDown={onKeyDown}
        onCopy={(e) => {
          if (editing || !range) return;
          e.preventDefault();
          // Rows off screen may need fetching, so write through the async clipboard as well.
          const data = e.clipboardData;
          copySelection().then((text) => {
            try {
              data.setData("text/plain", text);
            } catch {
              /* the event has finished */
            }
            navigator.clipboard?.writeText(text).catch(() => {});
          });
        }}
        onCut={(e) => {
          if (editing || !range || !editable) return;
          e.preventDefault();
          copySelection().then((text) => {
            navigator.clipboard?.writeText(text).catch(() => {});
            clearSelection();
          });
        }}
        onPaste={(e) => {
          if (editing || !range || !editable) return;
          e.preventDefault();
          const block = fromClipboard(e.clipboardData.getData("text/plain"));
          // One value pasted over a selection fills it, as in a spreadsheet.
          if (block.length === 1 && block[0]!.length === 1 && (range.r1 > range.r0 || range.c1 > range.c0)) {
            const height = range.r1 - range.r0 + 1;
            writeBlock(range.r0, range.c0, Array.from({ length: height }, () => Array(range.c1 - range.c0 + 1).fill(block[0]![0])));
          } else writeBlock(range.r0, range.c0, block);
        }}
      >
        <div className="tb-grid-inner" style={{ width: totalWidth, height: HEADER_H + rowCount * ROW_H }}>
          <div className="tb-head" role="row" style={{ gridTemplateColumns: template }}>
            <div
              className="tb-corner"
              role="columnheader"
              onPointerDown={(e) => {
                e.preventDefault();
                focusGrid();
                if (total) setSel({ anchor: { r: 0, c: 0 }, focus: { r: total - 1, c: columns.length - 1 } });
              }}
            >
              {grouped ? "" : "ID"}
            </div>
            {columns.map((col, c) => {
              const field = col.field_id !== null ? fieldsById.get(col.field_id) : undefined;
              const primary = field && field.id === table.primary_field_id;
              return (
                <div
                  key={col.key}
                  role="columnheader"
                  className={`tb-th ${range && c >= range.c0 && c <= range.c1 ? "in-range" : ""} ${isNumeric(col.type) ? "num" : ""}`}
                  title={field?.options.description || col.name}
                  onPointerDown={(e) => {
                    if (e.button !== 0 || !rowCount) return;
                    e.preventDefault();
                    focusGrid();
                    setSel(e.shiftKey && sel ? { ...sel, focus: { r: Math.max(0, (total ?? 1) - 1), c } } : { anchor: { r: 0, c }, focus: { r: Math.max(0, (total ?? 1) - 1), c } });
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ kind: "header", column: c, rect: e.currentTarget.getBoundingClientRect() });
                  }}
                >
                  <span className="tb-th-name">
                    {primary && <span className="tb-primary" title="Names rows where other tables link here" aria-label="Name field" />}
                    {col.name}
                    {field?.options.required && <span className="tb-required" aria-label="required">*</span>}
                  </span>
                  {(header?.sort || header?.design) && (
                    <button
                      type="button"
                      className="tb-th-menu"
                      aria-label={`${col.name} options`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => setMenu({ kind: "header", column: c, rect: e.currentTarget.getBoundingClientRect() })}
                    >
                      <Icon d={ICONS.chevron} size={14} />
                    </button>
                  )}
                  <span className="tb-resize" onPointerDown={(e) => startResize(e, col)} aria-hidden="true" />
                </div>
              );
            })}
            {editable && header?.design && (
              <button type="button" className="tb-th tb-add-field" aria-label="Add a field" title="Add a field" onClick={() => header.design!.insert(table.fields.length)}>
                <Icon d={ICONS.plus} />
              </button>
            )}
          </div>
          {visible.map((r) => {
            const row = rows.get(r);
            const isNew = r === newRowAt;
            const rowSelected = range !== null && r >= range.r0 && r <= range.r1 && (sel?.rows || (range.c0 === 0 && range.c1 === columns.length - 1));
            return (
              <div
                key={r}
                role="row"
                className={`tb-row ${isNew ? "tb-new-row" : ""} ${focus?.r === r ? "current" : ""}`}
                style={{ top: HEADER_H + r * ROW_H, gridTemplateColumns: template } as CSSProperties}
              >
                <div
                  className={`tb-gutter ${rowSelected ? "selected" : ""}`}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    e.preventDefault();
                    focusGrid();
                    setSel((prev) => (e.shiftKey && prev?.rows ? { ...prev, focus: { r, c: columns.length - 1 } } : { anchor: { r, c: 0 }, focus: { r, c: columns.length - 1 }, rows: true }));
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (!rowSelected) setSel({ anchor: { r, c: 0 }, focus: { r, c: columns.length - 1 }, rows: true });
                    setMenu({ kind: "cell", column: 0, rect: e.currentTarget.getBoundingClientRect() });
                  }}
                >
                  {isNew ? (
                    <span className="tb-new-mark" title="Type in this row to add a record">
                      <Icon d={ICONS.plus} size={12} />
                    </span>
                  ) : (
                    <>
                      <span className="tb-rownum">{row?.number ?? (grouped ? r + 1 : "")}</span>
                      {row?.id && !grouped && (
                        <button
                          type="button"
                          className="tb-expand"
                          aria-label="Open this record"
                          title="Open this record"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={() => setExpanded(r)}
                        >
                          <Icon d={ICONS.expand} size={12} />
                        </button>
                      )}
                    </>
                  )}
                </div>
                {columns.map((col, c) => {
                  const active = focus?.r === r && focus?.c === c;
                  const value = row?.values[col.key] ?? null;
                  return (
                    <div
                      key={col.key}
                      role="gridcell"
                      data-cell={`${r}:${c}`}
                      aria-selected={inRange(r, c)}
                      className={`tb-td tb-${col.type} ${inRange(r, c) ? "in-range" : ""} ${active ? "active" : ""} ${!row && !isNew ? "loading" : ""}`}
                      onPointerDown={(e) => cellDown(e, { r, c })}
                      onPointerEnter={() => dragging.current && setSel((prev) => (prev ? { ...prev, focus: { r, c } } : prev))}
                      onDoubleClick={() => startEdit({ r, c })}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        if (!inRange(r, c)) select({ r, c });
                        setMenu({ kind: "cell", column: c, rect: new DOMRect(e.clientX, e.clientY, 0, 0) });
                      }}
                    >
                      {row && <CellValue column={col} value={value} label={row.labels?.[col.key]} onToggle={canWrite(c) ? () => toggle({ r, c }) : undefined} />}
                    </div>
                  );
                })}
              </div>
            );
          })}
          {editing && (
            <CellEditor
              key={`${editing.r}:${editing.c}`}
              dbId={dbId}
              column={columns[editing.c]!}
              field={columns[editing.c]!.field_id !== null ? fieldsById.get(columns[editing.c]!.field_id!) : undefined}
              text={editing.text}
              style={{
                top: HEADER_H + editing.r * ROW_H,
                left: GUTTER + columns.slice(0, editing.c).reduce((s, col) => s + widthOf(col), 0),
                width: widthOf(columns[editing.c]!),
              }}
              rect={editing.rect}
              onDone={finishEdit}
              onCancel={cancelEdit}
            />
          )}
        </div>
        {total === 0 && !editable && <div className="tb-sheet-empty">{empty ?? <p className="muted">No rows.</p>}</div>}
      </div>
      <footer className="tb-status" aria-live="polite">
        <RecordNav
          current={focus && focus.r < (total ?? 0) ? focus.r : null}
          total={total}
          onGo={(r) => {
            select({ r, c: focus?.c ?? 0 });
            focusGrid();
          }}
          onNew={newRowAt !== null ? () => (select({ r: newRowAt, c: 0 }), focusGrid()) : undefined}
        />
        <span className="spacer" />
        {summary && summary.count > 1 && (
          <span className="muted small">
            Count {summary.count}
            {summary.numbers > 0 && summary.column && ` · Sum ${formatNumber(summary.sum, summary.column.options, summary.column.type === "currency")}`}
          </span>
        )}
        {activeRow && focus && columns[focus.c]?.type === "long_text" && <span className="muted small tb-status-hint">Shift+Enter starts a new line</span>}
      </footer>
      {menu && menu.kind === "header" && menuColumn && (
        <MenuPopover anchor={menu.rect} onClose={() => setMenu(null)}>
          {header?.sort && (
            <>
              <button type="button" onClick={() => header.sort!(menuColumn, "asc")}>
                <Icon d={ICONS.sort} /> Sort {sortWords(menuColumn).asc}
              </button>
              <button type="button" onClick={() => header.sort!(menuColumn, "desc")}>
                <Icon d={ICONS.sort} /> Sort {sortWords(menuColumn).desc}
              </button>
            </>
          )}
          {header?.filter && (
            <button type="button" onClick={() => header.filter!(menuColumn)}>
              <Icon d={ICONS.filter} /> Filter…
            </button>
          )}
          {editable && header?.design && menuField && (
            <>
              <hr />
              <button type="button" onClick={() => header.design!.edit(menuField)}>
                Edit field…
              </button>
              <button type="button" onClick={() => header.design!.insert(table.fields.indexOf(menuField))}>
                Insert field before
              </button>
              <button type="button" onClick={() => header.design!.insert(table.fields.indexOf(menuField) + 1)}>
                Insert field after
              </button>
              {menu.column > 0 && (
                <button type="button" onClick={() => header.design!.move(menuField, -1)}>
                  Move left
                </button>
              )}
              {menu.column < columns.length - 1 && (
                <button type="button" onClick={() => header.design!.move(menuField, 1)}>
                  Move right
                </button>
              )}
              {menuField.id !== table.primary_field_id && menuField.type !== "long_text" && (
                <button type="button" onClick={() => header.design!.primary(menuField)}>
                  Use to name rows in links
                </button>
              )}
              <button type="button" className="danger-text" onClick={() => header.design!.remove(menuField)}>
                Delete field
              </button>
            </>
          )}
        </MenuPopover>
      )}
      {menu && menu.kind === "cell" && (
        <MenuPopover anchor={menu.rect} onClose={() => setMenu(null)}>
          <button type="button" onClick={() => copySelection().then((t) => navigator.clipboard?.writeText(t))}>
            Copy
          </button>
          {editable && (
            <>
              <button
                type="button"
                onClick={() =>
                  navigator.clipboard?.readText().then(
                    (text) => range && writeBlock(range.r0, range.c0, fromClipboard(text)),
                    () => setError("Your browser didn't allow pasting from the menu. Press Ctrl+V (or ⌘V) instead."),
                  )
                }
              >
                Paste
              </button>
              <button type="button" onClick={clearSelection}>
                Clear
              </button>
              {range && range.r1 > range.r0 && (
                <button type="button" onClick={fillDown}>
                  Fill down
                </button>
              )}
            </>
          )}
          {!sel?.rows && header?.filter && range && range.r0 === range.r1 && range.c0 === range.c1 && rows.get(range.r0) && columns[range.c0] && (
            <>
              <hr />
              <button
                type="button"
                onClick={() => {
                  const col = columns[range.c0]!;
                  const row = rows.get(range.r0)!;
                  const v = copyText(row.values[col.key] ?? null, col, row.labels?.[col.key]);
                  header.filter!(col, v === "" ? "empty" : col.type === "checkbox" ? (v === "Yes" ? "notEmpty" : "empty") : "=", v);
                }}
              >
                <Icon d={ICONS.filter} /> Only rows like this
              </button>
            </>
          )}
          {editable && range && range.r0 < (total ?? 0) && (
            <>
              <hr />
              {range.r0 === range.r1 && (
                <button type="button" onClick={() => setExpanded(range.r0)}>
                  Open record
                </button>
              )}
              <button type="button" className="danger-text" onClick={() => deleteRows(range.r0, range.r1)}>
                Delete {range.r1 > range.r0 ? `${Math.min(range.r1, (total ?? 0) - 1) - range.r0 + 1} rows` : "row"}
              </button>
            </>
          )}
        </MenuPopover>
      )}
      {expanded !== null && (
        <RecordDialog
          dbId={dbId}
          table={table}
          tables={tables}
          row={expanded === "new" ? null : (rows.get(expanded) ?? null)}
          canEdit={editable}
          onClose={() => {
            setExpanded(null);
            focusGrid();
          }}
          onSaved={(row, revision) => {
            onRevision(revision);
            if (typeof expanded === "number") setRows((prev) => new Map(prev).set(expanded, row));
          }}
        />
      )}
    </div>
  );
}

function sortWords(col: Column): { asc: string; desc: string } {
  if (isNumeric(col.type)) return { asc: "smallest to largest", desc: "largest to smallest" };
  if (col.type === "date" || col.type === "datetime") return { asc: "oldest to newest", desc: "newest to oldest" };
  if (col.type === "checkbox") return { asc: "No first", desc: "Yes first" };
  return { asc: "A to Z", desc: "Z to A" };
}

function CellValue({ column, value, label, onToggle }: { column: Column; value: Value; label?: string; onToggle?: () => void }) {
  if (column.type === "checkbox")
    return (
      <span
        className={`tb-check ${value ? "checked" : ""}`}
        role="checkbox"
        aria-checked={value === true}
        onPointerDown={(e) => {
          if (!onToggle || e.button !== 0) return;
          e.stopPropagation();
          onToggle();
        }}
      />
    );
  if (value === null || value === "") return null;
  if (column.type === "choice") return <ChoiceChip field={column} value={String(value)} />;
  if (column.type === "link") return <span className="tb-link-chip">{label || `#${value}`}</span>;
  if (column.type === "url")
    return (
      <a
        href={String(value)}
        target="_blank"
        rel="noreferrer noopener"
        className="tb-url"
        title="Ctrl-click (or ⌘-click) to open"
        onClick={(e) => {
          if (!(e.ctrlKey || e.metaKey)) e.preventDefault();
        }}
      >
        {String(value)}
      </a>
    );
  return <span className="tb-text">{formatValue(value, column, label)}</span>;
}

function CellEditor({
  dbId,
  column,
  field,
  text,
  style,
  rect,
  onDone,
  onCancel,
}: {
  dbId: number;
  column: Column;
  field?: TableField;
  text: string;
  style: CSSProperties;
  rect?: DOMRect;
  onDone: (value: unknown, move?: "down" | "right" | "left" | "none", label?: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(text);
  const done = useRef(false);
  const finish = (v: unknown, move?: "down" | "right" | "left" | "none", label?: string) => {
    if (done.current) return;
    done.current = true;
    onDone(v, move, label);
  };
  const cancel = () => {
    if (done.current) return;
    done.current = true;
    onCancel();
  };
  const loadChoices = useMemo(() => (field ? choiceOptions(field) : () => []), [field]);
  const loadLinks = useMemo(() => linkOptions(dbId, column.options.table_id ?? 0), [dbId, column.options.table_id]);

  if (column.type === "choice" || column.type === "link") {
    const anchor = rect ?? new DOMRect(0, 0, 200, 30);
    return (
      <Popover anchor={anchor} onClose={cancel}>
        <Picker
          load={column.type === "choice" ? loadChoices : loadLinks}
          initialSearch={/^[^\s]$/.test(text) && text.length === 1 ? text : ""}
          onCancel={cancel}
          onPick={(o) => finish(o === null ? null : o.value, "none", o?.label)}
        />
      </Popover>
    );
  }

  const keys = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    } else if (e.key === "Enter" && !(column.type === "long_text" && e.shiftKey)) {
      e.preventDefault();
      finish(value, e.shiftKey ? "none" : "down");
    } else if (e.key === "Tab") {
      e.preventDefault();
      finish(value, e.shiftKey ? "left" : "right");
    }
  };

  if (column.type === "long_text")
    return (
      <textarea
        className="tb-editor tb-editor-long"
        style={style}
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={keys}
        onBlur={() => finish(value)}
        onFocus={(e) => e.currentTarget.setSelectionRange(value.length, value.length)}
      />
    );
  const type = column.type === "date" ? "date" : column.type === "datetime" ? "datetime-local" : "text";
  // A typed character starting the edit replaces the date (the native input can't take a lone digit).
  const initial = type !== "text" && !/^\d{4}-/.test(value) ? "" : value;
  return (
    <input
      className={`tb-editor ${isNumeric(column.type) ? "num" : ""}`}
      style={style}
      autoFocus
      type={type}
      inputMode={isNumeric(column.type) ? "decimal" : undefined}
      defaultValue={type === "text" ? undefined : initial.slice(0, type === "date" ? 10 : 16)}
      value={type === "text" ? value : undefined}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={keys}
      onBlur={(e) => finish(type === "text" ? value : e.currentTarget.value)}
    />
  );
}

function RecordNav({ current, total, onGo, onNew }: { current: number | null; total: number | null; onGo: (r: number) => void; onNew?: () => void }) {
  if (total === null) return <span className="muted small">Loading…</span>;
  const at = current ?? -1;
  return (
    <span className="tb-nav">
      <span className="muted small">Record</span>
      <button type="button" className="icon-button" aria-label="First record" disabled={!total || at === 0} onClick={() => onGo(0)}>
        <Icon d={ICONS.first} size={14} />
      </button>
      <button type="button" className="icon-button" aria-label="Previous record" disabled={!total || at <= 0} onClick={() => onGo(at - 1)}>
        <Icon d={ICONS.prev} size={14} />
      </button>
      <span className="small">
        {at >= 0 ? at + 1 : "–"} of {total.toLocaleString()}
      </span>
      <button type="button" className="icon-button" aria-label="Next record" disabled={!total || at >= total - 1} onClick={() => onGo(at + 1)}>
        <Icon d={ICONS.next} size={14} />
      </button>
      <button type="button" className="icon-button" aria-label="Last record" disabled={!total || at === total - 1} onClick={() => onGo(total - 1)}>
        <Icon d={ICONS.last} size={14} />
      </button>
      {onNew && (
        <button type="button" className="icon-button" aria-label="New record" title="New record" onClick={onNew}>
          <Icon d={ICONS.plus} size={14} />
        </button>
      )}
    </span>
  );
}
