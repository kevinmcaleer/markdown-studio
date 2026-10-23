import { api } from "../api";
import { withShare } from "../notes/filesApi";
export { TABLES_MIME } from "../notes/filesApi";
import type { Role } from "../sharing/api";

// The Tables API (server/studio/tables/api.py). A database is a .tables file;
// its tables, fields, rows, saved queries and forms come from here.

export type FieldType =
  | "text"
  | "long_text"
  | "number"
  | "currency"
  | "date"
  | "datetime"
  | "checkbox"
  | "choice"
  | "email"
  | "url"
  | "link";

export type Choice = { name: string; color: string };

export type FieldOptions = {
  required?: boolean;
  description?: string;
  decimals?: number;
  symbol?: string;
  choices?: Choice[];
  table_id?: number;
};

export type TableField = {
  id: number;
  table_id: number;
  name: string;
  type: FieldType;
  options: FieldOptions;
  position: number;
  width: number | null;
};

export type Table = {
  id: number;
  name: string;
  primary_field_id: number | null;
  row_count: number;
  fields: TableField[];
};

export type CriteriaOp = "=" | "<>" | "<" | "<=" | ">" | ">=" | "contains" | "notContains" | "starts" | "ends" | "empty" | "notEmpty";
export type Criterion = { op: CriteriaOp; value: string };
export type FieldRef = number | "id";
export type Total = "group" | "sum" | "avg" | "min" | "max" | "count" | "where";
export type SortDir = "asc" | "desc" | "none";

/** One column of the query designer's grid. */
export type QueryField = {
  field: FieldRef;
  show?: boolean;
  sort?: SortDir;
  criteria?: Criterion | null;
  or?: (Criterion | null)[];
  total?: Total;
  name?: string;
};

export type QuerySpec = {
  table_id: number;
  fields: QueryField[];
  or_rows?: number;
  totals?: boolean;
  limit?: number | null;
};

export type FormSpec = {
  table_id: number;
  fields?: { field: number; label?: string }[];
  columns?: 1 | 2;
  /** Opens on a new, empty record and only adds records. */
  entry_only?: boolean;
  description?: string;
};

export type SavedObject<S> = { id: number; kind: "query" | "form"; name: string; spec: S; updated_at: string };

export type Schema = {
  tables: Table[];
  queries: SavedObject<QuerySpec>[];
  forms: SavedObject<FormSpec>[];
  revision: number;
};

export type Database = {
  id: number;
  name: string;
  folder_id: number | null;
  owner_id: number;
  created_at: string;
  updated_at: string;
  owner?: string;
};

export type Opened = Schema & { database: Database; role: Role };

export type Filter = { field: FieldRef; op: CriteriaOp; value?: string };
export type Sort = { field: FieldRef; dir: "asc" | "desc" };
export type View = { filters: Filter[]; match: "all" | "any"; sort: Sort[]; search: string };

export type Column = {
  key: string;
  name: string;
  field_id: number | null;
  type: FieldType;
  options: FieldOptions;
  editable: boolean;
};

export type Value = string | number | boolean | null;

export type Row = {
  id: number | null;
  number: number | null;
  values: Record<string, Value>;
  labels?: Record<string, string>;
};

export type Result = { columns: Column[]; rows: Row[]; total: number; offset: number; grouped: boolean; revision: number };

export type SharedDatabase = { id: number; name: string; owner: string; role: Role; updated_at: string; shared_at: string };

const base = (id: number) => `/api/tables/${id}`;

export const tablesApi = {
  list: () => api<{ databases: Database[]; shared: SharedDatabase[] }>("/api/tables/databases"),
  create: (name: string, folderId: number | null = null, starter = true) =>
    api<{ database: Database }>("/api/tables/databases", { body: { name, folder_id: folderId, starter } }),
  open: (id: number) => api<Opened>(base(id)),
  revision: (id: number) => api<{ revision: number }>(`${base(id)}/revision`),

  addTable: (id: number, name: string) => api<Schema & { table_id: number }>(`${base(id)}/tables`, { body: { name } }),
  changeTable: (id: number, tableId: number, change: { name?: string; primary_field_id?: number; field_order?: number[]; position?: number }) =>
    api<Schema>(`${base(id)}/tables/${tableId}`, { method: "PATCH", body: change }),
  deleteTable: (id: number, tableId: number) => api<Schema>(`${base(id)}/tables/${tableId}`, { method: "DELETE" }),

  addField: (id: number, tableId: number, field: { name: string; type: FieldType; options: FieldOptions; position?: number }) =>
    api<Schema & { field_id: number }>(`${base(id)}/tables/${tableId}/fields`, { body: field }),
  changeField: (
    id: number,
    fieldId: number,
    change: { name?: string; type?: FieldType; options?: FieldOptions; width?: number; dry_run?: boolean },
  ) => api<Schema & { lost: number; examples?: string[] }>(`${base(id)}/fields/${fieldId}`, { method: "PATCH", body: change }),
  deleteField: (id: number, fieldId: number) => api<Schema>(`${base(id)}/fields/${fieldId}`, { method: "DELETE" }),

  rows: (id: number, tableId: number, view: View, offset: number, limit: number) =>
    api<Result>(`${base(id)}/tables/${tableId}/rows/query`, { body: { ...view, offset, limit } }),
  addRows: (id: number, tableId: number, rows: Record<string, unknown>[], opts: { strict?: boolean; add_choices?: boolean } = {}) =>
    api<{ rows: Row[]; revision: number }>(`${base(id)}/tables/${tableId}/rows`, { body: { rows, ...opts } }),
  updateRows: (id: number, tableId: number, updates: { id: number; values: Record<string, unknown> }[], addChoices = false) =>
    api<{ rows: Row[]; revision: number }>(`${base(id)}/tables/${tableId}/rows`, {
      method: "PATCH",
      body: { updates, add_choices: addChoices },
    }),
  deleteRows: (id: number, tableId: number, ids: number[]) =>
    api<{ deleted: number; revision: number }>(`${base(id)}/tables/${tableId}/rows/delete`, { body: { ids } }),
  lookup: (id: number, tableId: number, search: string) =>
    api<{ rows: { id: number; number: number; label: string }[] }>(`${base(id)}/tables/${tableId}/lookup`, { body: { search } }),

  addObject: <S>(id: number, kind: "query" | "form", name: string, spec: S) =>
    api<Schema & { object_id: number }>(`${base(id)}/objects`, { body: { kind, name, spec } }),
  changeObject: <S>(id: number, objectId: number, change: { name?: string; spec?: S }) =>
    api<Schema>(`${base(id)}/objects/${objectId}`, { method: "PATCH", body: change }),
  deleteObject: (id: number, objectId: number) => api<Schema>(`${base(id)}/objects/${objectId}`, { method: "DELETE" }),
  run: (id: number, spec: QuerySpec, offset: number, limit: number) =>
    api<Result & { table_id: number }>(`${base(id)}/query`, { body: { spec, offset, limit } }),

  importTable: (id: number, name: string, columns: { name: string }[], rows: string[][]) =>
    api<Schema & { table_id: number; skipped: number }>(`${base(id)}/import`, { body: { name, columns, rows } }),
  tableCsvUrl: (id: number, tableId: number, view?: View) =>
    withShare(`${base(id)}/export.csv?table=${tableId}${view ? `&view=${encodeURIComponent(JSON.stringify(view))}` : ""}`),
  queryCsvUrl: (id: number, queryId: number) => withShare(`${base(id)}/export.csv?query=${queryId}`),
  exportUrl: (id: number) => withShare(`${base(id)}/export.json`),
};

export const EMPTY_VIEW: View = { filters: [], match: "all", sort: [], search: "" };

