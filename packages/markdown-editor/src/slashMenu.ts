import { syntaxTree } from "@codemirror/language";
import { Facet, Prec, StateEffect, StateField, type EditorState, type Extension, type TransactionSpec } from "@codemirror/state";
import { EditorView, keymap, showTooltip, type Tooltip } from "@codemirror/view";
import { calloutKinds } from "./callouts";

// Typing "/" at the start of a line (or after a space) opens a menu of
// Markdown blocks, like Claude docs. Typing more filters it; arrows move,
// Enter or Tab picks, Escape closes. Picking one swaps "/query" for the
// Markdown, with the cursor (or a selected placeholder) where you'd type next.

export type SlashCommand = {
  id: string;
  label: string;
  /** Other words it can be found by. */
  keywords: string[];
  /** Menu section; a divider is drawn between sections. */
  group: string;
  /** 16×16 stroke icon path. */
  icon: string;
  /** The icon's viewBox, when it isn't drawn on 16×16 ("0 0 24 24", say). */
  viewBox?: string;
  /** Starts on its own line. */
  block?: boolean;
  /** Needs an empty line above it to parse (a table, a fence, a rule). */
  blankBefore?: boolean;
  /** The text inserted; the placeholder is selected, or the cursor goes there when it's empty. */
  insert?: () => { before: string; placeholder?: string; after?: string };
  /**
   * Runs instead of (or after) inserting text, with the "/query" already gone:
   * a host's command that opens its own picker, say.
   */
  run?: (view: EditorView) => void;
};

export const slashCommands: SlashCommand[] = [
  {
    id: "h1",
    label: "Heading 1",
    keywords: ["h1", "title", "#"],
    group: "blocks",
    icon: "M2 3.5v9M8 3.5v9M2 8h6M11 8.5l2-1.5v6",
    block: true,
    insert: () => ({ before: "# " }),
  },
  {
    id: "h2",
    label: "Heading 2",
    keywords: ["h2", "subtitle", "##"],
    group: "blocks",
    icon: "M2 3.5v9M8 3.5v9M2 8h6M10.5 8.5a1.5 1.5 0 0 1 3 .3c0 1.2-3 2.6-3 3.7h3",
    block: true,
    insert: () => ({ before: "## " }),
  },
  {
    id: "h3",
    label: "Heading 3",
    keywords: ["h3", "###"],
    group: "blocks",
    icon: "M2 3.5v9M8 3.5v9M2 8h6M10.5 7.5h3l-1.6 2a1.5 1.5 0 1 1-1.4 2.2",
    block: true,
    insert: () => ({ before: "### " }),
  },
  {
    id: "table",
    label: "Table",
    keywords: ["grid", "columns", "rows"],
    group: "blocks",
    icon: "M2.5 3h11v10h-11zM2.5 6.5h11M2.5 9.75h11M6.5 3v10",
    block: true,
    blankBefore: true,
    insert: () => ({ before: "| ", placeholder: "Column 1", after: " | Column 2 | Column 3 |\n| --- | --- | --- |\n|  |  |  |\n" }),
  },
  {
    id: "quote",
    label: "Quote",
    keywords: ["blockquote", ">"],
    group: "blocks",
    icon: "M3.5 4v8M6.5 5h6.5M6.5 8h6.5M6.5 11h4",
    block: true,
    insert: () => ({ before: "> " }),
  },
  ...(["note", "info", "tip", "success", "question", "warning", "danger", "example"] as const).map((type): SlashCommand => {
    const kind = calloutKinds.find((k) => k.type === type)!;
    return {
      id: `callout-${type}`,
      label: `${kind.label} callout`,
      keywords: ["callout", "admonition", "alert", "box", type, ...kind.aliases],
      group: "callouts",
      icon: kind.icon,
      viewBox: "0 0 24 24",
      block: true,
      blankBefore: true,
      insert: () => ({ before: `> [!${type}] `, placeholder: kind.label, after: "\n> " }),
    };
  }),
  {
    id: "bullet",
    label: "Bulleted list",
    keywords: ["ul", "unordered", "bullets", "-"],
    group: "lists",
    icon: "M6 4h7.5M6 8h7.5M6 12h7.5M2.75 4h.01M2.75 8h.01M2.75 12h.01",
    block: true,
    insert: () => ({ before: "- " }),
  },
  {
    id: "numbered",
    label: "Numbered list",
    keywords: ["ol", "ordered", "1."],
    group: "lists",
    icon: "M6.5 4h7M6.5 8h7M6.5 12h7M2.5 3l1-.5v3M2.5 7.5a.9.9 0 0 1 1.6.4c0 .7-1.6 1.2-1.6 1.9h1.7",
    block: true,
    insert: () => ({ before: "1. " }),
  },
  {
    id: "checklist",
    label: "Checklist",
    keywords: ["todo", "tasks", "checkbox", "[ ]"],
    group: "lists",
    icon: "M7 4.5h6.5M7 11.5h6.5M2 4.5l1.2 1.2L5.2 3.5M2.25 10h2.5v2.5h-2.5z",
    block: true,
    insert: () => ({ before: "- [ ] " }),
  },
  {
    id: "code",
    label: "Code block",
    keywords: ["fence", "snippet", "```", "pre"],
    group: "lists",
    icon: "M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5M9 3l-2 10",
    block: true,
    blankBefore: true,
    insert: () => ({ before: "```\n", after: "\n```\n" }),
  },
  {
    id: "divider",
    label: "Divider",
    keywords: ["rule", "hr", "line", "separator", "---"],
    group: "lists",
    icon: "M2.5 8h11",
    block: true,
    blankBefore: true,
    insert: () => ({ before: "---\n\n" }),
  },
  {
    id: "image",
    label: "Image",
    keywords: ["picture", "photo", "img"],
    group: "inline",
    icon: "M2.5 3h11v10h-11zM2.5 11l3.5-3.5 3 3 1.5-1.5 3 3M10.5 6.25h.01",
    insert: () => ({ before: "![", placeholder: "Description", after: "](https://)" }),
  },
  {
    id: "link",
    label: "Link",
    keywords: ["url", "href", "anchor"],
    group: "inline",
    icon: "M7 9a2.5 2.5 0 0 0 3.5 0l2-2a2.5 2.5 0 0 0-3.5-3.5l-.75.75M9 7a2.5 2.5 0 0 0-3.5 0l-2 2A2.5 2.5 0 0 0 7 12.5l.75-.75",
    insert: () => ({ before: "[", placeholder: "Link text", after: "](https://)" }),
  },
  {
    id: "highlight",
    label: "Highlight",
    keywords: ["mark", "==", "marker"],
    group: "inline",
    icon: "M9.5 2.5l4 4-6 6H3.5v-4zM2.5 14h11",
    insert: () => ({ before: "==", placeholder: "highlighted", after: "==" }),
  },
  {
    id: "date",
    label: "Date",
    keywords: ["today", "now", "time"],
    group: "inline",
    icon: "M2.5 3.5h11v10h-11zM2.5 6.5h11M5.5 2v3M10.5 2v3",
    insert: () => ({ before: new Date().toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) }),
  },
];

/** EasyMDE's `insertTexts`: the text before and after the cursor for each insert. */
export type InsertTexts = Partial<Record<"link" | "image" | "table" | "horizontalRule" | "code", [string, string]>>;

const INSERT_IDS = { link: "link", image: "image", table: "table", horizontalRule: "divider", code: "code" } as const;

/** The commands with a host's templates in place of the built-in ones. */
export function withInsertTexts(commands: SlashCommand[], texts: InsertTexts = {}): SlashCommand[] {
  return commands.map((command) => {
    const key = (Object.keys(INSERT_IDS) as (keyof InsertTexts)[]).find((k) => INSERT_IDS[k] === command.id);
    const text = key && texts[key];
    return text ? { ...command, insert: () => ({ before: text[0], after: text[1] }) } : command;
  });
}

/** Commands matching what's been typed after the slash, best first. */
export function filterCommands(query: string, commands = slashCommands): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  const score = (c: SlashCommand) => {
    const label = c.label.toLowerCase();
    if (label.startsWith(q)) return 0;
    if (c.keywords.some((k) => k.toLowerCase() === q)) return 1;
    if (label.split(/\s+/).some((w) => w.startsWith(q))) return 2;
    if (c.keywords.some((k) => k.toLowerCase().startsWith(q))) return 3;
    if (label.includes(q)) return 4;
    return -1;
  };
  return commands
    .map((c, i) => ({ c, i, s: score(c) }))
    .filter((m) => m.s >= 0)
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((m) => m.c);
}

/** The change that replaces from..to (the "/query") with the command's Markdown. */
export function applyCommand(state: EditorState, command: SlashCommand, from: number, to: number): TransactionSpec {
  const line = state.doc.lineAt(from);
  const textBefore = state.sliceDoc(line.from, from);
  let lead = "";
  if (command.block && textBefore.trim()) lead = command.blankBefore ? "\n\n" : "\n";
  else if (command.blankBefore && line.number > 1 && state.doc.line(line.number - 1).text.trim()) lead = "\n";
  const { before, placeholder = "", after = "" } = command.insert?.() ?? { before: "" };
  if (!command.insert) lead = "";
  const start = from + lead.length + before.length;
  return {
    changes: { from, to, insert: lead + before + placeholder + after },
    selection: { anchor: start, head: start + placeholder.length },
    scrollIntoView: true,
    userEvent: "input.complete",
  };
}

// ---------------------------------------------------------------- state

/** Which commands the menu offers; Notes gets the defaults, Decks adds slide commands. */
const commandList = Facet.define<SlashCommand[], SlashCommand[]>({ combine: (lists) => lists[0] ?? slashCommands });

/** The commands this editor offers (the defaults, or what it was given). */
export function commandsOf(state: EditorState): SlashCommand[] {
  return state.facet(commandList);
}

/** Whether this editor has the "/" menu (a table's cells offer it too). */
export function hasSlashMenu(state: EditorState): boolean {
  return state.field(menuField, false) !== undefined;
}

// `scroll` is set when the keyboard moved the highlight, so the menu brings it into view;
// a mouse hover leaves the list where the user scrolled it.
// `tooltip` is kept for as long as the menu stays at `from`: CodeMirror rebuilds a tooltip
// whenever it gets a new object, which would reset the list's scroll on every highlight change.
type MenuState = { from: number; query: string; selected: number; scroll?: boolean; tooltip: Tooltip } | null;

const moveSelection = StateEffect.define<{ index: number; scroll: boolean }>();
const closeMenu = StateEffect.define<null>();

/** Where "/" may open the menu: not in code, links or URLs, where a slash is just a slash. */
type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]>;

function slashAllowed(state: EditorState, pos: number): boolean {
  const before = pos > 0 ? state.sliceDoc(pos - 1, pos) : "";
  if (before && !/\s/.test(before)) return false;
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (/^(FencedCode|CodeBlock|InlineCode|CodeText|URL|Link|Image|HTMLBlock|Comment)$/.test(node.name)) return false;
  }
  return true;
}

const menuField = StateField.define<MenuState>({
  create: () => null,
  update(menu, tr) {
    for (const e of tr.effects) {
      if (e.is(closeMenu)) return null;
      if (e.is(moveSelection) && menu) menu = { ...menu, selected: e.value.index, scroll: e.value.scroll };
    }
    const head = tr.state.selection.main.head;
    if (!menu) {
      // Open only on a "/" the user just typed.
      if (!tr.isUserEvent("input.type") || !tr.state.selection.main.empty) return null;
      let typed: number | null = null;
      tr.changes.iterChanges((_fa, _ta, fromB, toB, text) => {
        if (text.toString() === "/" && toB === head) typed = fromB;
      });
      return typed !== null && slashAllowed(tr.state, typed) ? { from: typed, query: "", selected: 0, tooltip: menuTooltip(typed) } : null;
    }
    if (!tr.docChanged && !tr.selection) return menu;
    const from = tr.changes.mapPos(menu.from, 1);
    const sel = tr.state.selection.main;
    if (!sel.empty || head <= from || tr.state.sliceDoc(from, from + 1) !== "/") return null;
    const query = tr.state.sliceDoc(from + 1, head);
    if (query.includes("\n") || query.length > 24) return null;
    // A space after a query nothing matches means you've moved on.
    if (/\s$/.test(query) && !filterCommands(query, tr.state.facet(commandList)).length) return null;
    const tooltip = from === menu.from ? menu.tooltip : menuTooltip(from);
    return { from, query, selected: query === menu.query ? menu.selected : 0, tooltip };
  },
  provide: (field) => showTooltip.from(field, (menu) => menu?.tooltip ?? null),
});

function pick(view: EditorView, command: SlashCommand) {
  const menu = view.state.field(menuField);
  if (!menu) return;
  view.dispatch({ ...applyCommand(view.state, command, menu.from, view.state.selection.main.head), effects: closeMenu.of(null) });
  view.focus();
  command.run?.(view);
}

// ---------------------------------------------------------------- view

function menuTooltip(pos: number): Tooltip {
  return {
    pos,
    above: false,
    create(view) {
      const dom = document.createElement("div");
      dom.className = "cm-slash-menu";
      dom.setAttribute("role", "listbox");
      dom.setAttribute("aria-label", "Insert");
      // Keep focus in the editor while clicking items.
      dom.addEventListener("mousedown", (e) => e.preventDefault());
      let shownQuery: string | null = null;
      let shownSelected = -1;
      let rows: HTMLElement[] = [];
      const render = (state: EditorState) => {
        const menu = state.field(menuField);
        if (!menu) return;
        if (menu.query !== shownQuery) {
          shownQuery = menu.query;
          shownSelected = -1;
          build(menu.query, state);
          dom.scrollTop = 0;
        }
        if (menu.selected === shownSelected) return;
        shownSelected = menu.selected;
        // Only the highlight changes here: rebuilding the rows would reset the scroll position.
        rows.forEach((row, i) => row.setAttribute("aria-selected", String(i === menu.selected)));
        const row = rows[menu.selected];
        if (row && menu.scroll) row.scrollIntoView({ block: "nearest" });
      };
      const build = (query: string, state: EditorState) => {
        const items = filterCommands(query, state.facet(commandList));
        rows = [];
        dom.replaceChildren();
        if (!items.length) {
          const empty = document.createElement("div");
          empty.className = "cm-slash-empty";
          empty.textContent = "No matches";
          dom.append(empty);
          return;
        }
        items.forEach((command, i) => {
          if (i > 0 && !query.trim() && command.group !== items[i - 1].group) {
            const hr = document.createElement("div");
            hr.className = "cm-slash-divider";
            hr.setAttribute("role", "separator");
            dom.append(hr);
          }
          const item = document.createElement("div");
          item.className = "cm-slash-item";
          item.setAttribute("role", "option");
          const viewBox = command.viewBox ?? "0 0 16 16";
          // The same 1.3px line whatever the icon was drawn on.
          const stroke = (1.3 * Number(viewBox.split(/\s+/)[2] ?? 16)) / 16;
          item.innerHTML = `<svg width="16" height="16" viewBox="${viewBox}" aria-hidden="true"><path d="${command.icon}" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
          item.append(command.label);
          item.addEventListener("mousemove", () => {
            const current = view.state.field(menuField);
            if (current && current.selected !== i) view.dispatch({ effects: moveSelection.of({ index: i, scroll: false }) });
          });
          item.addEventListener("click", () => pick(view, command));
          dom.append(item);
          rows.push(item);
        });
      };
      render(view.state);
      return { dom, update: (u) => render(u.state) };
    },
  };
}

function move(step: number) {
  return (view: EditorView) => {
    const menu = view.state.field(menuField);
    const count = menu ? filterCommands(menu.query, view.state.facet(commandList)).length : 0;
    if (!menu || !count) return false;
    view.dispatch({ effects: moveSelection.of({ index: (menu.selected + step + count) % count, scroll: true }) });
    return true;
  };
}

function choose(view: EditorView) {
  const menu = view.state.field(menuField);
  const command = menu && filterCommands(menu.query, view.state.facet(commandList))[menu.selected];
  if (!command) return false;
  pick(view, command);
  return true;
}

function close(view: EditorView) {
  if (!view.state.field(menuField)) return false;
  view.dispatch({ effects: closeMenu.of(null) });
  return true;
}

const menuKeys = Prec.highest(
  keymap.of([
    { key: "ArrowDown", run: move(1) },
    { key: "ArrowUp", run: move(-1) },
    { key: "Ctrl-n", run: move(1) },
    { key: "Ctrl-p", run: move(-1) },
    { key: "Enter", run: choose },
    { key: "Tab", run: choose },
    { key: "Escape", run: close },
  ]),
);

const menuTheme = EditorView.theme({
  // CodeMirror puts its own .cm-tooltip class on this element.
  ".cm-tooltip.cm-slash-menu": {
    border: "1px solid var(--border)",
    borderRadius: "12px",
    background: "var(--surface)",
    boxShadow: "0 8px 28px rgb(0 0 0 / 0.12)",
    width: "15rem",
    maxHeight: "min(22rem, 50vh)",
    overflowY: "auto",
    padding: "0.35rem",
    fontFamily: "var(--font-sans)",
    fontSize: "14px",
    lineHeight: "1.4",
    color: "var(--text)",
  },
  ".cm-slash-item": {
    display: "flex",
    alignItems: "center",
    gap: "0.65rem",
    padding: "0.45rem 0.6rem",
    borderRadius: "8px",
    cursor: "pointer",
  },
  ".cm-slash-item svg": { flex: "none", color: "var(--muted)" },
  ".cm-slash-item[aria-selected=true]": { background: "var(--surface-2)" },
  ".cm-slash-divider": { height: "1px", margin: "0.3rem 0.6rem", background: "var(--border)" },
  ".cm-slash-empty": { padding: "0.45rem 0.6rem", color: "var(--muted)" },
});

/** The "/" menu. Add it to an editable editor. */
export function slashMenu(commands: SlashCommand[] = slashCommands): Extension {
  return [commandList.of(commands), menuField, menuKeys, menuTheme];
}
