import { slashCommands } from "../slashMenu";
import type { Active, Block, FormatAction } from "./formatting";

// The buttons both toolbars are built from. Icons are 16×16 stroke paths, the
// same as the "/" menu's (and taken from it where there's one).

const slashIcon = (id: string) => slashCommands.find((c) => c.id === id)!.icon;

export type FormatItem = {
  id: string;
  label: string;
  /** Shown in the tooltip; "Mod" becomes ⌘ or Ctrl. */
  keys?: string;
  icon: string;
  action: FormatAction;
  /** Whether it shows as on for what's at the cursor. */
  on?: (active: Active) => boolean;
};

const mod = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";
const alt = mod === "⌘" ? "⌥" : "Alt+";
const shift = mod === "⌘" ? "⇧" : "Shift+";

/** "Mod-Shift-x" as "⌘⇧X" or "Ctrl+Shift+X". */
export function keyLabel(keys: string): string {
  return keys
    .replace("Mod-", mod)
    .replace("Alt-", alt)
    .replace("Shift-", shift)
    .replace(/-$/, "−")
    .replace(/(^|[+⌘⌥⇧])([a-z])$/, (_m, before: string, key: string) => before + key.toUpperCase());
}

/** "Bold (⌘B)" or "Bold (Ctrl+B)". */
export function itemTitle(item: Pick<FormatItem, "label" | "keys">): string {
  if (!item.keys) return item.label;
  return `${item.label} (${keyLabel(item.keys)})`;
}

export const ITEMS = {
  bold: {
    id: "bold",
    label: "Bold",
    keys: "Mod-B",
    icon: "M4.5 2.75h4.25a2.6 2.6 0 0 1 0 5.2H4.5zM4.5 7.95h5a2.65 2.65 0 0 1 0 5.3h-5z",
    action: { mark: "bold" },
    on: (a) => a.marks.bold,
  },
  italic: {
    id: "italic",
    label: "Italic",
    keys: "Mod-I",
    icon: "M7 2.75h5.5M3.5 13.25H9M9.75 2.75l-3.5 10.5",
    action: { mark: "italic" },
    on: (a) => a.marks.italic,
  },
  strike: {
    id: "strike",
    label: "Strikethrough",
    keys: "Mod-Shift-X",
    icon: "M2.5 8h11M11.25 4.75C10.8 3.6 9.6 2.75 8 2.75c-1.9 0-3.25 1-3.25 2.4 0 .9.5 1.5 1.3 1.9M4.75 11.25c.45 1.15 1.65 2 3.25 2 1.9 0 3.25-1 3.25-2.45 0-.5-.15-.9-.4-1.25",
    action: { mark: "strike" },
    on: (a) => a.marks.strike,
  },
  highlight: {
    id: "highlight",
    label: "Highlight",
    keys: "Mod-Shift-H",
    icon: slashIcon("highlight"),
    action: { mark: "highlight" },
    on: (a) => a.marks.highlight,
  },
  code: {
    id: "code",
    label: "Inline code",
    keys: "Mod-E",
    icon: "M5.75 4.5 2.25 8l3.5 3.5M10.25 4.5l3.5 3.5-3.5 3.5",
    action: { mark: "code" },
    on: (a) => a.marks.code,
  },
  link: {
    id: "link",
    label: "Link",
    keys: "Mod-K",
    icon: slashIcon("link"),
    action: { insert: "link" },
  },
  bullet: {
    id: "bullet",
    label: "Bulleted list",
    keys: "Mod-Shift-8",
    icon: slashIcon("bullet"),
    action: { block: "bullet" },
    on: (a) => a.block === "bullet",
  },
  numbered: {
    id: "numbered",
    label: "Numbered list",
    keys: "Mod-Shift-7",
    icon: slashIcon("numbered"),
    action: { block: "numbered" },
    on: (a) => a.block === "numbered",
  },
  checklist: {
    id: "checklist",
    label: "Checklist",
    keys: "Mod-Shift-9",
    icon: slashIcon("checklist"),
    action: { block: "checklist" },
    on: (a) => a.block === "checklist",
  },
  outdent: {
    id: "outdent",
    label: "Decrease indent",
    keys: "Mod-[",
    icon: "M2.5 3h11M7.5 6.5h6M7.5 9.5h6M2.5 13h11M5 6 3 8l2 2",
    action: { shift: -1 },
  },
  indent: {
    id: "indent",
    label: "Increase indent",
    keys: "Mod-]",
    icon: "M2.5 3h11M7.5 6.5h6M7.5 9.5h6M2.5 13h11M3 6l2 2-2 2",
    action: { shift: 1 },
  },
  quote: {
    id: "quote",
    label: "Quote",
    icon: slashIcon("quote"),
    action: { block: "quote" },
    on: (a) => a.block === "quote",
  },
  codeBlock: {
    id: "codeBlock",
    label: "Code block",
    icon: slashIcon("code"),
    action: { insert: "code" },
    on: (a) => a.codeBlock,
  },
  table: { id: "table", label: "Table", icon: slashIcon("table"), action: { insert: "table" } },
  image: { id: "image", label: "Picture", icon: slashIcon("image"), action: { insert: "image" } },
  divider: { id: "divider", label: "Horizontal line", icon: slashIcon("divider"), action: { insert: "divider" } },
  undo: { id: "undo", label: "Undo", keys: "Mod-Z", icon: "M5.5 3.5 2.5 6.5l3 3M2.5 6.5h7a3.5 3.5 0 0 1 0 7H6", action: { history: "undo" } },
  redo: { id: "redo", label: "Redo", keys: "Mod-Shift-Z", icon: "M10.5 3.5l3 3-3 3M13.5 6.5h-7a3.5 3.5 0 0 0 0 7H10", action: { history: "redo" } },
  headingBigger: {
    id: "headingBigger",
    label: "Bigger heading",
    keys: "Mod-Alt-=",
    icon: "M2 3.5v9M7.5 3.5v9M2 8h5.5M12 5v6M9.5 7.5 12 5l2.5 2.5",
    action: { heading: "bigger" },
  },
  headingSmaller: {
    id: "headingSmaller",
    label: "Smaller heading",
    keys: "Mod-Alt--",
    icon: "M2 3.5v9M7.5 3.5v9M2 8h5.5M12 5v6M9.5 8.5 12 11l2.5-2.5",
    action: { heading: "smaller" },
  },
  clear: {
    id: "clear",
    label: "Clear formatting",
    keys: "Mod-\\",
    icon: "M3.5 3h8M7.5 3 5.5 13M9 9.5l4 4M13 9.5l-4 4",
    action: { clear: true },
  },
} satisfies Record<string, FormatItem>;

/** The main toolbar, in groups; headings are a menu of their own in front. */
export const TOOLBAR: FormatItem[][] = [
  [ITEMS.bold, ITEMS.italic, ITEMS.strike, ITEMS.highlight, ITEMS.code, ITEMS.link],
  [ITEMS.bullet, ITEMS.numbered, ITEMS.checklist, ITEMS.outdent, ITEMS.indent],
  [ITEMS.quote, ITEMS.codeBlock, ITEMS.table, ITEMS.image, ITEMS.divider],
];

/** The mini-toolbar over a selection; its style menu (STYLES) comes first. */
export const MINI_TOOLBAR: FormatItem[][] = [
  [ITEMS.bold, ITEMS.italic, ITEMS.strike, ITEMS.highlight, ITEMS.code, ITEMS.link],
  [ITEMS.bullet, ITEMS.numbered, ITEMS.checklist],
  [ITEMS.clear],
];

/** The mini-toolbar over a selection in a table cell: only what a cell can hold (no lists, headings or quotes). */
export const CELL_TOOLBAR: FormatItem[][] = [
  [ITEMS.bold, ITEMS.italic, ITEMS.strike, ITEMS.highlight, ITEMS.code, ITEMS.link],
  [ITEMS.clear],
];

/** The mini-toolbar's style menu. */
export const STYLES: { block: Block; label: string; keys?: string }[] = [
  { block: "paragraph", label: "Body", keys: "Mod-Alt-0" },
  { block: "h1", label: "Heading 1", keys: "Mod-Alt-1" },
  { block: "h2", label: "Heading 2", keys: "Mod-Alt-2" },
  { block: "h3", label: "Heading 3", keys: "Mod-Alt-3" },
  { block: "quote", label: "Quote" },
];

export function iconSvg(path: string): string {
  return `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
