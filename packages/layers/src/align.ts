// Lining shapes up with each other and spacing them out evenly, without
// Fabric.js: works on plain boxes and says how far to move each one.

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface Shift {
  dx: number;
  dy: number;
}

export type AlignHow = "left" | "center" | "right" | "top" | "middle" | "bottom";
export type DistributeHow = "horizontal" | "vertical";

/** How far to move each box so they all line up on the edge or middle of the box around them all. */
export function alignBoxes(boxes: Box[], how: AlignHow): Shift[] {
  if (!boxes.length) return [];
  const l = Math.min(...boxes.map(b => b.left));
  const t = Math.min(...boxes.map(b => b.top));
  const r = Math.max(...boxes.map(b => b.left + b.width));
  const bt = Math.max(...boxes.map(b => b.top + b.height));
  return boxes.map(b => {
    switch (how) {
      case "left": return { dx: l - b.left, dy: 0 };
      case "center": return { dx: (l + r) / 2 - (b.left + b.width / 2), dy: 0 };
      case "right": return { dx: r - (b.left + b.width), dy: 0 };
      case "top": return { dx: 0, dy: t - b.top };
      case "middle": return { dx: 0, dy: (t + bt) / 2 - (b.top + b.height / 2) };
      case "bottom": return { dx: 0, dy: bt - (b.top + b.height) };
    }
  });
}

/**
 * How far to move each box so the gaps between them are all the same. The
 * first and last (by position) stay put; the ones between them move. With
 * fewer than three boxes nothing moves.
 */
export function distributeBoxes(boxes: Box[], how: DistributeHow): Shift[] {
  const out: Shift[] = boxes.map(() => ({ dx: 0, dy: 0 }));
  if (boxes.length < 3) return out;
  const h = how === "horizontal";
  const start = (b: Box) => (h ? b.left : b.top);
  const size = (b: Box) => (h ? b.width : b.height);
  // Ordered by their middles, so a wide box doesn't jump the queue.
  const order = boxes.map((_, i) => i).sort((a, b) => start(boxes[a]) + size(boxes[a]) / 2 - (start(boxes[b]) + size(boxes[b]) / 2) || a - b);
  const first = boxes[order[0]];
  const last = boxes[order[order.length - 1]];
  const span = start(last) + size(last) - start(first);
  const total = boxes.reduce((s, b) => s + size(b), 0);
  const gap = (span - total) / (boxes.length - 1);
  let at = start(first);
  for (const i of order) {
    const move = at - start(boxes[i]);
    out[i] = h ? { dx: move, dy: 0 } : { dx: 0, dy: move };
    at += size(boxes[i]) + gap;
  }
  return out;
}
