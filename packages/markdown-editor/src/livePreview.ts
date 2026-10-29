import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension, Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { tableCursor, tableField } from "./tableWidget";

// The live view: Markdown shown as it reads, and still edited as text, like
// Obsidian's live preview. Headings, emphasis, links, list bullets, quotes
// and rules hide their Markdown except on the line the cursor is on, where
// it all shows so it can be edited. Tables are drawn as tables throughout
// (see tableWidget.ts). Raw mode is the editor without this.

const hidden = Decoration.replace({});

const lineClass = (className: string) => Decoration.line({ class: className });

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-md-bullet";
    span.textContent = "•";
    return span;
  }
  ignoreEvent() {
    return false;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-md-checkbox";
    box.checked = this.checked;
    box.disabled = view.state.readOnly;
    box.setAttribute("aria-label", this.checked ? "Done" : "To do");
    box.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("click", (e) => {
      e.preventDefault();
      toggleTask(view, view.posAtDOM(box));
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

class RuleWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-md-rule";
    return span;
  }
  ignoreEvent() {
    return false;
  }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super();
  }
  eq(other: ImageWidget) {
    return other.src === this.src && other.alt === this.alt;
  }
  toDOM() {
    if (!/^(https?:|data:image\/|\/)/i.test(this.src)) {
      const span = document.createElement("span");
      span.className = "cm-md-image-alt";
      span.textContent = this.alt || this.src;
      return span;
    }
    const img = document.createElement("img");
    img.className = "cm-md-image";
    img.src = this.src;
    img.alt = this.alt;
    return img;
  }
  ignoreEvent() {
    return false;
  }
}

/** Ticks or unticks the task whose list marker starts at `pos`. */
export function toggleTask(view: EditorView, pos: number) {
  const line = view.state.doc.lineAt(pos);
  const match = /^([-*+]\s+\[)([ xX])\]/.exec(line.text.slice(pos - line.from));
  if (!match || view.state.readOnly) return;
  const at = pos + match[1].length;
  view.dispatch({ changes: { from: at, to: at + 1, insert: match[2] === " " ? "x" : " " }, userEvent: "input.task" });
}

/** Lines the cursor or selection is on, which show their Markdown. None when the editor isn't focused. */
function activeLines(view: EditorView): Set<number> {
  const lines = new Set<number>();
  const { state } = view;
  if (!view.hasFocus || state.readOnly) return lines;
  for (const range of state.selection.ranges) {
    const last = state.doc.lineAt(range.to).number;
    for (let n = state.doc.lineAt(range.from).number; n <= last; n++) lines.add(n);
  }
  return lines;
}

export function buildDecorations(state: EditorState, ranges: readonly { from: number; to: number }[], active: Set<number>): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const { doc } = state;
  const isActive = (pos: number) => active.has(doc.lineAt(pos).number);
  const hide = (from: number, to: number) => to > from && decorations.push(hidden.range(from, to));
  const lines = (from: number, to: number, className: string) => {
    const first = doc.lineAt(from).number;
    const last = doc.lineAt(to).number;
    for (let n = first; n <= last; n++) {
      const classes = [className, n === first && `${className}-first`, n === last && `${className}-last`].filter(Boolean).join(" ");
      decorations.push(lineClass(classes).range(doc.line(n).from));
    }
  };

  for (const { from, to } of ranges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        const parent = node.node.parent?.name ?? "";
        switch (node.name) {
          case "Table":
            return false;
          case "ATXHeading1":
          case "ATXHeading2":
          case "ATXHeading3":
          case "ATXHeading4":
          case "ATXHeading5":
          case "ATXHeading6":
            decorations.push(lineClass(`cm-md-heading cm-md-h${node.name.slice(-1)}`).range(doc.lineAt(node.from).from));
            return;
          case "HeaderMark": {
            if (!parent.startsWith("ATXHeading") || isActive(node.from)) return;
            const line = doc.lineAt(node.from);
            const text = line.text;
            if (!text.slice(0, node.from - line.from).trim()) {
              // The opening #s, and the space after them.
              let end = node.to;
              while (end < line.to && text[end - line.from] === " ") end++;
              hide(node.from, end);
            } else {
              // Closing #s, and the space before them.
              let start = node.from;
              while (start > line.from && text[start - line.from - 1] === " ") start--;
              hide(start, node.to);
            }
            return;
          }
          case "EmphasisMark":
          case "StrikethroughMark":
          case "HighlightMark":
            if (!isActive(node.from)) hide(node.from, node.to);
            return;
          case "CodeMark":
            if (parent === "InlineCode" && !isActive(node.from)) hide(node.from, node.to);
            return;
          case "Link":
            if (!isActive(node.from)) {
              const marks = node.node.getChildren("LinkMark");
              if (marks.length >= 2) decorations.push(Decoration.mark({ class: "cm-md-link" }).range(marks[0].to, marks[1].from));
            }
            return;
          case "LinkMark":
          case "LinkLabel":
          case "LinkTitle":
            if ((parent === "Link" || parent === "Autolink") && !isActive(node.from)) hide(node.from, node.to);
            return;
          case "URL":
            if (parent === "Link" && !isActive(node.from)) hide(node.from, node.to);
            return;
          case "Image": {
            if (isActive(node.from)) return false;
            const url = node.node.getChild("URL");
            const marks = node.node.getChildren("LinkMark");
            const alt = marks.length >= 2 ? state.sliceDoc(marks[0].to, marks[1].from) : "";
            if (url)
              decorations.push(
                Decoration.replace({ widget: new ImageWidget(state.sliceDoc(url.from, url.to), alt) }).range(node.from, node.to),
              );
            return false;
          }
          case "ListMark": {
            if (isActive(node.from)) return;
            const list = node.node.parent?.parent?.name;
            const task = node.node.nextSibling;
            const marker = task?.name === "Task" ? task.getChild("TaskMarker") : null;
            if (marker) {
              const checked = /x/i.test(state.sliceDoc(marker.from, marker.to));
              const end = Math.min(doc.lineAt(node.from).to, marker.to + 1);
              decorations.push(Decoration.replace({ widget: new CheckboxWidget(checked) }).range(node.from, end));
              if (checked && task && task.to > end) decorations.push(Decoration.mark({ class: "cm-md-task-done" }).range(end, task.to));
            } else if (list === "BulletList") {
              decorations.push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to));
            }
            return;
          }
          case "Blockquote":
            lines(node.from, node.to, "cm-md-quote");
            return;
          case "QuoteMark": {
            if (isActive(node.from)) return;
            const line = doc.lineAt(node.from);
            hide(node.from, line.text[node.to - line.from] === " " ? node.to + 1 : node.to);
            return;
          }
          case "HorizontalRule":
            if (!isActive(node.from)) decorations.push(Decoration.replace({ widget: new RuleWidget() }).range(node.from, node.to));
            return;
          case "FencedCode":
          case "CodeBlock":
            lines(node.from, Math.max(node.from, node.to - 1), "cm-md-code");
            return;
        }
      },
    });
  }
  return Decoration.set(decorations, true);
}

const inlinePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view.state, view.visibleRanges, activeLines(view));
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        update.focusChanged ||
        syntaxTree(update.state) !== syntaxTree(update.startState) ||
        update.state.readOnly !== update.startState.readOnly
      )
        this.decorations = buildDecorations(update.state, update.view.visibleRanges, activeLines(update.view));
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** Cmd/Ctrl-click opens a link, as in the preview. A plain click puts the cursor in it. */
const linkClicks = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (!(event.metaKey || event.ctrlKey) || event.button !== 0) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return false;
    for (let node: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(view.state).resolveInner(pos, 1); node; node = node.parent) {
      const url =
        node.name === "Link" ? node.getChild("URL") : node.name === "URL" || node.name === "Autolink" ? node : null;
      if (!url) continue;
      const href = view.state.sliceDoc(url.from, url.to).replace(/^<|>$/g, "");
      if (!/^(https?:|mailto:)/i.test(href)) return false;
      window.open(href, "_blank", "noopener,noreferrer");
      event.preventDefault();
      return true;
    }
    return false;
  },
});

const liveTheme = EditorView.theme({
  "&.cm-live .cm-scroller": { fontFamily: "var(--font-sans)", lineHeight: "1.7" },
  "&.cm-live .cm-content": { fontSize: "16px" },
  ".cm-md-heading": { fontFamily: "var(--font-serif)" },
  ".cm-md-h1": { paddingTop: "0.6em", paddingBottom: "0.1em" },
  ".cm-md-h2": { paddingTop: "0.5em", paddingBottom: "0.05em" },
  ".cm-md-h3": { paddingTop: "0.35em" },
  ".cm-md-bullet": { display: "inline-block", width: "0.7em", color: "var(--muted)", fontWeight: "700" },
  ".cm-md-checkbox": { margin: "0 0.45em 0 0", verticalAlign: "-0.1em", accentColor: "var(--accent)", cursor: "pointer" },
  ".cm-md-task-done": { color: "var(--muted)", textDecoration: "line-through" },
  ".cm-md-link": { color: "var(--accent)", textDecoration: "underline", textUnderlineOffset: "2px" },
  ".cm-line.cm-md-quote": { borderLeft: "3px solid var(--border)", paddingLeft: "1em", color: "var(--muted)" },
  ".cm-line.cm-md-code": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.86em",
    backgroundColor: "var(--code-bg)",
    paddingInline: "1rem",
  },
  ".cm-line.cm-md-code-first": { borderTopLeftRadius: "10px", borderTopRightRadius: "10px", paddingTop: "0.5rem" },
  ".cm-line.cm-md-code-last": { borderBottomLeftRadius: "10px", borderBottomRightRadius: "10px", paddingBottom: "0.5rem" },
  ".cm-md-rule": { display: "inline-block", width: "100%", verticalAlign: "middle", borderTop: "1px solid var(--border)" },
  ".cm-md-image": { maxWidth: "100%", borderRadius: "6px", verticalAlign: "bottom" },
  ".cm-md-image-alt": { color: "var(--muted)", fontStyle: "italic" },

  // Tables, drawn like Claude docs: a hover handle on each row and column,
  // and bars below and to the right that add a row or a column.
  ".cm-md-table": { position: "relative", padding: "0.85rem 2.75rem 1.1rem 6px", fontFamily: "var(--font-sans)" },
  ".cm-md-table-scroll": { overflowX: "auto" },
  ".cm-md-table table": { width: "100%", borderCollapse: "collapse", fontSize: "0.95em", lineHeight: "1.5" },
  ".cm-md-table th, .cm-md-table td": {
    border: "1px solid var(--border)",
    padding: "0.45em 0.75em",
    minWidth: "6rem",
    verticalAlign: "top",
    outline: "none",
    textAlign: "left",
    caretColor: "var(--accent)",
  },
  ".cm-md-table th": { backgroundColor: "var(--surface-2)", fontWeight: "600" },
  ".cm-md-table td:focus, .cm-md-table th:focus": { boxShadow: "inset 0 0 0 2px color-mix(in srgb, var(--accent) 45%, transparent)" },
  ".cm-md-table .selected": { backgroundColor: "color-mix(in srgb, var(--syntax-function) 10%, transparent)" },
  ".cm-md-table code": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.88em",
    backgroundColor: "var(--code-bg)",
    borderRadius: "4px",
    padding: "0.1em 0.3em",
  },
  ".cm-md-table mark": { backgroundColor: "var(--highlight)", color: "inherit", borderRadius: "2px" },
  ".cm-md-table a": { color: "var(--accent)" },
  ".cm-md-table button": {
    position: "absolute",
    display: "grid",
    placeItems: "center",
    padding: "0",
    border: "1px solid var(--border)",
    background: "var(--surface)",
    color: "var(--muted)",
    cursor: "pointer",
    opacity: "0",
    transition: "opacity 120ms",
  },
  ".cm-md-table button svg": {
    width: "14px",
    height: "14px",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5",
    strokeLinecap: "round",
    strokeLinejoin: "round",
  },
  ".cm-md-table.editable:hover > button, .cm-md-table.editable.menu-open > button, .cm-md-table.editable:focus-within > button": { opacity: "1" },
  ".cm-md-table:not(.editable) > button": { display: "none" },
  ".cm-md-table button:hover": { color: "var(--text)", backgroundColor: "var(--surface-2)" },
  ".cm-md-table-handle": { zIndex: "2", borderRadius: "999px", transform: "translate(-50%, -50%)" },
  ".cm-md-table-colhandle": { width: "28px", height: "14px" },
  ".cm-md-table-colhandle svg": { strokeWidth: "2.5 !important" },
  ".cm-md-table-rowhandle": { width: "14px", height: "28px" },
  ".cm-md-table-rowhandle svg": { strokeWidth: "2.5 !important" },
  ".cm-md-table-add": { border: "0 !important", background: "var(--surface-2) !important", borderRadius: "6px" },
  ".cm-md-table-add:hover": { background: "color-mix(in srgb, var(--text) 12%, transparent) !important" },
  ".cm-md-table-addrow": { left: "6px", right: "2.75rem", bottom: "0", height: "16px" },
  ".cm-md-table-addcol": { top: "0.85rem", bottom: "1.1rem", right: "1.9rem", width: "16px" },
  ".cm-md-table-more": { top: "0.85rem", right: "0", width: "28px", height: "28px", borderRadius: "8px" },
  ".cm-md-table-more svg": { strokeWidth: "2.5 !important" },
  ".cm-md-table-menu": {
    position: "absolute",
    zIndex: "5",
    minWidth: "13rem",
    padding: "4px",
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "12px",
    boxShadow: "0 8px 28px rgb(0 0 0 / 0.14)",
  },
  ".cm-md-table .cm-md-table-menu button": {
    position: "static",
    opacity: "1",
    display: "flex",
    alignItems: "center",
    gap: "0.6rem",
    width: "100%",
    padding: "0.45rem 0.6rem",
    border: "0",
    borderRadius: "8px",
    background: "none",
    color: "var(--text)",
    fontSize: "0.92rem",
    textAlign: "left",
  },
  ".cm-md-table .cm-md-table-menu button svg": { width: "16px", height: "16px" },
  ".cm-md-table .cm-md-table-menu button:disabled": { color: "var(--muted)", opacity: "0.5", cursor: "default", background: "none" },
});

/** The live view, for a Markdown editor. Leave it out for raw Markdown. */
export function livePreview(): Extension {
  return [EditorView.editorAttributes.of({ class: "cm-live" }), inlinePreview, tableField, tableCursor, linkClicks, liveTheme];
}
