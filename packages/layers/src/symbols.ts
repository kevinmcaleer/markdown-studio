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

// ---------------------------------------------------------------- building blocks
// The symbols below are unions of simple pieces. Every piece is wound
// clockwise, so where two overlap the non-zero fill still fills them once,
// and only the rings passed as `holes` cut anything out.

/** A rounded rectangle (a bubble with no tail). */
export const rrect = (x: number, y: number, w: number, h: number, r: number): XY[] => bubble(x, y, w, h, Math.min(r, w / 2, h / 2));

/** A thick line from `a` to `b` with round ends, `w` wide. */
export function bar(a: XY, b: XY, w: number): XY[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
  // The cap round `b`, then the cap round `a`; the straight sides close them.
  return [...arc(b.x, b.y, w / 2, ang - 90, ang + 90, 8), ...arc(a.x, a.y, w / 2, ang + 90, ang + 270, 8)];
}

/** A regular polygon with `n` sides, `r` to the corners, a corner at the top. */
export function regular(cx: number, cy: number, r: number, n: number): XY[] {
  return Array.from({ length: n }, (_, i) => at(cx, cy, r, rad(-90 + (360 * i) / n)));
}

// ---------------------------------------------------------------- figures

/**
 * The kevsrobots assembly figure: a friendly robot, about 200 × 300. With
 * `lift`, its arms reach up to carry something at shoulder height.
 */
export function robot(ox: number, oy: number, lift = false): { fill: XY[][]; holes: XY[][] } {
  const X = (x: number) => x + ox;
  const Y = (y: number) => y + oy;
  const fill: XY[][] = [
    circle(X(100), Y(10), 9), // antenna ball
    rect(X(95), Y(10), 10, 20),
    rrect(X(55), Y(30), 90, 80, 22), // head
    rect(X(90), Y(108), 20, 14), // neck
    rrect(X(45), Y(120), 110, 110, 18), // body
    rect(X(68), Y(228), 22, 50), // legs
    rect(X(110), Y(228), 22, 50),
    rrect(X(56), Y(274), 46, 22, 8), // feet
    rrect(X(98), Y(274), 46, 22, 8),
    circle(X(100), Y(175), 7), // the chest light, lit inside its ring
  ];
  if (lift) {
    fill.push(bar({ x: X(50), y: Y(140) }, { x: X(16), y: Y(-14) }, 22), bar({ x: X(150), y: Y(140) }, { x: X(184), y: Y(-14) }, 22));
  } else {
    fill.push(bar({ x: X(48), y: Y(136) }, { x: X(30), y: Y(210) }, 22), bar({ x: X(152), y: Y(136) }, { x: X(170), y: Y(210) }, 22));
  }
  const holes: XY[][] = [
    circle(X(82), Y(62), 10), // eyes
    circle(X(118), Y(62), 10),
    rrect(X(80), Y(84), 40, 9, 4.5), // smile
    circle(X(100), Y(175), 15), // chest light ring
  ];
  return { fill, holes };
}

/** The assembly figure on its own, 200 × 300. */
export const FIGURE = (() => {
  const r = robot(0, 0);
  return pathOf(r.fill, r.holes);
})();

/** Two figures carrying a long part over their heads: "this takes two people", about 460 × 330. */
export const TWO_PEOPLE = (() => {
  const a = robot(0, 30, true);
  const b = robot(260, 30, true);
  const plate = rrect(4, 0, 452, 24, 6);
  return pathOf([...a.fill, ...b.fill, plate], [...a.holes, ...b.holes]);
})();

/** A warning triangle with an exclamation mark cut out of it: "careful here", 200 × 180. */
export const CAREFUL = (() => {
  const tri: XY[] = [
    ...arc(100, 22, 16, 210, 330, 6),
    ...arc(182, 164, 16, -30, 90, 6),
    ...arc(18, 164, 16, 90, 210, 6),
  ];
  return pathOf([tri], [rrect(89, 58, 22, 64, 11), circle(100, 146, 13)]);
})();

/** A pointing hand (a manicule), pointing right, about 220 × 160. */
export const POINTING_HAND = (() => {
  const cuff = rect(0, 60, 42, 96);
  const palm = rrect(34, 50, 104, 106, 34);
  const finger = rrect(100, 30, 120, 34, 17);
  const fingers = [rrect(112, 72, 50, 28, 14), rrect(112, 104, 50, 28, 14), rrect(112, 134, 46, 24, 12)];
  const thumb = bar({ x: 76, y: 66 }, { x: 118, y: 14 }, 26);
  return pathOf([cuff, palm, finger, ...fingers, thumb], [rect(10, 70, 6, 76)]);
})();

// ---------------------------------------------------------------- tools

/** A screwdriver, lying flat, about 200 × 44. */
export const SCREWDRIVER = (() => {
  const handle = rrect(0, 0, 84, 44, 16);
  const shaft = rect(80, 16, 92, 12);
  const tip: XY[] = [{ x: 170, y: 13 }, { x: 200, y: 19 }, { x: 200, y: 25 }, { x: 170, y: 31 }];
  const grooves = [rect(16, 8, 6, 28), rect(32, 8, 6, 28), rect(48, 8, 6, 28)];
  return pathOf([handle, shaft, tip], grooves);
})();

/** An Allen (hex) key, about 70 × 130. */
export const ALLEN_KEY = pathOf([[
  { x: 0, y: 5 }, { x: 12, y: 0 }, { x: 24, y: 5 }, { x: 24, y: 106 }, { x: 65, y: 106 }, { x: 70, y: 118 }, { x: 65, y: 130 }, { x: 0, y: 130 },
]]);

/** Pliers, jaws up, about 200 × 200. */
export const PLIERS = (() => {
  const pivot = { x: 100, y: 84 };
  return pathOf([
    bar(pivot, { x: 92, y: 8 }, 16),
    bar(pivot, { x: 108, y: 8 }, 16),
    bar(pivot, { x: 64, y: 196 }, 16),
    bar(pivot, { x: 136, y: 196 }, 16),
    bar({ x: 84, y: 134 }, { x: 64, y: 196 }, 26),
    bar({ x: 116, y: 134 }, { x: 136, y: 196 }, 26),
    circle(pivot.x, pivot.y, 14),
  ], [circle(pivot.x, pivot.y, 5)]);
})();

/** A soldering iron with its cable, about 240 × 70. */
export const SOLDERING_IRON = (() => {
  const handle = rrect(40, 14, 90, 36, 14);
  const collar = rect(126, 18, 18, 28);
  const barrel = rect(142, 25, 56, 14);
  const tip: XY[] = [{ x: 196, y: 24 }, { x: 240, y: 32 }, { x: 196, y: 40 }];
  const cable = arcBand(40, 46, 20, 90, 270, 6);
  const plug = rrect(28, 52, 28, 14, 5);
  return pathOf([handle, collar, barrel, tip, cable, plug], [rect(150, 29, 8, 6), rect(164, 29, 8, 6), rect(178, 29, 8, 6)]);
})();

/** A hot glue gun with a glue stick in the back, about 210 × 160. */
export const GLUE_GUN = (() => {
  const body = rrect(24, 20, 136, 52, 14);
  const nozzle: XY[] = [{ x: 158, y: 36 }, { x: 196, y: 42 }, { x: 196, y: 50 }, { x: 158, y: 56 }];
  const nozzleTip = rect(194, 41, 14, 10);
  const grip = bar({ x: 70, y: 72 }, { x: 54, y: 146 }, 36);
  const trigger = bar({ x: 104, y: 72 }, { x: 110, y: 112 }, 12);
  const stick = rrect(0, 37, 34, 18, 5);
  return pathOf([body, nozzle, nozzleTip, grip, trigger, stick]);
})();

/** A hammer, about 100 × 180. */
export const HAMMER = (() => {
  const head = rrect(0, 0, 100, 38, 8);
  const handle = bar({ x: 50, y: 30 }, { x: 50, y: 170 }, 20);
  return pathOf([head, handle]);
})();

/** A 3D printer: a frame, a hot end and a part on the bed, about 200 × 180. */
export const PRINTER_3D = (() => {
  const frame = rrect(0, 0, 200, 180, 10);
  const inside = rrect(12, 12, 176, 156, 4);
  const gantry = rect(12, 30, 176, 12);
  const carriage = rrect(84, 38, 32, 24, 4);
  const nozzle: XY[] = [{ x: 92, y: 62 }, { x: 108, y: 62 }, { x: 100, y: 76 }];
  const bed = rect(12, 150, 176, 10);
  const part = rrect(80, 110, 40, 40, 4);
  return pathOf([frame, gantry, carriage, nozzle, bed, part], [inside]);
})();

/** A screw from the side, with its thread, about 60 × 210. */
export const SCREW = (() => {
  const head: XY[] = [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 44, y: 24 }, { x: 16, y: 24 }];
  const shaft = rect(21, 22, 18, 168);
  const teeth: XY[][] = [];
  for (let y = 34; y < 180; y += 18) {
    teeth.push([{ x: 21, y }, { x: 21, y: y + 14 }, { x: 13, y: y + 7 }]);
    teeth.push([{ x: 39, y: y + 9 }, { x: 47, y: y + 16 }, { x: 39, y: y + 23 }]);
  }
  const tip: XY[] = [{ x: 21, y: 188 }, { x: 39, y: 188 }, { x: 30, y: 210 }];
  return pathOf([head, shaft, ...teeth, tip], [rect(24, 4, 12, 8)]);
})();

/** A hex nut, face on, 100 × 100. */
export const NUT = pathOf([regular(50, 50, 50, 6)], [circle(50, 50, 22)]);
