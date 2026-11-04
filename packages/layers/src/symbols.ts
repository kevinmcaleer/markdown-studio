// Assembly-instruction symbols in the style of flat-pack furniture sheets:
// a bold hand-drawn tick and cross, solid curved and turning arrows, a "no"
// sign and a help bubble. Each is one filled outline, so it recolours with
// the shape's Colour and scales cleanly.

export interface XY {
  x: number;
  y: number;
}

/** A bold, hand-drawn tick, in a 100 × 100 box. */
export const TICK =
  "M 2 54 C 8 46 17 44 23 49 C 28 54 33 61 38 68 C 51 43 68 19 91 2 C 96 -1 101 4 98 9 " +
  "C 79 33 63 62 51 93 C 47 101 36 101 31 94 C 23 81 13 70 4 64 C 0 61 0 57 2 54 Z";

/** A bold, hand-drawn cross: two brush strokes, in a 100 × 100 box. */
export const CROSS =
  "M 3 15 C 0 6 9 0 17 5 C 42 27 68 52 96 80 C 102 88 92 100 83 94 C 55 68 29 44 3 15 Z " +
  "M 85 3 C 93 -2 102 6 97 14 C 74 39 48 67 20 96 C 12 103 0 94 6 85 C 33 58 58 30 85 3 Z";

/** Twice the area of a ring, signed: positive when it goes clockwise on the page (y down). */
export function area2(ring: XY[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s;
}

const turn = (ring: XY[], clockwise: boolean): XY[] => (area2(ring) > 0 === clockwise ? ring : [...ring].reverse());

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * An SVG path of filled rings and holes. Rings are wound clockwise and holes
 * the other way, so the default (non-zero) fill cuts the holes out and fills
 * anything drawn inside a hole again.
 */
export function pathOf(fill: XY[][], holes: XY[][] = []): string {
  const ring = (r: XY[]) => `M ${r.map(p => `${r1(p.x)} ${r1(p.y)}`).join(" L ")} Z`;
  return [...fill.map(r => ring(turn(r, true))), ...holes.map(r => ring(turn(r, false)))].join(" ");
}

const at = (cx: number, cy: number, r: number, a: number): XY => ({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Points along an arc from `a0` to `a1` degrees (0 = right, 90 = down). */
function arc(cx: number, cy: number, r: number, a0: number, a1: number, steps?: number): XY[] {
  const n = steps ?? Math.max(4, Math.ceil(Math.abs(a1 - a0) / 6));
  return Array.from({ length: n + 1 }, (_, i) => at(cx, cy, r, rad(a0 + ((a1 - a0) * i) / n)));
}

/** A thick band along an arc, `w` wide. */
export function arcBand(cx: number, cy: number, r: number, a0: number, a1: number, w: number): XY[] {
  return [...arc(cx, cy, r + w / 2, a0, a1), ...arc(cx, cy, r - w / 2, a1, a0)];
}

/**
 * A solid arrow bent round an arc: a `w`-wide shaft from `a0` to `a1` degrees
 * and a filled head, `head` long and `headW` wide, that ends at `a1`.
 */
export function arcArrow(cx: number, cy: number, r: number, a0: number, a1: number, w: number, head: number, headW: number): XY[] {
  const dir = Math.sign(a1 - a0) || 1;
  const headDeg = (head / r) * (180 / Math.PI);
  const neck = a1 - dir * headDeg;
  const tip = at(cx, cy, r, rad(a1));
  return [
    ...arc(cx, cy, r + w / 2, a0, neck),
    at(cx, cy, r + headW / 2, rad(neck)),
    tip,
    at(cx, cy, r - headW / 2, rad(neck)),
    ...arc(cx, cy, r - w / 2, neck, a0),
  ];
}

export function circle(cx: number, cy: number, r: number): XY[] {
  return arc(cx, cy, r, 0, 360, 48).slice(0, -1);
}

/** A rounded rectangle, with a tail from the bottom edge (a speech bubble) when `tail` is given. */
export function bubble(x: number, y: number, w: number, h: number, r: number, tail?: { from: number; to: number; tip: XY }): XY[] {
  const pts: XY[] = [
    ...arc(x + w - r, y + r, r, -90, 0, 6),
    ...arc(x + w - r, y + h - r, r, 0, 90, 6),
  ];
  if (tail) pts.push({ x: x + tail.to, y: y + h }, tail.tip, { x: x + tail.from, y: y + h });
  pts.push(...arc(x + r, y + h - r, r, 90, 180, 6), ...arc(x + r, y + r, r, 180, 270, 6));
  return pts;
}

const rect = (x: number, y: number, w: number, h: number): XY[] => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
];

/** A solid arrow curving up and to the right, about 200 × 140. */
export const CURVED_SOLID = pathOf([arcArrow(200, 260, 200, 205, 268, 26, 54, 74)]);

/** A solid arrow going three quarters of the way round, for "turn it", about 200 × 200. */
export const ROTATE = pathOf([arcArrow(100, 100, 80, 120, 390, 24, 50, 70)]);

/** A "don't" sign: a ring with a slash across it, 200 × 200. */
export const NO_SIGN = (() => {
  const c = 100;
  const a = rad(45);
  const d = { x: Math.cos(a), y: Math.sin(a) };
  const n = { x: -d.y, y: d.x };
  const len = 76;
  const w = 11;
  const slash: XY[] = [
    { x: c - d.x * len + n.x * w, y: c - d.y * len + n.y * w },
    { x: c + d.x * len + n.x * w, y: c + d.y * len + n.y * w },
    { x: c + d.x * len - n.x * w, y: c + d.y * len - n.y * w },
    { x: c - d.x * len - n.x * w, y: c - d.y * len - n.y * w },
  ];
  return pathOf([circle(c, c, 98), slash], [circle(c, c, 76)]);
})();

/** A speech bubble outline with a question mark in it: "ask for help", about 240 × 230. */
export const HELP = (() => {
  const outer = bubble(0, 0, 240, 190, 36, { from: 46, to: 92, tip: { x: 30, y: 232 } });
  // The same bubble 14 in from the outside, tail and all.
  const inner = bubble(14, 14, 212, 162, 22, { from: 52.7, to: 73.8, tip: { x: 59, y: 194 } });
  // The question mark: a hook, a stem and a dot.
  const hook = arcBand(120, 74, 30, 200, 450, 20);
  const stem = rect(110, 94, 20, 26);
  const dot = circle(120, 142, 12);
  return pathOf([outer, hook, stem, dot], [inner]);
})();
