import { Prec, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, showTooltip, type Tooltip } from "@codemirror/view";
import { calloutKinds, type CalloutKind } from "./callouts";
import "./callouts.css";

// The callout type picker. With the caret on a callout's type name (the
// "tip" in `> [!tip]`), a list of every type opens under it, each with its
// icon and colour, so you can see what there is and pick one. Typing filters
// it; arrows and Enter pick from the keyboard; Escape puts it away.

/** The type name of the callout whose `> [!…]` the caret is in: where it is, and what's written. */
export type CalloutTypeRange = { from: number; to: number; name: string };

/** The `[!name]` the caret is in, on a quote's first line; null anywhere else. */
export function calloutTypeAt(state: EditorState): CalloutTypeRange | null {
  const caret = state.selection.main;
  if (!caret.empty) return null;
  const line = state.doc.lineAt(caret.head);
  const match = /^(>[ \t]?\[!)([\w-]*)\]/.exec(line.text);
  if (!match) return null;
  // Only a quote's first line can say what kind of callout it is.
  if (line.number > 1 && /^\s*>/.test(state.doc.line(line.number - 1).text)) return null;
  const from = line.from + match[1].length;
  const to = from + match[2].length;
  if (caret.head < from || caret.head > to) return null;
  return { from, to, name: match[2].toLowerCase() };
}

const names = (kind: CalloutKind) => [kind.type, ...kind.aliases];

/** The types to offer for what's written: all of them, or the ones a part-typed name starts. */
export function calloutChoices(name: string): CalloutKind[] {
  if (!name || calloutKinds.some((kind) => names(kind).includes(name))) return calloutKinds;
  const started = calloutKinds.filter((kind) => names(kind).some((n) => n.startsWith(name)));
  return started.length ? started : calloutKinds;
}

/** Which of `choices` the name already is (or the first, for a new name). */
function current(choices: CalloutKind[], name: string): number {
  const at = choices.findIndex((kind) => names(kind).includes(name));
  return at < 0 ? 0 : at;
}

type Picker = { range: CalloutTypeRange | null; focused: boolean; dismissed: boolean; selected: number; scroll: boolean; tooltip: Tooltip | null };

const move = StateEffect.define<{ index: number; scroll: boolean }>();
const dismiss = StateEffect.define<null>();
const focused = StateEffect.define<boolean>();

const pickerField = StateField.define<Picker>({
  create: () => ({ range: null, focused: false, dismissed: false, selected: 0, scroll: false, tooltip: null }),
  update(picker, tr) {
    let { focused: hasFocus, dismissed, selected, scroll } = picker;
    for (const e of tr.effects) {
      if (e.is(focused)) hasFocus = e.value;
      if (e.is(dismiss)) dismissed = true;
      if (e.is(move)) ({ index: selected, scroll } = e.value);
    }
    const range = tr.state.readOnly ? null : calloutTypeAt(tr.state);
    const sameBox = !!range && !!picker.range && range.from === tr.changes.mapPos(picker.range.from);
    // A new callout, or the caret back in after leaving, opens it again.
    if (!sameBox) dismissed = false;
    // A changed name highlights the type it now is.
    if (range && (!sameBox || range.name !== picker.range?.name)) {
      selected = current(calloutChoices(range.name), range.name);
      scroll = true;
    }
    const show = !!range && hasFocus && !dismissed;
    const tooltip = !show ? null : sameBox && picker.tooltip ? picker.tooltip : pickerTooltip(range.from);
    return { range, focused: hasFocus, dismissed, selected, scroll, tooltip };
  },
  provide: (f) => showTooltip.from(f, (v) => v.tooltip),
});

/** Changes the callout's type to `kind`, leaving the caret after its `]`. */
function pick(view: EditorView, kind: CalloutKind) {
  const { range } = view.state.field(pickerField);
  if (!range) return;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: kind.type },
    selection: { anchor: range.from + kind.type.length + 1 },
    userEvent: "input.callout-type",
  });
  view.focus();
}

function pickerTooltip(pos: number): Tooltip {
  return {
    pos,
    above: false,
    create(view) {
      const dom = document.createElement("div");
      dom.className = "cm-callout-picker";
      dom.setAttribute("role", "listbox");
      dom.setAttribute("aria-label", "Callout type");
      dom.addEventListener("mousedown", (e) => e.preventDefault());
      const heading = document.createElement("div");
      heading.className = "cm-callout-picker-heading";
      heading.textContent = "Callout type";
      const list = document.createElement("div");
      list.className = "cm-callout-picker-list";
      dom.append(heading, list);
      let shownName: string | null = null;
      let rows: HTMLElement[] = [];
      const render = (state: EditorState) => {
        const picker = state.field(pickerField);
        if (!picker.range) return;
        if (picker.range.name !== shownName) {
          shownName = picker.range.name;
          build(calloutChoices(shownName));
        }
        rows.forEach((row, i) => row.setAttribute("aria-selected", String(i === picker.selected)));
        if (picker.scroll) rows[picker.selected]?.scrollIntoView?.({ block: "nearest" });
      };
      const build = (choices: CalloutKind[]) => {
        rows = choices.map((kind, i) => {
          const row = document.createElement("div");
          row.className = `cm-callout-picker-item callout-${kind.type}`;
          row.setAttribute("role", "option");
          row.dataset.type = kind.type;
          const icon = document.createElement("span");
          icon.className = "callout-icon";
          icon.setAttribute("aria-hidden", "true");
          const label = document.createElement("span");
          label.className = "cm-callout-picker-label";
          label.textContent = kind.label;
          row.append(icon, label);
          if (kind.aliases.length) {
            const also = document.createElement("span");
            also.className = "cm-callout-picker-aliases";
            also.textContent = kind.aliases.join(", ");
            row.append(also);
          }
          row.addEventListener("mousemove", () => {
            if (view.state.field(pickerField).selected !== i) view.dispatch({ effects: move.of({ index: i, scroll: false }) });
          });
          row.addEventListener("click", () => pick(view, kind));
          return row;
        });
        list.replaceChildren(...rows);
      };
      render(view.state);
      return { dom, update: (u) => render(u.state) };
    },
  };
}

function step(by: number) {
  return (view: EditorView) => {
    const { range, selected, tooltip } = view.state.field(pickerField);
    if (!range || !tooltip) return false;
    const count = calloutChoices(range.name).length;
    view.dispatch({ effects: move.of({ index: (selected + by + count) % count, scroll: true }) });
    return true;
  };
}

function choose(view: EditorView) {
  const { range, selected, tooltip } = view.state.field(pickerField);
  const kind = range && tooltip ? calloutChoices(range.name)[selected] : null;
  if (!kind) return false;
  pick(view, kind);
  return true;
}

function close(view: EditorView) {
  if (!view.state.field(pickerField).tooltip) return false;
  view.dispatch({ effects: dismiss.of(null) });
  return true;
}

/** Puts the caret at the end of the type name of the callout whose `> [!…]` starts at `pos`, which opens the picker. */
export function editCalloutType(view: EditorView, pos: number): boolean {
  const line = view.state.doc.lineAt(pos);
  const match = /^(>[ \t]?\[![\w-]*)\]/.exec(line.text);
  if (!match || view.state.readOnly) return false;
  view.dispatch({ selection: { anchor: line.from + match[1].length } });
  view.focus();
  return true;
}

const keys = Prec.highest(
  keymap.of([
    { key: "ArrowDown", run: step(1) },
    { key: "ArrowUp", run: step(-1) },
    { key: "Enter", run: choose },
    { key: "Escape", run: close },
  ]),
);

const theme = EditorView.theme({
  ".cm-tooltip.cm-callout-picker": {
    border: "1px solid var(--border)",
    borderRadius: "12px",
    background: "var(--surface)",
    boxShadow: "0 8px 28px rgb(0 0 0 / 0.12)",
    width: "17rem",
    padding: "0.35rem",
    fontFamily: "var(--font-sans)",
    fontSize: "14px",
    lineHeight: "1.4",
    color: "var(--text)",
  },
  ".cm-callout-picker-heading": { padding: "0.25rem 0.6rem 0.35rem", color: "var(--muted)", fontSize: "12px", fontWeight: "600" },
  ".cm-callout-picker-list": { maxHeight: "min(20rem, 45vh)", overflowY: "auto" },
  ".cm-callout-picker-item": {
    display: "flex",
    alignItems: "center",
    gap: "0.6rem",
    padding: "0.4rem 0.6rem",
    borderRadius: "8px",
    cursor: "pointer",
  },
  ".cm-callout-picker-item .callout-icon": {
    width: "1.6rem",
    height: "1.6rem",
    borderRadius: "6px",
    // The icon in its colour on its own tint, the way the callout itself looks.
    background: "rgb(var(--callout-color) / 0.14)",
    position: "relative",
    WebkitMask: "none",
    mask: "none",
  },
  ".cm-callout-picker-item .callout-icon::after": {
    content: '""',
    position: "absolute",
    inset: "0.3rem",
    backgroundColor: "color-mix(in srgb, rgb(var(--callout-color)) var(--callout-title-tone, 75%), black)",
    WebkitMask: "var(--callout-icon) center / contain no-repeat",
    mask: "var(--callout-icon) center / contain no-repeat",
  },
  ".cm-callout-picker-label": { fontWeight: "600", color: "color-mix(in srgb, rgb(var(--callout-color)) var(--callout-title-tone, 60%), black)" },
  ".cm-callout-picker-aliases": {
    marginLeft: "auto",
    color: "var(--muted)",
    fontSize: "12px",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    minWidth: "0",
  },
  ".cm-callout-picker-item[aria-selected=true]": { background: "var(--surface-2)" },
});

/** The callout type picker. Add it to an editable editor. */
export function calloutPicker(): Extension {
  return [pickerField, keys, theme, EditorView.focusChangeEffect.of((_state, focusing) => focused.of(focusing))];
}
