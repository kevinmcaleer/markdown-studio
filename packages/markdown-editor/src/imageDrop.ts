import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";

// Where a dragged image will land. One image goes between two lines: a dotted
// line follows the pointer from gap to gap, and the image is linked there on
// drop. Several at once, where the host has somewhere to keep them without
// linking them (a gallery), go there instead, and the whole editor says so.

/** A gap between lines: `pos` is where the image goes, `side` whether that's before or after its line. */
export type DropGap = { pos: number; side: "before" | "after" };

/** Blocks a gap can't split; it moves to whichever end is nearer. */
const WHOLE = ["FencedCode", "CodeBlock", "HTMLBlock", "CommentBlock", "Table"];

/** The gap nearest `pos`'s line that isn't inside code or a table. */
export function snapGap(state: EditorState, gap: DropGap): DropGap {
  for (let node: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(gap.pos, 1); node; node = node.parent) {
    if (!WHOLE.includes(node.name)) continue;
    const start = state.doc.lineAt(node.from).from;
    const end = state.doc.lineAt(Math.max(node.from, node.to - (state.sliceDoc(node.to - 1, node.to) === "\n" ? 1 : 0))).to;
    if (gap.pos <= start || gap.pos >= end) continue;
    return gap.pos - start <= end - gap.pos ? { pos: start, side: "before" } : { pos: end, side: "after" };
  }
  return gap;
}

/** The gap between lines nearest a point `clientY` down the page. */
export function dropGap(view: EditorView, clientY: number): DropGap {
  const height = Math.min(Math.max(clientY - view.documentTop, 0), Math.max(0, view.contentHeight - 1));
  const block = view.lineBlockAtHeight(height);
  const after = height > block.top + block.height / 2;
  return snapGap(view.state, after ? { pos: block.to, side: "after" } : { pos: block.from, side: "before" });
}

/** How many images are being dragged, from what the browser lets on before the drop (it hides the names). */
export function draggedImages(data: DataTransfer | null): number {
  if (!data || !Array.from(data.types ?? []).includes("Files")) return 0;
  const files = Array.from(data.items ?? []).filter((item) => item.kind === "file");
  // Some browsers only give the types away on drop; count the unknowns as images.
  return files.filter((item) => !item.type || item.type.startsWith("image/")).length || (files.length ? 0 : 1);
}

export type ImageDropOptions = {
  /** Whether a dropped image can go in at all (there's somewhere to upload it). */
  single: boolean;
  /** Whether several dropped at once go to the host's library instead. */
  many: boolean;
  /** What the library is called: "the gallery". */
  libraryName: string;
};

const LINGER = 400;

class Indicator {
  line: HTMLElement;
  zone: HTMLElement;
  timer = 0;

  constructor(
    readonly view: EditorView,
    readonly options: ImageDropOptions,
  ) {
    this.line = document.createElement("div");
    this.line.className = "cm-image-drop-line";
    this.line.setAttribute("aria-hidden", "true");
    this.zone = document.createElement("div");
    this.zone.className = "cm-image-drop-zone";
    this.zone.setAttribute("role", "status");
  }

  over(event: DragEvent) {
    const count = draggedImages(event.dataTransfer);
    if (!count || this.view.state.readOnly) return this.hide();
    clearTimeout(this.timer);
    // dragover keeps firing while the pointer's over the editor, even standing still.
    this.timer = window.setTimeout(() => this.hide(), LINGER);
    this.view.dom.classList.add("cm-image-dragging");
    if (count > 1 && this.options.many) {
      this.line.remove();
      const label = document.createElement("span");
      label.textContent = `Drop to add ${count} images to ${this.options.libraryName}`;
      this.zone.replaceChildren(label);
      if (!this.zone.isConnected) this.view.dom.append(this.zone);
      return;
    }
    this.zone.remove();
    if (!this.options.single) return this.hide();
    this.place(dropGap(this.view, event.clientY));
  }

  place(gap: DropGap) {
    const view = this.view;
    const block = view.lineBlockAt(gap.pos);
    const editor = view.dom.getBoundingClientRect();
    const scroller = view.scrollDOM.getBoundingClientRect();
    const content = view.contentDOM.getBoundingClientRect();
    const style = getComputedStyle(view.contentDOM);
    // In the middle of a blank line beside the gap, where there is one, so it reads as between paragraphs.
    const doc = view.state.doc;
    const line = doc.lineAt(gap.pos);
    const beside = gap.side === "before" ? (line.number > 1 ? doc.line(line.number - 1) : null) : line.number < doc.lines ? doc.line(line.number + 1) : null;
    const blank = beside && !beside.text.trim() ? view.lineBlockAt(beside.from) : null;
    const y = view.documentTop + (blank ? blank.top + blank.height / 2 : gap.side === "before" ? block.top : block.bottom);
    if (y < scroller.top || y > scroller.bottom) {
      this.line.remove();
      return;
    }
    const left = content.left + parseFloat(style.paddingLeft || "0");
    const right = content.right - parseFloat(style.paddingRight || "0");
    Object.assign(this.line.style, {
      top: `${y - editor.top}px`,
      left: `${Math.max(left, scroller.left) - editor.left}px`,
      width: `${Math.max(0, Math.min(right, scroller.right) - Math.max(left, scroller.left))}px`,
    });
    if (!this.line.isConnected) view.dom.append(this.line);
  }

  hide() {
    clearTimeout(this.timer);
    this.line.remove();
    this.zone.remove();
    this.view.dom.classList.remove("cm-image-dragging");
  }

  destroy() {
    this.hide();
  }
}

const dropTheme = EditorView.theme({
  // The caret CodeMirror draws while dragging; the line takes its place.
  "&.cm-image-dragging .cm-dropCursor": { display: "none" },
  ".cm-image-drop-line": {
    position: "absolute",
    zIndex: "20",
    height: "0",
    marginTop: "-1px",
    borderTop: "2px dotted var(--accent)",
    pointerEvents: "none",
  },
  ".cm-image-drop-line::before, .cm-image-drop-line::after": {
    content: '""',
    position: "absolute",
    top: "-5px",
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    background: "var(--accent)",
  },
  ".cm-image-drop-line::before": { left: "-4px" },
  ".cm-image-drop-line::after": { right: "-4px" },
  ".cm-image-drop-zone": {
    position: "absolute",
    inset: "4px",
    zIndex: "20",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "center",
    paddingTop: "1rem",
    border: "2px dotted var(--accent)",
    borderRadius: "10px",
    background: "color-mix(in srgb, var(--accent) 8%, transparent)",
    fontFamily: "var(--font-sans)",
    fontSize: "14px",
    color: "var(--accent)",
    pointerEvents: "none",
  },
  ".cm-image-drop-zone span": {
    height: "fit-content",
    padding: "0.3rem 0.8rem",
    borderRadius: "999px",
    background: "var(--surface, #fff)",
    boxShadow: "0 4px 14px rgb(0 0 0 / 0.1)",
  },
});

/** Shows where dragged images will land. */
export function imageDropIndicator(options: ImageDropOptions): Extension {
  return [
    dropTheme,
    ViewPlugin.define((view) => new Indicator(view, options), {
      eventHandlers: {
        dragover(event) {
          this.over(event);
          return false;
        },
        dragleave(event) {
          if (!(event.relatedTarget instanceof Node && this.view.dom.contains(event.relatedTarget))) this.hide();
          return false;
        },
        drop() {
          this.hide();
          return false;
        },
      },
    }),
  ];
}
