import { syntaxTree } from "@codemirror/language";
import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, showTooltip, type Tooltip } from "@codemirror/view";
import { cardPicturePicker } from "./cardsWidget";
import { imageSizeMarkdown, imageSizes, parseImageSize, type ImageSize } from "./imageSize";
import { isLayersUrl, layersOpener } from "./layersFacet";

// The image popover: clicking a picture in the live view keeps the picture
// showing and opens a small form under it, like the link card: its title (the
// alt text) and URL, its size, "Choose image" to swap the picture for another
// from the host's image picker, "Remove image", and "Edit markdown" for the
// Markdown itself. Everything it does is written straight into the Markdown,
// `![title](url){size}`, so the text stays the one place the picture lives.

/** A picture in the text: where its Markdown is, what it says, and its `{size}`. */
export type ImageAt = {
  /** The `![…](…)` itself. */
  from: number;
  to: number;
  /** The end of its `{size}`, or `to` when it has none. */
  end: number;
  alt: string;
  url: string;
  /** A `"title"` after the URL, kept as it is. */
  title: string;
  size: ImageSize | null;
};

/** The picture whose Markdown starts at `pos`, or null. */
export function imageAt(state: EditorState, pos: number): ImageAt | null {
  for (let node: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (node.name !== "Image") continue;
    if (node.from !== pos) return null;
    const marks = node.getChildren("LinkMark");
    const url = node.getChild("URL");
    const title = node.getChild("LinkTitle");
    if (marks.length < 2) return null;
    const line = state.doc.lineAt(node.to);
    const modifier = parseImageSize(state.sliceDoc(node.to, Math.min(line.to, node.to + 8)));
    return {
      from: node.from,
      to: node.to,
      end: node.to + (modifier?.length ?? 0),
      alt: unescape(state.sliceDoc(marks[0].to, marks[1].from)),
      url: url ? state.sliceDoc(url.from, url.to) : "",
      title: title ? state.sliceDoc(title.from + 1, title.to - 1) : "",
      size: modifier?.size ?? null,
    };
  }
  return null;
}

const unescape = (text: string) => text.replace(/\\([[\]])/g, "$1");

/** The Markdown for a picture, without its size: brackets in the alt text and spaces in the URL are escaped. */
export function imageMarkdown(image: { alt: string; url: string; title?: string }): string {
  const alt = image.alt.trim().replace(/([[\]])/g, "\\$1");
  const url = image.url.trim().replace(/[\s()]/g, encodeURIComponent);
  const title = image.title ? ` "${image.title.replace(/"/g, "&quot;")}"` : "";
  return `![${alt}](${url}${title})`;
}

/** What removing a picture deletes: its whole line when the line is just the picture, otherwise the picture. */
export function imageRemoval(state: EditorState, image: ImageAt): { from: number; to: number } {
  const line = state.doc.lineAt(image.from);
  const rest = state.sliceDoc(line.from, image.from) + state.sliceDoc(image.end, line.to);
  if (rest.trim()) return { from: image.from, to: image.end };
  // The line and its line break, so no blank line is left behind.
  if (line.to < state.doc.length) return { from: line.from, to: line.to + 1 };
  return { from: line.from > 0 ? line.from - 1 : line.from, to: line.to };
}

/** A picture's alt text from its file name, for a picture picked without one. Left as the
 *  file name, so it isn't taken for a caption someone wrote (imageCaption.ts). */
const altFromUrl = (url: string) => {
  const name = url.split(/[?#]/)[0].split("/").filter(Boolean).pop() ?? "";
  try {
    return decodeURIComponent(name).replace(/\.\w+$/, "");
  } catch {
    return name.replace(/\.\w+$/, "");
  }
};

const open = StateEffect.define<number>();
const close = StateEffect.define<null>();

const field = StateField.define<{ pos: number; tooltip: Tooltip } | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(close)) return null;
      if (e.is(open)) return imageAt(tr.state, e.value) ? { pos: e.value, tooltip: popoverTooltip(e.value) } : null;
    }
    if (!value || !tr.docChanged) return value;
    // Edits elsewhere move it along; the picture going away closes it.
    const pos = tr.changes.mapPos(value.pos, -1);
    if (!imageAt(tr.state, pos)) return null;
    return pos === value.pos ? value : { pos, tooltip: popoverTooltip(pos) };
  },
  provide: (f) => showTooltip.from(f, (v) => v?.tooltip ?? null),
});

/** Opens the popover for the picture whose Markdown starts at `pos`. False when it can't be edited. */
export function openImagePopover(view: EditorView, pos: number): boolean {
  if (view.state.readOnly || view.state.field(field, false) === undefined || !imageAt(view.state, pos)) return false;
  view.dispatch({ effects: open.of(pos) });
  return true;
}

/** Whether the popover is open on the picture at `pos`. */
export function imagePopoverAt(state: EditorState): number | null {
  return state.field(field, false)?.pos ?? null;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(label: string, title: string, className = ""): HTMLButtonElement {
  const b = el("button", className, label);
  b.type = "button";
  b.title = title;
  return b;
}

function popoverTooltip(pos: number): Tooltip {
  return {
    pos,
    above: false,
    create: (view) => ({ dom: popover(view, pos) }),
  };
}

function popover(view: EditorView, start: number): HTMLElement {
  const dom = el("form", "cm-image-popover");
  dom.setAttribute("aria-label", "Picture");
  const first = imageAt(view.state, start);
  // Where the picture is now: the field moves it along as the text changes.
  const current = () => {
    const pos = view.state.field(field, false)?.pos ?? start;
    return imageAt(view.state, pos);
  };

  const row = (label: string, value: string, placeholder: string) => {
    const wrap = el("label");
    wrap.append(el("span", "", label));
    const input = el("input");
    input.value = value;
    input.placeholder = placeholder;
    input.spellcheck = false;
    wrap.append(input);
    dom.append(wrap);
    return input;
  };
  const alt = row("Title", first?.alt ?? "", "A caption, shown under the picture");
  alt.spellcheck = true;
  const url = row("URL", first?.url ?? "", "https://… or /images/…");
  url.inputMode = "url";
  url.autocapitalize = "off";

  // Sizes go straight into the Markdown, as the buttons on the picture do.
  const sizes = el("div", "cm-image-popover-sizes");
  sizes.setAttribute("role", "group");
  sizes.setAttribute("aria-label", "Size");
  sizes.append(el("span", "", "Size"));
  const sizeButtons = new Map<ImageSize, HTMLButtonElement>();
  const showSize = (size: ImageSize | null) => {
    for (const [s, b] of sizeButtons) b.setAttribute("aria-pressed", String(s === (size ?? "full")));
  };
  for (const { size, label, title } of imageSizes) {
    const b = button(label, title);
    b.addEventListener("click", () => {
      const image = current();
      if (!image) return;
      view.dispatch({ changes: { from: image.to, to: image.end, insert: imageSizeMarkdown(size) }, userEvent: "input.image-size" });
      showSize(size);
    });
    sizeButtons.set(size, b);
    sizes.append(b);
  }
  showSize(first?.size ?? null);
  dom.append(sizes);

  const actions = el("div", "cm-image-popover-actions");
  const picker = view.state.facet(cardPicturePicker);
  const choose = picker ? button("Choose image", "Pick another picture from the project's images, or upload one") : null;
  const remove = button("Remove image", "Delete the picture and its Markdown", "danger");
  const markdown = button("Edit markdown", "Show the picture's Markdown to edit it by hand");
  // Layers (layersBlock.ts): a graphic opens again; any other picture can be drawn on.
  const layers = view.state.facet(layersOpener);
  const graphic = first && isLayersUrl(first.url);
  const draw = layers
    ? button(graphic ? "Edit graphic" : "Draw on it", graphic ? "Change this graphic in Layers" : "Add text, arrows and shapes over this picture in Layers", graphic ? "layers" : "")
    : null;
  const done = button("Done", "Save and close", "primary");
  done.type = "submit";
  actions.append(...(draw ? [draw] : []), ...(choose ? [choose] : []), remove, markdown, el("span", "cm-image-popover-gap"), done);
  dom.append(actions);

  let closed = false;
  let picking = false;
  /** Writes the title and URL, when they changed. */
  const save = () => {
    const image = current();
    if (!image || !url.value.trim()) return;
    const insert = imageMarkdown({ alt: alt.value, url: url.value, title: image.title });
    if (insert !== view.state.sliceDoc(image.from, image.to))
      view.dispatch({ changes: { from: image.from, to: image.to, insert }, userEvent: "input.image" });
  };
  const finish = (keep: boolean, focusEditor = true) => {
    if (closed) return;
    closed = true;
    if (keep) save();
    view.dispatch({ effects: close.of(null) });
    if (focusEditor) view.focus();
  };

  choose?.addEventListener("click", () => {
    picking = true;
    picker!(choose, (picture) => {
      picking = false;
      const image = current();
      if (!image || closed) return;
      // Typed but not saved yet: the new picture keeps the title, or takes its own.
      const title = alt.value.trim() || picture.alt || altFromUrl(picture.src);
      const insert = imageMarkdown({ alt: title, url: picture.src, title: image.title });
      view.dispatch({ changes: { from: image.from, to: image.to, insert }, userEvent: "input.image" });
      alt.value = title;
      url.value = picture.src;
      alt.focus();
    });
    // The picker may close without a pick; focus coming back ends picking.
    window.setTimeout(() => dom.addEventListener("focusin", () => (picking = false), { once: true }));
  });
  draw?.addEventListener("click", () => {
    save();
    const image = current();
    closed = true;
    view.dispatch({ effects: close.of(null) });
    if (image) layers!.open(view, image.from);
  });
  remove.addEventListener("click", () => {
    const image = current();
    closed = true;
    view.dispatch({
      ...(image ? { changes: imageRemoval(view.state, image), userEvent: "delete.image" } : {}),
      effects: close.of(null),
    });
    view.focus();
  });
  markdown.addEventListener("click", () => {
    save();
    const image = current();
    closed = true;
    // The caret on the picture's line shows its Markdown, as it does for any line.
    view.focus();
    view.dispatch({ effects: close.of(null), ...(image ? { selection: { anchor: image.from + 2 + alt.value.trim().length } } : {}), scrollIntoView: true });
  });

  dom.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!url.value.trim()) return url.focus();
    finish(true);
  });
  dom.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    }
  });
  // Buttons act without taking the focus from the fields.
  dom.addEventListener("mousedown", (e) => {
    if ((e.target as Element).closest("button")) e.preventDefault();
  });
  // Clicking away keeps what was typed, as a card's form does.
  dom.addEventListener("focusout", (e) => {
    const next = (e as FocusEvent).relatedTarget as Node | null;
    if (next && dom.contains(next)) return;
    window.setTimeout(() => {
      if (closed || picking || dom.contains(document.activeElement)) return;
      finish(true, false);
    }, 150);
  });
  queueMicrotask(() => alt.focus());
  return dom;
}

const theme = EditorView.theme({
  ".cm-tooltip.cm-image-popover": {
    display: "grid",
    gap: "0.45rem",
    width: "28.5rem",
    maxWidth: "calc(100vw - 2rem)",
    marginTop: "6px",
    padding: "0.65rem",
    border: "1px solid var(--border)",
    borderRadius: "10px",
    background: "var(--surface)",
    boxShadow: "0 8px 28px rgb(0 0 0 / 0.14)",
    fontFamily: "var(--font-sans)",
    fontSize: "13px",
    color: "var(--text)",
  },
  ".cm-image-popover label": { display: "grid", gridTemplateColumns: "2.6rem 1fr", alignItems: "center", gap: "0.4rem" },
  ".cm-image-popover label > span, .cm-image-popover-sizes > span": { color: "var(--muted)" },
  ".cm-image-popover input": {
    font: "inherit",
    padding: "0.3rem 0.45rem",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    background: "var(--bg)",
    color: "var(--text)",
    minWidth: "0",
  },
  ".cm-image-popover input:focus": { outline: "2px solid color-mix(in srgb, var(--accent) 45%, transparent)", outlineOffset: "0" },
  ".cm-image-popover-sizes": { display: "flex", alignItems: "center", gap: "2px" },
  ".cm-image-popover-sizes > span": { width: "2.6rem", marginRight: "0.4rem" },
  ".cm-image-popover-sizes button": {
    font: "inherit",
    padding: "0.2rem 0.55rem",
    border: "0",
    borderRadius: "5px",
    background: "transparent",
    color: "var(--text)",
    cursor: "pointer",
  },
  ".cm-image-popover-sizes button:hover": { background: "var(--surface-2)" },
  ".cm-image-popover-sizes button[aria-pressed=true]": { background: "var(--accent)", color: "var(--accent-text, #fff)" },
  ".cm-image-popover-actions": { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.35rem", paddingTop: "0.15rem" },
  ".cm-image-popover-gap": { flex: "1" },
  ".cm-image-popover-actions button": {
    font: "inherit",
    padding: "0.25rem 0.6rem",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    background: "var(--surface)",
    color: "var(--text)",
    whiteSpace: "nowrap",
    cursor: "pointer",
  },
  ".cm-image-popover-actions button:hover": { background: "var(--surface-2)" },
  ".cm-image-popover-actions button.danger": { color: "var(--danger, #b42318)" },
  ".cm-image-popover-actions button.layers": { color: "#6d28d9", borderColor: "rgb(124 58 237 / 0.45)" },
  ".cm-image-popover-actions button.primary": { background: "var(--accent)", borderColor: "var(--accent)", color: "var(--accent-text, #fff)" },
  // The picture being edited is ringed while its popover is open.
  ".cm-md-image-wrap.cm-md-image-editing .cm-md-image": { outline: "2px solid var(--accent)", outlineOffset: "2px" },
  // Its sizes are in the popover, so the hover buttons step aside.
  ".cm-md-image-wrap.cm-md-image-editing .cm-md-image-sizes": { display: "none" },
});

/** Clicking a picture in the live view opens its popover. */
export function imagePopover(): Extension {
  return [field, theme];
}
