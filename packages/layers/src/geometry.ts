// Connector geometry, without Fabric.js: where a shape's snap points sit,
// which side a line should leave from, and how far a point is from a line.

export interface Pt {
  x: number;
  y: number;
}

/** A shape's snap points, named for the side of the shape they sit on. */
export type Side = "top" | "right" | "bottom" | "left";
export const SIDES: Side[] = ["top", "right", "bottom", "left"];

const DIRS: Record<Side, Pt> = { top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 } };

/** The middle of each side of a `w`×`h` box centred on (0, 0). */
export function boxSides(w: number, h: number): Record<Side, Pt> {
  return { top: { x: 0, y: -h / 2 }, right: { x: w / 2, y: 0 }, bottom: { x: 0, y: h / 2 }, left: { x: -w / 2, y: 0 } };
}

/**
 * Where a polygon's outline crosses the straight lines up, right, down and
 * left from (0, 0), the point it's centred on. A triangle's left and right
 * snap points then sit on its sloping sides, not out in the air beside them.
 */
export function polygonSides(points: Pt[]): Record<Side, Pt> {
  const out = {} as Record<Side, Pt>;
  for (const side of SIDES) {
    const d = DIRS[side];
    const vertical = d.x === 0;
    let best = 0;
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      // Across the axis we're walking along: the coordinate that must be 0.
      const ac = vertical ? a.x : a.y;
      const bc = vertical ? b.x : b.y;
      const along = (p: Pt) => (vertical ? p.y * d.y : p.x * d.x);
      if (ac === 0 && bc === 0) {
        best = Math.max(best, along(a), along(b));
        continue;
      }
      if ((ac > 0 && bc > 0) || (ac < 0 && bc < 0) || ac === bc) continue;
      const s = ac / (ac - bc);
      const hit = { x: a.x + s * (b.x - a.x), y: a.y + s * (b.y - a.y) };
      best = Math.max(best, along(hit));
    }
    out[side] = { x: d.x * best, y: d.y * best };
  }
  return out;
}

export const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** The snap point nearest `toward`: the side a line heading there should leave from. */
export function facingSide(anchors: Record<Side, Pt>, toward: Pt): Side {
  let best: Side = "top";
  let bestD = Infinity;
  for (const side of SIDES) {
    const d = dist(anchors[side], toward);
    if (d < bestD) {
      bestD = d;
      best = side;
    }
  }
  return best;
}

/** How far `p` is from the segment `a`–`b`. */
export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (!len2) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
}

/** `p` moved so the line from `from` runs at a multiple of 45°, keeping its length. */
export function snapAngle(from: Pt, p: Pt, step = Math.PI / 4): Pt {
  const len = dist(from, p);
  const a = Math.round(Math.atan2(p.y - from.y, p.x - from.x) / step) * step;
  return { x: from.x + Math.cos(a) * len, y: from.y + Math.sin(a) * len };
}
