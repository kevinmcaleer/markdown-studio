import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { tablesApi, type TableField, type Value } from "./api";
import { choiceColor } from "./fields";

// Small pieces the Tables screens share: popovers, dialogs, the picker used for
// choices and links, and a field's input in forms.

/** A floating panel next to `anchor`; closes on Escape or a click outside. */
export function Popover({
  anchor,
  onClose,
  children,
  className = "",
  align = "left",
}: {
  anchor: DOMRect | { left: number; top: number; bottom: number; right: number };
  onClose: () => void;
  children: ReactNode;
  className?: string;
  align?: "left" | "right";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: anchor.left, top: anchor.bottom + 4 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = align === "right" ? anchor.right - w : anchor.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = anchor.bottom + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(8, anchor.top - h - 4);
    setPos({ left, top });
  }, [anchor, align]);

  useEffect(() => {
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
        return;
      }
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", close, true);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", close, true);
    };
  }, [onClose]);

  return (
    <div ref={ref} className={`tb-popover ${className}`} style={{ left: pos.left, top: pos.top }}>
      {children}
    </div>
  );
}

/** A menu of actions in a popover. */
export function MenuPopover({ anchor, onClose, children, align }: { anchor: DOMRect; onClose: () => void; children: ReactNode; align?: "left" | "right" }) {
  return (
    <Popover anchor={anchor} onClose={onClose} className="menu-list tb-menu" align={align}>
      <div role="menu" className="tb-menu-items" onClick={onClose}>
        {children}
      </div>
    </Popover>
  );
}

/** A modal dialog (the platform's own <dialog>). */
export function Dialog({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog ref={ref} className={`card dialog tb-dialog ${wide ? "tb-dialog-wide" : ""}`} onClose={onClose} onCancel={onClose}>
      <h2>{title}</h2>
      {children}
    </dialog>
  );
}

export type PickOption = { value: string | number; label: string; color?: string; hint?: string };

/**
 * A searchable list to pick one option from, driven by the keyboard: type to
 * narrow it, arrows to move, Enter to pick, Escape to give up.
 */
export function Picker({
  load,
  onPick,
  onCancel,
  initialSearch = "",
  allowEmpty = true,
  autoFocus = true,
}: {
  load: (search: string) => Promise<PickOption[]> | PickOption[];
  onPick: (option: PickOption | null) => void;
  onCancel: () => void;
  initialSearch?: string;
  allowEmpty?: boolean;
  autoFocus?: boolean;
}) {
  const [search, setSearch] = useState(initialSearch);
  const [options, setOptions] = useState<PickOption[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    Promise.resolve(load(search)).then(
      (found) => {
        if (!live) return;
        setOptions(found);
        setActive(0);
        setLoading(false);
      },
      () => live && setLoading(false),
    );
    return () => {
      live = false;
    };
  }, [search, load]);

  const list: (PickOption | null)[] = allowEmpty && !search ? [null, ...options] : options;

  return (
    <div
      className="tb-picker"
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setActive((a) => Math.min(list.length - 1, a + 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setActive((a) => Math.max(0, a - 1));
        } else if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          if (list.length) onPick(list[active] ?? null);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
        e.stopPropagation();
      }}
    >
      <input
        autoFocus={autoFocus}
        className="tb-picker-search"
        placeholder="Find…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        aria-label="Find"
      />
      <ul role="listbox" className="tb-picker-list">
        {list.map((o, i) => (
          <li
            key={o === null ? "__empty" : String(o.value)}
            role="option"
            aria-selected={i === active}
            className={i === active ? "active" : ""}
            onMouseEnter={() => setActive(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(o);
            }}
          >
            {o === null ? (
              <span className="muted">(empty)</span>
            ) : o.color ? (
              <span className={`tb-chip tb-chip-${o.color}`}>{o.label}</span>
            ) : (
              <>
                <span>{o.label || <span className="muted">(no name)</span>}</span>
                {o.hint && <span className="muted small">{o.hint}</span>}
              </>
            )}
          </li>
        ))}
        {!loading && list.length === 0 && <li className="muted small tb-picker-none">Nothing matches.</li>}
      </ul>
    </div>
  );
}

/** Options for a choice field, filtered by what's typed. */
export function choiceOptions(field: Pick<TableField, "options">) {
  return (search: string): PickOption[] =>
    (field.options.choices ?? [])
      .filter((c) => c.name.toLowerCase().includes(search.toLowerCase()))
      .map((c) => ({ value: c.name, label: c.name, color: c.color }));
}

/** Rows of the linked table to pick from, found on the server. */
export function linkOptions(dbId: number, tableId: number) {
  return async (search: string): Promise<PickOption[]> => {
    const { rows } = await tablesApi.lookup(dbId, tableId, search);
    return rows.map((r) => ({ value: r.id, label: r.label, hint: `#${r.number}` }));
  };
}

export function ChoiceChip({ field, value }: { field: Pick<TableField, "options">; value: string }) {
  return <span className={`tb-chip tb-chip-${choiceColor(field.options, value)}`}>{value}</span>;
}

/**
 * A field's input, full size, for forms and the record dialog. Values are what
 * the server takes: text as typed, a link's row id, a yes/no as true or false.
 */
export function FieldInput({
  dbId,
  field,
  value,
  label,
  onChange,
  readOnly,
  id,
}: {
  dbId: number;
  field: TableField;
  value: Value;
  label?: string;
  onChange: (value: Value, label?: string) => void;
  readOnly: boolean;
  id: string;
}) {
  const [picking, setPicking] = useState<DOMRect | null>(null);
  const text = value === null || value === undefined ? "" : String(value);
  switch (field.type) {
    case "long_text":
      return <textarea id={id} rows={4} value={text} readOnly={readOnly} onChange={(e) => onChange(e.target.value)} />;
    case "checkbox":
      return (
        <input
          id={id}
          type="checkbox"
          className="tb-form-check"
          checked={value === true}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.checked)}
        />
      );
    case "date":
      return <input id={id} type="date" value={text.slice(0, 10)} readOnly={readOnly} onChange={(e) => onChange(e.target.value)} />;
    case "datetime":
      return <input id={id} type="datetime-local" value={text.slice(0, 16)} readOnly={readOnly} onChange={(e) => onChange(e.target.value)} />;
    case "choice":
      return (
        <select id={id} value={text} disabled={readOnly} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">(empty)</option>
          {(field.options.choices ?? []).map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
          {text && !(field.options.choices ?? []).some((c) => c.name === text) && <option value={text}>{text}</option>}
        </select>
      );
    case "link":
      return (
        <>
          <button
            id={id}
            type="button"
            className="tb-link-input"
            disabled={readOnly}
            onClick={(e) => setPicking(e.currentTarget.getBoundingClientRect())}
          >
            {value === null || value === undefined ? <span className="muted">Pick a row…</span> : label || `#${value}`}
          </button>
          {picking && field.options.table_id && (
            <Popover anchor={picking} onClose={() => setPicking(null)}>
              <Picker
                load={linkOptions(dbId, field.options.table_id)}
                onCancel={() => setPicking(null)}
                onPick={(o) => {
                  setPicking(null);
                  onChange(o === null ? null : (o.value as number), o?.label);
                }}
              />
            </Popover>
          )}
        </>
      );
    default: {
      const type = field.type === "email" ? "email" : field.type === "url" ? "url" : "text";
      const numeric = field.type === "number" || field.type === "currency";
      return (
        <input
          id={id}
          type={type}
          inputMode={numeric ? "decimal" : undefined}
          value={text}
          readOnly={readOnly}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    }
  }
}

export function Icon({ d, size = 16 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export const ICONS = {
  plus: "M8 3v10M3 8h10",
  table: "M2.5 3h11v10h-11zM2.5 6.5h11M2.5 10h11M6.5 3v10",
  query: "M7 12a5 5 0 1 1 0-10 5 5 0 0 1 0 10zM10.5 10.5 14 14",
  form: "M3 2.5h10v11H3zM5.5 5.5h5M5.5 8h5M5.5 10.5h3",
  filter: "M2.5 3.5h11l-4.2 5v4l-2.6 1.2V8.5z",
  sort: "M5 3v10M2.5 10.5 5 13l2.5-2.5M11 13V3M8.5 5.5 11 3l2.5 2.5",
  chevron: "M4.5 6.5 8 10l3.5-3.5",
  more: "M3.5 8h.01M8 8h.01M12.5 8h.01",
  expand: "M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9",
  close: "M4 4l8 8M12 4l-8 8",
  download: "M8 3v8M4.5 7.5 8 11l3.5-3.5M3 13h10",
  upload: "M8 11V3M4.5 6.5 8 3l3.5 3.5M3 13h10",
  first: "M4 3.5v9M12 3.5 7 8l5 4.5",
  prev: "M10.5 3.5 6 8l4.5 4.5",
  next: "M5.5 3.5 10 8l-4.5 4.5",
  last: "M12 3.5v9M4 3.5 9 8l-5 4.5",
  trash: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 9h5.8l.6-9",
  sum: "M12 3H4l4.5 5L4 13h8",
};
