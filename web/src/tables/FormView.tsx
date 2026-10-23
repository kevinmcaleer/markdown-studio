import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError } from "../api";
import { EMPTY_VIEW, tablesApi, type FormSpec, type Row, type SavedObject, type Schema, type Table, type TableField } from "./api";
import { changesOf, draftOf, RecordEditor, type Draft } from "./RecordDialog";
import { Icon, ICONS } from "./ui";

// Forms: one record at a time, as in Access. Browse with the arrows, add a
// record, or (for a data entry form) only ever add. Moving to another record
// saves the one you were on. Editors switch to Design to choose the fields,
// their labels and the layout.

export function FormView({
  dbId,
  form,
  tables,
  canEdit,
  reloadKey,
  onSchema,
  onRevision,
}: {
  dbId: number;
  form: SavedObject<FormSpec>;
  tables: Table[];
  canEdit: boolean;
  reloadKey: number;
  onSchema: (schema: Schema) => void;
  onRevision: (revision: number) => void;
}) {
  const spec = form.spec;
  const table = tables.find((t) => t.id === spec.table_id);
  const [designing, setDesigning] = useState(false);
  const [index, setIndex] = useState<number | "new">(spec.entry_only ? "new" : 0);
  const [total, setTotal] = useState<number | null>(null);
  const [row, setRow] = useState<Row | null>(null);
  const [draft, setDraft] = useState<Draft>(draftOf(null));
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);

  const fields: TableField[] = useMemo(() => {
    if (!table) return [];
    if (!spec.fields?.length) return table.fields;
    const byId = new Map(table.fields.map((f) => [f.id, f]));
    return spec.fields.map((f) => byId.get(f.field)).filter((f): f is TableField => !!f);
  }, [table, spec.fields]);
  const labels = useMemo(() => Object.fromEntries((spec.fields ?? []).filter((f) => f.label).map((f) => [f.field, f.label!])), [spec.fields]);

  const loadRecord = useCallback(
    async (at: number | "new") => {
      if (!table) return;
      setError("");
      if (at === "new") {
        setRow(null);
        setDraft(draftOf(null));
        const count = await tablesApi.rows(dbId, table.id, EMPTY_VIEW, 0, 1);
        setTotal(count.total);
        return;
      }
      const result = await tablesApi.rows(dbId, table.id, EMPTY_VIEW, at, 1);
      setTotal(result.total);
      if (!result.rows.length && result.total > 0) return setIndex(result.total - 1);
      if (!result.rows.length) return setIndex("new");
      setRow(result.rows[0]!);
      setDraft(draftOf(result.rows[0]!));
    },
    [dbId, table],
  );

  useEffect(() => {
    loadRecord(index).catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load the record."));
  }, [index, loadRecord]);

  // Someone else changed the data: show the current record as it is now, unless it's being edited.
  const dirty = Object.keys(changesOf(row, draft, fields)).length > 0;
  useEffect(() => {
    if (!dirty && index !== "new") loadRecord(index).catch(() => {});
    // Only when the data changes elsewhere.
  }, [reloadKey]);

  async function save(): Promise<boolean> {
    if (!table) return false;
    const changes = changesOf(row, draft, fields);
    if (!Object.keys(changes).length && row) return true;
    if (!row && !Object.keys(changes).length) {
      setError("Fill in the form first.");
      return false;
    }
    setSaving(true);
    setError("");
    try {
      const res = row?.id
        ? await tablesApi.updateRows(dbId, table.id, [{ id: row.id, values: changes }])
        : await tablesApi.addRows(dbId, table.id, [changes], { strict: true });
      onRevision(res.revision);
      if (row) {
        setRow(res.rows[0]!);
        setDraft(draftOf(res.rows[0]!));
      }
      setNotice(row ? "Saved." : "Record added.");
      setTimeout(() => setNotice(""), 2500);
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save the record.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function go(to: number | "new") {
    if (canEdit && dirty && !(await save())) return;
    if (to === index) await loadRecord(to);
    else setIndex(to);
  }

  async function remove() {
    if (!table || !row?.id || !window.confirm("Delete this record? This can't be undone.")) return;
    try {
      const res = await tablesApi.deleteRows(dbId, table.id, [row.id]);
      onRevision(res.revision);
      await loadRecord(typeof index === "number" ? Math.max(0, Math.min(index, (total ?? 1) - 2)) : "new");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't delete the record.");
    }
  }

  if (!table)
    return (
      <div className="tb-empty">
        <p className="muted">This form's table has been deleted.</p>
      </div>
    );

  if (designing && canEdit)
    return <FormDesigner dbId={dbId} form={form} table={table} onSchema={onSchema} onDone={() => setDesigning(false)} />;

  const at = typeof index === "number" ? index : null;
  const last = (total ?? 0) - 1;

  return (
    <div className="tb-form-page">
      <div className="tb-toolbar">
        <span className="spacer" />
        {canEdit && (
          <button type="button" className="menu-button" onClick={() => setDesigning(true)}>
            Design
          </button>
        )}
      </div>
      <div className="tb-form-scroll">
        <form
          className="card tb-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const added = !row;
            if ((await save()) && added) {
              // Ready for the next one, as Access moves to a new record.
              if (spec.entry_only) setDraft(draftOf(null));
              else if (index === "new") await loadRecord("new");
              else setIndex("new");
            }
          }}
        >
          <h1>{form.name}</h1>
          {spec.description && <p className="muted">{spec.description}</p>}
          {!spec.entry_only && (
            <p className="muted small">{row?.number ? `${table.name} #${row.number}` : `New ${table.name} record`}</p>
          )}
          <RecordEditor dbId={dbId} fields={fields} draft={draft} onChange={setDraft} readOnly={!canEdit} columns={spec.columns ?? 1} labels={labels} />
          {error && (
            <p className="error small" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="success small" role="status">
              {notice}
            </p>
          )}
          {canEdit && (
            <div className="row">
              <button type="submit" className="primary" disabled={saving || (!dirty && !!row)}>
                {row ? "Save" : spec.entry_only ? "Submit" : "Add record"}
              </button>
              {dirty && row && (
                <button type="button" className="menu-button" onClick={() => setDraft(draftOf(row))}>
                  Undo changes
                </button>
              )}
              <span className="spacer" />
              {row && !spec.entry_only && (
                <button type="button" className="menu-button danger-text" onClick={remove}>
                  <Icon d={ICONS.trash} /> Delete
                </button>
              )}
            </div>
          )}
        </form>
      </div>
      {!spec.entry_only && (
        <footer className="tb-status">
          <span className="tb-nav">
            <span className="muted small">Record</span>
            <button type="button" className="icon-button" aria-label="First record" disabled={!total || at === 0} onClick={() => go(0)}>
              <Icon d={ICONS.first} size={14} />
            </button>
            <button type="button" className="icon-button" aria-label="Previous record" disabled={!total || at === 0} onClick={() => go(at === null ? last : at - 1)}>
              <Icon d={ICONS.prev} size={14} />
            </button>
            <span className="small">{at === null ? `New (${total ?? 0} saved)` : `${at + 1} of ${total ?? "…"}`}</span>
            <button type="button" className="icon-button" aria-label="Next record" disabled={at === null || at >= last} onClick={() => go((at ?? 0) + 1)}>
              <Icon d={ICONS.next} size={14} />
            </button>
            <button type="button" className="icon-button" aria-label="Last record" disabled={!total || at === last} onClick={() => go(last)}>
              <Icon d={ICONS.last} size={14} />
            </button>
            {canEdit && (
              <button type="button" className="icon-button" aria-label="New record" title="New record" disabled={at === null} onClick={() => go("new")}>
                <Icon d={ICONS.plus} size={14} />
              </button>
            )}
          </span>
        </footer>
      )}
    </div>
  );
}

function FormDesigner({ dbId, form, table, onSchema, onDone }: { dbId: number; form: SavedObject<FormSpec>; table: Table; onSchema: (s: Schema) => void; onDone: () => void }) {
  const [name, setName] = useState(form.name);
  const [spec, setSpec] = useState<FormSpec>(() => ({
    ...form.spec,
    fields: form.spec.fields?.length ? form.spec.fields : table.fields.map((f) => ({ field: f.id })),
  }));
  const [error, setError] = useState("");
  const chosen = spec.fields ?? [];
  const byId = new Map(table.fields.map((f) => [f.id, f]));
  const missing = table.fields.filter((f) => !chosen.some((c) => c.field === f.id));

  const setFields = (fields: NonNullable<FormSpec["fields"]>) => setSpec((s) => ({ ...s, fields }));

  async function save() {
    try {
      onSchema(await tablesApi.changeObject(dbId, form.id, { name: name.trim() || form.name, spec: { ...spec, fields: chosen.filter((c) => byId.has(c.field)) } }));
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save the form.");
    }
  }

  return (
    <div className="tb-form-scroll">
      <form
        className="card tb-form stack"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <h2>Design “{form.name}”</h2>
        <div className="field">
          <label htmlFor="tb-form-name">Title</label>
          <input id="tb-form-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="tb-form-description">Description</label>
          <input id="tb-form-description" value={spec.description ?? ""} placeholder="Shown under the title" onChange={(e) => setSpec((s) => ({ ...s, description: e.target.value }))} />
        </div>
        <div className="row">
          <label className="small tb-inline">
            Layout
            <select value={spec.columns ?? 1} onChange={(e) => setSpec((s) => ({ ...s, columns: Number(e.target.value) as 1 | 2 }))}>
              <option value={1}>One column</option>
              <option value={2}>Two columns</option>
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={!!spec.entry_only} onChange={(e) => setSpec((s) => ({ ...s, entry_only: e.target.checked }))} />
            Data entry only (adds records, never shows existing ones)
          </label>
        </div>
        <fieldset className="tb-form-fields">
          <legend>Fields, in order</legend>
          {chosen.map((c, i) => {
            const f = byId.get(c.field);
            if (!f) return null;
            return (
              <div key={c.field} className="tb-form-field-row">
                <span className="tb-form-field-name">{f.name}</span>
                <input aria-label={`Label for ${f.name}`} placeholder={`Label (${f.name})`} value={c.label ?? ""} onChange={(e) => setFields(chosen.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                <button type="button" className="icon-button" aria-label="Move up" disabled={i === 0} onClick={() => setFields(swap(chosen, i, i - 1))}>
                  <Icon d="M4.5 9.5 8 6l3.5 3.5" size={14} />
                </button>
                <button type="button" className="icon-button" aria-label="Move down" disabled={i === chosen.length - 1} onClick={() => setFields(swap(chosen, i, i + 1))}>
                  <Icon d={ICONS.chevron} size={14} />
                </button>
                <button type="button" className="icon-button" aria-label={`Take ${f.name} off the form`} onClick={() => setFields(chosen.filter((_, j) => j !== i))}>
                  <Icon d={ICONS.close} size={14} />
                </button>
              </div>
            );
          })}
          {missing.length > 0 && (
            <div className="tb-form-add">
              <span className="muted small">Add:</span>
              {missing.map((f) => (
                <button key={f.id} type="button" className="tb-field-pill" onClick={() => setFields([...chosen, { field: f.id }])}>
                  {f.name}
                </button>
              ))}
            </div>
          )}
        </fieldset>
        {error && (
          <p className="error small" role="alert">
            {error}
          </p>
        )}
        <div className="row">
          <button type="submit" className="primary">
            Save design
          </button>
          <button type="button" className="menu-button" onClick={onDone}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

function swap<T>(list: T[], a: number, b: number): T[] {
  const out = [...list];
  [out[a], out[b]] = [out[b]!, out[a]!];
  return out;
}
