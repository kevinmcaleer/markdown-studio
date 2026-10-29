import { syntaxTree } from "@codemirror/language";
import { Facet, StateField, type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

// In the live view, a fenced block in a language the host can draw (```mermaid,
// say) shows as its drawing while the cursor is outside it, and as its source
// once the cursor moves in (clicking the drawing puts it there). The host
// supplies the drawing through the `codeRenderers` option.

/** Draws a block's source into `element`; may finish later. */
export type CodeRenderer = (source: string, element: HTMLElement) => void | Promise<void>;

/** The renderers, by fence language (lower case). */
export const codeRenderers = Facet.define<Record<string, CodeRenderer>, Record<string, CodeRenderer>>({
  combine: (values) => Object.assign({}, ...values),
});

class RenderedCodeWidget extends WidgetType {
  constructor(
    readonly language: string,
    readonly source: string,
  ) {
    super();
  }
  eq(other: RenderedCodeWidget) {
    return other.language === this.language && other.source === this.source;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-rendered";
    wrap.title = "Click to edit";
    const body = document.createElement("div");
    body.className = `cm-md-rendered-body cm-md-rendered-${this.language}`;
    wrap.append(body);
    const failed = (error: unknown) => {
      body.textContent = "";
      const pre = document.createElement("pre");
      pre.className = "cm-md-rendered-error";
      pre.textContent = `Couldn't draw this ${this.language} block: ${error instanceof Error ? error.message : String(error)}`;
      body.append(pre);
    };
    const render = view.state.facet(codeRenderers)[this.language];
    try {
      Promise.resolve(render?.(this.source, body))
        .catch(failed)
        .finally(() => view.requestMeasure());
    } catch (error) {
      failed(error);
    }
    // Clicking the drawing opens its source, with the cursor on the first line of code.
    wrap.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const open = view.state.doc.lineAt(view.posAtDOM(wrap));
      const first = open.number < view.state.doc.lines ? view.state.doc.line(open.number + 1) : open;
      view.dispatch({ selection: { anchor: first.from }, scrollIntoView: true });
      view.focus();
    });
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

/** The fenced blocks to draw: those in a language with a renderer, closed, and without the cursor in them. */
export function findRenderedCode(state: EditorState): DecorationSet {
  const renderers = state.facet(codeRenderers);
  if (!Object.keys(renderers).length) return Decoration.none;
  const { doc, selection } = state;
  const blocks: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === "Document") return true;
      // Only top-level blocks: one inside a quote or list has its markers on every line.
      if (node.name === "FencedCode" && node.node.parent?.name === "Document") {
        const info = node.node.getChild("CodeInfo");
        const language = info ? state.sliceDoc(info.from, info.to).trim().split(/\s+/)[0].toLowerCase() : "";
        const marks = node.node.getChildren("CodeMark");
        const open = doc.lineAt(node.from);
        const close = doc.lineAt(Math.max(node.from, node.to - 1));
        const closed = marks.length >= 2 && close.number > open.number && marks[marks.length - 1].from >= close.from;
        const touched = selection.ranges.some((r) => r.from <= close.to && r.to >= open.from);
        if (renderers[language] && closed && !touched) {
          const source = state.sliceDoc(open.to + 1, close.from).replace(/\n$/, "");
          blocks.push(Decoration.replace({ widget: new RenderedCodeWidget(language, source), block: true }).range(open.from, close.to));
        }
      }
      return false;
    },
  });
  return Decoration.set(blocks);
}

export const renderedCodeField = StateField.define<DecorationSet>({
  create: findRenderedCode,
  update(blocks, tr) {
    if (
      tr.docChanged ||
      tr.selection ||
      tr.reconfigured ||
      syntaxTree(tr.state) !== syntaxTree(tr.startState) ||
      tr.state.readOnly !== tr.startState.readOnly
    )
      return findRenderedCode(tr.state);
    return blocks;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export const renderedCodeTheme = EditorView.theme({
  // No box of its own: the drawing sits on the page's background, with an
  // outline on hover to show it can be clicked.
  ".cm-md-rendered": {
    margin: "0.5rem 0",
    padding: "0.75rem",
    borderRadius: "10px",
    border: "1px solid transparent",
    backgroundColor: "transparent",
    cursor: "pointer",
    overflowX: "auto",
    textAlign: "center",
  },
  ".cm-md-rendered:hover": { borderColor: "var(--border)" },
  ".cm-md-rendered svg": { maxWidth: "100%", height: "auto" },
  ".cm-md-rendered-error": { margin: "0", textAlign: "left", whiteSpace: "pre-wrap", color: "var(--muted)", fontSize: "0.85em" },
});
