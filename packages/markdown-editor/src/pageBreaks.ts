import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, Facet, type Range, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import type { SlashCommand } from "./slashMenu";

// Page breaks: a line holding only `<!-- page -->` splits a long write-up
// into pages where the host publishes it (kevsrobots' project pages show one
// page at a time, with Previous / 1 2 3 / Next). It's an HTML comment, so
// anywhere else the text simply reads as one page.
//
// With the host's `pageBreaks` option on, the live view draws each marker as
// a dashed rule naming the page it starts ("Page 2"), and the "/" menu gets a
// Page break command. The Raw view shows the comment itself.

/** The marker the "/" command writes. */
export const PAGE_BREAK = "<!-- page -->";

/** Whether a comment block's text (`<!--` to `-->`) is a page break. */
export function isPageBreak(comment: string): boolean {
  return /^<!--\s*page(?:\s*break)?\s*-->$/i.test(comment.trim());
}

/** Turns page breaks on in the live view (any `true` wins). */
export const pageBreaksOn = Facet.define<boolean, boolean>({ combine: (values) => values.some(Boolean) });

class PageBreakWidget extends WidgetType {
  constructor(readonly page: number) {
    super();
  }
  eq(other: PageBreakWidget) {
    return other.page === this.page;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("div");
    box.className = "cm-md-page-break";
    box.setAttribute("role", "separator");
    box.setAttribute("aria-label", `Page break: page ${this.page} starts here`);
    const label = document.createElement("span");
    label.className = "cm-md-page-break-label cm-md-select-box";
    label.textContent = `Page ${this.page}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "cm-md-page-break-remove";
    remove.title = "Remove page break";
    remove.setAttribute("aria-label", "Remove page break");
    remove.textContent = "×";
    remove.addEventListener("mousedown", (ev) => ev.preventDefault());
    remove.addEventListener("click", (ev) => {
      ev.preventDefault();
      if (view.state.readOnly) return;
      const pos = view.posAtDOM(box);
      const line = view.state.doc.lineAt(pos);
      if (!isPageBreak(line.text)) return;
      // Take the marker's line and one blank line after it.
      view.dispatch({ changes: pageBreakRemoval(view.state, line.number), userEvent: "delete" });
      view.focus();
    });
    box.append(label, remove);
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

/** The change that takes out the page break on line `n`, with one blank line after it. */
export function pageBreakRemoval(state: EditorState, n: number): { from: number; to: number } {
  const doc = state.doc;
  const line = doc.line(n);
  const next = n < doc.lines ? doc.line(n + 1) : null;
  if (next && !next.text.trim()) return { from: line.from, to: Math.min(next.to + 1, doc.length) };
  return { from: Math.max(0, line.from - 1), to: line.to };
}

/** The page-break markers in `state`, drawn as rules, when the host turned them on. */
export function findPageBreaks(state: EditorState): DecorationSet {
  if (!state.facet(pageBreaksOn)) return Decoration.none;
  const out: Range<Decoration>[] = [];
  let page = 1;
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === "Document") return true;
      if (node.name === "CommentBlock") {
        const line = state.doc.lineAt(node.from);
        const end = state.doc.lineAt(node.to);
        if (line.number === end.number && isPageBreak(line.text)) {
          page += 1;
          out.push(Decoration.replace({ block: true, widget: new PageBreakWidget(page) }).range(line.from, line.to));
        }
      }
      return false;
    },
  });
  return Decoration.set(out, true);
}

export const pageBreaksField = StateField.define<DecorationSet>({
  create: findPageBreaks,
  update(breaks, tr) {
    if (tr.docChanged || tr.reconfigured || syntaxTree(tr.state) !== syntaxTree(tr.startState)) return findPageBreaks(tr.state);
    return breaks.map(tr.changes);
  },
  provide: (field) => [EditorView.decorations.from(field), EditorView.atomicRanges.of((view) => view.state.field(field))],
});

export const pageBreaksTheme = EditorView.baseTheme({
  ".cm-md-page-break": {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: "0.6rem",
    // Padding, not margin: CodeMirror doesn't count a block widget's margin (see spacedBlock).
    padding: "0.4rem 0",
    color: "var(--muted)",
    fontSize: "0.8rem",
    fontFamily: "var(--font-sans, inherit)",
    letterSpacing: "0.04em",
    textTransform: "uppercase",
  },
  ".cm-md-page-break::before, .cm-md-page-break::after": {
    content: '""',
    flex: "1",
    borderTop: "1px dashed var(--border)",
  },
  ".cm-md-page-break-remove": {
    position: "absolute",
    right: "0",
    border: "none",
    background: "var(--bg, transparent)",
    color: "var(--muted)",
    padding: "0 0.3rem",
    lineHeight: "1",
    fontSize: "1rem",
    cursor: "pointer",
    opacity: "0",
  },
  ".cm-md-page-break:hover .cm-md-page-break-remove, .cm-md-page-break-remove:focus": { opacity: "1" },
  ".cm-md-page-break-remove:hover": { color: "var(--danger, #b4322a)" },
});

/** The "/" menu's Page break command. */
export const pageBreakCommand: SlashCommand = {
  id: "page-break",
  label: "Page break",
  keywords: ["page", "pages", "pagination", "split", "next page", "new page"],
  group: "lists",
  icon: "M2.5 2.5v3h11v-3M2.5 13.5v-3h11v3M2 8h2M7 8h2M12 8h2",
  block: true,
  blankBefore: true,
  insert: () => ({ before: `${PAGE_BREAK}\n\n` }),
};

/** Page breaks for a host that mounts its own editor: the live-view rules. */
export function pageBreaks(): Extension {
  return pageBreaksOn.of(true);
}
