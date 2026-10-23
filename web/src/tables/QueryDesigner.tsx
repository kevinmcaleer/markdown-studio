import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../api";
import {
  tablesApi,
  type CriteriaOp,
  type Criterion,
  type FieldRef,
  type FieldType,
  type QueryField,
  type QuerySpec,
  type SavedObject,
  type Schema,
  type Table,
  type Total,
} from "./api";
import { Datasheet } from "./Datasheet";
import { isNumeric, needsValue, opLabel, opsFor } from "./fields";
import { Icon, ICONS } from "./ui";

// The query designer, laid out like Access's (and puddle's): a grid with a
// column per field and rows for Total, Sort, Show, Criteria and "or". Criteria
// in one row must all match; any row may match. Results show underneath, and
// stay editable unless the query groups rows.

const TOTALS: { total: Total; label: string; numeric?: boolean }[] = [
  { total: "group", label: "Group by" },
  { total: "sum", label: "Sum", numeric: true },
  { total: "avg", label: "Average", numeric: true },
  { total: "min", label: "Min" },
  { total: "max", label: "Max" },
  { total: "count", label: "Count" },
  { total: "where", label: "Where" },
];

type FieldInfo = { ref: FieldRef; name: string; type: FieldType };

export function QueryDesigner({
  dbId,
  query,
  tables,
  canEdit,
  reloadKey,
  onSchema,
  onRevision,
}: {
  dbId: number;
  query: SavedObject<QuerySpec>;
  tables: Table[];
  canEdit: boolean;
  reloadKey: number;
  onSchema: (schema: Schema) => void;
  onRevision: (revision: number) => void;
}) {
  const [spec, setSpec] = useState<QuerySpec>(query.spec);
  const [error, setError] = useState("");
  const [showDesign, setShowDesign] = useState(true);
  const saved = useRef(JSON.stringify(query.spec));
  const table = tables.find((t) => t.id === spec.table_id);

  // Someone else changed the saved query: take their version.
  useEffect(() => {
    const incoming = JSON.stringify(query.spec);
    if (incoming !== saved.current) {
      saved.current = incoming;
      setSpec(query.spec);
    }
  }, [query.spec]);

  // Changes save themselves, a moment after the last one.
  useEffect(() => {
    if (!canEdit) return;
    const json = JSON.stringify(spec);
    if (json === saved.current) return;
    const t = setTimeout(async () => {
      try {
        saved.current = json;
        onSchema(await tablesApi.changeObject(dbId, query.id, { spec }));
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Couldn't save the query.");
      }
    }, 600);
    return () => clearTimeout(t);
  }, [spec, canEdit, dbId, query.id, onSchema]);

  const fields: FieldInfo[] = useMemo(
    () => (table ? [{ ref: "id", name: "ID", type: "number" }, ...table.fields.map((f) => ({ ref: f.id, name: f.name, type: f.type }))] : []),
    [table],
  );
  const info = (ref: FieldRef) => fields.find((f) => f.ref === ref);
  const rows = spec.or_rows ?? 0;

  const change = (patch: Partial<QuerySpec>) => setSpec((s) => ({ ...s, ...patch }));
  const changeField = (i: number, patch: Partial<QueryField>) => setSpec((s) => ({ ...s, fields: s.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) }));
  const setCriterion = (i: number, row: number, c: Criterion | null) =>
    setSpec((s) => ({
      ...s,
      fields: s.fields.map((f, j) => {
        if (j !== i) return f;
        if (row === 0) return { ...f, criteria: c };
        const or = [...(f.or ?? [])];
        while (or.length < row) or.push(null);
        or[row - 1] = c;
        return { ...f, or };
      }),
    }));
  const move = (i: number, by: number) =>
    setSpec((s) => {
      const list = [...s.fields];
      const [f] = list.splice(i, 1);
      list.splice(Math.max(0, Math.min(list.length, i + by)), 0, f!);
      return { ...s, fields: list };
    });

  // Results follow the design, a moment after it changes.
  const [runSpec, setRunSpec] = useState(spec);
  useEffect(() => {
    const t = setTimeout(() => setRunSpec(spec), 400);
    return () => clearTimeout(t);
  }, [spec]);
  const runJson = JSON.stringify(runSpec);
  const fieldsKey = table?.fields.map((f) => `${f.id}:${f.type}:${f.name}`).join("|");
  const load = useCallback((offset: number, limit: number) => tablesApi.run(dbId, JSON.parse(runJson), offset, limit), [dbId, runJson, fieldsKey]);

  if (!table)
    return (
      <div className="tb-empty">
        <p className="muted">This query's table has been deleted.</p>
      </div>
    );

  return (
    <div className="tb-query">
      <div className="tb-toolbar">
        <label className="small tb-inline">
          Table
          <select
            value={spec.table_id}
            disabled={!canEdit}
            onChange={(e) => {
              if (spec.fields.length && !window.confirm("Start the query again on another table? Its fields come out of the grid.")) return;
              change({ table_id: Number(e.target.value), fields: [], or_rows: 0, totals: false });
            }}
          >
            {tables.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className={`menu-button ${spec.totals ? "on" : ""}`} aria-pressed={!!spec.totals} disabled={!canEdit} onClick={() => change({ totals: !spec.totals })}>
          <Icon d={ICONS.sum} /> Totals
        </button>
        <button type="button" className="menu-button" disabled={!canEdit || rows >= 20} onClick={() => change({ or_rows: rows + 1 })}>
          <Icon d={ICONS.plus} /> “Or” row
        </button>
        <label className="small tb-inline">
          Top
          <input
            className="tb-short"
            type="number"
            min={1}
            placeholder="All"
            disabled={!canEdit}
            value={spec.limit ?? ""}
            onChange={(e) => change({ limit: e.target.value ? Math.max(1, Number(e.target.value)) : null })}
          />
        </label>
        <span className="spacer" />
        {error && (
          <span className="error-text small" role="alert">
            {error}
          </span>
        )}
        <button type="button" className="menu-button" aria-expanded={showDesign} onClick={() => setShowDesign((s) => !s)}>
          {showDesign ? "Hide design" : "Show design"}
        </button>
        <a className="menu-button" href={tablesApi.queryCsvUrl(dbId, query.id)} download>
          <Icon d={ICONS.download} /> CSV
        </a>
      </div>

      {showDesign && (
        <div className="tb-design">
          <div className="tb-field-list" aria-label={`Fields of ${table.name}`}>
            <span className="muted small">{table.name}</span>
            {fields.map((f) => (
              <button
                key={String(f.ref)}
                type="button"
                className="tb-field-pill"
                disabled={!canEdit}
                title={`Add ${f.name} to the grid`}
                onClick={() => change({ fields: [...spec.fields, { field: f.ref, show: true, sort: "none" }] })}
              >
                {f.name}
              </button>
            ))}
            {canEdit && fields.length > 1 && (
              <button
                type="button"
                className="menu-button small"
                onClick={() => change({ fields: [...spec.fields, ...fields.filter((f) => f.ref !== "id").map((f) => ({ field: f.ref, show: true, sort: "none" as const }))] })}
              >
                Add all
              </button>
            )}
          </div>
          <div className="tb-design-grid" role="table" aria-label="Query design">
            <div className="tb-design-labels" role="rowgroup">
              <span>Field</span>
              {spec.totals && <span>Total</span>}
              <span>Sort</span>
              <span>Show</span>
              <span>Criteria</span>
              {Array.from({ length: rows }, (_, r) => (
                <span key={r} className="tb-or-label">
                  or
                  {canEdit && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Remove “or” row ${r + 1}`}
                      onClick={() =>
                        setSpec((s) => ({
                          ...s,
                          or_rows: rows - 1,
                          fields: s.fields.map((f) => ({ ...f, or: (f.or ?? []).filter((_, j) => j !== r) })),
                        }))
                      }
                    >
                      <Icon d={ICONS.close} size={12} />
                    </button>
                  )}
                </span>
              ))}
            </div>
            {spec.fields.length === 0 && <p className="muted small tb-design-empty">Click a field above to put it in the grid.</p>}
            {spec.fields.map((qf, i) => {
              const f = info(qf.field);
              const type = f?.type ?? "text";
              return (
                <div key={i} className="tb-design-col" role="rowgroup">
                  <div className="tb-design-field">
                    <select
                      aria-label="Field"
                      value={String(qf.field)}
                      disabled={!canEdit}
                      onChange={(e) => changeField(i, { field: e.target.value === "id" ? "id" : Number(e.target.value) })}
                    >
                      {!f && <option value={String(qf.field)}>(deleted)</option>}
                      {fields.map((x) => (
                        <option key={String(x.ref)} value={String(x.ref)}>
                          {x.name}
                        </option>
                      ))}
                    </select>
                    {canEdit && (
                      <span className="tb-design-tools">
                        <button type="button" className="icon-button" aria-label="Move left" disabled={i === 0} onClick={() => move(i, -1)}>
                          <Icon d={ICONS.prev} size={12} />
                        </button>
                        <button type="button" className="icon-button" aria-label="Move right" disabled={i === spec.fields.length - 1} onClick={() => move(i, 1)}>
                          <Icon d={ICONS.next} size={12} />
                        </button>
                        <button type="button" className="icon-button" aria-label="Take out of the grid" onClick={() => change({ fields: spec.fields.filter((_, j) => j !== i) })}>
                          <Icon d={ICONS.close} size={12} />
                        </button>
                      </span>
                    )}
                  </div>
                  {spec.totals && (
                    <select aria-label="Total" value={qf.total ?? "group"} disabled={!canEdit} onChange={(e) => changeField(i, { total: e.target.value as Total })}>
                      {TOTALS.filter((t) => !t.numeric || isNumeric(type) || qf.total === t.total).map((t) => (
                        <option key={t.total} value={t.total}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  )}
                  <select aria-label="Sort" value={qf.sort ?? "none"} disabled={!canEdit} onChange={(e) => changeField(i, { sort: e.target.value as QueryField["sort"] })}>
                    <option value="none">(not sorted)</option>
                    <option value="asc">Ascending</option>
                    <option value="desc">Descending</option>
                  </select>
                  <label className="tb-design-show">
                    <input
                      type="checkbox"
                      aria-label="Show"
                      checked={qf.show !== false && qf.total !== "where"}
                      disabled={!canEdit || qf.total === "where"}
                      onChange={(e) => changeField(i, { show: e.target.checked })}
                    />
                  </label>
                  {Array.from({ length: rows + 1 }, (_, r) => (
                    <CriterionCell
                      key={r}
                      type={spec.totals && ["count", "sum", "avg"].includes(qf.total ?? "") ? "number" : type}
                      value={r === 0 ? (qf.criteria ?? null) : (qf.or?.[r - 1] ?? null)}
                      readOnly={!canEdit}
                      onChange={(c) => setCriterion(i, r, c)}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {runSpec.fields.length > 0 ? (
        <Datasheet
          dbId={dbId}
          table={table}
          tables={tables}
          load={load}
          reloadKey={reloadKey}
          canEdit={canEdit}
          allowNewRows={false}
          onRevision={onRevision}
          empty={<p className="muted">No rows match.</p>}
        />
      ) : (
        <div className="tb-empty">
          <p className="muted">Put fields in the grid to see the results here.</p>
        </div>
      )}
    </div>
  );
}

function CriterionCell({ type, value, readOnly, onChange }: { type: FieldType; value: Criterion | null; readOnly: boolean; onChange: (c: Criterion | null) => void }) {
  const ops = opsFor(type);
  const op = value?.op ?? "";
  return (
    <div className="tb-criterion">
      <select
        aria-label="Condition"
        value={op}
        disabled={readOnly}
        onChange={(e) => (e.target.value ? onChange({ op: e.target.value as CriteriaOp, value: value?.value ?? "" }) : onChange(null))}
      >
        <option value="">—</option>
        {ops.map((o) => (
          <option key={o} value={o}>
            {opLabel(o, type)}
          </option>
        ))}
      </select>
      {value && needsValue(value.op) && (
        <input
          aria-label="Value"
          type={type === "date" ? "date" : "text"}
          value={value.value}
          readOnly={readOnly}
          onChange={(e) => onChange({ ...value, value: e.target.value })}
        />
      )}
    </div>
  );
}
