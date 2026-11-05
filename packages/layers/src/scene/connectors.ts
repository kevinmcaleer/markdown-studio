// Connector housings for the ends of wires: the plug a lead ends in, as a
// model (Kev, 2026-11-05: real connector models, not a box). Each family is
// drawn from its datasheet's nominal sizes, with the pin cavities in its
// mating face, the wire entries in its back and its latch, so it reads as the
// part in a line drawing. The same models are in Snakie Standard's catalog
// (examples/parts/snakie-standard/<id>/), made by scripts/connector-stls.ts.
//
// A model is made here as triangles, centred as a part's model is (the middle
// of its box at 0, 0, 0), with the middle of its mating face (where it meets
// the socket, facing into it) and where its wire comes out of the back.
// No three.js here, so it can be tested and run in Node.

import type { Vec3 } from "./model";

export interface ConnectorFamily {
  id: string;
  label: string;
  detail: string;
  pitch: number;
  ways: number[];
  /** Mm: across the pins (for `n` ways), its height, and front to back. */
  size: (n: number) => [number, number, number];
}

const s = (n: number, pitch: number, extra: number) => (n - 1) * pitch + extra;

export const CONNECTOR_FAMILIES: ConnectorFamily[] = [
  { id: "molex-5264", label: "Molex Mini-SPOX 5264", detail: "2.5 mm pitch; the lead on Feetech STS3215 bus servos", pitch: 2.5, ways: [2, 3, 4, 5, 6], size: n => [s(n, 2.5, 4.9), 4.6, 10] },
  { id: "jst-xh", label: "JST XH", detail: "2.5 mm pitch; balance leads, many hobby boards", pitch: 2.5, ways: [2, 3, 4, 5, 6, 7, 8], size: n => [s(n, 2.5, 4.9), 5.75, 9.8] },
  { id: "jst-ph", label: "JST PH", detail: "2 mm pitch; small LiPo cells, sensors", pitch: 2, ways: [2, 3, 4, 5, 6], size: n => [s(n, 2, 3.9), 4.5, 6] },
  { id: "jst-sh", label: "JST SH (Qwiic, STEMMA QT)", detail: "1 mm pitch; I²C sensor leads", pitch: 1, ways: [2, 3, 4, 5, 6], size: n => [s(n, 1, 3), 2.9, 4.25] },
  { id: "dupont", label: "Dupont", detail: "2.54 mm pitch; jumper wires onto header pins", pitch: 2.54, ways: [1, 2, 3, 4, 5, 6, 8, 10], size: n => [n * 2.54, 2.54, 14] },
];

/** The connector a new socket gets: the STS3215 servo lead's. */
export const DEFAULT_CONNECTOR = "molex-5264-3";

export interface Connector {
  id: string;
  family: ConnectorFamily;
  ways: number;
  /** "Molex Mini-SPOX 5264, 3 way". */
  name: string;
}

/** The connector an id names ("jst-xh-4"), or null. */
export function connectorOf(id: string): Connector | null {
  const m = /^(.+)-(\d+)$/.exec(id || "");
  if (!m) return null;
  const family = CONNECTOR_FAMILIES.find(f => f.id === m[1]);
  const ways = Number(m[2]);
  if (!family || !family.ways.includes(ways)) return null;
  return { id, family, ways, name: `${family.label}, ${ways} way` };
}

/** Every connector, for a menu. */
export function allConnectors(): Connector[] {
  return CONNECTOR_FAMILIES.flatMap(f => f.ways.map(n => connectorOf(`${f.id}-${n}`)!));
}

/** The file its model is given: "molex-5264-3.stl". */
export const connectorFile = (id: string) => `${id}.stl`;

export interface ConnectorMesh {
  positions: Float32Array;
  /** The middle of the mating face, and the way it faces (into the socket). */
  contact: Vec3;
  normal: Vec3;
  /** Where the wire leaves the back, and the way it goes. */
  exit: Vec3;
  exitNormal: Vec3;
  size: Vec3;
}

// ------------------------------------------------------------ building triangles

type V = Vec3;
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const at = (o: V, u: V, a: number, v: V, b: number, n: V = [0, 0, 0], c = 0): V => [
  o[0] + u[0] * a + v[0] * b + n[0] * c,
  o[1] + u[1] * a + v[1] * b + n[1] * c,
  o[2] + u[2] * a + v[2] * b + n[2] * c,
];

class Tris {
  out: number[] = [];
  /** A flat four-cornered face, wound to face `want`. */
  quad(a: V, b: V, c: V, d: V, want: V): void {
    const flip = dot(cross(sub(b, a), sub(c, a)), want) < 0;
    const t = flip ? [a, d, c, b] : [a, b, c, d];
    this.out.push(...t[0], ...t[1], ...t[2], ...t[0], ...t[2], ...t[3]);
  }
  tri(a: V, b: V, c: V, want: V): void {
    const flip = dot(cross(sub(b, a), sub(c, a)), want) < 0;
    this.out.push(...a, ...(flip ? c : b), ...(flip ? b : c));
  }
  /**
   * A rectangle from `o`, `w` along `u` and `h` along `v`, facing `n`, with
   * rectangular recesses `[a0, b0, a1, b1, depth]` sunk into it.
   */
  face(o: V, u: V, v: V, n: V, w: number, h: number, pockets: [number, number, number, number, number][] = []): void {
    const as = [...new Set([0, w, ...pockets.flatMap(p => [p[0], p[2]])])].sort((x, y) => x - y);
    const bs = [...new Set([0, h, ...pockets.flatMap(p => [p[1], p[3]])])].sort((x, y) => x - y);
    for (let i = 0; i + 1 < as.length; i++) {
      for (let j = 0; j + 1 < bs.length; j++) {
        const ca = (as[i] + as[i + 1]) / 2, cb = (bs[j] + bs[j + 1]) / 2;
        if (pockets.some(p => ca > p[0] && ca < p[2] && cb > p[1] && cb < p[3])) continue;
        this.quad(at(o, u, as[i], v, bs[j]), at(o, u, as[i + 1], v, bs[j]), at(o, u, as[i + 1], v, bs[j + 1]), at(o, u, as[i], v, bs[j + 1]), n);
      }
    }
    const neg = (x: V): V => [-x[0], -x[1], -x[2]];
    for (const [a0, b0, a1, b1, d] of pockets) {
      const P = (a: number, b: number, c: number) => at(o, u, a, v, b, n, c);
      // The walls face into the recess; its floor faces out.
      this.quad(P(a0, b0, 0), P(a0, b1, 0), P(a0, b1, -d), P(a0, b0, -d), u);
      this.quad(P(a1, b0, 0), P(a1, b1, 0), P(a1, b1, -d), P(a1, b0, -d), neg(u));
      this.quad(P(a0, b0, 0), P(a1, b0, 0), P(a1, b0, -d), P(a0, b0, -d), v);
      this.quad(P(a0, b1, 0), P(a1, b1, 0), P(a1, b1, -d), P(a0, b1, -d), neg(v));
      this.quad(P(a0, b0, -d), P(a1, b0, -d), P(a1, b1, -d), P(a0, b1, -d), n);
    }
  }
  /** A box from `min` to `max`; `pockets` by side ("-z", "+z", "+y"…). */
  box(min: V, max: V, pockets: Partial<Record<"-x" | "+x" | "-y" | "+y" | "-z" | "+z", [number, number, number, number, number][]>> = {}): void {
    const [x0, y0, z0] = min, [x1, y1, z1] = max;
    const X: V = [1, 0, 0], Y: V = [0, 1, 0], Z: V = [0, 0, 1];
    // Each side's own u and v run from its corner, so pockets are in the side's terms: u across, v up.
    this.face([x0, y0, z0], X, Y, [0, 0, -1], x1 - x0, y1 - y0, pockets["-z"]);
    this.face([x0, y0, z1], X, Y, Z, x1 - x0, y1 - y0, pockets["+z"]);
    this.face([x0, y0, z0], Z, Y, [-1, 0, 0], z1 - z0, y1 - y0, pockets["-x"]);
    this.face([x1, y0, z0], Z, Y, X, z1 - z0, y1 - y0, pockets["+x"]);
    this.face([x0, y0, z0], X, Z, [0, -1, 0], x1 - x0, z1 - z0, pockets["-y"]);
    this.face([x0, y1, z0], X, Z, Y, x1 - x0, z1 - z0, pockets["+y"]);
  }
  /** A ramp (a latch): `w` wide across X, rising from `y` at `z0` to `y + rise` at `z1`, then dropping straight down. */
  ramp(x: number, w: number, y: number, z0: number, z1: number, rise: number): void {
    const xa = x - w / 2, xb = x + w / 2;
    const A: V = [xa, y, z0], B: V = [xb, y, z0], C: V = [xb, y, z1], D: V = [xa, y, z1], E: V = [xa, y + rise, z1], F: V = [xb, y + rise, z1];
    this.quad(A, B, F, E, [0, 1, -(rise / (z1 - z0))]);
    this.quad(D, C, F, E, [0, 0, 1]);
    this.tri(A, D, E, [-1, 0, 0]);
    this.tri(B, C, F, [1, 0, 0]);
    this.quad(A, B, C, D, [0, -1, 0]);
  }
}

/**
 * A connector's model. In its own terms the pins run across X, its latch is
 * on top (+Y), its mating face is at z = 0 facing -Z and its back at z = L.
 */
export function connectorMesh(id: string): ConnectorMesh {
  const c = connectorOf(id) || connectorOf(DEFAULT_CONNECTOR)!;
  const n = c.ways;
  const p = c.family.pitch;
  const [W, H, L] = c.family.size(n);
  const t = new Tris();
  const pins = Array.from({ length: n }, (_, i) => W / 2 + (i - (n - 1) / 2) * p);
  const pinY = H * 0.45;
  // Square cavities in the front for the header's pins, entries in the back for the wires.
  const cav = (size: number, depth: number, y = pinY): [number, number, number, number, number][] => pins.map(x => [x - size / 2, y - size / 2, x + size / 2, y + size / 2, depth]);
  const back = (size: number, depth: number, y = pinY): [number, number, number, number, number][] => pins.map(x => [W - x - size / 2, y - size / 2, W - x + size / 2, y + size / 2, depth]);
  switch (c.family.id) {
    case "molex-5264":
      t.box([0, 0, 0], [W, H, L], { "-z": cav(1.6, 3), "+z": back(1.7, 3) });
      // The locking ramp on top, and the polarising ribs down each side.
      t.ramp(W / 2, Math.min(3.2, W - 1.5), H, 1.2, 4.2, 0.9);
      t.box([-0.5, 0.6, 1], [0, H - 0.8, L - 1]);
      t.box([W, 0.6, 1], [W + 0.5, H - 0.8, L - 1]);
      break;
    case "jst-xh":
      t.box([0, 0, 0], [W, H, L], { "-z": cav(1.5, 3), "+z": back(1.6, 3), "+y": pins.map(x => [x - 0.6, 3.2, x + 0.6, 5.4, 0.5] as [number, number, number, number, number]) });
      // The friction lock: a raised lip along the top's front.
      t.box([0.8, H, 0], [W - 0.8, H + 0.7, 2.2]);
      break;
    case "jst-ph":
      t.box([0, 0, 0], [W, H, L], { "-z": cav(1.1, 2), "+z": back(1.2, 2) });
      t.ramp(W / 2, Math.min(2.4, W - 1.2), H, 0.6, 2.8, 0.6);
      break;
    case "jst-sh":
      t.box([0, 0, 0], [W, H, L], { "-z": cav(0.6, 1.5), "+z": back(0.7, 1.5) });
      t.ramp(W / 2, Math.min(1.6, W - 0.8), H, 0.3, 1.6, 0.35);
      break;
    default:
      // Dupont: one 2.54 mm square cell per pin, each with its latch window on top.
      t.box([0, 0, 0], [W, H, L], {
        "-z": cav(1, 4, H / 2),
        "+z": back(1.3, 4, H / 2),
        "+y": pins.map(x => [x - 0.55, 3, x + 0.55, 4.8, 0.4] as [number, number, number, number, number]),
      });
  }
  const pos = new Float32Array(t.out);
  // Centred on the middle of its box, as a part's model is.
  const min: V = [Infinity, Infinity, Infinity], max: V = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], pos[i + k]);
    max[k] = Math.max(max[k], pos[i + k]);
  }
  const mid = min.map((m, k) => (m + max[k]) / 2) as V;
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) pos[i + k] -= mid[k];
  const r = (v: V) => v.map(x => Math.round(x * 1e4) / 1e4 + 0) as Vec3;
  const pinMid = c.family.id === "dupont" ? H / 2 : pinY;
  return {
    positions: pos,
    contact: r([W / 2 - mid[0], pinMid - mid[1], 0 - mid[2]]),
    normal: [0, 0, -1],
    exit: r([W / 2 - mid[0], pinMid - mid[1], L - mid[2]]),
    exitNormal: [0, 0, 1],
    size: r(sub(max, min)),
  };
}

/** How far a plug stands out of its socket in an exploded view, mm. */
export function plugLift(id: string): number {
  const c = connectorOf(id) || connectorOf(DEFAULT_CONNECTOR)!;
  return Math.max(6, c.family.size(c.ways)[2] * 1.2);
}
