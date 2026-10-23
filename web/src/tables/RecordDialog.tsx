import { useState } from "react";
import { ApiError } from "../api";
import { tablesApi, type Row, type Table, type TableField, type Value } from "./api";
import { Dialog, FieldInput } from "./ui";

// One record, every field at full size: the datasheet's "open record", and the
// body of a form.

export type Draft = { values: Record<string, Value>; labels: Record<string, string> };

export const draftOf = (row: Row | null): Draft => ({ values: { ...(row?.values ?? {}) }, labels: { ...(row?.labels ?? {}) } });

/** The fields that differ between a record and its draft, as the server takes them. */
export function changesOf(row: Row | null, draft: Draft, fields: TableField[]): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const f of fields) {
    const key = String(f.id);
    const before = row?.values[key] ?? null;
    const after = draft.values[key] ?? null;
    if (after === before || (after === "" && before === null)) continue;
    out[key] = after === "" ? null : after;
  }
  return out;
}

export function RecordEditor({
  dbId,
  fields,
  draft,
  onChange,
  readOnly,
  columns = 1,
  labels = {},
}: {
  dbId: number;
  fields: TableField[];
  draft: Draft;
  onChange: (draft: Draft) => void;
  readOnly: boolean;
  columns?: 1 | 2;
  labels?: Record<number, string>;
}) {
  return (
    <div className={`tb-record ${columns === 2 ? "two" : ""}`}>
      {fields.map((f) => {
        const key = String(f.id);
        const id = `tb-field-${f.id}`;
        return (
          <div key={f.id} className={`field tb-record-field tb-record-${f.type}`}>
            <label htmlFor={id}>
              {labels[f.id] || f.name}
              {f.options.required && <span className="tb-required"> *</span>}
            </label>
            <FieldInput
              dbId={dbId}
              id={id}
              field={f}
              value={draft.values[key] ?? null}
              label={draft.labels[key]}
              readOnly={readOnly}
              onChange={(value, label) =>
                onChange({
                  values: { ...draft.values, [key]: value },
                  labels: label === undefined ? draft.labels : { ...draft.labels, [key]: label },
                })
              }
            />
            {f.options.description && <span className="muted small">{f.options.description}</span>}
          </div>
        );
      })}
    </div>
  );
}

export function RecordDialog({
  dbId,
  table,
  row,
  canEdit,
  onClose,
  onSaved,
}: {
  dbId: number;
  table: Table;
  tables: Table[];
  row: Row | null;
  canEdit: boolean;
  onClose: () => void;
  onSaved: (row: Row, revision: number) => void;
}) {
  const [draft, setDraft] = useState(() => draftOf(row));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    const changes = changesOf(row, draft, table.fields);
    if (!Object.keys(changes).length) return onClose();
    setSaving(true);
    setError("");
    try {
      const res = row?.id
        ? await tablesApi.updateRows(dbId, table.id, [{ id: row.id, values: changes }])
        : await tablesApi.addRows(dbId, table.id, [changes], { strict: true });
      onSaved(res.rows[0]!, res.revision);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save the record.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title={row?.number ? `${table.name} #${row.number}` : `New ${table.name} record`} onClose={onClose} wide>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <RecordEditor dbId={dbId} fields={table.fields} draft={draft} onChange={setDraft} readOnly={!canEdit} />
        {error && (
          <p className="error small" role="alert">
            {error}
          </p>
        )}
        <div className="row">
          {canEdit && (
            <button type="submit" className="primary" disabled={saving}>
              Save
            </button>
          )}
          <button type="button" className="menu-button" onClick={onClose}>
            {canEdit ? "Cancel" : "Close"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
