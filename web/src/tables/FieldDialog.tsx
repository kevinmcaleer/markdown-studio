import { useState } from "react";
import { ApiError } from "../api";
import { tablesApi, type Choice, type FieldOptions, type FieldType, type Schema, type Table, type TableField } from "./api";
import { CHOICE_COLORS, FIELD_TYPES, typeLabel } from "./fields";
import { Dialog, Icon, ICONS } from "./ui";

// Adding a field, or changing one: its name, type and the type's options.
// Changing the type converts the values; anything that won't convert is
// listed first, and only cleared once you say so.

export function FieldDialog({
  dbId,
  table,
  tables,
  field,
  position,
  onClose,
  onSchema,
}: {
  dbId: number;
  table: Table;
  tables: Table[];
  /** The field to change; null adds one at `position`. */
  field: TableField | null;
  position?: number;
  onClose: () => void;
  onSchema: (schema: Schema) => void;
}) {
  const [name, setName] = useState(field?.name ?? "");
  const [type, setType] = useState<FieldType>(field?.type ?? "text");
  const [options, setOptions] = useState<FieldOptions>(field?.options ?? {});
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [warning, setWarning] = useState<{ lost: number; examples: string[] } | null>(null);
  const others = tables.filter((t) => t.id !== table.id || type === "link");

  const set = (patch: Partial<FieldOptions>) => setOptions((o) => ({ ...o, ...patch }));

  async function save(confirmed = false) {
    setError("");
    const clean: FieldOptions = { ...options };
    if (type === "link" && !clean.table_id) return setError("Pick the table this field links to.");
    if (type === "choice") clean.choices = (clean.choices ?? []).filter((c) => c.name.trim());
    setSaving(true);
    try {
      if (field) {
        const typeChanges = type !== field.type || JSON.stringify(clean.choices) !== JSON.stringify(field.options.choices) || clean.table_id !== field.options.table_id;
        if (typeChanges && !confirmed) {
          const dry = await tablesApi.changeField(dbId, field.id, { type, options: clean, dry_run: true });
          if (dry.lost > 0) {
            setWarning({ lost: dry.lost, examples: dry.examples ?? [] });
            setSaving(false);
            return;
          }
        }
        onSchema(await tablesApi.changeField(dbId, field.id, { name: name.trim() || field.name, type, options: clean }));
      } else {
        onSchema(await tablesApi.addField(dbId, table.id, { name: name.trim() || typeLabel(type), type, options: clean, position }));
      }
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save the field.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title={field ? `Edit ${field.name}` : "Add a field"} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="field">
          <label htmlFor="tb-field-name">Name</label>
          <input id="tb-field-name" autoFocus value={name} placeholder={typeLabel(type)} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="tb-field-type">Type</label>
          <select
            id="tb-field-type"
            value={type}
            onChange={(e) => {
              const next = e.target.value as FieldType;
              setType(next);
              setWarning(null);
              if (next === "currency" && options.decimals === undefined) set({ decimals: 2 });
            }}
          >
            {FIELD_TYPES.map((t) => (
              <option key={t.type} value={t.type}>
                {t.label}
              </option>
            ))}
          </select>
          <span className="muted small">{FIELD_TYPES.find((t) => t.type === type)?.hint}</span>
        </div>

        {(type === "number" || type === "currency") && (
          <div className="row tb-options-row">
            {type === "currency" && (
              <div className="field">
                <label htmlFor="tb-symbol">Symbol</label>
                <input id="tb-symbol" className="tb-short" value={options.symbol ?? "£"} maxLength={4} onChange={(e) => set({ symbol: e.target.value })} />
              </div>
            )}
            <div className="field">
              <label htmlFor="tb-decimals">Decimal places</label>
              <select
                id="tb-decimals"
                value={options.decimals ?? ""}
                onChange={(e) => set({ decimals: e.target.value === "" ? undefined : Number(e.target.value) })}
              >
                {type === "number" && <option value="">As entered</option>}
                {[0, 1, 2, 3, 4].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {type === "choice" && <ChoicesEditor choices={options.choices ?? []} onChange={(choices) => set({ choices })} />}

        {type === "link" && (
          <div className="field">
            <label htmlFor="tb-link-table">Links to</label>
            <select id="tb-link-table" value={options.table_id ?? ""} onChange={(e) => set({ table_id: Number(e.target.value) || undefined })}>
              <option value="">Pick a table…</option>
              {others.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <span className="muted small">Each row picks one row of that table, shown by its name field.</span>
          </div>
        )}

        <div className="field">
          <label htmlFor="tb-description">Description</label>
          <input id="tb-description" value={options.description ?? ""} placeholder="Shown in forms and on the column" onChange={(e) => set({ description: e.target.value })} />
        </div>
        <label className="check">
          <input type="checkbox" checked={!!options.required} onChange={(e) => set({ required: e.target.checked })} />
          Required (forms won't save a record without it)
        </label>

        {warning && (
          <div className="tb-warning" role="alert">
            <p>
              {warning.lost === 1 ? "1 value doesn't" : `${warning.lost} values don't`} fit {typeLabel(type)} and will be cleared
              {warning.examples.length > 0 && <>, such as {warning.examples.map((e) => `“${e}”`).join(", ")}</>}.
            </p>
            <div className="row">
              <button type="button" className="danger" disabled={saving} onClick={() => save(true)}>
                Change it anyway
              </button>
              <button type="button" className="menu-button" onClick={() => setWarning(null)}>
                Keep the values
              </button>
            </div>
          </div>
        )}
        {error && (
          <p className="error small" role="alert">
            {error}
          </p>
        )}
        {!warning && (
          <div className="row">
            <button type="submit" className="primary" disabled={saving}>
              {field ? "Save" : "Add field"}
            </button>
            <button type="button" className="menu-button" onClick={onClose}>
              Cancel
            </button>
          </div>
        )}
      </form>
    </Dialog>
  );
}

function ChoicesEditor({ choices, onChange }: { choices: Choice[]; onChange: (choices: Choice[]) => void }) {
  const update = (i: number, patch: Partial<Choice>) => onChange(choices.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <fieldset className="tb-choices">
      <legend>Choices</legend>
      {choices.map((c, i) => (
        <div key={i} className="tb-choice-row">
          <select aria-label="Colour" className={`tb-color tb-chip-${c.color}`} value={c.color} onChange={(e) => update(i, { color: e.target.value })}>
            {CHOICE_COLORS.map((color) => (
              <option key={color} value={color}>
                {color}
              </option>
            ))}
          </select>
          <input aria-label={`Choice ${i + 1}`} value={c.name} onChange={(e) => update(i, { name: e.target.value })} />
          <button type="button" className="icon-button" aria-label={`Remove ${c.name || "choice"}`} onClick={() => onChange(choices.filter((_, j) => j !== i))}>
            <Icon d={ICONS.close} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="menu-button tb-add-choice"
        onClick={() => onChange([...choices, { name: "", color: CHOICE_COLORS[(choices.length % (CHOICE_COLORS.length - 1)) + 1]! }])}
      >
        <Icon d={ICONS.plus} /> Add a choice
      </button>
    </fieldset>
  );
}
