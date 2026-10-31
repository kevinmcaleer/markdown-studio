import { codeFolding, foldEffect, foldedRanges, syntaxTree, unfoldEffect } from "@codemirror/language";
import type { EditorState, Extension, Range, StateEffect } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { parseCalloutHeader } from "./callouts";
import "./callouts.css";
import { copyText } from "./clipboard";
import "./image-sizes.css";
import { imageSizeClass, imageSizeMarkdown, imageSizes, parseImageSize, type ImageSize } from "./imageSize";
import { renderedCodeField, renderedCodeTheme } from "./codeRenderers";
import { cardsField, cardsTheme } from "./cardsWidget";
import { galleryField, galleryTheme } from "./galleryWidget";
import { videosField, videosTheme } from "./videosWidget";
import { tableCursor, tableField } from "./tableWidget";
import { sizePicture } from "./steadyScroll";

// The live view: Markdown shown as it reads, and still edited as text, like
// Obsidian's live preview. Headings, emphasis, links, list bullets, quotes
// and rules hide their Markdown except on the line the cursor is on, where
// it all shows so it can be edited. A fenced code block hides its fences
// (showing just its language and a copy button) until the cursor is anywhere
// inside it. Tables are drawn as tables throughout (see tableWidget.ts).
// Callouts (`> [!note]`, see callouts.ts) are drawn as boxes, their `[!type]`
// an icon, and a foldable one folds from its chevron. Raw mode is the editor without this.

const hidden = Decoration.replace({});

const lineClass = (className: string) => Decoration.line({ class: className });

/** How far each level of a list indents, in em; the published page's lists use the same. */
const HANG_EM = 1.3;

type SyntaxNode = ReturnType<typeof syntaxTree>["topNode"];

/** A list's gutter, in em: wider when its numbers reach two digits or more. */
function gutter(list: SyntaxNode): number {
  const mark = list.lastChild?.getChild("ListMark");
  const digits = list.name === "OrderedList" && mark ? mark.to - mark.from - 1 : 1;
  return HANG_EM + 0.6 * Math.max(0, digits - 1);
}

/**
 * Puts a hanging list item's marker in its gutter (see `hang` below). `indent`
 * is how far a nested item's marker sits in, in em, the widget covering its
 * leading spaces; null for a list in a quote, whose marker stays inline.
 */
function inGutter(marker: HTMLElement, indent: number | null): HTMLElement {
  if (indent === null) return marker;
  const box = document.createElement("span");
  box.className = "cm-md-list-marker";
  box.style.paddingLeft = `${indent}em`;
  box.append(marker);
  return box;
}

class BulletWidget extends WidgetType {
  constructor(readonly indent: number | null = null) {
    super();
  }
  eq(other: BulletWidget) {
    return other.indent === this.indent;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-md-bullet";
    span.textContent = "•";
    return inGutter(span, this.indent);
  }
  ignoreEvent() {
    return false;
  }
}

/** A nested numbered item's leading spaces, drawn as wide as the gutters they sit in. */
class IndentWidget extends WidgetType {
  constructor(readonly indent: number) {
    super();
  }
  eq(other: IndentWidget) {
    return other.indent === this.indent;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-md-list-indent";
    span.style.width = `${this.indent}em`;
    return span;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly indent: number | null = null,
  ) {
    super();
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked && other.indent === this.indent;
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
    return inGutter(box, this.indent);
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

const COPY_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3"/></svg>';
const COPIED_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7"/></svg>';

/** The code inside the fenced block that starts at `pos`, without its fences (or the quote and list markers it sits in). */
export function fencedCodeText(state: EditorState, pos: number): string {
  const inner = syntaxTree(state).resolveInner(pos, 1);
  let node: typeof inner | null = inner;
  while (node && node.name !== "FencedCode") node = node.parent;
  if (!node) return "";
  const { doc } = state;
  const open = doc.lineAt(node.from);
  const marks = node.getChildren("CodeMark");
  const end = marks.length >= 2 ? doc.lineAt(marks[marks.length - 1].from) : null;
  const last = end && end.number > open.number ? end.number - 1 : doc.lineAt(node.to).number;
  const indent = node.from - open.from;
  const out: string[] = [];
  for (let n = open.number + 1; n <= last; n++) {
    const text = doc.line(n).text;
    const prefix = text.slice(0, indent);
    out.push(/^[\s>]*$/.test(prefix) ? text.slice(indent) : text);
  }
  return out.join("\n");
}

/** A fenced block's language, small, in place of its opening fence, with a button that copies its code. */
class FenceLabelWidget extends WidgetType {
  constructor(readonly language: string) {
    super();
  }
  eq(other: FenceLabelWidget) {
    return other.language === this.language;
  }
  toDOM(view: EditorView) {
    const span = document.createElement("span");
    span.className = "cm-md-fence-label";
    span.textContent = this.language;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "cm-md-code-copy";
    copy.title = "Copy code";
    copy.setAttribute("aria-label", "Copy code");
    copy.innerHTML = COPY_ICON;
    let reset: ReturnType<typeof setTimeout> | undefined;
    const show = (label: string, icon: string) => {
      copy.title = label;
      copy.setAttribute("aria-label", label);
      copy.innerHTML = icon;
      clearTimeout(reset);
      reset = setTimeout(() => {
        copy.title = "Copy code";
        copy.setAttribute("aria-label", "Copy code");
        copy.innerHTML = COPY_ICON;
      }, 1500);
    };
    // Keep the click away from the editor, which would put the cursor in the block and open it.
    copy.addEventListener("mousedown", (event) => event.preventDefault());
    copy.addEventListener("click", (event) => {
      event.preventDefault();
      copyText(fencedCodeText(view.state, view.posAtDOM(span))).then(
        () => show("Copied", COPIED_ICON),
        () => show("Couldn't copy", COPY_ICON),
      );
    });
    const wrap = document.createElement("span");
    wrap.className = "cm-md-fence-head";
    wrap.append(span, copy);
    return wrap;
  }
  ignoreEvent(event: Event) {
    return event.target instanceof Element && !!event.target.closest(".cm-md-code-copy");
  }
}

/**
 * An image, drawn as the picture at its `{size}` (see imageSize.ts). Hovering
 * it shows its sizes, and picking one rewrites the modifier after its Markdown.
 */
class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly size: ImageSize | null,
    /** How long the image's Markdown is, without its modifier, and how long the modifier is. */
    readonly markdownLength: number,
    readonly modifierLength: number,
    /** No size buttons when the text can't be changed. */
    readonly readOnly: boolean,
  ) {
    super();
  }
  eq(other: ImageWidget) {
    return (
      other.src === this.src &&
      other.alt === this.alt &&
      other.size === this.size &&
      other.markdownLength === this.markdownLength &&
      other.modifierLength === this.modifierLength &&
      other.readOnly === this.readOnly
    );
  }
  toDOM(view: EditorView) {
    if (!/^(https?:|data:image\/|\/)/i.test(this.src)) {
      const span = document.createElement("span");
      span.className = "cm-md-image-alt";
      span.textContent = this.alt || this.src;
      return span;
    }
    const wrap = document.createElement("span");
    wrap.className = this.size ? `cm-md-image-wrap cm-md-image-sized ${imageSizeClass(this.size)}` : "cm-md-image-wrap";
    const img = document.createElement("img");
    img.className = "cm-md-image";
    img.src = this.src;
    img.alt = this.alt;
    sizePicture(img);
    wrap.append(img);
    if (this.readOnly) return wrap;

    const bar = document.createElement("span");
    bar.className = "cm-md-image-sizes";
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "Image size");
    const current = this.size ?? "full";
    for (const { size, label, title } of imageSizes) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.title = title;
      button.setAttribute("aria-pressed", String(size === current));
      button.addEventListener("mousedown", (e) => e.preventDefault());
      button.addEventListener("click", (e) => {
        e.preventDefault();
        const from = view.posAtDOM(wrap) + this.markdownLength;
        view.dispatch({ changes: { from, to: from + this.modifierLength, insert: imageSizeMarkdown(size) }, userEvent: "input.image-size" });
      });
      bar.append(button);
    }
    wrap.append(bar);
    return wrap;
  }
  ignoreEvent(event: Event) {
    return event.target instanceof Element && !!event.target.closest(".cm-md-image-sizes");
  }
}

/** A callout's `> [!type]`: its icon, and its title when it wasn't given one. */
class CalloutHeadWidget extends WidgetType {
  constructor(readonly title: string) {
    super();
  }
  eq(other: CalloutHeadWidget) {
    return other.title === this.title;
  }
  toDOM() {
    const head = document.createElement("span");
    head.className = "cm-md-callout-head";
    const icon = document.createElement("span");
    icon.className = "callout-icon";
    head.append(icon);
    if (this.title) head.append(this.title);
    return head;
  }
  ignoreEvent() {
    return false;
  }
}

/** The chevron at the end of a foldable callout's title, which folds its body away. */
class CalloutFoldWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly folded: boolean,
  ) {
    super();
  }
  eq(other: CalloutFoldWidget) {
    return other.from === this.from && other.to === this.to && other.folded === this.folded;
  }
  toDOM(view: EditorView) {
    const chevron = document.createElement("button");
    chevron.type = "button";
    chevron.className = "cm-md-callout-fold";
    chevron.setAttribute("aria-label", this.folded ? "Expand" : "Collapse");
    chevron.setAttribute("aria-expanded", String(!this.folded));
    chevron.addEventListener("mousedown", (e) => e.preventDefault());
    chevron.addEventListener("click", (e) => {
      e.preventDefault();
      view.dispatch({ effects: (this.folded ? unfoldEffect : foldEffect).of({ from: this.from, to: this.to }) });
    });
    return chevron;
  }
  ignoreEvent() {
    return true;
  }
}

/** The callout a quote starting at `from` is, and where its `> [!type]±` ends; null for a plain quote. */
function calloutAt(state: EditorState, from: number) {
  const line = state.doc.lineAt(from);
  const text = line.text.slice(from - line.from);
  const mark = /^>[ \t]?(\[![\w-]+\][+-]?)[ \t]*/.exec(text);
  const header = mark && parseCalloutHeader(text.replace(/^>[ \t]?/, ""));
  return mark && header ? { header, markEnd: from + mark[0].length, line } : null;
}

/** Ticks or unticks the task whose list marker starts at `pos`. */
export function toggleTask(view: EditorView, pos: number) {
  const line = view.state.doc.lineAt(pos);
  const match = /^(\s*[-*+]\s+\[)([ xX])\]/.exec(line.text.slice(pos - line.from));
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
  // A callout's `> [!type]` is drawn as one widget, so the nodes inside it are left alone.
  let skip = { from: -1, to: -1 };
  // A block that spans a fold is entered once for each visible range around it.
  const seen = new Set<number>();
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

  // A list item's first line hangs: its marker sits in a gutter as wide as the
  // list is deep, and wrapped lines line up with the words, not the marker.
  // Returns the item's prefix and how far in (em) its own gutter starts, or
  // null for a list in a quote or callout, which is left as it was.
  const hang = (mark: SyntaxNode, task: SyntaxNode | null): { from: number; to: number; indent: number; own: number } | null => {
    const line = doc.lineAt(mark.from);
    if (!/^[ \t]*$/.test(state.sliceDoc(line.from, mark.from))) return null;
    const gutters: number[] = [];
    for (let up: SyntaxNode | null = mark.parent; up; up = up.parent) if (/^(Bullet|Ordered)List$/.test(up.name)) gutters.push(gutter(up));
    const width = gutters.reduce((a, b) => a + b, 0);
    const to = Math.min(line.to, (task ?? mark).to + 1);
    decorations.push(Decoration.line({ class: "cm-md-list-item", attributes: { style: `--mde-hang: ${+width.toFixed(2)}em` } }).range(line.from));
    return { from: line.from, to, indent: +(width - gutters[0]).toFixed(2), own: gutters[0] };
  };

  for (const { from, to } of ranges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        if (node.from >= skip.from && node.to <= skip.to) return false;
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
              // data-href lets a host style links by where they go (a parts
              // catalog link as a chip, say), as it can the rendered <a>s.
              const url = node.node.getChildren("URL").pop();
              const attributes = url ? { "data-href": state.sliceDoc(url.from, url.to) } : undefined;
              if (marks.length >= 2) decorations.push(Decoration.mark({ class: "cm-md-link", attributes }).range(marks[0].to, marks[1].from));
            }
            return;
          case "LinkMark":
          case "LinkLabel":
          case "LinkTitle":
            if ((parent === "Link" || parent === "Autolink") && !isActive(node.from)) hide(node.from, node.to);
            return;
          case "URL": {
            // Only the target after "](" — a bare URL used as the link's text is a URL node too.
            const marks = parent === "Link" ? node.node.parent!.getChildren("LinkMark") : [];
            if (marks.length >= 2 && node.from >= marks[1].to && !isActive(node.from)) hide(node.from, node.to);
            return;
          }
          case "Image": {
            if (isActive(node.from)) return false;
            const url = node.node.getChild("URL");
            const marks = node.node.getChildren("LinkMark");
            const alt = marks.length >= 2 ? state.sliceDoc(marks[0].to, marks[1].from) : "";
            const modifier = parseImageSize(state.sliceDoc(node.to, Math.min(doc.lineAt(node.to).to, node.to + 8)));
            const length = modifier?.length ?? 0;
            if (url)
              decorations.push(
                Decoration.replace({
                  widget: new ImageWidget(state.sliceDoc(url.from, url.to), alt, modifier?.size ?? null, node.to - node.from, length, state.readOnly),
                }).range(node.from, node.to + length),
              );
            return false;
          }
          case "ListMark": {
            const list = node.node.parent?.parent?.name;
            const task = node.node.nextSibling;
            const marker = task?.name === "Task" ? task.getChild("TaskMarker") : null;
            const hung = hang(node.node, marker);
            const markerBox = (from: number, width?: number) =>
              hung &&
              decorations.push(
                Decoration.mark({ class: "cm-md-list-marker", attributes: width ? { style: `min-width: ${width}em` } : {} }).range(from, hung.to),
              );
            if (isActive(node.from)) {
              markerBox(hung?.from ?? 0);
              return;
            }
            // A hanging bullet's or task's widget is its marker box, covering its whole prefix.
            if (marker) {
              const checked = /x/i.test(state.sliceDoc(marker.from, marker.to));
              const end = Math.min(doc.lineAt(node.from).to, marker.to + 1);
              decorations.push(Decoration.replace({ widget: new CheckboxWidget(checked, hung?.indent ?? null) }).range(hung?.from ?? node.from, end));
              if (checked && task && task.to > end) decorations.push(Decoration.mark({ class: "cm-md-task-done" }).range(end, task.to));
            } else if (list === "BulletList") {
              decorations.push(Decoration.replace({ widget: new BulletWidget(hung?.indent ?? null) }).range(hung?.from ?? node.from, hung?.to ?? node.to));
            } else if (hung && node.from > hung.from) {
              decorations.push(Decoration.replace({ widget: new IndentWidget(hung.indent) }).range(hung.from, node.from));
              markerBox(node.from, hung.own);
            } else if (hung) {
              markerBox(hung.from);
            }
            return;
          }
          case "Blockquote": {
            if (seen.has(node.from)) return;
            seen.add(node.from);
            const callout = calloutAt(state, node.from);
            if (!callout) {
              lines(node.from, node.to, "cm-md-quote");
              return;
            }
            const { header, markEnd, line } = callout;
            lines(node.from, node.to, "cm-md-callout");
            for (let n = line.number; n <= doc.lineAt(node.to).number; n++)
              decorations.push(lineClass(`callout-${header.type}`).range(doc.line(n).from));
            decorations.push(lineClass("cm-md-callout-title").range(line.from));
            const end = doc.lineAt(node.to);
            if (header.fold && end.number > line.number) {
              const body = { from: line.to, to: end.to };
              let folded = false;
              foldedRanges(state).between(body.from, body.from, (from, to) => void (folded ||= from === body.from && to === body.to));
              decorations.push(Decoration.widget({ widget: new CalloutFoldWidget(body.from, body.to, folded), side: -1 }).range(line.to));
            }
            if (isActive(node.from)) return;
            decorations.push(Decoration.replace({ widget: new CalloutHeadWidget(header.titled ? "" : header.title) }).range(node.from, markEnd));
            skip = { from: node.from, to: markEnd };
            return;
          }
          case "QuoteMark": {
            if (isActive(node.from)) return;
            const line = doc.lineAt(node.from);
            hide(node.from, line.text[node.to - line.from] === " " ? node.to + 1 : node.to);
            return;
          }
          case "HorizontalRule":
            if (!isActive(node.from)) decorations.push(Decoration.replace({ widget: new RuleWidget() }).range(node.from, node.to));
            return;
          case "FencedCode": {
            lines(node.from, Math.max(node.from, node.to - 1), "cm-md-code");
            const open = doc.lineAt(node.from);
            const close = doc.lineAt(Math.max(node.from, node.to - 1));
            for (let n = open.number; n <= close.number; n++) if (active.has(n)) return;
            const info = node.node.getChild("CodeInfo");
            decorations.push(lineClass("cm-md-fence cm-md-fence-open").range(open.from));
            decorations.push(
              Decoration.replace({ widget: new FenceLabelWidget(info ? state.sliceDoc(info.from, info.to) : "") }).range(open.from, open.to),
            );
            const marks = node.node.getChildren("CodeMark");
            const end = marks.length >= 2 ? marks[marks.length - 1] : null;
            if (end && close.number > open.number && end.from >= close.from) {
              decorations.push(lineClass("cm-md-fence").range(close.from));
              hide(close.from, close.to);
            }
            return;
          }
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
        foldedRanges(update.state) !== foldedRanges(update.startState) ||
        update.state.readOnly !== update.startState.readOnly
      )
        this.decorations = buildDecorations(update.state, update.view.visibleRanges, activeLines(update.view));
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** The `> [!type]-` callouts in a document, by the range their body folds over. */
export function closedCallouts(state: EditorState): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  const { doc } = state;
  for (let n = 1; n <= doc.lines; n++) {
    const head = doc.line(n);
    if (!/^>[ \t]?\[![\w-]+\]-/.test(head.text)) continue;
    let last = n;
    while (last < doc.lines && /^\s{0,3}>/.test(doc.line(last + 1).text)) last++;
    if (last > n) out.push({ from: head.to, to: doc.line(last).to });
    n = last;
  }
  return out;
}

/** Callouts written `[!type]-` start folded: when the editor opens, and when its whole text is replaced. */
const calloutFolds = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      this.fold(view);
    }
    update(update: ViewUpdate) {
      if (!update.docChanged) return;
      let whole = false;
      update.changes.iterChanges((fromA, toA) => void (whole ||= fromA === 0 && toA === update.startState.doc.length));
      if (whole) this.fold(update.view);
    }
    fold(view: EditorView) {
      const effects: StateEffect<unknown>[] = closedCallouts(view.state).map((range) => foldEffect.of(range));
      // A view can't be updated from its own constructor or update, so this waits a tick.
      if (effects.length) queueMicrotask(() => view.dispatch({ effects }));
    }
  },
);

/** Cmd/Ctrl-click opens a link, as in the preview. A plain click puts the cursor in it. */
const linkClicks = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (!(event.metaKey || event.ctrlKey) || event.button !== 0) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return false;
    for (let node: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(view.state).resolveInner(pos, 1); node; node = node.parent) {
      const url =
        node.name === "Link" ? node.getChildren("URL").pop() ?? null : node.name === "URL" || node.name === "Autolink" ? node : null;
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
  ".cm-line.cm-md-list-item": { paddingLeft: "calc(var(--mde-hang) + 6px)", textIndent: "calc(-1 * var(--mde-hang))" },
  ".cm-md-list-marker": { display: "inline-block", minWidth: "var(--mde-hang)", boxSizing: "border-box", textIndent: "0", whiteSpace: "pre" },
  ".cm-md-list-indent": { display: "inline-block" },
  ".cm-md-bullet": { display: "inline-block", width: "0.7em", textIndent: "0", color: "var(--muted)", fontWeight: "700" },
  ".cm-md-checkbox": { margin: "0 0.45em 0 0", verticalAlign: "-0.1em", accentColor: "var(--accent)", cursor: "pointer" },
  ".cm-md-task-done": { color: "var(--muted)", textDecoration: "line-through" },
  ".cm-md-link": { color: "var(--accent)", textDecoration: "underline", textUnderlineOffset: "2px" },
  ".cm-line.cm-md-quote": { borderLeft: "3px solid var(--border)", paddingLeft: "1em", color: "var(--muted)" },
  // Callouts: their colour and icon come from callouts.css's callout-<type> classes.
  // A solid tint with rounded corners (callouts.css), no stripe down the left.
  ".cm-line.cm-md-callout": {
    backgroundColor: "rgb(var(--callout-color) / 0.1)",
    paddingInline: "1em",
  },
  ".cm-line.cm-md-callout-first": { borderTopLeftRadius: "8px", borderTopRightRadius: "8px", paddingTop: "0.35em" },
  ".cm-line.cm-md-callout-last": { borderBottomLeftRadius: "8px", borderBottomRightRadius: "8px", paddingBottom: "0.35em" },
  // A folded callout is just its title line, so that line closes the box.
  ".cm-line.cm-md-callout-title:has(.cm-md-callout-fold[aria-expanded=false])": {
    borderBottomLeftRadius: "8px",
    borderBottomRightRadius: "8px",
    paddingBottom: "0.35em",
  },
  ".cm-line.cm-md-callout .cm-md-quote-text": { color: "inherit" },
  ".cm-line.cm-md-callout .cm-md-quote-text:not(.cm-md-em)": { fontStyle: "normal" },
  ".cm-line.cm-md-callout-title": { color: "color-mix(in srgb, rgb(var(--callout-color)) var(--callout-title-tone, 60%), black)", fontWeight: "600" },
  ".cm-md-callout-head": { display: "inline-flex", alignItems: "center", gap: "0.5em", marginRight: "0.5em", verticalAlign: "-0.15em" },
  ".cm-md-callout-head .callout-icon": { width: "1.1em", height: "1.1em" },
  ".cm-md-callout-fold": {
    width: "1.4em",
    height: "1.4em",
    padding: "0",
    border: "0",
    borderRadius: "4px",
    background: "none",
    marginLeft: "0.4em",
    verticalAlign: "-0.3em",
    color: "inherit",
    cursor: "pointer",
  },
  ".cm-md-callout-fold::before": {
    content: '""',
    display: "block",
    width: "0.4em",
    height: "0.4em",
    margin: "auto",
    borderRight: "2px solid currentColor",
    borderBottom: "2px solid currentColor",
    transform: "rotate(45deg)",
    transition: "transform 120ms",
  },
  ".cm-md-callout-fold[aria-expanded=false]::before": { transform: "rotate(-45deg)" },
  ".cm-md-callout-fold:hover": { backgroundColor: "rgb(var(--callout-color) / 0.15)" },
  // Inline `code` in prose: the code-block font, a touch smaller like on the page.
  "&.cm-live .cm-line:not(.cm-md-code) .cm-md-mono": { fontSize: "0.88em", padding: "0.1em 0.2em" },
  ".cm-line.cm-md-code": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.86em",
    backgroundColor: "var(--code-bg)",
    paddingInline: "1rem",
  },
  ".cm-line.cm-md-code-first": { borderTopLeftRadius: "10px", borderTopRightRadius: "10px", paddingTop: "0.5rem" },
  ".cm-line.cm-md-code-last": { borderBottomLeftRadius: "10px", borderBottomRightRadius: "10px", paddingBottom: "0.5rem" },
  // A fence line while the cursor is outside its block: the language, small
  // and to the right, on the opening line; the closing line all but gone.
  ".cm-line.cm-md-fence": { fontSize: "0.7em", lineHeight: "1.2" },
  ".cm-line.cm-md-fence-open": { textAlign: "right" },
  ".cm-md-fence-label": { color: "var(--muted)", fontFamily: "var(--font-sans)", letterSpacing: "0.02em" },
  ".cm-md-fence-head": { display: "inline-flex", alignItems: "center", gap: "0.5em" },
  ".cm-md-code-copy": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "1.9em",
    height: "1.9em",
    margin: "-0.35em -0.6em -0.35em 0",
    padding: "0",
    border: "1px solid transparent",
    borderRadius: "5px",
    background: "transparent",
    color: "var(--muted)",
    cursor: "pointer",
  },
  ".cm-md-code-copy:hover, .cm-md-code-copy:focus-visible": { color: "var(--text)", borderColor: "var(--border)", background: "var(--surface)" },
  ".cm-md-code-copy svg": {
    width: "1.45em",
    height: "1.45em",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.4",
    strokeLinecap: "round",
    strokeLinejoin: "round",
  },
  ".cm-md-rule": { display: "inline-block", width: "100%", verticalAlign: "middle", borderTop: "1px solid var(--border)" },
  ".cm-md-image": { maxWidth: "100%", height: "auto", borderRadius: "6px", verticalAlign: "bottom" },
  // An image's sizes show on its top edge while it's hovered. A sized
  // image's wrapper takes the size, and the picture fills it.
  ".cm-md-image-wrap": { position: "relative", display: "inline-block", maxWidth: "100%", verticalAlign: "bottom" },
  ".cm-md-image-sized .cm-md-image": { width: "100%" },
  ".cm-md-image-wrap.image-full, .cm-md-image-wrap.image-cover": { width: "100%" },
  ".cm-md-image-wrap.image-half": { width: "calc(50% - 0.3em)" },
  ".cm-md-image-wrap.image-small": { width: "calc(25% - 0.3em)" },
  ".cm-md-image-wrap.image-cover .cm-md-image": { height: "200px", objectFit: "cover", borderRadius: "5px" },
  ".cm-md-image-sizes": {
    position: "absolute",
    top: "6px",
    left: "6px",
    display: "flex",
    width: "max-content",
    gap: "2px",
    padding: "2px",
    borderRadius: "6px",
    background: "var(--surface)",
    boxShadow: "0 1px 4px rgba(0, 0, 0, 0.2)",
    fontFamily: "var(--font-sans)",
    fontSize: "0.72rem",
    lineHeight: "1",
    opacity: "0",
    transition: "opacity 0.12s",
  },
  ".cm-md-image-wrap:hover .cm-md-image-sizes, .cm-md-image-sizes:focus-within": { opacity: "1" },
  ".cm-md-image-sizes button": {
    padding: "0.3em 0.55em",
    border: "0",
    borderRadius: "4px",
    background: "transparent",
    color: "var(--text)",
    font: "inherit",
    whiteSpace: "nowrap",
    cursor: "pointer",
  },
  ".cm-md-image-sizes button:hover": { background: "var(--surface-2)" },
  ".cm-md-image-sizes button[aria-pressed=true]": { background: "var(--accent)", color: "var(--accent-text)" },
  ".cm-md-image-alt": { color: "var(--muted)", fontStyle: "italic" },

  // Tables, drawn like Claude docs: a hover handle on each row and column,
  // and bars below and to the right that add a row or a column.
  ".cm-md-table": { position: "relative", padding: "0.85rem 2.75rem 1.1rem 6px", fontFamily: "var(--font-sans)" },
  ".cm-md-table-scroll": { overflowX: "auto" },
  // A table in a quote or callout (see tableWidget.ts) carries on its box.
  ".cm-md-table.cm-md-table-quoted": { borderLeft: "3px solid var(--border)", paddingLeft: "calc(1em + 6px)" },
  ".cm-md-table.cm-md-table-callout": {
    borderLeft: "0",
    backgroundColor: "rgb(var(--callout-color) / 0.1)",
    paddingLeft: "1em",
  },
  ".cm-md-table.cm-md-table-callout.cm-md-table-quote-last": { borderBottomLeftRadius: "8px", borderBottomRightRadius: "8px" },
  // A table the host draws another way (see tableRenderer): just the drawing until it's edited.
  ".cm-md-table.previewing": { paddingRight: "6px" },
  ".cm-md-table.previewing > :not(.cm-md-table-preview)": { display: "none" },
  ".cm-md-table.editable .cm-md-table-preview": { cursor: "pointer" },
  // The "/" menu in a cell (its look comes from the slash menu's own theme).
  ".cm-md-table-slash": { position: "absolute", zIndex: "20" },
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
  // A cell's line breaks (<br> in the Markdown) are "\n"s while it's typed in.
  ".cm-md-table td:focus, .cm-md-table th:focus": { whiteSpace: "pre-wrap", boxShadow: "inset 0 0 0 2px color-mix(in srgb, var(--accent) 45%, transparent)" },
  ".cm-md-table .selected": { backgroundColor: "color-mix(in srgb, var(--syntax-function) 10%, transparent)" },
  ".cm-md-table code": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.88em",
    backgroundColor: "var(--code-bg)",
    borderRadius: "4px",
    padding: "0.1em 0.3em",
  },
  // An image grid (imageGrid.ts): no borders, a card per image, equal columns,
  // the empty header row hidden. Its look matches image-grid.css (the preview).
  ".cm-md-table.image-grid table": { tableLayout: "fixed", borderCollapse: "separate", borderSpacing: "0.75rem", width: "calc(100% + 1.5rem)", margin: "0 -0.75rem" },
  ".cm-md-table.image-grid th, .cm-md-table.image-grid td": {
    border: "0",
    padding: "0",
    minWidth: "0",
    background: "none",
    fontWeight: "normal",
    textAlign: "center",
    borderRadius: "10px",
  },
  ".cm-md-table.image-grid-nohead thead": { display: "none" },
  ".cm-md-table.image-grid th:not(.image-card)": { color: "var(--muted)", fontSize: "0.85em", fontWeight: "600" },
  // An empty cell still shows where an image can go while editing.
  ".cm-md-table.image-grid.editable td:not(.image-card)": { outline: "1px dashed var(--border)", minHeight: "3rem", height: "3rem" },
  ".cm-md-table.image-grid .image-card": {
    padding: "0.5rem 0.5rem 0.25rem",
    border: "1px solid var(--border)",
    backgroundColor: "var(--surface)",
    boxShadow: "0 1px 2px rgb(0 0 0 / 0.06)",
    color: "var(--muted)",
    fontSize: "0.88em",
    lineHeight: "1.4",
  },
  ".cm-md-table.image-grid .image-card img": { display: "block", width: "100%", maxWidth: "100%", height: "auto", aspectRatio: "4 / 3", objectFit: "contain", margin: "0 auto 0.25rem", borderRadius: "6px" },
  ".cm-md-table.image-grid .image-card img.image-cover": { objectFit: "cover" },
  // Any other image in a cell fits it rather than spilling out of the table.
  ".cm-md-table img": { maxWidth: "100%", height: "auto" },
  // A cell that starts with #'s is a heading (cellHeadings.ts), sized like the note's own headings.
  ".cm-md-table .cell-heading": { margin: "0", fontFamily: "var(--font-serif)", fontWeight: "500", lineHeight: "1.25", color: "var(--text)" },
  ".cm-md-table h1.cell-heading": { fontSize: "1.6em" },
  ".cm-md-table h2.cell-heading": { fontSize: "1.35em" },
  ".cm-md-table h3.cell-heading": { fontSize: "1.15em", fontWeight: "600" },
  ".cm-md-table :is(h4, h5, h6).cell-heading": { fontSize: "1em", fontWeight: "600" },
  ".cm-md-table.image-grid th:has(.cell-heading)": { fontSize: "1em", paddingBottom: "0.25rem" },
  ".cm-md-table mark": { backgroundColor: "var(--highlight)", color: "inherit", borderRadius: "2px" },
  ".cm-md-table a": { color: "var(--accent)" },
  // A host's note above a table (tableNote).
  ".cm-md-table-note": { padding: "0.5rem 2.75rem 0 6px" },
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
  // A handle is pressed to open its menu or dragged to move its row or column.
  ".cm-md-table-handle": { zIndex: "2", borderRadius: "999px", transform: "translate(-50%, -50%)", cursor: "grab", touchAction: "none" },
  ".cm-md-table.dragging, .cm-md-table.dragging *": { cursor: "grabbing !important", userSelect: "none" },
  ".cm-md-table-dropline": { position: "absolute", zIndex: "3", pointerEvents: "none", backgroundColor: "var(--accent)", borderRadius: "2px" },
  ".cm-md-table-dropline-row": { height: "3px", transform: "translateY(-50%)" },
  ".cm-md-table-dropline-col": { width: "3px", transform: "translateX(-50%)" },
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
    zIndex: "20",
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
  ".cm-md-table .cm-md-table-menu button svg": { width: "16px", height: "16px", flexShrink: "0" },
  ".cm-md-table-menu-choices": {
    display: "flex",
    alignItems: "center",
    gap: "2px",
    margin: "4px 0 0",
    padding: "6px 0.6rem 2px",
    borderTop: "1px solid var(--border)",
    color: "var(--muted)",
    fontSize: "0.85rem",
  },
  ".cm-md-table-menu-choices > span": { marginRight: "auto" },
  ".cm-md-table .cm-md-table-menu .cm-md-table-menu-choices button": { width: "auto", padding: "0.35rem" },
  ".cm-md-table .cm-md-table-menu .cm-md-table-menu-choices button[aria-checked=true]": { background: "var(--accent)", color: "var(--accent-text)" },
  ".cm-md-table .cm-md-table-menu button:disabled": { color: "var(--muted)", opacity: "0.5", cursor: "default", background: "none" },
});

/** The live view, for a Markdown editor. Leave it out for raw Markdown. */
export function livePreview(): Extension {
  return [
    EditorView.editorAttributes.of({ class: "cm-live" }),
    inlinePreview,
    codeFolding(),
    calloutFolds,
    tableField,
    tableCursor,
    renderedCodeField,
    galleryField,
    cardsField,
    videosField,
    linkClicks,
    liveTheme,
    renderedCodeTheme,
    galleryTheme,
    cardsTheme,
    videosTheme,
  ];
}
