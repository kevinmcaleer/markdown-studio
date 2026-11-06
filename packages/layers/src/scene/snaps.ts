// Where a joint can catch on a model: the face under the pointer and the
// points on it worth snapping to, as in Snakie's Build workspace (its
// robot-holes.ts finds hole centres the same way).
//
// A model from a STEP file knows its CAD faces, so a face is exactly the
// triangles of the CAD face under the pointer. An STL is only triangles,
// so its faces are found from them:
//
// - A flat face is the triangles joined to the one under the pointer that
//   lie in its plane. Its snaps are its middle, its corners, the middles of
//   its straight edges, and the centre of each round hole in it.
// - A curved face (the side of a peg, a screw's neck, the inside of a
//   hole) is the triangles joined smoothly to it. Its snaps are the centres
//   of the round rims at its ends, facing the way the part meets another
//   there: a screw's neck faces down its shank, a hole's rim faces out.
// - The side of a pin or peg (a thin square or round post) also offers the
//   pin's base, on its axis where it comes out of the board or body it
//   stands in, and its tip. Both face the way the pin points, so a shield's
//   pin base sits on the top of the header it plugs into.
//
// No three.js here, so it can be tested. Units are the model's (mm).

export type V3 = [number, number, number];

export type SnapRole = "centre" | "corner" | "edge" | "hole" | "rim" | "pocket" | "pin" | "tip";

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
  /** Each triangle's CAD face (0xffff: not known), for a model from a STEP file. */
  readonly cadFace: Uint16Array | null;
  private cadTris: Map<number, number[]> | null = null;

  constructor(pos: ArrayLike<number>, cadFaces?: Uint16Array | null) {
    const n = Math.floor(pos.length / 9);
    this.triangles = n;
    this.cadFace = cadFaces && cadFaces.length === n ? cadFaces : null;
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

  /** The triangles of triangle `t`'s CAD face, when the model knows its faces. */
  cadFaceOf(t: number): number[] | null {
    const f = this.cadFace?.[t];
    if (f === undefined || f === 0xffff) return null;
    if (!this.cadTris) {
      this.cadTris = new Map();
      this.cadFace!.forEach((id, i) => {
        if (id === 0xffff || this.area[i] <= 0) return;
        let list = this.cadTris!.get(id);
        if (!list) this.cadTris!.set(id, (list = []));
        list.push(i);
      });
    }
    return this.cadTris.get(f) || null;
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
  const cad = topo.cadFaceOf(seed);
  if (cad) return cadFace(topo, cad, seed, n0, d0);
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
  if (curved || isStrip(topo, flat, n0)) snaps = withPin(snaps, pinSnaps(topo, flat, n0));
  return { tris, curved: curved && snaps.length > 0 && tris !== flat, normal: n0, snaps };
}

/**
 * A CAD face: flat when all its triangles lie in the seed's plane, else
 * curved (a cylinder, a fillet, a cone), with the snaps of each kind.
 */
function cadFace(topo: Topology, tris: number[], seed: number, n0: V3, d0: number): Face {
  let flat = true;
  for (const t of tris) {
    if (dot(topo.normalOf(t), n0) < FLAT_COS) flat = false;
    else for (let k = 0; k < 3 && flat; k++) if (Math.abs(dot(n0, topo.point(topo.corner[t * 3 + k])) - d0) > 0.02) flat = false;
    if (!flat) break;
  }
  if (flat) return { tris, curved: false, normal: n0, snaps: isStrip(topo, tris, n0) ? withPin(flatSnaps(topo, tris, n0), pinSnaps(topo, tris, n0)) : flatSnaps(topo, tris, n0) };
  const snaps = curvedSnaps(topo, tris, seed);
  if (snaps.length) return { tris, curved: true, normal: n0, snaps: withPin(snaps, pinSnaps(topo, facetOf(topo, seed, n0, d0), n0)) };
  // Many CADs split a round surface in two halves along a seam: the halves
  // joined smoothly make the whole hole or peg, with its rims.
  const smooth = grow(topo, seed, (x, y) => dot(topo.normalOf(x), topo.normalOf(y)) > SMOOTH_COS);
  if (smooth.length > tris.length) {
    const whole = curvedSnaps(topo, smooth, seed);
    if (whole.length) return { tris: smooth, curved: true, normal: n0, snaps: whole };
  }
  // A curved face with no round rim (a fillet's strip, a freeform patch): the
  // facet under the pointer still offers its middle and corners, as an STL's would.
  const facet = facetOf(topo, seed, n0, d0);
  return { tris: facet, curved: false, normal: n0, snaps: flatSnaps(topo, facet, n0) };
}

/** The flat facet of a CAD face that triangle `seed` lies in. */
function facetOf(topo: Topology, seed: number, n0: V3, d0: number): number[] {
  return grow(topo, seed, (_, o) => {
    if (topo.cadFace![o] !== topo.cadFace![seed] || dot(topo.normalOf(o), n0) < FLAT_COS) return false;
    for (let k = 0; k < 3; k++) if (Math.abs(dot(n0, topo.point(topo.corner[o * 3 + k])) - d0) > 0.02) return false;
    return true;
  });
}

// ------------------------------------------------------------ pins

/** Sideways: a pin's side faces lie within about 3° of its axis. */
const SIDE_SIN = Math.sin((3 * Math.PI) / 180);
/** Across: a board face a pin comes out of is within about 3° of square to it. */
const ACROSS_COS = Math.cos((3 * Math.PI) / 180);

/**
 * The base and tip of the pin whose side `facet` (a thin flat strip, n its
 * normal) is part of, if it is one: a post standing out of the model, much
 * longer than it is wide, whose sides go right round it.
 *
 * A pin's base is where its axis meets a face square to it that reaches
 * beyond the pin: the board the pin is soldered into (one mesh with the
 * pin, or a separate one, as a pin stood against it is), or the body of a
 * header. That face looks the way the pin sticks out of it, so the snap
 * there does too; a pin right through a board has a base on each side.
 * The tip is the far end of the pin from each base, looking the same way.
 */
export function pinSnaps(topo: Topology, facet: number[], n: V3): Snap[] {
  if (!facet.length) return [];
  // The strip's long way is the pin's axis, near enough.
  const pts: V3[] = [];
  for (const t of facet) for (let k = 0; k < 3; k++) pts.push(topo.point(topo.corner[t * 3 + k]));
  let axis = longWay(pts, n);
  if (!axis) return [];
  const sides = (a: V3) => grow(topo, facet[0], (_, o) => topo.area[o] > 0 && Math.abs(dot(topo.normalOf(o), a)) < SIDE_SIN, 50_000);
  let side = sides(axis);
  // Square it up from the side across the pin from the first (a square
  // pin's next side, or a quarter round a round one): both lie along it.
  let best = 1;
  let other: V3 | null = null;
  for (const t of side) {
    const c = Math.abs(dot(topo.normalOf(t), n));
    if (c < best) [best, other] = [c, topo.normalOf(t)];
  }
  if (other && best < 0.7) {
    const a = unit(cross(n, other));
    axis = dot(a, axis) < 0 ? mul(a, -1) : a;
    side = sides(axis);
  }
  if (side.length < 4 || side.length >= 50_000) return [];
  // The sides must go right round, as a post's do, not be one wall of a box.
  let sum: V3 = [0, 0, 0];
  let area = 0;
  for (const t of side) {
    sum = add(sum, mul(topo.normalOf(t), topo.area[t]));
    area += topo.area[t];
  }
  if (len(sum) > 0.2 * area) return [];
  // Its middle line, length and width.
  let mid: V3 = [0, 0, 0];
  const ids = new Set<number>();
  for (const t of side) {
    const c = mul(add(add(topo.point(topo.corner[t * 3]), topo.point(topo.corner[t * 3 + 1])), topo.point(topo.corner[t * 3 + 2])), 1 / 3);
    mid = add(mid, mul(c, topo.area[t] / area));
    for (let k = 0; k < 3; k++) ids.add(topo.corner[t * 3 + k]);
  }
  let lo = Infinity, hi = -Infinity, radius = 0;
  // Its width two ways across: about the same for a square or round pin,
  // not for a long block such as a header's body.
  const across = unit(cross(axis, n));
  let wLo = Infinity, wHi = -Infinity, dLo = Infinity, dHi = -Infinity;
  for (const id of ids) {
    const p = topo.point(id);
    const s = dot(p, axis);
    lo = Math.min(lo, s);
    hi = Math.max(hi, s);
    const off = sub(sub(p, mid), mul(axis, dot(sub(p, mid), axis)));
    radius = Math.max(radius, len(off));
    const w = dot(p, across), d = dot(p, n);
    wLo = Math.min(wLo, w);
    wHi = Math.max(wHi, w);
    dLo = Math.min(dLo, d);
    dHi = Math.max(dHi, d);
  }
  const length = hi - lo;
  const w = wHi - wLo, d = dHi - dLo;
  if (radius <= 0 || length < 3 * radius || Math.min(w, d) < 0.6 * Math.max(w, d)) return [];
  const centre = sub(mid, mul(axis, dot(mid, axis)));
  // A post's sides look away from its middle; a hole's look into it.
  const f0 = pts[0];
  if (dot(n, sub(sub(f0, centre), mul(axis, dot(f0, axis)))) <= 0) return [];
  const onAxis = (s: number): V3 => add(centre, mul(axis, s));
  // Faces square to the pin that it comes out of, along its length.
  const inSide = new Set(side);
  const near = radius * 1.6 + 0.05;
  const bases: { s: number; up: 1 | -1 }[] = [];
  for (let t = 0; t < topo.triangles; t++) {
    if (inSide.has(t) || topo.area[t] <= 0) continue;
    const c = dot(topo.normalOf(t), axis);
    if (Math.abs(c) < ACROSS_COS) continue;
    const a = topo.point(topo.corner[t * 3]);
    const s = dot(a, axis);
    if (s < lo - 0.05 || s > hi + 0.05) continue;
    const up: 1 | -1 = c > 0 ? 1 : -1;
    // The pin must stick out of it, the way it looks.
    if ((up > 0 ? hi - s : s - lo) < Math.max(radius, 0.1)) continue;
    if (bases.some(b => b.up === up && Math.abs(b.s - s) < 0.05)) continue;
    const b = topo.point(topo.corner[t * 3 + 1]), d = topo.point(topo.corner[t * 3 + 2]);
    // Not the pin's own end: some of it reaches past the pin's edge.
    const out = (p: V3) => len(sub(sub(p, centre), mul(axis, dot(p, axis)))) > radius * 1.2;
    if (!out(a) && !out(b) && !out(d)) continue;
    const at = onAxis(s);
    if (distToTri(at, a, b, d) > near) continue;
    bases.push({ s, up });
  }
  const snaps: Snap[] = [];
  for (const b of bases) {
    const look = mul(axis, b.up);
    snaps.push({ p: onAxis(b.s), n: look, role: "pin", radius });
    snaps.push({ p: onAxis(b.up > 0 ? hi : lo), n: look, role: "tip", radius });
  }
  return dedupe(snaps);
}

/** The long way across points lying in a plane of normal `n`, if they're much longer than wide. */
function longWay(pts: V3[], n: V3): V3 | null {
  let u: V3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  u = unit(sub(u, mul(n, dot(u, n))));
  const v = cross(n, u);
  let mu = 0, mv = 0;
  for (const p of pts) {
    mu += dot(p, u);
    mv += dot(p, v);
  }
  mu /= pts.length;
  mv /= pts.length;
  let xx = 0, xy = 0, yy = 0;
  for (const p of pts) {
    const a = dot(p, u) - mu, b = dot(p, v) - mv;
    xx += a * a;
    xy += a * b;
    yy += b * b;
  }
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
  const dir = add(mul(u, Math.cos(angle)), mul(v, Math.sin(angle)));
  return xx + yy > 0 ? unit(dir) : null;
}

/** How far point p is from triangle abc. */
function distToTri(p: V3, a: V3, b: V3, c: V3): number {
  // Ericson, Real-Time Collision Detection, 5.1.5.
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return len(ap);
  const bp = sub(p, b);
  const d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return len(bp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return len(sub(p, add(a, mul(ab, d1 / (d1 - d3)))));
  const cp = sub(p, c);
  const d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return len(cp);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return len(sub(p, add(a, mul(ac, d2 / (d2 - d6)))));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return len(sub(p, add(b, mul(sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6))))));
  const den = 1 / (va + vb + vc);
  return len(sub(p, add(a, add(mul(ab, vb * den), mul(ac, vc * den)))));
}

/** A face's snaps with a pin's added, leaving out any already there facing the same way. */
function withPin(snaps: Snap[], pin: Snap[]): Snap[] {
  return [...snaps, ...pin.filter(q => !snaps.some(s => len(sub(s.p, q.p)) < 1e-3 && dot(s.n, q.n) > 0.99))];
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
/**
 * The snap a pointer at `at` takes: the nearest within reach. A round
 * snap (a hole, a rim, a round face's middle) also catches anywhere inside
 * its circle as drawn (`reach`, px), so a wide hole's centre can be had from
 * over the hole itself. `held` (the face held with ⌘/Ctrl): any distance.
 */
export function nearestSnap(screen: { x: number; y: number }[], snaps: Snap[], at: { x: number; y: number }, catchPx = 22, holePx = 40, reach: number[] = [], held = false): number {
  let best = -1;
  let bestD = Infinity;
  screen.forEach((p, i) => {
    const d = Math.hypot(p.x - at.x, p.y - at.y);
    const base = snaps[i].role === "hole" || snaps[i].role === "rim" ? holePx : catchPx;
    const lim = held ? Infinity : Math.max(base, reach[i] || 0);
    if (d <= lim && d < bestD) {
      best = i;
      bestD = d;
    }
  });
  return best;
}
