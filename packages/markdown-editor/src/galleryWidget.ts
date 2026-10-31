import { StateField, type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { findGalleries, galleryHtml, galleryLayouts, galleryOpenLine, wireGallery, type GalleryImage, type GalleryLayout } from "./gallery";
import "./gallery.css";
import { rememberedHeight, rememberHeight } from "./steadyScroll";

// In the live view a `::: gallery` block (see gallery.ts) shows as its gallery
// while the cursor is outside it, and as its image lines once the cursor moves
// in, so pictures are added, removed and reordered as lines. Clicking the
// gallery puts the cursor on its first line; its layout buttons rewrite the
// `::: gallery <layout>` line. A filmstrip's thumbnails still swap its large
// picture, so it can be tried out in place.

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
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-gallery";
    rememberHeight(wrap, this.key);
    wrap.innerHTML = galleryHtml(this.layout, this.images);
    const gallery = wrap.firstElementChild as HTMLElement | null;
    if (gallery) wireGallery(gallery);
    if (!this.images.length) {
      const note = document.createElement("p");
      note.className = "cm-md-gallery-note";
      note.textContent = "An empty gallery: click here and add picture lines between ::: gallery and :::";
      wrap.append(note);
    }
    // Pictures are links to themselves: in the editor they don't navigate.
    wrap.addEventListener("click", (event) => {
      if ((event.target as Element).closest("a")) event.preventDefault();
    });

    if (!this.readOnly) {
      const bar = document.createElement("div");
      bar.className = "cm-md-gallery-bar";
      bar.setAttribute("role", "group");
      bar.setAttribute("aria-label", "Gallery layout");
      for (const { layout, label, title } of galleryLayouts) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.title = title;
        button.setAttribute("aria-pressed", String(layout === this.layout));
        button.addEventListener("mousedown", (e) => e.preventDefault());
        button.addEventListener("click", (e) => {
          e.preventDefault();
          const line = view.state.doc.lineAt(view.posAtDOM(wrap));
          view.dispatch({ changes: { from: line.from, to: line.to, insert: galleryOpenLine(layout) }, userEvent: "input.gallery-layout" });
        });
        bar.append(button);
      }
      wrap.append(bar);
    }

    // Clicking anywhere but a filmstrip's thumbnails (or the layout buttons) opens its lines.
    wrap.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      const target = event.target as Element;
      if (target.closest(".cm-md-gallery-bar")) return;
      if (target.closest(".md-gallery-filmstrip .md-gallery-item")) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      const { doc } = view.state;
      const open = doc.lineAt(view.posAtDOM(wrap));
      const first = open.number < doc.lines ? doc.line(open.number + 1) : open;
      view.focus();
      view.dispatch({ selection: { anchor: first.from }, scrollIntoView: true });
    });
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

/** The gallery blocks to draw: closed, and without the cursor in them. */
export function findGalleryWidgets(state: EditorState): DecorationSet {
  const { doc, selection } = state;
  const text = doc.toString();
  if (!text.includes(":::")) return Decoration.none;
  const blocks: Range<Decoration>[] = [];
  for (const block of findGalleries(text.split("\n"))) {
    const open = doc.line(block.open + 1);
    const close = doc.line(block.close + 1);
    const touched = selection.ranges.some((r) => r.from <= close.to && r.to >= open.from);
    if (touched) {
      // Open: its lines, with their pictures as small thumbnails so the list is easy to reorder.
      for (let n = open.number; n <= close.number; n++) {
        const edge = n === open.number ? " cm-md-gallery-first" : n === close.number ? " cm-md-gallery-last" : "";
        blocks.push(Decoration.line({ class: `cm-md-gallery-line${edge}` }).range(doc.line(n).from));
      }
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

export const galleryTheme = EditorView.theme({
  ".cm-md-gallery": {
    position: "relative",
    margin: "0.5rem 0",
    padding: "0.5rem",
    borderRadius: "12px",
    border: "1px solid transparent",
    cursor: "pointer",
  },
  ".cm-md-gallery:hover": { borderColor: "var(--border)" },
  ".cm-md-gallery .md-gallery": { margin: "0" },
  ".cm-line.cm-md-gallery-line": { backgroundColor: "rgb(var(--gallery-tint, 120 120 120) / 0.07)", paddingLeft: "0.75rem", paddingRight: "0.75rem" },
  ".cm-line.cm-md-gallery-first": { borderTopLeftRadius: "8px", borderTopRightRadius: "8px", paddingTop: "0.3em", color: "var(--muted)" },
  ".cm-line.cm-md-gallery-last": { borderBottomLeftRadius: "8px", borderBottomRightRadius: "8px", paddingBottom: "0.3em", color: "var(--muted)" },
  ".cm-line.cm-md-gallery-line .cm-md-image": { maxHeight: "4.5rem", width: "auto", maxWidth: "8rem", objectFit: "cover", borderRadius: "6px" },
  ".cm-md-gallery-note": { margin: "0", padding: "1rem", textAlign: "center", color: "var(--muted)", fontSize: "0.9em" },
  ".cm-md-gallery-bar": {
    position: "absolute",
    top: "0.9rem",
    right: "0.9rem",
    display: "flex",
    gap: "2px",
    padding: "2px",
    borderRadius: "8px",
    background: "var(--surface, #fff)",
    border: "1px solid var(--border)",
    boxShadow: "0 1px 3px rgb(0 0 0 / 0.12)",
    opacity: "0",
    transition: "opacity 0.12s",
    fontFamily: "var(--font-ui, inherit)",
  },
  ".cm-md-gallery:hover .cm-md-gallery-bar, .cm-md-gallery-bar:focus-within": { opacity: "1" },
  ".cm-md-gallery-bar button": {
    border: "0",
    borderRadius: "6px",
    padding: "0.2rem 0.55rem",
    background: "none",
    color: "var(--text)",
    fontSize: "0.8rem",
    cursor: "pointer",
  },
  ".cm-md-gallery-bar button:hover": { background: "var(--hover, rgb(0 0 0 / 0.06))" },
  ".cm-md-gallery-bar button[aria-pressed=true]": { background: "var(--accent)", color: "var(--accent-text)" },
});
