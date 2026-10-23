import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError } from "../api";
import { EMPTY_VIEW, tablesApi, type Column, type CriteriaOp, type FieldRef, type Filter, type Schema, type Table, type TableField, type View } from "./api";
import { Datasheet, type HeaderActions } from "./Datasheet";
import { FieldDialog } from "./FieldDialog";
import { needsValue, opLabel, opsFor } from "./fields";
import { Icon, ICONS, Popover } from "./ui";

// A table's datasheet with its filter, sort and search bar. The view (filters
// and sort) is remembered per table in this browser.

const viewKey = (dbId: number, tableId: number) => `tables.view.${dbId}.${tableId}`;

function readView(dbId: number, tableId: number): View {
  try {
    const saved = JSON.parse(localStorage.getItem(viewKey(dbId, tableId)) ?? "null");
    if (saved && Array.isArray(saved.filters) && Array.isArray(saved.sort)) return { ...EMPTY_VIEW, ...saved, search: "" };
  } catch {
    /* private mode, or nothing saved */
  }
  return EMPTY_VIEW;
}

export function TableView({
  dbId,
  table,
  tables,
  canEdit,
  reloadKey,
  onSchema,
  onRevision,
}: {
  dbId: number;
  table: Table;
  tables: Table[];
  canEdit: boolean;
  reloadKey: number;
  onSchema: (schema: Schema) => void;
  onRevision: (revision: number) => void;
}) {
  const [view, setView] = useState<View>(() => readView(dbId, table.id));
  const [search, setSearch] = useState("");
  const [panel, setPanel] = useState<{ kind: "filter" | "sort"; rect: DOMRect } | null>(null);
  const [fieldDialog, setFieldDialog] = useState<{ field: TableField | null; position?: number } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    try {
      localStorage.setItem(viewKey(dbId, table.id), JSON.stringify({ ...view, search: "" }));
    } catch {
      /* private mode */
    }
  }, [dbId, table.id, view]);

  // Searching waits for a pause in typing.
  useEffect(() => {
    const t = setTimeout(() => setView((v) => (v.search === search ? v : { ...v, search })), 250);
    return () => clearTimeout(t);
  }, [search]);

  // Fields deleted since the view was saved drop out of it.
  const fieldIds = useMemo(() => new Set<FieldRef>(["id", ...table.fields.map((f) => f.id)]), [table.fields]);
  const liveView = useMemo<View>(
    () => ({ ...view, filters: view.filters.filter((f) => fieldIds.has(f.field)), sort: view.sort.filter((s) => fieldIds.has(s.field)) }),
    [view, fieldIds],
  );
  const viewJson = JSON.stringify(liveView);
  // The grid starts over when the view or the table's fields change.
  const fieldsKey = table.fields.map((f) => `${f.id}:${f.type}:${f.name}:${JSON.stringify(f.options)}`).join("|");
  const load = useCallback((offset: number, limit: number) => tablesApi.rows(dbId, table.id, JSON.parse(viewJson), offset, limit), [dbId, table.id, viewJson, fieldsKey]);

  async function design(action: () => Promise<Schema>) {
    setError("");
    try {
      onSchema(await action());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't change the table.");
    }
  }

  const header: HeaderActions = {
    sort: (col: Column, dir) => setView((v) => ({ ...v, sort: [{ field: refOf(col), dir }, ...v.sort.filter((s) => s.field !== refOf(col))] })),
    filter: (col: Column, op, value) => {
      const field = refOf(col);
      const ops = opsFor(col.type);
      const filter: Filter = { field, op: (op as CriteriaOp) ?? ops[0]!, value: value ?? "" };
      setView((v) => ({ ...v, filters: [...v.filters, filter] }));
      if (op === undefined) {
        const bar = document.querySelector<HTMLElement>(".tb-filter-button");
        if (bar) setPanel({ kind: "filter", rect: bar.getBoundingClientRect() });
      }
    },
    design: canEdit
      ? {
          edit: (field) => setFieldDialog({ field }),
          insert: (position) => setFieldDialog({ field: null, position }),
          move: (field, by) => {
            const order = table.fields.map((f) => f.id);
            const i = order.indexOf(field.id);
            order.splice(i, 1);
            order.splice(i + by, 0, field.id);
            design(() => tablesApi.changeTable(dbId, table.id, { field_order: order }));
          },
          primary: (field) => design(() => tablesApi.changeTable(dbId, table.id, { primary_field_id: field.id })),
          remove: (field) => {
            if (!window.confirm(`Delete the field “${field.name}” and everything in it? This can't be undone.`)) return;
            design(() => tablesApi.deleteField(dbId, field.id));
          },
        }
      : undefined,
  };

  const toolbar = (
    <div className="tb-toolbar">
      <button
        type="button"
        className={`menu-button tb-filter-button ${liveView.filters.length ? "on" : ""}`}
        onClick={(e) => setPanel({ kind: "filter", rect: e.currentTarget.getBoundingClientRect() })}
      >
        <Icon d={ICONS.filter} /> {liveView.filters.length ? `Filtered (${liveView.filters.length})` : "Filter"}
      </button>
      <button
        type="button"
        className={`menu-button ${liveView.sort.length ? "on" : ""}`}
        onClick={(e) => setPanel({ kind: "sort", rect: e.currentTarget.getBoundingClientRect() })}
      >
        <Icon d={ICONS.sort} /> {liveView.sort.length ? `Sorted (${liveView.sort.length})` : "Sort"}
      </button>
      {(liveView.filters.length > 0 || liveView.sort.length > 0) && (
        <button type="button" className="menu-button small" onClick={() => setView(EMPTY_VIEW)}>
          Clear
        </button>
      )}
      <input className="tb-search" type="search" placeholder="Search" aria-label="Search this table" value={search} onChange={(e) => setSearch(e.target.value)} />
      <span className="spacer" />
      {error && (
        <span className="error-text small" role="alert">
          {error}
        </span>
      )}
      <a className="menu-button" href={tablesApi.tableCsvUrl(dbId, table.id, liveView)} download>
        <Icon d={ICONS.download} /> CSV
      </a>
    </div>
  );

  return (
    <>
      <Datasheet
        dbId={dbId}
        table={table}
        tables={tables}
        load={load}
        reloadKey={reloadKey}
        canEdit={canEdit}
        header={header}
        onRevision={onRevision}
        onWidth={canEdit ? (field, width) => design(() => tablesApi.changeField(dbId, field.id, { width })) : undefined}
        toolbar={toolbar}
      />
      {panel?.kind === "filter" && (
        <Popover anchor={panel.rect} onClose={() => setPanel(null)} className="tb-panel">
          <FilterPanel table={table} view={liveView} onChange={setView} />
        </Popover>
      )}
      {panel?.kind === "sort" && (
        <Popover anchor={panel.rect} onClose={() => setPanel(null)} className="tb-panel">
          <SortPanel table={table} view={liveView} onChange={setView} />
        </Popover>
      )}
      {fieldDialog && (
        <FieldDialog
          dbId={dbId}
          table={table}
          tables={tables}
          field={fieldDialog.field}
          position={fieldDialog.position}
          onClose={() => setFieldDialog(null)}
          onSchema={onSchema}
        />
      )}
    </>
  );
}

const refOf = (col: Column): FieldRef => col.field_id ?? "id";

/** The fields to filter and sort on: ID first, then the table's own. */
function fieldChoices(table: Table) {
  return [{ ref: "id" as FieldRef, name: "ID", type: "number" as const }, ...table.fields.map((f) => ({ ref: f.id as FieldRef, name: f.name, type: f.type }))];
}

function FilterPanel({ table, view, onChange }: { table: Table; view: View; onChange: (v: View) => void }) {
  const choices = fieldChoices(table);
  const typeOf = (ref: FieldRef) => choices.find((c) => c.ref === ref)?.type ?? "text";
  const update = (i: number, patch: Partial<Filter>) => onChange({ ...view, filters: view.filters.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
  return (
    <div className="tb-panel-body">
      {view.filters.length === 0 && <p className="muted small">No filters: every row shows.</p>}
      {view.filters.length > 1 && (
        <label className="small tb-match">
          Show rows that match
          <select value={view.match} onChange={(e) => onChange({ ...view, match: e.target.value as View["match"] })}>
            <option value="all">all of these</option>
            <option value="any">any of these</option>
          </select>
        </label>
      )}
      {view.filters.map((f, i) => {
        const type = typeOf(f.field);
        return (
          <div key={i} className="tb-filter-row">
            <select
              aria-label="Field"
              value={String(f.field)}
              onChange={(e) => {
                const field = e.target.value === "id" ? "id" : Number(e.target.value);
                const ops = opsFor(typeOf(field));
                update(i, { field, op: ops.includes(f.op) ? f.op : ops[0]! });
              }}
            >
              {choices.map((c) => (
                <option key={String(c.ref)} value={String(c.ref)}>
                  {c.name}
                </option>
              ))}
            </select>
            <select aria-label="Condition" value={f.op} onChange={(e) => update(i, { op: e.target.value as CriteriaOp })}>
              {opsFor(type).map((op) => (
                <option key={op} value={op}>
                  {opLabel(op, type)}
                </option>
              ))}
            </select>
            {needsValue(f.op) &&
              (type === "choice" ? (
                <select aria-label="Value" value={f.value ?? ""} onChange={(e) => update(i, { value: e.target.value })}>
                  <option value="">Pick…</option>
                  {(table.fields.find((x) => x.id === f.field)?.options.choices ?? []).map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  aria-label="Value"
                  type={type === "date" ? "date" : "text"}
                  inputMode={type === "number" || type === "currency" ? "decimal" : undefined}
                  value={f.value ?? ""}
                  autoFocus={!f.value}
                  onChange={(e) => update(i, { value: e.target.value })}
                />
              ))}
            <button type="button" className="icon-button" aria-label="Remove filter" onClick={() => onChange({ ...view, filters: view.filters.filter((_, j) => j !== i) })}>
              <Icon d={ICONS.close} />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="menu-button"
        onClick={() => {
          const first = choices[1] ?? choices[0]!;
          onChange({ ...view, filters: [...view.filters, { field: first.ref, op: opsFor(first.type)[0]!, value: "" }] });
        }}
      >
        <Icon d={ICONS.plus} /> Add a filter
      </button>
    </div>
  );
}

function SortPanel({ table, view, onChange }: { table: Table; view: View; onChange: (v: View) => void }) {
  const choices = fieldChoices(table);
  return (
    <div className="tb-panel-body">
      {view.sort.length === 0 && <p className="muted small">In ID order.</p>}
      {view.sort.map((s, i) => (
        <div key={i} className="tb-filter-row">
          <span className="muted small tb-then">{i === 0 ? "Sort by" : "then by"}</span>
          <select
            aria-label="Field"
            value={String(s.field)}
            onChange={(e) => {
              const field = e.target.value === "id" ? "id" : Number(e.target.value);
              onChange({ ...view, sort: view.sort.map((x, j) => (j === i ? { ...x, field } : x)) });
            }}
          >
            {choices.map((c) => (
              <option key={String(c.ref)} value={String(c.ref)}>
                {c.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Direction"
            value={s.dir}
            onChange={(e) => onChange({ ...view, sort: view.sort.map((x, j) => (j === i ? { ...x, dir: e.target.value as "asc" | "desc" } : x)) })}
          >
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
          <button type="button" className="icon-button" aria-label="Remove sort" onClick={() => onChange({ ...view, sort: view.sort.filter((_, j) => j !== i) })}>
            <Icon d={ICONS.close} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="menu-button"
        onClick={() => {
          const used = new Set(view.sort.map((s) => s.field));
          const next = choices.find((c) => !used.has(c.ref) && c.ref !== "id") ?? choices[0]!;
          onChange({ ...view, sort: [...view.sort, { field: next.ref, dir: "asc" }] });
        }}
      >
        <Icon d={ICONS.plus} /> Add a sort
      </button>
    </div>
  );
}
