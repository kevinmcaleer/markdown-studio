// Where a joint can catch on a model: the face under the pointer and the
// points on it worth snapping to, as in Snakie's Build workspace (its
// robot-holes.ts finds hole centres the same way).
//
// An STL is only triangles, so faces are found from them:
//
// - A flat face is the triangles joined to the one under the pointer that
//   lie in its plane. Its snaps are its middle, its corners, the middles of
//   its straight edges, and the centre of each round hole in it.
// - A curved face (the side of a peg, a screw's neck, the inside of a
//   hole) is the triangles joined smoothly to it. Its snaps are the centres
//   of the round rims at its ends, facing the way the part meets another
//   there: a screw's neck faces down its shank, a hole's rim faces out.
//
// No three.js here, so it can be tested. Units are the model's (mm).

export type V3 = [number, number, number];

export type SnapRole = "centre" | "corner" | "edge" | "hole" | "rim" | "pocket";

export interface Snap {
  p: V3;
  /** The way the face looks there; a joint puts the other part against it. */
  n: V3;
  role: SnapRole;
  /** A hole's or rim's radius. */
  radius?: number;
}

export interface Face {
  /** The face's triangles (indexes into the model's triangles). */
  tris: number[];
  curved: boolean;
  /** A flat face's normal, or the normal of the triangle first found. */
  normal: V3;
  snaps: Snap[];
}

/** Models with more triangles than this are picked without snaps. */
export const MAX_SNAP_TRIANGLES = 1_500_000;

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
};

/**
 * A model's triangles joined up: shared corners welded, and each triangle's
 * neighbour across each of its edges. Built once per model, on first use.
 */
export class Topology {
  readonly triangles: number;
  /** Each triangle's three welded corner ids. */
  readonly corner: Uint32Array;
  /** Welded corner positions. */
  readonly points: Float64Array;
  readonly normal: Float32Array;
  readonly area: Float32Array;
  /** The triangle across each edge (corner k to k+1), or -1. */
  readonly next: Int32Array;
  private faces = new Map<number, Face>();

  constructor(pos: ArrayLike<number>) {
    const n = Math.floor(pos.length / 9);
    this.triangles = n;
    this.corner = new Uint32Array(n * 3);
    this.normal = new Float32Array(n * 3);
    this.area = new Float32Array(n);
    this.next = new Int32Array(n * 3).fill(-1);
    // Weld corners to the nearest micrometre.
    const ids = new Map<string, number>();
    const pts: number[] = [];
    const q = 1000;
    for (let v = 0; v < n * 3; v++) {
      const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
      const key = `${Math.round(x * q)},${Math.round(y * q)},${Math.round(z * q)}`;
      let id = ids.get(key);
      if (id === undefined) {
        id = pts.length / 3;
        ids.set(key, id);
        pts.push(x, y, z);
      }
      this.corner[v] = id;
    }
    this.points = Float64Array.from(pts);
    const nv = pts.length / 3;
    const edges = new Map<number, number>();
    for (let t = 0; t < n; t++) {
      const a = this.point(this.corner[t * 3]), b = this.point(this.corner[t * 3 + 1]), c = this.point(this.corner[t * 3 + 2]);
      const cr = cross(sub(b, a), sub(c, a));
      const l = len(cr);
      this.area[t] = l / 2;
      const u = l > 1e-12 ? mul(cr, 1 / l) : ([0, 0, 0] as V3);
      this.normal.set(u, t * 3);
      // A triangle with no area (a fan's sliver at a cone's tip) joins
      // nothing; counting it would leave its neighbours unjoined.
      if (l < 1e-9) continue;
      for (let k = 0; k < 3; k++) {
        const i = this.corner[t * 3 + k], j = this.corner[t * 3 + ((k + 1) % 3)];
        if (i === j) continue;
        const key = Math.min(i, j) * nv + Math.max(i, j);
        const other = edges.get(key);
        if (other === undefined) edges.set(key, t * 3 + k);
        else if (other >= 0) {
          const ot = Math.floor(other / 3);
          if (ot !== t) {
            this.next[t * 3 + k] = ot;
            this.next[other] = t;
          }
          edges.set(key, -1); // a third triangle on the edge joins nothing
        }
      }
    }
  }

  point(id: number): V3 {
    return [this.points[id * 3], this.points[id * 3 + 1], this.points[id * 3 + 2]];
  }

  normalOf(t: number): V3 {
    return [this.normal[t * 3], this.normal[t * 3 + 1], this.normal[t * 3 + 2]];
  }

  /**
   * The face a joint was picked on, from the point and direction it kept: a
   * face with a snap there facing that way, else the flat face the point
   * lies on (or the face nearest it).
   */
  faceNear(point: V3, normal: V3): Face | null {
    const n = unit(normal);
    const dist = new Float64Array(this.triangles);
    const order: number[] = [];
    for (let t = 0; t < this.triangles; t++) {
      const c = mul(add(add(this.point(this.corner[t * 3]), this.point(this.corner[t * 3 + 1])), this.point(this.corner[t * 3 + 2])), 1 / 3);
      dist[t] = len(sub(c, point));
      order.push(t);
    }
    order.sort((a, b) => dist[a] - dist[b]);
    const near = order.slice(0, 400);
    for (const t of near) {
      const f = this.faceAt(t);
      if (f?.snaps.some(s => len(sub(s.p, point)) < 0.05 && dot(s.n, n) > 0.99)) return f;
    }
    for (const t of near) {
      if (this.area[t] <= 0 || dot(this.normalOf(t), n) < 0.99) continue;
      const a = this.point(this.corner[t * 3]);
      if (Math.abs(dot(sub(point, a), n)) < 0.05) return this.faceAt(t);
    }
    return near.length ? this.faceAt(near[0]) : null;
  }

  /** The face that triangle `t` belongs to, and its snaps. Kept for next time. */
  faceAt(t: number): Face | null {
    if (t < 0 || t >= this.triangles) return null;
    const done = this.faces.get(t);
    if (done) return done;
    const face = findFace(this, t);
    for (const i of face.tris) this.faces.set(i, face);
    return face;
  }
}

const FLAT_COS = Math.cos((1 * Math.PI) / 180);
const SMOOTH_COS = Math.cos((22 * Math.PI) / 180);

function grow(topo: Topology, seed: number, joins: (from: number, to: number) => boolean, limit = 400_000): number[] {
  const seen = new Set([seed]);
  const out = [seed];
  for (let i = 0; i < out.length && out.length < limit; i++) {
    const t = out[i];
    for (let k = 0; k < 3; k++) {
      const o = topo.next[t * 3 + k];
      if (o < 0 || seen.has(o) || !joins(t, o)) continue;
      seen.add(o);
      out.push(o);
    }
  }
  return out;
}

const areaOf = (topo: Topology, tris: number[]) => tris.reduce((s, t) => s + topo.area[t], 0);

/** Whether these flat triangles make a long thin strip, as one facet of a round surface does. */
function isStrip(topo: Topology, tris: number[], n: V3): boolean {
  // Two directions across the face's plane, to measure it in.
  let u: V3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  u = unit(sub(u, mul(n, dot(u, n))));
  const v = cross(n, u);
  let uLo = Infinity, uHi = -Infinity, vLo = Infinity, vHi = -Infinity;
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const p = topo.point(topo.corner[t * 3 + k]);
      const a = dot(p, u), b = dot(p, v);
      if (a < uLo) uLo = a;
      if (a > uHi) uHi = a;
      if (b < vLo) vLo = b;
      if (b > vHi) vHi = b;
    }
  }
  const w = uHi - uLo, h = vHi - vLo;
  const short = Math.min(w, h), long = Math.max(w, h);
  return long > 0 && short / long < 0.35;
}

function findFace(topo: Topology, seed: number): Face {
  const n0 = topo.normalOf(seed);
  const p0 = topo.point(topo.corner[seed * 3]);
  const d0 = dot(n0, p0);
  const flat = grow(topo, seed, (_, o) => {
    if (dot(topo.normalOf(o), n0) < FLAT_COS) return false;
    for (let k = 0; k < 3; k++) if (Math.abs(dot(n0, topo.point(topo.corner[o * 3 + k])) - d0) > 0.02) return false;
    return true;
  });
  const smooth = grow(topo, seed, (a, b) => dot(topo.normalOf(a), topo.normalOf(b)) > SMOOTH_COS);
  // A facet of a round surface is a thin flat strip of a bigger smooth one.
  // It has to be a strip: a shallow part (a small pad above sloping sides,
  // the bottom of a recess) grows a huge smooth region too, and reading
  // that as round left its face with nothing to click (Kev, 2026-11-04).
  const curved = smooth.length > flat.length && areaOf(topo, flat) < 0.15 * areaOf(topo, smooth) && isStrip(topo, flat, n0);
  let tris = curved ? smooth : flat;
  let snaps = curved ? curvedSnaps(topo, tris, seed) : flatSnaps(topo, tris, n0);
  // A round surface with no rim to speak of still offers its facet.
  if (!snaps.length && curved) {
    tris = flat;
    snaps = flatSnaps(topo, flat, n0);
  }
  return { tris, curved: curved && snaps.length > 0 && tris !== flat, normal: n0, snaps };
}

// ------------------------------------------------------------ edges of a face

interface Loop {
  ids: number[];
  /** For each edge (ids[i] to ids[i+1]), the triangle outside the face across it, or -1. */
  outside: number[];
  /** Whether it comes back to where it started (a real ring, not a broken run). */
  closed: boolean;
}

/**
 * The face's border, as runs of corner ids: closed loops where the border
 * is sound, and open runs where it isn't. The edges are followed whichever
 * way round they face, because a model whose triangles don't all wind the
 * same way (plenty of STLs, especially inside a recess) would otherwise
 * give no loop at all, and so no snaps on a face that looks perfectly fine.
 */
function borderLoops(topo: Topology, tris: number[]): Loop[] {
  const inFace = new Set(tris);
  interface Edge { a: number; b: number; out: number; used: boolean }
  const edges: Edge[] = [];
  const at = new Map<number, Edge[]>();
  const put = (v: number, e: Edge) => {
    let list = at.get(v);
    if (!list) at.set(v, (list = []));
    list.push(e);
  };
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const o = topo.next[t * 3 + k];
      if (o >= 0 && inFace.has(o)) continue;
      const a = topo.corner[t * 3 + k], b = topo.corner[t * 3 + ((k + 1) % 3)];
      if (a === b) continue;
      const e: Edge = { a, b, out: o, used: false };
      edges.push(e);
      put(a, e);
      put(b, e);
    }
  }
  /** The next unused edge at `v`, if any. */
  const stepFrom = (v: number): Edge | undefined => (at.get(v) || []).find(e => !e.used);
  const loops: Loop[] = [];
  for (const first of edges) {
    if (first.used) continue;
    // Start a run where the border ends (a corner with one edge), so an open
    // run comes out whole rather than split in two.
    let start = first.a;
    if ((at.get(first.b) || []).filter(e => !e.used).length === 1) start = first.b;
    const ids = [start];
    const outside: number[] = [];
    let cur = start;
    let closed = false;
    for (let guard = 0; guard < 1_000_000; guard++) {
      const e = stepFrom(cur);
      if (!e) break;
      e.used = true;
      outside.push(e.out);
      cur = e.a === cur ? e.b : e.a;
      if (cur === start) {
        closed = true;
        break;
      }
      ids.push(cur);
    }
    if (ids.length >= 3) loops.push({ ids, outside, closed });
  }
  return loops;
}

interface Ring {
  centre: V3;
  radius: number;
  round: boolean;
  /** The plane the loop lies in (Newell's method), any way round. */
  axis: V3;
  /** Length of the loop. */
  length: number;
}

function ringOf(topo: Topology, ids: number[]): Ring {
  const pts = ids.map(i => topo.point(i));
  let length = 0;
  let c: V3 = [0, 0, 0];
  let nw: V3 = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const l = len(sub(b, a));
    length += l;
    c = add(c, mul(add(a, b), l / 2));
    nw = add(nw, [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])]);
  }
  const centre = length > 0 ? mul(c, 1 / length) : pts[0];
  const radii = pts.map(p => len(sub(p, centre)));
  const radius = radii.reduce((s, r) => s + r, 0) / radii.length;
  const sd = Math.sqrt(radii.reduce((s, r) => s + (r - radius) ** 2, 0) / radii.length);
  // Round: every corner the same way from the middle, enough of them, and
  // the loop about as long as that circle (not a square, whose corners are equal too).
  const round = pts.length >= 8 && radius > 0 && sd / radius < 0.08 && Math.abs(length / (2 * Math.PI * radius) - 1) < 0.08;
  return { centre, radius, round, axis: unit(nw), length };
}

// ------------------------------------------------------------ flat faces

function flatSnaps(topo: Topology, tris: number[], n: V3): Snap[] {
  const loops = borderLoops(topo, tris);
  // Whatever its border turns out like, the face always offers its middle.
  const snaps: Snap[] = [{ p: areaCentre(topo, tris), n, role: "centre" }];
  if (!loops.length) return snaps;
  const rings = loops.map(l => ringOf(topo, l.ids));
  // The outer border is the longest; a broken run only stands in for it when
  // nothing closed, since an unclosed run says nothing about what's a hole.
  let outer = -1;
  loops.forEach((l, i) => {
    if (!l.closed) return;
    if (outer < 0 || rings[i].length > rings[outer].length) outer = i;
  });
  const sound = outer >= 0;
  if (!sound) loops.forEach((_, i) => (outer = outer < 0 || rings[i].length > rings[outer].length ? i : outer));
  const o = rings[outer];
  if (sound && o.round) {
    snaps[0] = { p: o.centre, n, role: "centre", radius: o.radius };
  } else {
    const pts = loops[outer].ids.map(i => topo.point(i));
    const { corners, mids } = straightRuns(pts, o.length);
    corners.forEach(p => snaps.push({ p, n, role: "corner" }));
    mids.forEach(p => snaps.push({ p, n, role: "edge" }));
  }
  if (sound) {
    rings.forEach((r, i) => {
      if (i === outer || !loops[i].closed) return;
      snaps.push(r.round ? { p: r.centre, n, role: "hole", radius: r.radius } : { p: r.centre, n, role: "pocket" });
    });
  }
  return dedupe(snaps);
}

function areaCentre(topo: Topology, tris: number[]): V3 {
  let c: V3 = [0, 0, 0];
  let total = 0;
  for (const t of tris) {
    const a = topo.area[t];
    const m = mul(add(add(topo.point(topo.corner[t * 3]), topo.point(topo.corner[t * 3 + 1])), topo.point(topo.corner[t * 3 + 2])), 1 / 3);
    c = add(c, mul(m, a));
    total += a;
  }
  return total > 0 ? mul(c, 1 / total) : topo.point(topo.corner[tris[0] * 3]);
}

/**
 * The straight stretches of a border: their ends are corners and their
 * middles edge snaps. A stretch keeps going while the border stays within a
 * few degrees of its first direction; short ones (a rounded corner's facets)
 * don't count.
 */
function straightRuns(pts: V3[], perimeter: number): { corners: V3[]; mids: V3[] } {
  const n = pts.length;
  const dir = (i: number) => unit(sub(pts[(i + 1) % n], pts[i]));
  const straight = Math.cos((6 * Math.PI) / 180);
  // Start at a turn, so no stretch is split across the loop's start.
  let start = 0;
  let sharpest = 1;
  for (let i = 0; i < n; i++) {
    const c = dot(dir((i - 1 + n) % n), dir(i));
    if (c < sharpest) {
      sharpest = c;
      start = i;
    }
  }
  const runs: { a: V3; b: V3 }[] = [];
  let i = 0;
  while (i < n) {
    const first = (start + i) % n;
    const d = dir(first);
    let j = i + 1;
    while (j < n && dot(dir((start + j) % n), d) > straight) j++;
    runs.push({ a: pts[first], b: pts[(start + j) % n] });
    i = j;
  }
  const min = Math.max(perimeter * 0.04, 1e-6);
  const corners: V3[] = [];
  const mids: V3[] = [];
  for (const r of runs) {
    if (len(sub(r.b, r.a)) < min) continue;
    corners.push(r.a, r.b);
    mids.push(mul(add(r.a, r.b), 0.5));
  }
  return { corners, mids };
}

// ------------------------------------------------------------ curved faces

function curvedSnaps(topo: Topology, tris: number[], seed: number): Snap[] {
  const snaps: Snap[] = [];
  const hit = areaCentre(topo, [seed]);
  for (const loop of borderLoops(topo, tris)) {
    if (!loop.closed) continue;
    const r = ringOf(topo, loop.ids);
    if (!r.round) continue;
    // Face the way the surface beyond the rim faces: a screw head's underside
    // faces down the shank, the top round a hole faces out of it.
    let beyond: V3 = [0, 0, 0];
    loop.outside.forEach(t => {
      if (t >= 0) beyond = add(beyond, mul(topo.normalOf(t), topo.area[t]));
    });
    let s = dot(unit(beyond), r.axis);
    if (Math.abs(s) < 0.2) {
      // Nothing clear beyond (an open edge): face away from the surface,
      // so a peg's end faces off the peg and a hole's rim out of the hole.
      s = -(Math.sign(dot(sub(hit, r.centre), r.axis)) || 1);
    }
    snaps.push({ p: r.centre, n: mul(r.axis, Math.sign(s) || 1), role: "rim", radius: r.radius });
  }
  return dedupe(snaps);
}

function dedupe(snaps: Snap[]): Snap[] {
  const out: Snap[] = [];
  for (const s of snaps) if (!out.some(o => o.role === s.role && len(sub(o.p, s.p)) < 1e-3)) out.push(s);
  return out;
}

/** The snap nearest the pointer, in screen pixels, within its catch radius. */
export function nearestSnap(screen: { x: number; y: number }[], snaps: Snap[], at: { x: number; y: number }, catchPx = 22, holePx = 40): number {
  let best = -1;
  let bestD = Infinity;
  screen.forEach((p, i) => {
    const d = Math.hypot(p.x - at.x, p.y - at.y);
    const lim = snaps[i].role === "hole" || snaps[i].role === "rim" ? holePx : catchPx;
    if (d <= lim && d < bestD) {
      best = i;
      bestD = d;
    }
  });
  return best;
}
