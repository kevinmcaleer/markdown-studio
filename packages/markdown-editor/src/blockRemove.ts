import { undo } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { Facet, StateField, type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

// Bins: one click takes a whole block out of the text (a gallery, cards,
// videos, a drawn diagram, or a whole section under its heading), so a writer
// never has to go into the Markdown to remove one. Nothing asks first: a
// small "… removed · Undo" note shows for a few seconds instead, and Ctrl+Z
// works as for any other edit.
//
// Every bin is the same: an icon only, no box, centred in its button.

/** The bin, in a 16×16 box (stroked). */
export const BIN_PATH = "M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.5h6.6L12 4M6.75 6.5v4.5M9.25 6.5v4.5";

/** The bin's SVG. */
export function binSvg(): string {
  return `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${BIN_PATH}"/></svg>`;
}

/** An icon-only bin button that calls `onRemove` (clicks don't reach the block under it). */
export function binButton(title: string, onRemove: () => void, className = ""): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `cm-md-bin${className ? ` ${className}` : ""}`;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.dataset.mdRemove = "";
  b.innerHTML = binSvg();
  b.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onRemove();
  });
  return b;
}

/**
 * The range that takes out lines `from`..`to` (positions in them), whole,
 * with one blank line next to them so no gap is left behind.
 */
export function blockRemoval(state: EditorState, from: number, to: number): { from: number; to: number } {
  const { doc } = state;
  const first = doc.lineAt(Math.max(0, Math.min(from, doc.length)));
  const last = doc.lineAt(Math.max(first.from, Math.min(to, doc.length)));
  let start = first.from;
  let end = last.to;
  if (last.number < doc.lines) {
    end = last.to + 1; // its line break
    const next = doc.line(last.number + 1);
    if (!next.text.trim()) end = next.number < doc.lines ? next.to + 1 : next.to;
    else if (first.number > 1 && !doc.line(first.number - 1).text.trim()) start = doc.line(first.number - 1).from;
  } else if (first.number > 1) {
    // At the end of the text: the line break before it, and a blank line before that.
    start = first.from - 1;
    const prev = doc.line(first.number - 1);
    if (!prev.text.trim() && prev.number > 1) start = prev.from - 1;
  }
  return { from: start, to: end };
}

const notes = new WeakMap<EditorView, { box: HTMLElement; timer: ReturnType<typeof setTimeout> }>();

/** A short "`label` removed · Undo" note at the bottom of the editor. */
export function showUndoNote(view: EditorView, label: string): void {
  const old = notes.get(view);
  if (old) {
    clearTimeout(old.timer);
    old.box.remove();
  }
  const box = document.createElement("div");
  box.className = "cm-md-undo-note";
  box.setAttribute("role", "status");
  const text = document.createElement("span");
  text.textContent = `${label} removed`;
  const again = document.createElement("button");
  again.type = "button";
  again.textContent = "Undo";
  const close = () => {
    const n = notes.get(view);
    if (n?.box === box) notes.delete(view);
    clearTimeout(timer);
    box.remove();
  };
  again.addEventListener("mousedown", (e) => e.preventDefault());
  again.addEventListener("click", () => {
    undo(view);
    view.focus();
    close();
  });
  box.append(text, again);
  view.dom.append(box);
  const timer = setTimeout(close, 7000);
  notes.set(view, { box, timer });
}

/** Takes lines `from`..`to` out of the text (see blockRemoval), then offers Undo. */
export function removeBlock(view: EditorView, from: number, to: number, label = "Block"): boolean {
  if (view.state.readOnly) return false;
  const range = blockRemoval(view.state, from, to);
  if (range.to <= range.from) return false;
  view.dispatch({
    changes: range,
    selection: { anchor: range.from },
    userEvent: "delete.block",
    scrollIntoView: false,
  });
  showUndoNote(view, label);
  return true;
}

/** Removes the block widget `dom` stands for: the lines from where it starts to `endLine(start)`. */
export function removeWidgetBlock(view: EditorView, dom: HTMLElement, label: string, endOf?: (state: EditorState, line: number) => number): boolean {
  let pos: number;
  try {
    pos = view.posAtDOM(dom);
  } catch {
    return false;
  }
  const { state } = view;
  const line = state.doc.lineAt(pos);
  const to = endOf ? endOf(state, line.number) : closingFence(state, line.number);
  if (to < 0) return false;
  return removeBlock(view, line.from, to, label);
}

/** The end of the `:::` / fenced block opening on line `n` (1-based), or -1. */
export function closingFence(state: EditorState, n: number): number {
  const { doc } = state;
  const open = doc.line(n).text.trim();
  const fence = /^(`{3,}|~{3,})/.exec(open)?.[1];
  for (let i = n + 1; i <= doc.lines; i++) {
    const text = doc.line(i).text.trim();
    if (fence ? text.startsWith(fence) && !text.slice(fence.length).trim() : text === ":::") return doc.line(i).to;
  }
  return -1;
}

// Sections: with the host's `sectionRemove`, a heading it names gets a bin
// (shown when the pointer is over the heading) that takes out the heading and
// everything under it, up to the next heading at its level or above.

/** Names a heading's section to give it a bin ("Bill of Materials"), or null for none. */
export type SectionRemove = (heading: string, level: number) => string | null | false | undefined;

export const sectionRemovers = Facet.define<SectionRemove>();

/** Where the section headed on line `n` ends: before the next heading at its level or above. */
export function sectionEnd(state: EditorState, n: number): number {
  const { doc } = state;
  const level = /^(#{1,6})\s/.exec(doc.line(n).text)?.[1].length ?? 1;
  let fence: string | null = null;
  for (let i = n + 1; i <= doc.lines; i++) {
    const text = doc.line(i).text;
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(text)?.[1];
    if (f) {
      if (!fence) fence = f[0].repeat(f.length);
      else if (f.startsWith(fence)) fence = null;
      continue;
    }
    if (fence) continue;
    const h = /^(#{1,6})\s/.exec(text);
    if (h && h[1].length <= level) {
      // Up to the last non-blank line before it.
      let j = i - 1;
      while (j > n && !doc.line(j).text.trim()) j--;
      return doc.line(j).to;
    }
  }
  let j = doc.lines;
  while (j > n && !doc.line(j).text.trim()) j--;
  return doc.line(j).to;
}

/** Takes out the section headed on line `n` (1-based), then offers Undo. */
export function removeSection(view: EditorView, n: number, label: string): boolean {
  const { doc } = view.state;
  if (n < 1 || n > doc.lines) return false;
  return removeBlock(view, doc.line(n).from, sectionEnd(view.state, n), label);
}

class SectionBinWidget extends WidgetType {
  constructor(readonly label: string) {
    super();
  }
  eq(other: SectionBinWidget) {
    return other.label === this.label;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("span");
    wrap.className = "cm-md-section-bin";
    wrap.contentEditable = "false";
    const b = binButton(`Remove the ${this.label} section (its heading and everything under it)`, () => {
      const line = view.state.doc.lineAt(view.posAtDOM(wrap));
      removeSection(view, line.number, this.label);
    });
    wrap.append(b);
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

function findSectionBins(state: EditorState): DecorationSet {
  const removers = state.facet(sectionRemovers);
  if (!removers.length || state.readOnly) return Decoration.none;
  const out: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === "Document") return true;
      const m = /^ATXHeading([1-6])$/.exec(node.name);
      if (m && node.node.parent?.name === "Document") {
        const line = state.doc.lineAt(node.from);
        const text = line.text.replace(/^#{1,6}\s*/, "").replace(/\s#+\s*$/, "").trim();
        let label: string | null = null;
        for (const r of removers) {
          try {
            const got = r(text, Number(m[1]));
            if (got) {
              label = got;
              break;
            }
          } catch {
            // A host's mistake shouldn't break the editor.
          }
        }
        if (label) out.push(Decoration.widget({ widget: new SectionBinWidget(label), side: 1 }).range(line.to));
      }
      return false;
    },
  });
  return Decoration.set(out);
}

export const sectionBinsField = StateField.define<DecorationSet>({
  create: findSectionBins,
  update(bins, tr) {
    if (tr.docChanged || tr.reconfigured || syntaxTree(tr.state) !== syntaxTree(tr.startState) || tr.state.readOnly !== tr.startState.readOnly)
      return findSectionBins(tr.state);
    return bins;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export const binTheme = EditorView.theme({
  // Icon-only: no box, the bin centred in its button.
  // Doubled class: beats a bar's own `… button` pill style.
  ".cm-md-bin.cm-md-bin": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "1.75rem",
    height: "1.75rem",
    padding: "0",
    margin: "0",
    border: "0",
    outline: "none",
    borderRadius: "6px",
    background: "none",
    boxShadow: "none",
    color: "var(--muted, #6b7280)",
    cursor: "pointer",
    flex: "none",
  },
  ".cm-md-bin.cm-md-bin:hover, .cm-md-bin.cm-md-bin:focus-visible": { color: "var(--danger, #dc2626)", background: "none" },
  ".cm-md-bin.cm-md-bin svg": { display: "block", width: "16px !important", height: "16px", flex: "none" },
  // On a heading: after its text, shown while the pointer is on the heading.
  ".cm-md-section-bin": { display: "inline-flex", verticalAlign: "middle", marginLeft: "0.4rem", opacity: "0", transition: "opacity 0.12s" },
  ".cm-line:hover .cm-md-section-bin, .cm-md-section-bin:focus-within": { opacity: "1" },
  ".cm-md-section-bin .cm-md-bin": { fontSize: "1rem" },
  // A bin over a block that has no bar of its own (a drawn diagram): its top right corner.
  // The Undo note: bottom centre of the window, so it's seen wherever the editor is scrolled.
  ".cm-md-undo-note": {
    position: "fixed",
    left: "50%",
    bottom: "4.5rem",
    transform: "translateX(-50%)",
    zIndex: "1000",
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    padding: "0.45rem 0.6rem 0.45rem 0.9rem",
    borderRadius: "10px",
    background: "var(--text, #1f2937)",
    color: "var(--bg, #fff)",
    fontFamily: "var(--font-sans, system-ui)",
    fontSize: "0.9rem",
    boxShadow: "0 6px 20px rgb(0 0 0 / 0.2)",
    whiteSpace: "nowrap",
  },
  ".cm-md-undo-note button": {
    font: "inherit",
    fontWeight: "600",
    padding: "0.2rem 0.6rem",
    border: "0",
    borderRadius: "6px",
    background: "rgb(255 255 255 / 0.16)",
    color: "inherit",
    cursor: "pointer",
  },
  ".cm-md-undo-note button:hover": { background: "rgb(255 255 255 / 0.28)" },
  ".cm-md-has-corner-bin": { position: "relative" },
  ".cm-md-has-corner-bin:hover > .cm-md-corner-bin.cm-md-bin.cm-md-bin, .cm-md-corner-bin.cm-md-bin.cm-md-bin:focus-visible": { opacity: "1" },
  ".cm-md-corner-bin.cm-md-bin.cm-md-bin": { position: "absolute", top: "0.35rem", right: "0.35rem", zIndex: "3", opacity: "0", transition: "opacity 0.12s" },
});
