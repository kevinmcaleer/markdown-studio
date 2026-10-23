import type { Column, CriteriaOp, FieldOptions, FieldType, Value } from "./api";

// Field types as the app shows them, the criteria each offers, and how values
// are written. Number and date formatting follows puddle's (src/ui/format.ts):
// the browser's locale, four-digit years, and values that never change, only
// how they're written.

export const FIELD_TYPES: { type: FieldType; label: string; hint: string }[] = [
  { type: "text", label: "Short text", hint: "A name, a title, a code: one line." },
  { type: "long_text", label: "Long text", hint: "Notes and descriptions, over several lines." },
  { type: "number", label: "Number", hint: "Counts, measurements, anything to add up." },
  { type: "currency", label: "Currency", hint: "Money, with a currency symbol." },
  { type: "date", label: "Date", hint: "A day." },
  { type: "datetime", label: "Date and time", hint: "A day and a time of day." },
  { type: "checkbox", label: "Yes/No", hint: "A tick box." },
  { type: "choice", label: "Choice", hint: "One of a list of options, like a status." },
  { type: "email", label: "Email", hint: "An email address." },
  { type: "url", label: "Web address", hint: "A link to a web page." },
  { type: "link", label: "Link to another table", hint: "A row of another table, like an order's customer." },
];

export const typeLabel = (type: FieldType) => FIELD_TYPES.find((t) => t.type === type)?.label ?? type;

export const CRITERIA_LABELS: Record<CriteriaOp, string> = {
  "=": "Equals",
  "<>": "Isn't",
  "<": "Less than",
  "<=": "At most",
  ">": "More than",
  ">=": "At least",
  contains: "Contains",
  notContains: "Doesn't contain",
  starts: "Starts with",
  ends: "Ends with",
  empty: "Is empty",
  notEmpty: "Isn't empty",
};

const TEXT_OPS: CriteriaOp[] = ["contains", "notContains", "=", "<>", "starts", "ends", "empty", "notEmpty"];
const NUMBER_OPS: CriteriaOp[] = ["=", "<>", "<", "<=", ">", ">=", "empty", "notEmpty"];
const DATE_OPS: CriteriaOp[] = ["=", "<>", "<", "<=", ">", ">=", "empty", "notEmpty"];

/** The criteria that make sense for a type, most useful first. */
export function opsFor(type: FieldType): CriteriaOp[] {
  if (type === "number" || type === "currency") return NUMBER_OPS;
  if (type === "date" || type === "datetime") return DATE_OPS;
  if (type === "checkbox") return ["notEmpty", "empty"];
  if (type === "choice") return ["=", "<>", "contains", "empty", "notEmpty"];
  return TEXT_OPS;
}

export const needsValue = (op: CriteriaOp) => op !== "empty" && op !== "notEmpty";

/** What the yes/no criteria say, since "is empty" reads oddly for a tick box. */
export function opLabel(op: CriteriaOp, type: FieldType): string {
  if (type === "checkbox") return op === "notEmpty" ? "Is ticked" : op === "empty" ? "Isn't ticked" : CRITERIA_LABELS[op];
  if (type === "date" || type === "datetime") {
    if (op === "<") return "Before";
    if (op === ">") return "After";
    if (op === "<=") return "On or before";
    if (op === ">=") return "On or after";
  }
  return CRITERIA_LABELS[op];
}

export const isNumeric = (type: FieldType) => type === "number" || type === "currency";

// ------------------------------------------------------------- formatting

const numberFormats = new Map<string, Intl.NumberFormat>();

function numberFormat(locale: string, decimals: number | undefined): Intl.NumberFormat {
  const key = `${locale}|${decimals}`;
  let f = numberFormats.get(key);
  if (!f) {
    const digits = decimals === undefined ? { maximumFractionDigits: 10 } : { minimumFractionDigits: decimals, maximumFractionDigits: decimals };
    numberFormats.set(key, (f = new Intl.NumberFormat(locale, digits)));
  }
  return f;
}

const dateFormats = new Map<string, Intl.DateTimeFormat>();

function dateFormat(locale: string, time: boolean): Intl.DateTimeFormat {
  const key = `${locale}|${time}`;
  let f = dateFormats.get(key);
  if (!f) {
    // Four-digit years and two-digit days and months, so a date never reads as anything else; UTC so no time zone moves it.
    const opts: Intl.DateTimeFormatOptions = {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      ...(time && { hour: "2-digit", minute: "2-digit" }),
    };
    dateFormats.set(key, (f = new Intl.DateTimeFormat(locale, opts)));
  }
  return f;
}

export const displayLocale = () => (typeof navigator !== "undefined" && navigator.language) || "en-GB";

/** A stored date (2026-12-31) or date and time (2026-12-31T14:05) in the locale's short form. */
export function formatDate(value: string, time: boolean, locale = displayLocale()): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(value);
  if (!m || Number(m[1]) < 1000) return value;
  const at = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0)));
  if (Number.isNaN(at.getTime())) return value;
  return dateFormat(locale, time && m[4] !== undefined).format(at);
}

export function formatNumber(value: number, options: FieldOptions, currency: boolean, locale = displayLocale()): string {
  const text = numberFormat(locale, options.decimals).format(value);
  if (!currency) return text;
  const symbol = options.symbol ?? "£";
  return value < 0 ? `-${symbol}${text.replace(/^[-−]/, "")}` : `${symbol}${text}`;
}

/** A value as the grid shows it. A link shows the linked row's name, from ``label``. */
export function formatValue(value: Value, column: Pick<Column, "type" | "options">, label?: string, locale = displayLocale()): string {
  if (value === null || value === undefined || value === "") return "";
  switch (column.type) {
    case "number":
    case "currency":
      return typeof value === "number" ? formatNumber(value, column.options, column.type === "currency", locale) : String(value);
    case "date":
      return formatDate(String(value), false, locale);
    case "datetime":
      return formatDate(String(value), true, locale);
    case "checkbox":
      return value ? "Yes" : "No";
    case "link":
      return label ?? `#${value}`;
    default:
      return String(value);
  }
}

/** A value as plain text for copying, in a form the server reads back when pasted. */
export function copyText(value: Value, column: Pick<Column, "type" | "options">, label?: string): string {
  if (value === null || value === undefined) return "";
  if (column.type === "checkbox") return value ? "Yes" : "No";
  if (column.type === "link") return label ?? "";
  if (column.type === "datetime") return String(value).replace("T", " ");
  return String(value);
}

/** The text an editor starts with: the stored value, as typed. */
export function editText(value: Value, type: FieldType): string {
  if (value === null || value === undefined) return "";
  if (type === "checkbox") return value ? "Yes" : "No";
  return String(value);
}

export const CHOICE_COLORS = ["grey", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"] as const;

export function choiceColor(options: FieldOptions, name: string): string {
  return options.choices?.find((c) => c.name === name)?.color ?? "grey";
}
