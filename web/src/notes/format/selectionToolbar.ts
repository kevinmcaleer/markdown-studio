import { Prec, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, showTooltip, type Tooltip, type TooltipView, type ViewUpdate } from "@codemirror/view";
import { activeFormats, runFormat } from "./formatting";
import { iconSvg, itemTitle, MINI_TOOLBAR } from "./items";

// A small dark toolbar over selected text, in the style of NoodlePlanner's
// editor toolbar. It waits until you let go of the mouse, so it doesn't jump
// about while you drag, and Escape puts it away until the selection changes.

type Shown = { pointerDown: boolean; focused: boolean; dismissed: boolean };

const setPointer = StateEffect.define<boolean>();
const setFocused = StateEffect.define<boolean>();
const dismiss = StateEffect.define<null>();

const shownField = StateField.define<Shown>({
  create: () => ({ pointerDown: false, focused: false, dismissed: false }),
  update(value, tr) {
    let next = value;
    if (tr.selection && next.dismissed) next = { ...next, dismissed: false };
    for (const e of tr.effects) {
      if (e.is(setPointer)) next = { ...next, pointerDown: e.value };
      if (e.is(setFocused)) next = { ...next, focused: e.value };
      if (e.is(dismiss)) next = { ...next, dismissed: true };
    }
    return next;
  },
});

function visible(state: EditorState): boolean {
  const shown = state.field(shownField);
  const range = state.selection.main;
  if (range.empty || state.readOnly || shown.pointerDown || !shown.focused || shown.dismissed) return false;
  // Only a selection with something besides spaces in it.
  return state.sliceDoc(range.from, Math.min(range.to, range.from + 200)).trim() !== "";
}

const toolbarTooltip = showTooltip.compute([shownField, "selection"], (state): Tooltip | null =>
  visible(state) ? { pos: state.selection.main.from, above: true, create: createToolbar } : null,
);

function createToolbar(view: EditorView): TooltipView {
  const dom = document.createElement("div");
  dom.className = "cm-format-mini";
  dom.setAttribute("role", "toolbar");
  dom.setAttribute("aria-label", "Format selection");
  // Clicking a button must keep the selection and focus in the editor.
  dom.addEventListener("mousedown", (e) => e.preventDefault());
  const buttons: [HTMLButtonElement, (typeof MINI_TOOLBAR)[number][number]][] = [];
  MINI_TOOLBAR.forEach((group, g) => {
    if (g > 0) {
      const sep = document.createElement("span");
      sep.className = "cm-format-mini-sep";
      dom.append(sep);
    }
    for (const item of group) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cm-format-mini-btn";
      button.title = itemTitle(item);
      button.setAttribute("aria-label", item.label);
      button.innerHTML = iconSvg(item.icon);
      button.addEventListener("click", () => runFormat(view, item.action));
      dom.append(button);
      buttons.push([button, item]);
    }
  });
  const sync = (state: EditorState) => {
    const active = activeFormats(state);
    for (const [button, item] of buttons) if (item.on) button.setAttribute("aria-pressed", String(item.on(active)));
  };
  sync(view.state);
  return {
    dom,
    // Sit a little clear of the line.
    offset: { x: 0, y: 6 },
    update: (u: ViewUpdate) => {
      if (u.docChanged || u.selectionSet) sync(u.state);
    },
  };
}

const theme = EditorView.theme({
  // NoodlePlanner's dark editor toolbar: #252526, #3a3a3a lines and hovers, #d4d4d4 text.
  ".cm-tooltip.cm-format-mini": {
    display: "flex",
    alignItems: "center",
    gap: "2px",
    padding: "4px",
    background: "#252526",
    color: "#d4d4d4",
    border: "1px solid #3a3a3a",
    borderRadius: "8px",
    boxShadow: "0 6px 20px rgb(0 0 0 / 0.28)",
    fontFamily: "var(--font-sans)",
  },
  ".cm-format-mini-btn": {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: "28px",
    height: "28px",
    padding: "0 6px",
    border: "1px solid transparent",
    borderRadius: "4px",
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
  },
  ".cm-format-mini-btn:hover": { background: "#3a3a3a", borderColor: "#555" },
  ".cm-format-mini-btn[aria-pressed=true]": { background: "#3a3a3a", color: "#ffffff" },
  ".cm-format-mini-btn:focus-visible": { outline: "2px solid var(--accent)", outlineOffset: "1px" },
  ".cm-format-mini-sep": { width: "1px", alignSelf: "stretch", margin: "4px 3px", background: "#3a3a3a" },
});

/** The floating toolbar over a selection. Add it to an editable Markdown editor. */
export function selectionToolbar(): Extension {
  return [
    shownField,
    toolbarTooltip,
    theme,
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button !== 0) return false;
        view.dispatch({ effects: setPointer.of(true) });
        const up = () => {
          document.removeEventListener("mouseup", up);
          if (view.dom.isConnected) view.dispatch({ effects: setPointer.of(false) });
        };
        document.addEventListener("mouseup", up);
        return false;
      },
    }),
    // Before the default Escape, which would drop the selection too.
    Prec.highest(
      keymap.of([
        {
          key: "Escape",
          run(view) {
            if (!visible(view.state)) return false;
            view.dispatch({ effects: dismiss.of(null) });
            return true;
          },
        },
      ]),
    ),
    EditorView.focusChangeEffect.of((_state, focusing) => setFocused.of(focusing)),
  ];
}
