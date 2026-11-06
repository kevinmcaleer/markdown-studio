// Wires that go round the parts instead of through them.
//
// The model's triangles are drawn into a grid of little cubes (a few mm
// across), and each cube learns how far it is from the nearest solid
// surface (a chamfer distance transform) and which part that surface
// belongs to. A cube is free when it is further off every surface than the
// wire's radius plus some room. A* finds the shortest run of free cubes from
// one end's lead to the other's; pulling it tight (keeping each straight
// stretch only where it stays free) leaves a few corners, and those become
// the wire's waypoints, each on the part it is nearest, so the wire still
// follows its parts when they move or explode.
//
// The surface is a shell: a part's inside is far from its surface too, but
// it is walled in by the band round the shell, so a run from outside never
// gets there.

import { Matrix4, Vector3 } from "three";

/** Mm of room kept between a wire and the parts, over its radius. */
export const WIRE_ROOM = 1.5;
/** Most cubes in the grid: the cube size grows to keep under it. */
const MAX_CELLS = 3_000_000;
/** Smallest cube, mm. */
const MIN_CELL = 0.5;
/** Mm the grid reaches past the model all round, so a wire can go round its outside. */
const MARGIN = 20;

export interface Solid {
  part: string;
  /** Triangles, three corners each, in the part's own frame. */
  positions: ArrayLike<number>;
  /** The part's place in the world. */
  matrix: Matrix4;
}

export interface SolidGrid {
  origin: Vector3;
  cell: number;
  nx: number;
  ny: number;
  nz: number;
  /** Each cube's distance from the nearest surface, in cubes (×10, chamfer). */
  dist: Uint16Array;
  /** Which solid that surface is (its index in `parts`, -1 none). */
  owner: Int32Array;
  parts: string[];
}

const FAR = 0xffff;

/** The solids drawn into a grid that also takes in `extra` points (wire ends). */
export function solidGrid(solids: Solid[], extra: Vector3[] = [], cellWant?: number): SolidGrid | null {
  const world: Float32Array[] = [];
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  const v = new Vector3();
  for (const s of solids) {
    const out = new Float32Array(s.positions.length - (s.positions.length % 9));
    for (let i = 0; i + 2 < out.length; i += 3) {
      v.set(s.positions[i], s.positions[i + 1], s.positions[i + 2]).applyMatrix4(s.matrix);
      out[i] = v.x;
      out[i + 1] = v.y;
      out[i + 2] = v.z;
      min.min(v);
      max.max(v);
    }
    world.push(out);
  }
  for (const p of extra) {
    min.min(p);
    max.max(p);
  }
  if (!(max.x >= min.x)) return null;
  min.subScalar(MARGIN);
  max.addScalar(MARGIN);
  const size = max.clone().sub(min);
  const cell = Math.max(cellWant ?? MIN_CELL, MIN_CELL, Math.cbrt((size.x * size.y * size.z) / MAX_CELLS));
  const nx = Math.ceil(size.x / cell) + 1, ny = Math.ceil(size.y / cell) + 1, nz = Math.ceil(size.z / cell) + 1;
  const n = nx * ny * nz;
  const dist = new Uint16Array(n).fill(FAR);
  const owner = new Int32Array(n).fill(-1);
  const put = (x: number, y: number, z: number, who: number) => {
    const i = Math.floor((x - min.x) / cell), j = Math.floor((y - min.y) / cell), k = Math.floor((z - min.z) / cell);
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return;
    const at = i + nx * (j + ny * k);
    dist[at] = 0;
    owner[at] = who;
  };
  // Each triangle sampled closer than half a cube, so its cubes join up.
  const step = cell * 0.5;
  world.forEach((t, who) => {
    for (let i = 0; i + 8 < t.length; i += 9) {
      const ax = t[i], ay = t[i + 1], az = t[i + 2];
      const bx = t[i + 3], by = t[i + 4], bz = t[i + 5];
      const cx = t[i + 6], cy = t[i + 7], cz = t[i + 8];
      const ab = Math.hypot(bx - ax, by - ay, bz - az), ac = Math.hypot(cx - ax, cy - ay, cz - az), bc = Math.hypot(cx - bx, cy - by, cz - bz);
      const m = Math.min(400, Math.max(1, Math.ceil(Math.max(ab, ac, bc) / step)));
      for (let a = 0; a <= m; a++) {
        for (let b = 0; a + b <= m; b++) {
          const u = a / m, w = b / m, r = 1 - u - w;
          put(ax * r + bx * u + cx * w, ay * r + by * u + cy * w, az * r + bz * u + cz * w, who);
        }
      }
    }
  });
  fillInsides(dist, nx, ny, nz);
  chamfer(dist, owner, nx, ny, nz);
  return { origin: min, cell, nx, ny, nz, dist, owner, parts: solids.map(s => s.part) };
}

/**
 * Cubes walled in by a surface (a part's inside) count as solid: every cube
 * not reached from the grid's edge without crossing a surface is set to 0.
 */
function fillInsides(dist: Uint16Array, nx: number, ny: number, nz: number): void {
  const n = nx * ny * nz;
  const out = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  const seed = (at: number) => {
    if (out[at] || dist[at] === 0) return;
    out[at] = 1;
    queue[tail++] = at;
  };
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++)
        if (x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1) seed(x + nx * (y + ny * z));
  const plane = nx * ny;
  while (head < tail) {
    const at = queue[head++];
    const x = at % nx, y = Math.floor(at / nx) % ny, z = Math.floor(at / plane);
    if (x > 0) seed(at - 1);
    if (x < nx - 1) seed(at + 1);
    if (y > 0) seed(at - nx);
    if (y < ny - 1) seed(at + nx);
    if (z > 0) seed(at - plane);
    if (z < nz - 1) seed(at + plane);
  }
  for (let i = 0; i < n; i++) if (!out[i]) dist[i] = 0;
}

/** Two passes of a 3-4-5 chamfer distance (×10 of a cube: 10, 14, 17), carrying who is nearest. */
function chamfer(dist: Uint16Array, owner: Int32Array, nx: number, ny: number, nz: number): void {
  const fwd: [number, number, number, number][] = [];
  for (let dz = -1; dz <= 0; dz++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (dz === 0 && (dy > 0 || (dy === 0 && dx >= 0))) continue;
        const k = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
        fwd.push([dx, dy, dz, k === 1 ? 10 : k === 2 ? 14 : 17]);
      }
  const pass = (dir: 1 | -1) => {
    const offs = fwd.map(([dx, dy, dz, c]) => [dx * dir, dy * dir, dz * dir, c] as const);
    const z0 = dir > 0 ? 0 : nz - 1, z1 = dir > 0 ? nz : -1;
    const y0 = dir > 0 ? 0 : ny - 1, y1 = dir > 0 ? ny : -1;
    const x0 = dir > 0 ? 0 : nx - 1, x1 = dir > 0 ? nx : -1;
    for (let z = z0; z !== z1; z += dir)
      for (let y = y0; y !== y1; y += dir)
        for (let x = x0; x !== x1; x += dir) {
          const at = x + nx * (y + ny * z);
          let best = dist[at];
          if (best === 0) continue;
          let who = owner[at];
          for (const [dx, dy, dz, c] of offs) {
            const X = x + dx, Y = y + dy, Z = z + dz;
            if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue;
            const o = X + nx * (Y + ny * Z);
            const d = dist[o] + c;
            if (d < best) {
              best = d;
              who = owner[o];
            }
          }
          dist[at] = Math.min(best, FAR);
          owner[at] = who;
        }
  };
  pass(1);
  pass(-1);
}

const cellOf = (g: SolidGrid, p: Vector3): [number, number, number] => [
  Math.floor((p.x - g.origin.x) / g.cell),
  Math.floor((p.y - g.origin.y) / g.cell),
  Math.floor((p.z - g.origin.z) / g.cell),
];
const inside = (g: SolidGrid, i: number, j: number, k: number) => i >= 0 && j >= 0 && k >= 0 && i < g.nx && j < g.ny && k < g.nz;
const centreOf = (g: SolidGrid, at: number) => {
  const i = at % g.nx, j = Math.floor(at / g.nx) % g.ny, k = Math.floor(at / (g.nx * g.ny));
  return new Vector3(g.origin.x + (i + 0.5) * g.cell, g.origin.y + (j + 0.5) * g.cell, g.origin.z + (k + 0.5) * g.cell);
};

/** Mm from `p` to the nearest surface (Infinity outside the grid). */
export function clearance(g: SolidGrid, p: Vector3): number {
  const [i, j, k] = cellOf(g, p);
  if (!inside(g, i, j, k)) return Infinity;
  const d = g.dist[i + g.nx * (j + g.ny * k)];
  return d === FAR ? Infinity : (d / 10) * g.cell;
}

/** The part whose surface is nearest `p`, if any. */
export function nearestPart(g: SolidGrid, p: Vector3): string | null {
  const [i, j, k] = cellOf(g, p);
  if (!inside(g, i, j, k)) return null;
  const o = g.owner[i + g.nx * (j + g.ny * k)];
  return o >= 0 ? g.parts[o] : null;
}

/** Whether the straight run from `a` to `b` stays `keep` mm off every surface. */
export function clearRun(g: SolidGrid, a: Vector3, b: Vector3, keep: number): boolean {
  const len = a.distanceTo(b);
  const n = Math.max(1, Math.ceil(len / (g.cell * 0.4)));
  const p = new Vector3();
  for (let s = 0; s <= n; s++) {
    p.copy(a).lerp(b, s / n);
    // Half a cube's slack: the grid only knows distance to a cube's middle. Never through a surface.
    const c = clearance(g, p);
    if (c <= 0 || c + g.cell * 0.5 < keep) return false;
  }
  return true;
}

/**
 * From `p`, out along `n` (or, failing that, the nearest way) to where it's
 * `keep` mm clear, never through a part: once off the face it started on,
 * a surface stops it. Null if there's nowhere near.
 */
function escape(g: SolidGrid, p: Vector3, n: Vector3 | null, keep: number): Vector3 | null {
  if (clearance(g, p) >= keep) return p.clone();
  const want = Math.ceil((keep / g.cell) * 10);
  if (n) {
    const q = new Vector3();
    let left = false;
    for (let s = g.cell * 0.5; s <= 40; s += g.cell * 0.5) {
      q.copy(p).addScaledVector(n, s);
      const c = clearance(g, q);
      if (c >= keep + g.cell * 0.5) return q.clone();
      // Off its own face, then into another: blocked that way.
      if (c > 0) left = true;
      else if (left) break;
    }
  }
  // The nearest clear cube, breadth first, through cubes that aren't a surface.
  const [i0, j0, k0] = cellOf(g, p);
  if (!inside(g, i0, j0, k0)) return null;
  const start = i0 + g.nx * (j0 + g.ny * k0);
  const seen = new Set([start]);
  let ring = [start];
  // The first cube or two may be the face it starts on.
  const own = Math.ceil(1.5 / g.cell) + 1;
  for (let r = 0; r < Math.ceil(30 / g.cell) && ring.length; r++) {
    const next: number[] = [];
    for (const at of ring) {
      const i = at % g.nx, j = Math.floor(at / g.nx) % g.ny, k = Math.floor(at / (g.nx * g.ny));
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const X = i + dx, Y = j + dy, Z = k + dz;
        if (!inside(g, X, Y, Z)) continue;
        const o = X + g.nx * (Y + g.ny * Z);
        if (seen.has(o)) continue;
        seen.add(o);
        if (g.dist[o] >= want) return centreOf(g, o);
        if (g.dist[o] === 0 && r >= own) continue;
        next.push(o);
      }
    }
    ring = next;
  }
  return null;
}

/** A binary heap of cube indices by cost. */
class Heap {
  private items: number[] = [];
  constructor(private key: Float32Array) {}
  get size() {
    return this.items.length;
  }
  push(x: number) {
    const a = this.items;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.key[a[p]] <= this.key[a[i]]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): number {
    const a = this.items;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < a.length && this.key[a[l]] < this.key[a[m]]) m = l;
        if (r < a.length && this.key[a[r]] < this.key[a[m]]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/** The shortest run of clear cubes from `a` to `b` (both clear), as cube middles. Null when there's none. */
function search(g: SolidGrid, a: Vector3, b: Vector3, keep: number): Vector3[] | null {
  const want = Math.ceil((keep / g.cell) * 10);
  const free = (o: number) => g.dist[o] >= want;
  const [ai, aj, ak] = cellOf(g, a);
  const [bi, bj, bk] = cellOf(g, b);
  if (!inside(g, ai, aj, ak) || !inside(g, bi, bj, bk)) return null;
  const s = ai + g.nx * (aj + g.ny * ak), t = bi + g.nx * (bj + g.ny * bk);
  const n = g.nx * g.ny * g.nz;
  const cost = new Float32Array(n).fill(Infinity);
  const f = new Float32Array(n).fill(Infinity);
  const from = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const h = (o: number) => {
    const i = o % g.nx, j = Math.floor(o / g.nx) % g.ny, k = Math.floor(o / (g.nx * g.ny));
    return Math.hypot(i - bi, j - bj, k - bk);
  };
  const steps: [number, number, number, number][] = [];
  for (let dz = -1; dz <= 1; dz++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) if (dx || dy || dz) steps.push([dx, dy, dz, Math.hypot(dx, dy, dz)]);
  cost[s] = 0;
  f[s] = h(s);
  const open = new Heap(f);
  open.push(s);
  let visited = 0;
  while (open.size) {
    const o = open.pop();
    if (done[o]) continue;
    done[o] = 1;
    if (o === t) break;
    if (++visited > 4_000_000) return null;
    const i = o % g.nx, j = Math.floor(o / g.nx) % g.ny, k = Math.floor(o / (g.nx * g.ny));
    for (const [dx, dy, dz, c] of steps) {
      const X = i + dx, Y = j + dy, Z = k + dz;
      if (!inside(g, X, Y, Z)) continue;
      const q = X + g.nx * (Y + g.ny * Z);
      if (done[q] || (!free(q) && q !== t)) continue;
      const nc = cost[o] + c;
      if (nc < cost[q]) {
        cost[q] = nc;
        from[q] = o;
        f[q] = nc + h(q);
        open.push(q);
      }
    }
  }
  if (!done[t]) return null;
  const out: Vector3[] = [];
  for (let o = t; o !== -1; o = from[o]) out.push(centreOf(g, o));
  out.reverse();
  out[0] = a.clone();
  out[out.length - 1] = b.clone();
  return out;
}

/**
 * The run pulled tight: from each corner, straight to the furthest point it
 * clears (found by galloping out, then halving back), no stretch longer
 * than `maxRun`.
 */
function pullTight(g: SolidGrid, path: Vector3[], keep: number, maxRun: number): Vector3[] {
  const out = [path[0]];
  const last = path.length - 1;
  const ok = (i: number, j: number) => path[i].distanceTo(path[j]) <= maxRun && clearRun(g, path[i], path[j], keep);
  let i = 0;
  while (i < last) {
    let good = i + 1;
    let step = 1;
    while (good < last) {
      const j = Math.min(last, i + step * 2);
      if (!ok(i, j)) break;
      good = j;
      step *= 2;
    }
    // Between the last good and the first bad, halving.
    let bad = Math.min(last, i + step * 2);
    if (good < last && bad > good) {
      while (bad - good > 1) {
        const m = (good + bad) >> 1;
        if (ok(i, m)) good = m;
        else bad = m;
      }
    }
    out.push(path[good]);
    i = good;
  }
  return out;
}

export interface RouteEnd {
  /** Where the run starts (the end of a wire's lead), in the world. */
  p: Vector3;
  /** The way out of the face, if it has one. */
  n: Vector3 | null;
}

/**
 * The points a wire `keep` mm thick (its radius plus room) passes between
 * `a` and `b` to stay clear of the solids, in the world: none when the
 * straight run is clear, null when there's no way round. `maxRun` caps each
 * straight stretch (shorter ones bow less with slack).
 */
export function routeRound(g: SolidGrid, a: RouteEnd, b: RouteEnd, keep: number, maxRun = Infinity): Vector3[] | null {
  const found = findWay(g, a, b, keep);
  return found ? tighten(g, found, maxRun) : null;
}

/** A way found round the solids: the run of cubes, how much room it keeps, and where it starts and ends. */
export interface Way {
  a: RouteEnd;
  b: RouteEnd;
  /** Null: the straight run is clear. */
  path: Vector3[] | null;
  keep: number;
}

/**
 * The shortest way from `a` to `b` keeping `keep` mm off the solids; in a
 * tight spot, as close as the grid can tell, but never through a part.
 * Null when there's no way at all.
 */
export function findWay(g: SolidGrid, a: RouteEnd, b: RouteEnd, keep: number): Way | null {
  if (clearRun(g, a.p, b.p, keep)) return { a, b, path: null, keep };
  for (const k of [keep, Math.max(g.cell * 0.6, keep * 0.6), g.cell * 0.15]) {
    const a1 = escape(g, a.p, a.n, k);
    const b1 = escape(g, b.p, b.n, k);
    if (!a1 || !b1) continue;
    const path = search(g, a1, b1, k);
    if (path) return { a, b, path, keep: k };
  }
  return null;
}

/** A way pulled tight into the corners a wire passes, none of its straight stretches over `maxRun`. */
export function tighten(g: SolidGrid, way: Way, maxRun = Infinity): Vector3[] {
  if (!way.path) {
    if (way.a.p.distanceTo(way.b.p) <= maxRun) return [];
    const n = Math.ceil(way.a.p.distanceTo(way.b.p) / maxRun);
    return Array.from({ length: n - 1 }, (_, i) => way.a.p.clone().lerp(way.b.p, (i + 1) / n));
  }
  const out = pullTight(g, way.path, way.keep, maxRun);
  // The way out from each end, kept: it rises clear before it turns.
  if (out[0].distanceTo(way.a.p) < g.cell * 0.5) out.shift();
  if (out.length && out[out.length - 1].distanceTo(way.b.p) < g.cell * 0.5) out.pop();
  return out;
}
