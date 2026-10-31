import { type Extension, type SelectionRange } from "@codemirror/state";
import { BlockType, type BlockInfo, EditorView, type LayerMarker, RectangleMarker, layer } from "@codemirror/view";

// The selection highlight, drawn the way a word processor draws it.
//
// CodeMirror's own selection layer (drawSelection) paints a selection that
// runs over line ends as one shape: from the start to the editor's right
// edge, every line between it full width, and the last line from the left
// edge. In the live view, where page breaks, rules, tables and pictures are
// drawn as widgets and the text sits inside padding, that read as a big
// coloured slab with a bar down the left even when only two line breaks were
// picked (Kev, 2026-10-31).
//
// This layer paints only what's picked: the text on each visual line, a short
// mark where a line break is picked (so a blank line still shows), and a whole
// block widget (a page break's label, a table, a diagram) when the selection
// covers all of it. drawSelection still draws the cursor; its own selection
// layer is hidden in the theme below.

/** Width of the mark that stands for a picked line break, in px. */
const BREAK_WIDTH = 7;

/** A rectangle in client coordinates. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Joins boxes that sit on the same visual line into one, left to right, so a
 * line with bold text, a link chip or an inline picture is one even band
 * instead of overlapping patches. Boxes narrower than half a pixel are dropped.
 */
export function mergeRows(boxes: readonly Box[]): Box[] {
  const sorted = boxes.filter((b) => b.right - b.left > 0.5 && b.bottom - b.top > 0.5).sort((a, b) => a.top - b.top || a.left - b.left);
  const rows: Box[] = [];
  for (const b of sorted) {
    const row = rows.find((r) => {
      const overlap = Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top);
      return overlap > 0.5 * Math.min(r.bottom - r.top, b.bottom - b.top);
    });
    if (row) {
      row.left = Math.min(row.left, b.left);
      row.right = Math.max(row.right, b.right);
      row.top = Math.min(row.top, b.top);
      row.bottom = Math.max(row.bottom, b.bottom);
    } else rows.push({ ...b });
  }
  return rows;
}

/** The text boxes of document range `from`–`to`, which sits on one visual line block. */
function textBoxes(view: EditorView, from: number, to: number): Box[] {
  if (from >= to) return [];
  try {
    const start = view.domAtPos(from);
    const end = view.domAtPos(to);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return mergeRows(Array.from(range.getClientRects(), (r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })));
  } catch {
    return [];
  }
}

/** The element a block widget starting at `from` is drawn with. */
function widgetElement(view: EditorView, block: BlockInfo): HTMLElement | null {
  for (const el of Array.from(view.contentDOM.children) as HTMLElement[]) {
    if (el.classList.contains("cm-line") || el.classList.contains("cm-gap")) continue;
    let pos: number;
    try {
      pos = view.posAtDOM(el);
    } catch {
      continue;
    }
    if (pos === block.from) return el;
  }
  return null;
}

/** The client boxes to paint for one selection range. */
function rangeBoxes(view: EditorView, sel: SelectionRange): Box[] {
  const out: Box[] = [];
  const lineHeight = view.defaultLineHeight;
  const visit = (block: BlockInfo) => {
    if (block.to < sel.from || block.from > sel.to) return;
    if (block.type !== BlockType.Text) {
      // A widget: painted whole, and only when the selection covers it. A
      // zero-length widget (a toolbar above a line) isn't text, so never.
      if (block.from === block.to || block.from < sel.from || block.to > sel.to) return;
      const el = widgetElement(view, block);
      // A widget can name the part that shows it's picked (a page break's
      // label); a spaced block (see spacedBlock) is painted without its spacing.
      const inner = el?.classList.contains("cm-md-block-space") ? (el.firstElementChild as HTMLElement | null) : el;
      const target = (el?.querySelector<HTMLElement>(".cm-md-select-box") ?? inner)?.getBoundingClientRect();
      if (target && target.width > 0 && target.height > 0) out.push({ left: target.left, top: target.top, right: target.right, bottom: target.bottom });
      return;
    }
    const from = Math.max(sel.from, block.from);
    const to = Math.min(sel.to, block.to);
    const rows = textBoxes(view, from, to);
    out.push(...rows);
    // The line break at the end of this line is picked: a short mark after
    // the text (or at the start of a blank line), the way word processors do.
    if (sel.to > block.to && sel.from <= block.to) {
      const last = rows.length ? rows[rows.length - 1] : null;
      const end = view.coordsAtPos(block.to, -1) ?? view.coordsAtPos(block.to, 1);
      const x = Math.max(last?.right ?? -Infinity, end?.left ?? -Infinity);
      const top = last?.top ?? end?.top;
      const bottom = last?.bottom ?? end?.bottom;
      if (Number.isFinite(x) && top !== undefined && bottom !== undefined) {
        out.push({ left: x, top, right: x + BREAK_WIDTH, bottom: Math.max(bottom, top + Math.min(lineHeight, 4)) });
      }
    }
  };
  for (const block of view.viewportLineBlocks) {
    if (block.to < sel.from || block.from > sel.to) continue;
    if (Array.isArray(block.type)) for (const part of block.type) visit(part);
    else visit(block);
  }
  return out;
}

const selectionLayer = layer({
  above: false,
  class: "cm-md-selectionLayer",
  markers(view): readonly LayerMarker[] {
    const scroller = view.scrollDOM.getBoundingClientRect();
    const baseLeft = scroller.left - view.scrollDOM.scrollLeft * view.scaleX;
    const baseTop = scroller.top - view.scrollDOM.scrollTop * view.scaleY;
    const markers: LayerMarker[] = [];
    for (const sel of view.state.selection.ranges) {
      if (sel.empty) continue;
      for (const b of rangeBoxes(view, sel)) {
        markers.push(
          new RectangleMarker(
            "cm-selectionBackground",
            (b.left - baseLeft) / view.scaleX,
            (b.top - baseTop) / view.scaleY,
            (b.right - b.left) / view.scaleX,
            (b.bottom - b.top) / view.scaleY,
          ),
        );
      }
    }
    return markers;
  },
  update(update) {
    return update.docChanged || update.selectionSet || update.viewportChanged || update.geometryChanged || update.focusChanged;
  },
});

const textSelectionTheme = EditorView.theme({
  // drawSelection still draws the cursor; this layer draws the selection.
  "& > .cm-scroller > .cm-selectionLayer": { display: "none" },
  ".cm-md-selectionLayer .cm-selectionBackground": { borderRadius: "2px" },
});

/** The word-processor style selection highlight (use alongside drawSelection). */
export function textSelection(): Extension {
  return [selectionLayer, textSelectionTheme];
}
