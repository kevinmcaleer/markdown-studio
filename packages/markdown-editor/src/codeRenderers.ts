import { syntaxTree } from "@codemirror/language";
import { Facet, StateField, Transaction, type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { rememberedHeight, spacedBlock } from "./steadyScroll";

// In the live view, a fenced block in a language the host can draw (```mermaid,
// say) shows as its drawing while the cursor is outside it, and as its source
// once the cursor moves in (clicking the drawing puts it there). The host
// supplies the drawing through the `codeRenderers` option.
//
// A host can also supply an editor for a language (`codeEditors`): then, while
// the cursor is in such a block, the block shows as that editor (a split code +
// live diagram view for ```mermaid, say) instead of its raw lines. The editor
// writes its changes into the block.

/** Draws a block's source into `element`; may finish later. */
export type CodeRenderer = (source: string, element: HTMLElement) => void | Promise<void>;

/** The renderers, by fence language (lower case). */
export const codeRenderers = Facet.define<Record<string, CodeRenderer>, Record<string, CodeRenderer>>({
  combine: (values) => Object.assign({}, ...values),
});

/** What a block editor is given. */
export type CodeEditorContext = {
  /** Where to mount. */
  element: HTMLElement;
  /** The block's code (between the fences). */
  source: string;
  language: string;
  /** Call with the new code after each edit. */
  onChange: (source: string) => void;
  /** Call to leave the block with the keyboard: to the line before it or after it. */
  onExit: (where: "before" | "after") => void;
  /** True when the editor should take the focus once mounted. */
  focus: boolean;
};

/** A mounted block editor. */
export type CodeEditorHandle = {
  /** The block's code changed from outside (undo, say). */
  setSource?: (source: string) => void;
  focus?: () => void;
  destroy?: () => void;
};

/** Mounts an editor for a block's code (see `codeEditors`). */
export type CodeEditor = (context: CodeEditorContext) => CodeEditorHandle | void;

/** The block editors, by fence language (lower case). */
export const codeEditors = Facet.define<Record<string, CodeEditor>, Record<string, CodeEditor>>({
  combine: (values) => Object.assign({}, ...values),
});

// The code between a fenced block's fences, given the position of its opening line.
function blockAt(state: EditorState, pos: number) {
  const { doc } = state;
  let found: { open: ReturnType<typeof doc.lineAt>; close: ReturnType<typeof doc.lineAt> } | null = null;
  syntaxTree(state).iterate({
    from: pos,
    to: pos,
    enter(node) {
      if (found) return false;
      if (node.name !== "FencedCode") return true;
      found = { open: doc.lineAt(node.from), close: doc.lineAt(Math.max(node.from, node.to - 1)) };
      return false;
    },
  });
  if (!found) return null;
  const { open, close } = found as { open: ReturnType<typeof doc.lineAt>; close: ReturnType<typeof doc.lineAt> };
  const from = Math.min(open.to + 1, close.from);
  return { open, close, from, to: Math.max(from, close.from - 1) };
}

type EditorDom = HTMLElement & { codeEditor?: CodeEditorHandle | void };

class CodeEditorWidget extends WidgetType {
  constructor(
    readonly language: string,
    readonly source: string,
  ) {
    super();
  }
  eq(other: CodeEditorWidget) {
    return other.language === this.language && other.source === this.source;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div") as EditorDom;
    wrap.className = `cm-md-code-editor cm-md-code-editor-${this.language}`;
    const mount = view.state.facet(codeEditors)[this.language];
    // The block this editor shows, found again on each change (text above it may have moved it).
    const block = () => {
      try {
        return blockAt(view.state, view.posAtDOM(wrap));
      } catch {
        return null;
      }
    };
    wrap.codeEditor = mount?.({
      element: wrap,
      source: this.source,
      language: this.language,
      focus: view.hasFocus,
      onChange: (source) => {
        const b = block();
        if (!b) return;
        const before = view.state.sliceDoc(b.from, b.to);
        if (before === source) return;
        // The smallest change, so the cursor (kept in the block) doesn't move.
        let start = 0;
        while (start < before.length && start < source.length && before[start] === source[start]) start++;
        let endA = before.length;
        let endB = source.length;
        while (endA > start && endB > start && before[endA - 1] === source[endB - 1]) {
          endA--;
          endB--;
        }
        const insert = source.slice(start, endB);
        // An empty block has no line between the fences yet.
        const empty = b.from >= b.close.from;
        view.dispatch({
          changes: empty
            ? { from: b.close.from, insert: insert + "\n" }
            : { from: b.from + start, to: b.from + endA, insert },
          annotations: Transaction.userEvent.of("input.code-editor"),
        });
      },
      onExit: (where) => {
        const b = block();
        if (!b) return;
        const { doc } = view.state;
        if (where === "before") {
          if (b.open.number > 1) view.dispatch({ selection: { anchor: doc.line(b.open.number - 1).to }, scrollIntoView: true });
          else view.dispatch({ changes: { from: 0, insert: "\n" }, selection: { anchor: 0 }, scrollIntoView: true });
        } else if (b.close.number < doc.lines) {
          view.dispatch({ selection: { anchor: doc.line(b.close.number + 1).from }, scrollIntoView: true });
        } else {
          view.dispatch({ changes: { from: doc.length, insert: "\n" }, selection: { anchor: doc.length + 1 }, scrollIntoView: true });
        }
        view.focus();
      },
    });
    return wrap;
  }
  updateDOM(dom: HTMLElement) {
    // The same editor, now showing this block's code (an undo, or the next block).
    const handle = (dom as EditorDom).codeEditor;
    if (!handle?.setSource || !dom.classList.contains(`cm-md-code-editor-${this.language}`)) return false;
    handle.setSource(this.source);
    return true;
  }
  destroy(dom: HTMLElement) {
    (dom as EditorDom).codeEditor?.destroy?.();
  }
  ignoreEvent() {
    return true;
  }
}

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
  get estimatedHeight() {
    return rememberedHeight(`${this.language}\n${this.source}`) ?? -1;
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
      // Focus first, so a block editor that replaces the drawing knows to take the focus.
      view.focus();
      view.dispatch({ selection: { anchor: first.from }, scrollIntoView: true });
    });
    return spacedBlock(wrap, `${this.language}\n${this.source}`);
  }
  ignoreEvent() {
    return true;
  }
}

/**
 * The fenced blocks to draw: those in a language with a renderer, closed, and
 * without the cursor in them; and, with the cursor in them, those with an editor.
 */
export function findRenderedCode(state: EditorState): DecorationSet {
  const renderers = state.facet(codeRenderers);
  const editors = state.readOnly ? {} : state.facet(codeEditors);
  if (!Object.keys(renderers).length && !Object.keys(editors).length) return Decoration.none;
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
        if (closed && (touched ? editors[language] : renderers[language])) {
          const source = close.number > open.number + 1 ? state.sliceDoc(open.to + 1, close.from - 1) : "";
          const widget = touched ? new CodeEditorWidget(language, source) : new RenderedCodeWidget(language, source);
          blocks.push(Decoration.replace({ widget, block: true }).range(open.from, close.to));
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
    margin: "0",
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
  // Padding, not margin: CodeMirror doesn't count a block widget's margin (see spacedBlock).
  ".cm-md-code-editor": { padding: "0.5rem 0", cursor: "auto" },
  ".cm-md-rendered-error": { margin: "0", textAlign: "left", whiteSpace: "pre-wrap", color: "var(--muted)", fontSize: "0.85em" },
});
