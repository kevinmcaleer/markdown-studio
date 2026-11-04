// Screws for 3D scenes: metric machine screws (M2 to M6) drawn from their
// standard sizes, so a hole can be filled in one click without an STL. The
// screw tool picks a size, or measures it from the hole: the biggest screw
// that goes through it, as long as the hole is deep (a blind hole) or the
// part is thick plus a bit to bite on (a hole right through).
//
// The model is made here as triangles, centred as a part's model is (the
// middle of its box at 0, 0, 0), with the point where it meets the part it
// screws into: the underside of the head (the top of a countersunk head),
// facing down the shank. No three.js here, so it can be tested.

import type { Topology, Snap, V3 } from "./snaps";

export type ScrewHead = "socket" | "button" | "countersunk";

export interface ScrewSpec {
  /** Thread size in mm: 3 for M3. */
  d: number;
  /** Length in mm, as screws are sold: under the head, or overall for a countersunk head. */
  length: number;
  head: ScrewHead;
}

interface Size {
  d: number;
  pitch: number;
  /** Head diameter, height and hex key size (across flats), by head. */
  socket: [number, number, number];
  button: [number, number, number];
  countersunk: [number, number, number];
}

// ISO 4762 (socket cap), ISO 7380 (button) and ISO 10642 (countersunk).
export const SCREW_SIZES: Size[] = [
  { d: 2, pitch: 0.4, socket: [3.8, 2, 1.5], button: [3.5, 1.3, 1.3], countersunk: [4.4, 1.2, 1.3] },
  { d: 2.5, pitch: 0.45, socket: [4.5, 2.5, 2], button: [4.7, 1.4, 1.5], countersunk: [5.5, 1.5, 1.5] },
  { d: 3, pitch: 0.5, socket: [5.5, 3, 2.5], button: [5.7, 1.65, 2], countersunk: [6.72, 1.86, 2] },
  { d: 4, pitch: 0.7, socket: [7, 4, 3], button: [7.6, 2.2, 2.5], countersunk: [8.96, 2.48, 2.5] },
  { d: 5, pitch: 0.8, socket: [8.5, 5, 4], button: [9.5, 2.75, 3], countersunk: [11.2, 3.1, 3] },
  { d: 6, pitch: 1, socket: [10, 6, 5], button: [10.5, 3.3, 4], countersunk: [13.44, 3.72, 4] },
];

export const SCREW_LENGTHS = [3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 25, 30, 35, 40, 45, 50];

export const SCREW_HEADS: { id: ScrewHead; label: string; detail: string }[] = [
  { id: "socket", label: "Socket cap", detail: "A round head with a hex key socket" },
  { id: "button", label: "Button", detail: "A low domed head" },
  { id: "countersunk", label: "Countersunk", detail: "Sits flush in a countersunk hole" },
];

const sizeOf = (d: number): Size => SCREW_SIZES.find(s => s.d === d) || SCREW_SIZES[2];

/** "M3 × 8", "M2.5 × 6 button", "M4 × 10 countersunk". */
export function screwLabel(s: ScrewSpec): string {
  return `M${s.d} × ${s.length}${s.head === "socket" ? "" : ` ${s.head}`}`;
}

/** The part's name: "M3 × 8 screw". */
export function screwName(s: ScrewSpec): string {
  return `${screwLabel(s)} screw`;
}

/** The file name its model is given (for a URDF's meshes): "M3x8-socket.stl". */
export function screwFile(s: ScrewSpec): string {
  return `M${s.d}x${s.length}-${s.head}.stl`;
}

/** `value` as a screw, or null when it isn't one. */
export function normalizeScrew(value: unknown): ScrewSpec | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<ScrewSpec>;
  const d = Number(v.d);
  const length = Number(v.length);
  if (!SCREW_SIZES.some(s => s.d === d) || !Number.isFinite(length) || length < 1 || length > 200) return null;
  const head: ScrewHead = v.head === "button" || v.head === "countersunk" ? v.head : "socket";
  return { d, length: Math.round(length * 10) / 10, head };
}

// ------------------------------------------------------------ sizing from a hole

/**
 * The screw size for a round hole of this radius: the biggest that goes
 * through it (holes are drawn at the screw's size or a little over). A
 * countersunk head is matched to the countersink when the hole is that
 * wide. Holes smaller than M2 get M2.
 */
export function fitDiameter(radius: number, head: ScrewHead = "socket"): number {
  const D = radius * 2;
  if (head === "countersunk") {
    const sink = SCREW_SIZES.find(s => Math.abs(s.countersunk[0] - D) / s.countersunk[0] < 0.1);
    if (sink && D > sink.d * 1.4) return sink.d;
  }
  let best = SCREW_SIZES[0].d;
  for (const s of SCREW_SIZES) if (s.d <= D + 0.15) best = s.d;
  return best;
}

/**
 * The screw length for a hole: a blind hole takes the longest that fits
 * in it; a hole right through takes one through the part with about one
 * and a half times its size to spare (into the part behind, or a nut).
 */
export function fitLength(d: number, hole: { depth: number; through: boolean }): number {
  if (hole.through) {
    const want = hole.depth + 1.5 * d;
    return SCREW_LENGTHS.find(l => l >= want - 0.2) ?? SCREW_LENGTHS[SCREW_LENGTHS.length - 1];
  }
  let best = SCREW_LENGTHS[0];
  for (const l of SCREW_LENGTHS) if (l <= hole.depth + 0.2) best = l;
  return best;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
};
const along = (p: V3, d: V3, t: number): V3 => [p[0] + d[0] * t, p[1] + d[1] * t, p[2] + d[2] * t];

/** Every distance along the ray at which it crosses one of the model's triangles, nearest first. */
function rayHits(topo: Topology, from: V3, dir: V3, near?: { axis: V3; reach: number }): number[] {
  const out: number[] = [];
  for (let t = 0; t < topo.triangles; t++) {
    if (topo.area[t] <= 0) continue;
    const a = topo.point(topo.corner[t * 3]), b = topo.point(topo.corner[t * 3 + 1]), c = topo.point(topo.corner[t * 3 + 2]);
    if (near) {
      // Skip triangles nowhere near the ray (most of a big model), cheaply.
      const off = (p: V3) => {
        const v = sub(p, from);
        const k = dot(v, dir);
        return Math.hypot(v[0] - dir[0] * k, v[1] - dir[1] * k, v[2] - dir[2] * k);
      };
      if (off(a) > near.reach && off(b) > near.reach && off(c) > near.reach) continue;
    }
    const e1 = sub(b, a), e2 = sub(c, a);
    const pv = cross(dir, e2);
    const det = dot(e1, pv);
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const tv = sub(from, a);
    const u = dot(tv, pv) * inv;
    if (u < -1e-9 || u > 1 + 1e-9) continue;
    const qv = cross(tv, e1);
    const v = dot(dir, qv) * inv;
    if (v < -1e-9 || u + v > 1 + 1e-9) continue;
    const dist = dot(e2, qv) * inv;
    if (dist > 1e-6) out.push(dist);
  }
  out.sort((x, y) => x - y);
  // A ray through a shared edge crosses both triangles: count it once.
  return out.filter((d, i) => i === 0 || d - out[i - 1] > 1e-4);
}

/**
 * How deep a round hole is, from its centre on the face (`p`, the face
 * looking along `n`): to its bottom for a blind hole, or the part's
 * thickness beside it for a hole right through. In the model's own frame.
 */
export function holeDepth(topo: Topology, p: V3, n: V3, radius: number): { depth: number; through: boolean } {
  const down = unit([-n[0], -n[1], -n[2]]);
  const lift = 0.05;
  let u: V3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  u = unit(cross(n, u));
  const w = cross(n, u);
  const out = radius + Math.max(0.6, radius * 0.5);
  const reach = out + 1;
  // Beside the hole: in through the face, out the back.
  const thick: number[] = [];
  for (const dir of [u, w, mul(u, -1), mul(w, -1)]) {
    const from = along(along(p, dir, out), n, lift);
    const hits = rayHits(topo, from, down, { axis: down, reach });
    // The first crossing has to be this face, else the point is off it (a hole by an edge).
    if (hits.length < 2 || hits[0] > lift * 3) continue;
    thick.push(hits[1] - lift);
  }
  const thickness = thick.length ? Math.min(...thick) : 0;
  // Down the middle of the hole: a bottom, if it has one.
  const bottom = rayHits(topo, along(p, down, lift), down, { axis: down, reach: radius + 1 })[0];
  const depth = bottom !== undefined ? bottom + lift : Infinity;
  if (thickness > 0 && depth < thickness - 0.05) return { depth, through: false };
  if (thickness > 0) return { depth: thickness, through: true };
  if (Number.isFinite(depth)) return { depth, through: false };
  return { depth: radius * 4, through: true };
}

function mul(a: V3, k: number): V3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}

/** Whether a snap is a round hole a screw goes in. */
export const isHoleSnap = (s: Snap): boolean => (s.role === "hole" || s.role === "rim") && !!s.radius && s.radius > 0.3;

/**
 * The model's other holes like `ref`: as wide (within a few per cent) and
 * facing the same way, `ref` itself among them, each once. Looks through
 * the model's faces until `budgetMs` runs out, so a huge model can't hang.
 */
export function matchingHoles(topo: Topology, ref: Snap, budgetMs = 400): Snap[] {
  const out: Snap[] = [];
  const r0 = ref.radius || 0;
  const tol = Math.max(0.06, r0 * 0.05);
  const n0 = unit(ref.n);
  const seen = new Set<unknown>();
  const start = typeof performance !== "undefined" ? performance.now() : Date.now();
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  const take = (s: Snap) => {
    if (!isHoleSnap(s) || Math.abs((s.radius || 0) - r0) > tol || dot(unit(s.n), n0) < 0.995) return;
    if (out.some(o => Math.hypot(...sub(o.p, s.p)) < 0.05)) return;
    out.push(s);
  };
  take(ref);
  for (let t = 0; t < topo.triangles; t++) {
    if ((t & 255) === 0 && now() - start > budgetMs) break;
    if (topo.area[t] <= 0) continue;
    const f = topo.faceAt(t);
    if (!f || seen.has(f)) continue;
    seen.add(f);
    f.snaps.forEach(take);
  }
  return out;
}

// ------------------------------------------------------------ the model

const SEGMENTS = 36; // a multiple of 6, so the hex socket's corners fall on it

interface Built {
  /** Triangles, three corners of x, y, z each, centred on the screw's box. */
  positions: Float32Array;
  /** Where it meets the part (the underside of the head, or the top of a countersunk one), in the same frame. */
  contact: V3;
  /** The way the contact faces: down the shank. */
  normal: V3;
}

/**
 * A screw as triangles. Its axis is Z, head up; the thread is drawn as
 * slanted grooves, so line art draws one fine line per turn, slanting as a
 * thread does, inside a straight outline. The thread is drawn a little
 * coarser than it is on the smallest screws, so it still reads.
 */
export function screwMesh(spec: ScrewSpec): Built {
  const size = sizeOf(spec.d);
  const [dk, k, s] = size[spec.head];
  const R = spec.d / 2;
  const sunk = spec.head === "countersunk";
  const shank = Math.max(0.5, sunk ? spec.length - k : spec.length);
  const pitch = Math.max(size.pitch * 1.5, spec.d * 0.3);
  // Each turn of the thread is a narrow, shallow V groove in the shank: its
  // floor folds sharply enough to draw a line, its edges don't, and it is
  // too shallow to dent the outline. Each groove is tilted half a turn's
  // rise across the screw, so it slants as a thread does.
  const groove = pitch * 0.3;
  const dip = Math.tan((20 * Math.PI) / 180) * (groove / 2);
  const tilt = pitch / 4;
  type Ring = { r: number | ((th: number) => number); z: number | ((th: number) => number) };
  const rings: Ring[] = [];
  // The tip: its middle, then a small chamfer.
  rings.push({ r: 0, z: -shank }, { r: R * 0.8, z: -shank });
  // The thread, from just above the tip to a little below the head.
  const start = -shank + pitch * 0.5;
  const end = -Math.min(shank * 0.25, Math.max(pitch, spec.d * 0.3));
  const turns = Math.max(0, Math.floor((end - start) / pitch));
  for (let i = 0; i <= turns; i++) {
    const zk = start + i * pitch;
    for (const [dz, r] of [[0, R], [groove / 2, R - dip], [groove, R]] as const) rings.push({ r, z: th => zk + dz + tilt * Math.cos(th) });
  }
  const lastZ = start + turns * pitch + groove;
  rings.push({ r: R, z: Math.min(lastZ + pitch * 0.5, -0.05) });
  // The head.
  const hexR = (th: number) => {
    const a = s / 2;
    const step = Math.PI / 3;
    const phi = (((th % step) + step) % step) - step / 2;
    return a / Math.cos(phi);
  };
  const socketDepth = Math.min(k * (sunk ? 0.6 : spec.head === "button" ? 0.55 : 0.5), k - 0.2);
  if (spec.head === "socket") {
    const c = Math.min(dk * 0.06, k * 0.15);
    rings.push({ r: R, z: 0 }, { r: dk / 2, z: 0 }, { r: dk / 2, z: k - c }, { r: dk / 2 - c, z: k });
  } else if (spec.head === "button") {
    rings.push({ r: R, z: 0 }, { r: dk / 2, z: 0 }, { r: dk / 2, z: k * 0.15 });
    const top = Math.max(s * 0.62 + 0.3, dk * 0.3);
    for (let i = 1; i <= 6; i++) {
      const a = (i / 6) * (Math.PI / 2);
      rings.push({ r: top + (dk / 2 - top) * Math.cos(a), z: k * 0.15 + k * 0.85 * Math.sin(a) });
    }
  } else {
    rings.push({ r: R, z: 0 }, { r: dk / 2, z: k * 0.9 }, { r: dk / 2, z: k });
  }
  // The hex socket, down to its floor.
  rings.push({ r: hexR, z: k }, { r: hexR, z: k - socketDepth }, { r: 0, z: k - socketDepth });
  const top = k;
  const bottom = -shank;
  const cz = (top + bottom) / 2;
  const pts: number[] = [];
  const at = (ring: Ring, j: number): V3 => {
    const th = (j % SEGMENTS) * ((2 * Math.PI) / SEGMENTS);
    const r = typeof ring.r === "function" ? ring.r(th) : ring.r;
    const z = typeof ring.z === "function" ? ring.z(th) : ring.z;
    return [r * Math.cos(th), r * Math.sin(th), z - cz];
  };
  const isPoint = (ring: Ring) => ring.r === 0;
  const tri = (a: V3, b: V3, c: V3) => pts.push(...a, ...b, ...c);
  for (let i = 0; i + 1 < rings.length; i++) {
    const lo = rings[i], hi = rings[i + 1];
    for (let j = 0; j < SEGMENTS; j++) {
      const a = at(lo, j), b = at(lo, j + 1), c = at(hi, j + 1), d = at(hi, j);
      if (!isPoint(lo)) tri(a, b, c);
      if (!isPoint(hi)) tri(a, c, d);
    }
  }
  return { positions: Float32Array.from(pts), contact: [0, 0, (sunk ? k : 0) - cz], normal: [0, 0, -1] };
}

/** How far a screw is drawn out of its hole in an exploded view: clear of it, with room to see the hole. */
export function screwLift(spec: ScrewSpec): number {
  return Math.round(spec.length + Math.max(spec.length * 0.6, 8));
}
