import { StateField, type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { cardPicturePicker, type PickedPicture } from "./cardsWidget";
import {
  findGalleries,
  galleryBlockMarkdown,
  galleryHtml,
  galleryImageMarkdown,
  galleryLayouts,
  wireGallery,
  type GalleryImage,
  type GalleryLayout,
} from "./gallery";
import "./gallery.css";
import { imageMarkdown } from "./imagePopover";
import { rememberedHeight, spacedBlock } from "./steadyScroll";

// In the live view a `::: gallery` block (see gallery.ts) shows as its
// gallery, and is managed by pointing and clicking: "Add pictures" in its bar
// adds pictures at the end, each picture's buttons move it or remove it, and
// pictures can be dragged into a new order. The layout buttons rewrite the
// `::: gallery <layout>` line. Every change is written straight into the
// Markdown, and the bar's "Markdown" button shows those lines (moving the
// cursor into the block does too, as with cards) until "Show gallery".
// Clicking a picture no longer opens the lines: a filmstrip's thumbnails
// still swap its large picture, so it can be tried out in place.

const ICONS = {
  left: "M10 3.5 5.5 8l4.5 4.5",
  right: "M6 3.5 10.5 8 6 12.5",
  remove: "M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.5 8.5h5l.5-8.5",
  plus: "M8 3.5v9M3.5 8h9",
};

function svg(path: string): string {
  return `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${path}"/></svg>`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(className: string, text: string, title: string, icon?: string): HTMLButtonElement {
  const b = el("button", className);
  b.type = "button";
  b.title = title;
  if (icon && !text) b.setAttribute("aria-label", title);
  b.innerHTML = icon ? svg(icon) : "";
  if (text) b.append(icon ? Object.assign(el("span"), { textContent: text }) : document.createTextNode(text));
  return b;
}

type BlockAt = { from: number; to: number; openLine: number; layout: GalleryLayout; pictures: string[] };

/** The gallery block opening on line `openLine` (1-based), read fresh from the document. */
function blockOnLine(state: EditorState, openLine: number): BlockAt | null {
  const { doc } = state;
  const lines = doc.toString().split("\n");
  const block = findGalleries(lines).find((b) => b.open === openLine - 1);
  if (!block) return null;
  return {
    from: doc.line(block.open + 1).from,
    to: doc.line(block.close + 1).to,
    openLine,
    layout: block.layout,
    pictures: galleryImageMarkdown(lines.slice(block.open + 1, block.close).join("\n")),
  };
}

/** The gallery block the widget's DOM stands for. */
function blockAt(view: EditorView, dom: HTMLElement): BlockAt | null {
  let pos: number;
  try {
    pos = view.posAtDOM(dom);
  } catch {
    return null;
  }
  return blockOnLine(view.state, view.state.doc.lineAt(pos).number);
}

/** Rewrites a gallery block: its layout and its pictures, one per line. */
function rewrite(view: EditorView, block: BlockAt, next: { layout?: GalleryLayout; pictures?: string[] }) {
  const insert = galleryBlockMarkdown(next.layout ?? block.layout, next.pictures ?? block.pictures);
  if (insert === view.state.sliceDoc(block.from, block.to)) return;
  view.dispatch({ changes: { from: block.from, to: block.to, insert }, userEvent: "input.gallery" });
}

/** Moves the picture at `from` to `to` in a list. */
export function movePicture<T>(list: readonly T[], from: number, to: number): T[] {
  const out = list.slice();
  if (from < 0 || from >= out.length) return out;
  const [moved] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(to, out.length)), 0, moved);
  return out;
}

/** Adds pictures to the end of the gallery opening on `openLine`. */
export function addGalleryPictures(view: EditorView, openLine: number, pictures: readonly PickedPicture[]): boolean {
  const block = blockOnLine(view.state, openLine);
  if (!block || !pictures.length) return false;
  rewrite(view, block, { pictures: [...block.pictures, ...pictures.map((p) => imageMarkdown({ alt: p.alt, url: p.src }))] });
  return true;
}

const DRAG_TYPE = "application/x-mde-gallery-picture";

class GalleryWidget extends WidgetType {
  constructor(
    readonly layout: GalleryLayout,
    readonly images: readonly GalleryImage[],
    readonly readOnly: boolean,
  ) {
    super();
  }
  get key() {
    return `gallery ${this.layout}\n${this.images.map((i) => `${i.src} ${i.alt} ${i.title}`).join("\n")}`;
  }
  eq(other: GalleryWidget) {
    return other.key === this.key && other.readOnly === this.readOnly;
  }
  get estimatedHeight() {
    return rememberedHeight(this.key) ?? -1;
  }
  ignoreEvent() {
    return true;
  }

  toDOM(view: EditorView) {
    const wrap = el("div", `cm-md-gallery${this.readOnly ? "" : " editable"}`);
    const holder = el("div");
    holder.innerHTML = galleryHtml(this.layout, this.images);
    const gallery = holder.firstElementChild as HTMLElement;
    wireGallery(gallery);
    // Pictures are links to themselves: in the editor they don't navigate.
    wrap.addEventListener("click", (event) => {
      if ((event.target as Element).closest("a")) event.preventDefault();
    });

    if (this.readOnly) {
      wrap.append(gallery);
      return spacedBlock(wrap, this.key);
    }

    const add = (anchor: HTMLElement) => this.addPictures(view, wrap, anchor);

    // The bar: what it is, Add pictures, its layout, and its Markdown.
    const bar = el("div", "cm-md-gallery-bar");
    bar.append(el("span", "cm-md-gallery-label", "Gallery"));
    const addButton = button("cm-md-gallery-add", "Add pictures", "Add pictures at the end of the gallery", ICONS.plus);
    addButton.addEventListener("click", () => add(addButton));
    const layouts = el("span", "cm-md-gallery-layouts");
    layouts.setAttribute("role", "group");
    layouts.setAttribute("aria-label", "Gallery layout");
    for (const { layout, label, title } of galleryLayouts) {
      const b = button("", label, title);
      b.setAttribute("aria-pressed", String(layout === this.layout));
      b.addEventListener("click", () => {
        const block = blockAt(view, wrap);
        if (block) rewrite(view, block, { layout });
      });
      layouts.append(b);
    }
    const markdown = button("cm-md-gallery-markdown", "Markdown", "Show the Markdown this gallery is written in");
    markdown.addEventListener("click", () => {
      const block = blockAt(view, wrap);
      if (!block) return;
      const first = view.state.doc.line(Math.min(block.openLine + 1, view.state.doc.lines));
      view.focus();
      view.dispatch({ selection: { anchor: first.from }, scrollIntoView: true });
    });
    bar.append(addButton, layouts, markdown);
    wrap.append(bar);

    // Each picture: move it left or right, or remove it; or drag it.
    const items = Array.from(gallery.querySelectorAll<HTMLAnchorElement>(".md-gallery-item"));
    const count = items.length;
    const move = (from: number, to: number) => {
      const block = blockAt(view, wrap);
      if (block && block.pictures.length === count) rewrite(view, block, { pictures: movePicture(block.pictures, from, to) });
    };
    items.forEach((item, index) => {
      item.draggable = true;
      item.querySelector("img")?.setAttribute("draggable", "false");
      const tools = el("span", "cm-md-gallery-tools");
      const left = button("", "", "Move earlier", ICONS.left);
      const right = button("", "", "Move later", ICONS.right);
      const remove = button("cm-md-gallery-remove", "", "Remove from the gallery", ICONS.remove);
      left.disabled = index === 0;
      right.disabled = index === count - 1;
      const act = (b: HTMLButtonElement, run: () => void) =>
        b.addEventListener("click", (e) => {
          // Not the picture's own click (a filmstrip swapping its large picture).
          e.preventDefault();
          e.stopPropagation();
          run();
        });
      act(left, () => move(index, index - 1));
      act(right, () => move(index, index + 1));
      act(remove, () => {
        const block = blockAt(view, wrap);
        if (block && block.pictures.length === count) rewrite(view, block, { pictures: block.pictures.filter((_, i) => i !== index) });
      });
      tools.append(left, right, remove);
      item.append(tools);

      item.addEventListener("dragstart", (e) => {
        if (!e.dataTransfer) return;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(DRAG_TYPE, String(index));
        item.classList.add("is-dragging");
      });
      item.addEventListener("dragend", () => {
        item.classList.remove("is-dragging");
        items.forEach((i) => i.classList.remove("drop-before", "drop-after"));
      });
      const side = (e: DragEvent) => {
        const box = item.getBoundingClientRect();
        return e.clientX < box.left + box.width / 2 ? "before" : "after";
      };
      item.addEventListener("dragover", (e) => {
        if (!e.dataTransfer?.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const at = side(e);
        item.classList.toggle("drop-before", at === "before");
        item.classList.toggle("drop-after", at === "after");
      });
      item.addEventListener("dragleave", () => item.classList.remove("drop-before", "drop-after"));
      item.addEventListener("drop", (e) => {
        const from = Number(e.dataTransfer?.getData(DRAG_TYPE));
        if (!e.dataTransfer?.types.includes(DRAG_TYPE) || !Number.isInteger(from)) return;
        e.preventDefault();
        e.stopPropagation();
        let to = side(e) === "before" ? index : index + 1;
        if (from < to) to--;
        item.classList.remove("drop-before", "drop-after");
        if (to !== from) move(from, to);
      });
    });

    if (!count) {
      const empty = el("div", "cm-md-gallery-empty");
      const big = button("cm-md-gallery-add", "Add pictures", "Choose pictures for this gallery", ICONS.plus);
      big.addEventListener("click", () => add(big));
      empty.append(big, el("p", "", "They show in the order you add them, and drag to reorder."));
      wrap.append(empty);
    } else {
      wrap.append(gallery);
    }

    // Buttons act without taking the caret out of wherever it was.
    wrap.addEventListener("mousedown", (e) => {
      const target = e.target as Element;
      if (target.closest("input")) return;
      if (target.closest("button")) e.preventDefault();
    });
    return spacedBlock(wrap, this.key);
  }

  /** Opens the host's picker (or a field for a picture's address) and adds what's picked. */
  private addPictures(view: EditorView, wrap: HTMLElement, anchor: HTMLElement) {
    const block = blockAt(view, wrap);
    if (!block) return;
    const openLine = block.openLine;
    const add = (pictures: PickedPicture[]) => addGalleryPictures(view, openLine, pictures);
    const picker = view.state.facet(cardPicturePicker);
    if (picker) {
      picker(anchor, (picture) => add([picture]), { many: add });
      return;
    }
    // No picker: a picture's address.
    wrap.querySelector(".cm-md-gallery-url")?.remove();
    const row = el("form", "cm-md-gallery-url");
    const input = el("input");
    input.type = "url";
    input.placeholder = "Picture address (https://…)";
    input.setAttribute("aria-label", "Picture address");
    const use = button("", "Add", "Add this picture");
    use.type = "submit";
    const cancel = button("", "Cancel", "Don't add a picture");
    row.append(input, use, cancel);
    row.addEventListener("submit", (e) => {
      e.preventDefault();
      const src = input.value.trim();
      if (src) add([{ src, alt: "" }]);
      else row.remove();
    });
    cancel.addEventListener("click", () => row.remove());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        row.remove();
      }
    });
    wrap.querySelector(".cm-md-gallery-bar")?.after(row);
    input.focus();
  }
}

/** Lines of an open block (the cursor in it), and the button that shows its gallery again. */
class ShowGalleryWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM(view: EditorView) {
    const b = button("cm-md-gallery-show", "Show gallery", "Back to the gallery");
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", (e) => {
      e.preventDefault();
      const { doc } = view.state;
      const line = doc.lineAt(view.posAtDOM(b)).number - 1;
      const block = findGalleries(doc.toString().split("\n")).find((g) => g.open === line);
      if (!block) return;
      const close = doc.line(block.close + 1);
      if (close.number < doc.lines) view.dispatch({ selection: { anchor: doc.line(close.number + 1).from }, scrollIntoView: true });
      else view.dispatch({ changes: { from: close.to, insert: "\n" }, selection: { anchor: close.to + 1 }, scrollIntoView: true });
    });
    return b;
  }
  ignoreEvent() {
    return true;
  }
}

/** The gallery blocks the cursor is in, shown as their Markdown: the live view leaves their lines as plain text. */
export function openGalleryBlocks(state: EditorState): { from: number; to: number }[] {
  const { doc, selection } = state;
  const text = doc.toString();
  if (!/:::[ \t]*gallery/i.test(text)) return [];
  const open: { from: number; to: number }[] = [];
  for (const block of findGalleries(text.split("\n"))) {
    const from = doc.line(block.open + 1).from;
    const to = doc.line(block.close + 1).to;
    if (selection.ranges.some((r) => r.from <= to && r.to >= from)) open.push({ from, to });
  }
  return open;
}

/** The gallery blocks: drawn as galleries, or as their lines while the cursor is in one. */
export function findGalleryWidgets(state: EditorState): DecorationSet {
  const { doc, selection } = state;
  const text = doc.toString();
  if (!/:::[ \t]*gallery/i.test(text)) return Decoration.none;
  const blocks: Range<Decoration>[] = [];
  for (const block of findGalleries(text.split("\n"))) {
    const open = doc.line(block.open + 1);
    const close = doc.line(block.close + 1);
    const touched = selection.ranges.some((r) => r.from <= close.to && r.to >= open.from);
    if (touched) {
      for (let n = open.number; n <= close.number; n++) {
        const edge = n === open.number ? " cm-md-gallery-first" : n === close.number ? " cm-md-gallery-last" : "";
        blocks.push(Decoration.line({ class: `cm-md-gallery-line${edge}` }).range(doc.line(n).from));
      }
      if (!state.readOnly) blocks.push(Decoration.widget({ widget: new ShowGalleryWidget(), side: 1 }).range(open.to));
      continue;
    }
    blocks.push(Decoration.replace({ widget: new GalleryWidget(block.layout, block.images, state.readOnly), block: true }).range(open.from, close.to));
  }
  return Decoration.set(blocks, true);
}

export const galleryField = StateField.define<DecorationSet>({
  create: findGalleryWidgets,
  update(blocks, tr) {
    if (tr.docChanged || tr.selection || tr.reconfigured || tr.state.readOnly !== tr.startState.readOnly) return findGalleryWidgets(tr.state);
    return blocks;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const pill = {
  border: "0",
  borderRadius: "6px",
  padding: "0.2rem 0.55rem",
  background: "none",
  color: "var(--text)",
  font: "inherit",
  fontFamily: "var(--font-ui, inherit)",
  fontSize: "0.8rem",
  cursor: "pointer",
};

export const galleryTheme = EditorView.theme({
  ".cm-md-gallery": { whiteSpace: "normal", position: "relative", margin: "0", padding: "0.5rem", borderRadius: "14px", border: "1px dashed transparent" },
  ".cm-md-gallery.editable": { paddingTop: "2.4rem" },
  ".cm-md-gallery.editable:hover, .cm-md-gallery.editable:focus-within": { borderColor: "var(--border)" },
  ".cm-md-gallery .md-gallery": { margin: "0" },
  ".cm-md-gallery-bar": {
    position: "absolute",
    top: "0.45rem",
    left: "0.5rem",
    right: "0.5rem",
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    fontFamily: "var(--font-ui, inherit)",
    fontSize: "0.8rem",
    color: "var(--muted)",
    opacity: "0.55",
    transition: "opacity 0.12s",
  },
  ".cm-md-gallery:hover .cm-md-gallery-bar, .cm-md-gallery:focus-within .cm-md-gallery-bar": { opacity: "1" },
  ".cm-md-gallery-label": { fontWeight: "600", letterSpacing: "0.02em", marginRight: "auto" },
  ".cm-md-gallery-layouts": { display: "inline-flex", gap: "2px", padding: "2px", borderRadius: "8px", border: "1px solid var(--border)", background: "var(--surface, #fff)" },
  ".cm-md-gallery-bar button, .cm-md-gallery-show, .cm-md-gallery-url button, .cm-md-gallery-empty button": pill,
  ".cm-md-gallery-bar button:hover, .cm-md-gallery-url button:hover": { background: "var(--hover, rgb(0 0 0 / 0.06))" },
  ".cm-md-gallery-layouts button[aria-pressed=true]": { background: "var(--accent)", color: "var(--accent-text)" },
  ".cm-md-gallery-markdown, .cm-md-gallery-url button": { border: "1px solid var(--border) !important", background: "var(--surface, #fff) !important" },
  ".cm-md-gallery-add": { display: "inline-flex", alignItems: "center", gap: "0.25rem", border: "1px solid var(--border) !important", background: "var(--surface, #fff) !important" },
  ".cm-md-gallery-add:hover": { color: "var(--accent) !important", borderColor: "var(--accent) !important" },
  ".cm-md-gallery svg": { width: "1rem", height: "1rem", fill: "none", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round", strokeLinejoin: "round" },
  ".cm-md-gallery-empty": { display: "flex", flexDirection: "column", alignItems: "center", gap: "0.4rem", padding: "1.5rem 1rem", borderRadius: "10px", border: "1.5px dashed var(--border)" },
  ".cm-md-gallery-empty p": { margin: "0", color: "var(--muted)", fontSize: "0.85em", fontFamily: "var(--font-ui, inherit)" },
  ".cm-md-gallery-empty .cm-md-gallery-add": { fontSize: "0.9rem", padding: "0.4rem 0.8rem" },
  ".cm-md-gallery-url": { display: "flex", gap: "0.35rem", margin: "0 0 0.5rem", fontFamily: "var(--font-ui, inherit)" },
  ".cm-md-gallery-url input": {
    flex: "1",
    minWidth: "8rem",
    padding: "0.3rem 0.5rem",
    border: "1px solid var(--border)",
    borderRadius: "8px",
    background: "var(--editor-bg, var(--surface, #fff))",
    color: "var(--text)",
    font: "inherit",
    fontSize: "0.85rem",
  },
  // Each picture's buttons, over its top corner.
  ".cm-md-gallery .md-gallery-item": { position: "relative" },
  ".cm-md-gallery.editable .md-gallery-item": { cursor: "grab" },
  ".cm-md-gallery-tools": {
    position: "absolute",
    top: "0.3rem",
    right: "0.3rem",
    display: "flex",
    gap: "1px",
    padding: "2px",
    borderRadius: "8px",
    background: "var(--surface, #fff)",
    border: "1px solid var(--border)",
    boxShadow: "0 1px 3px rgb(0 0 0 / 0.12)",
    opacity: "0",
    transition: "opacity 0.12s",
  },
  ".md-gallery-item:hover > .cm-md-gallery-tools, .md-gallery-item:focus-within > .cm-md-gallery-tools": { opacity: "1" },
  ".cm-md-gallery-tools button": { display: "grid", placeItems: "center", width: "1.45rem", height: "1.45rem", padding: "0", border: "0", borderRadius: "6px", background: "none", color: "var(--text)", cursor: "pointer" },
  ".cm-md-gallery-tools button:hover:not(:disabled)": { background: "var(--hover, rgb(0 0 0 / 0.06))" },
  ".cm-md-gallery-tools .cm-md-gallery-remove:hover": { color: "#dc2626" },
  ".cm-md-gallery-tools button:disabled": { opacity: "0.35", cursor: "default" },
  ".cm-md-gallery-tools svg": { width: "0.9rem", height: "0.9rem" },
  ".md-gallery-item.is-dragging": { opacity: "0.4" },
  ".md-gallery-item.drop-before": { boxShadow: "-3px 0 0 0 var(--accent)" },
  ".md-gallery-item.drop-after": { boxShadow: "3px 0 0 0 var(--accent)" },
  // Its lines, while the cursor is in the block: plain Markdown, in the code font, as with cards.
  ".cm-line.cm-md-gallery-line": { backgroundColor: "rgb(var(--gallery-tint, 120 120 120) / 0.07)", paddingLeft: "0.75rem", paddingRight: "0.75rem", fontFamily: "var(--font-mono)", fontSize: "0.88em", lineHeight: "1.6" },
  ".cm-line.cm-md-gallery-line *": { fontFamily: "inherit", fontSize: "inherit !important", lineHeight: "inherit" },
  ".cm-line.cm-md-gallery-first": { borderTopLeftRadius: "8px", borderTopRightRadius: "8px", paddingTop: "0.3em", color: "var(--muted)" },
  ".cm-line.cm-md-gallery-last": { borderBottomLeftRadius: "8px", borderBottomRightRadius: "8px", paddingBottom: "0.3em", color: "var(--muted)" },
  ".cm-md-gallery-show": { marginLeft: "0.75rem", border: "1px solid var(--border) !important", background: "var(--surface, #fff) !important", verticalAlign: "middle" },
});
