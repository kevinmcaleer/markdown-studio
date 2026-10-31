// Smart guides: while a layer is dragged, its edges and middle snap to the
// canvas's edges and middle and to the other layers', and a guide line shows
// what it lined up with.

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Guide {
  /** "x": a vertical line at `at`; "y": a horizontal one. */
  axis: "x" | "y";
  at: number;
  /** The span it's drawn across, in canvas units. */
  from: number;
  to: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: Guide[];
}

const xs = (b: Box) => [b.left, b.left + b.width / 2, b.left + b.width];
const ys = (b: Box) => [b.top, b.top + b.height / 2, b.top + b.height];

/** How far to move `moving` so it lines up with `page` or one of `others`, within `threshold`. */
export function snap(moving: Box, page: Box, others: Box[], threshold: number): SnapResult {
  const targets = [page, ...others];
  const best = (axis: "x" | "y") => {
    const mine = axis === "x" ? xs(moving) : ys(moving);
    let found: { d: number; at: number } | null = null;
    for (const t of targets) {
      for (const at of axis === "x" ? xs(t) : ys(t)) {
        for (const m of mine) {
          const d = at - m;
          if (Math.abs(d) <= threshold && (!found || Math.abs(d) < Math.abs(found.d))) found = { d, at };
        }
      }
    }
    return found;
  };
  const bx = best("x");
  const by = best("y");
  const dx = bx ? bx.d : 0;
  const dy = by ? by.d : 0;
  const moved = { ...moving, left: moving.left + dx, top: moving.top + dy };
  const guides: Guide[] = [];
  // Every line the moved box now sits on, drawn across it and what it meets.
  for (const axis of ["x", "y"] as const) {
    if (!(axis === "x" ? bx : by)) continue;
    const mine = axis === "x" ? xs(moved) : ys(moved);
    const seen = new Set<number>();
    for (const t of targets) {
      for (const at of axis === "x" ? xs(t) : ys(t)) {
        if (seen.has(at) || !mine.some(m => Math.abs(m - at) < 0.5)) continue;
        seen.add(at);
        const spanOf = (b: Box) => (axis === "x" ? [b.top, b.top + b.height] : [b.left, b.left + b.width]);
        const [a0, a1] = spanOf(moved);
        const [b0, b1] = t === page ? spanOf(page) : spanOf(t);
        guides.push({ axis, at, from: Math.min(a0, b0), to: Math.max(a1, b1) });
      }
    }
  }
  return { dx, dy, guides };
}
