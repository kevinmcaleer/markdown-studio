import { syntaxTree } from "@codemirror/language";
import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, showTooltip, type Tooltip } from "@codemirror/view";
import { linkPrompt } from "./formatting";

// The link popover: Mod-K or the Link button asks for the URL and the text in
// a small form at the cursor, the way EasyMDE's promptURLs does, instead of
// leaving "https://" to type over. With the cursor in a link, it edits that link.

export type LinkDraft = { from: number; to: number; text: string; url: string };

const open = StateEffect.define<LinkDraft>();
const close = StateEffect.define<null>();

const URL_LIKE = /^(?:https?:\/\/|mailto:|\/|#)\S*$/i;

/** What the popover starts with: the link at the cursor, or the selected text (or URL). */
export function linkDraft(state: EditorState): LinkDraft {
  const { from, to } = state.selection.main;
  for (let node: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(from, -1); node; node = node.parent) {
    if (node.name !== "Link") continue;
    const marks = node.getChildren("LinkMark");
    const url = node.getChild("URL");
    if (marks.length >= 2 && node.to >= to)
      return { from: node.from, to: node.to, text: state.sliceDoc(marks[0].to, marks[1].from), url: url ? state.sliceDoc(url.from, url.to) : "" };
  }
  const picked = state.sliceDoc(from, to);
  if (picked.includes("\n")) return { from: to, to, text: "", url: "" };
  const trimmed = picked.trim();
  return URL_LIKE.test(trimmed) && trimmed ? { from, to, text: "", url: trimmed } : { from, to, text: picked, url: "" };
}

/** The Markdown for a link; brackets in the text and spaces in the URL are escaped. */
export function linkMarkdown(text: string, url: string): string {
  const label = (text.trim() || url.trim()).replace(/([[\]])/g, "\\$1");
  const target = url.trim().replace(/[\s()]/g, encodeURIComponent);
  return `[${label}](${target})`;
}

const field = StateField.define<{ draft: LinkDraft; tooltip: Tooltip } | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(close)) return null;
      if (e.is(open)) return { draft: e.value, tooltip: { pos: e.value.from, above: false, create: (view) => form(view, e.value) } };
    }
    if (value && tr.docChanged) return null;
    return value;
  },
  provide: (f) => showTooltip.from(f, (v) => v?.tooltip ?? null),
});

function form(view: EditorView, draft: LinkDraft) {
  const dom = document.createElement("form");
  dom.className = "cm-link-popover";
  dom.setAttribute("aria-label", "Link");
  const row = (label: string, value: string, placeholder: string) => {
    const wrap = document.createElement("label");
    const name = document.createElement("span");
    name.textContent = label;
    const input = document.createElement("input");
    input.value = value;
    input.placeholder = placeholder;
    input.spellcheck = false;
    wrap.append(name, input);
    dom.append(wrap);
    return input;
  };
  const text = row("Text", draft.text, "Link text");
  const url = row("URL", draft.url, "https://");
  url.type = "url";
  const actions = document.createElement("div");
  actions.className = "cm-link-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "primary";
  save.textContent = draft.url ? "Save" : "Insert";
  actions.append(cancel, save);
  dom.append(actions);

  const dismiss = () => {
    view.dispatch({ effects: close.of(null) });
    view.focus();
  };
  cancel.addEventListener("click", dismiss);
  dom.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dismiss();
    }
  });
  dom.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!url.value.trim()) return url.focus();
    const insert = linkMarkdown(text.value, url.value);
    view.dispatch({
      changes: { from: draft.from, to: draft.to, insert },
      selection: { anchor: draft.from + insert.length },
      effects: close.of(null),
      userEvent: "input",
      scrollIntoView: true,
    });
    view.focus();
  });
  // Start where there's something to type: the URL, unless it's already there.
  queueMicrotask(() => (draft.url && !draft.text ? text : url).focus());
  return { dom };
}

/** Opens the popover for the selection. False in a read-only editor. */
export function openLinkPopover(view: EditorView): boolean {
  if (view.state.readOnly) return false;
  view.dispatch({ effects: open.of(linkDraft(view.state)) });
  return true;
}

const theme = EditorView.theme({
  ".cm-tooltip.cm-link-popover": {
    display: "grid",
    gap: "0.45rem",
    width: "19rem",
    padding: "0.65rem",
    border: "1px solid var(--border)",
    borderRadius: "10px",
    background: "var(--surface)",
    boxShadow: "0 8px 28px rgb(0 0 0 / 0.14)",
    fontFamily: "var(--font-sans)",
    fontSize: "13px",
    color: "var(--text)",
  },
  ".cm-link-popover label": { display: "grid", gridTemplateColumns: "2.6rem 1fr", alignItems: "center", gap: "0.4rem" },
  ".cm-link-popover span": { color: "var(--muted)" },
  ".cm-link-popover input": {
    font: "inherit",
    padding: "0.3rem 0.45rem",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    background: "var(--bg)",
    color: "var(--text)",
    minWidth: "0",
  },
  ".cm-link-popover input:focus": { outline: "2px solid color-mix(in srgb, var(--accent) 45%, transparent)", outlineOffset: "0" },
  ".cm-link-actions": { display: "flex", justifyContent: "flex-end", gap: "0.35rem" },
  ".cm-link-actions button": {
    font: "inherit",
    padding: "0.25rem 0.7rem",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    background: "var(--surface)",
    color: "var(--text)",
    cursor: "pointer",
  },
  ".cm-link-actions button.primary": { background: "var(--accent)", borderColor: "var(--accent)", color: "var(--accent-text, #fff)" },
});

/** Mod-K and the Link buttons open a popover for the URL and text. */
export function linkPopover(): Extension {
  return [field, theme, linkPrompt.of(openLinkPopover)];
}
