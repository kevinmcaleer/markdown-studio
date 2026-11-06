// Making a track (a tank tread, a chain): one piece repeated round two or
// more wheels, its pieces joined end to end at their pivots, the last back
// to the first. The pieces' pivots lie on a loop that wraps the wheels'
// circles, `lift` mm outside them, as a belt does: the circles' convex hull.
//
// Each piece is placed so its start pivot sits on the loop and its end
// pivot on the next piece's start pivot (a chord of the loop, the pieces
// being rigid). The axis through its pivots lines up with the wheels' axle.
//
// Points and normals picked on the piece are in its own frame (its middle
// at 0, 0, 0); a wheel's circle is in the wheel's own frame. Units are mm.

import { Matrix4, Vector3 } from "three";
import { MAX_TRACK_PIECES, type TrackSpec } from "./trackSpec";

export { MAX_TRACK_PIECES, normalizeTrack, type TrackSpec, type TrackWheel } from "./trackSpec";

export type P2 = [number, number];

/** A circle on the plane the track runs in. */
export interface Circle2 {
  x: number;
  y: number;
  r: number;
}

/**
 * The loop round the circles, as a belt goes round pulleys: their convex
 * hull, as a polygon (counter-clockwise), finely enough that its chords
 * are a hair from the true curve.
 */
export function wrapLoop(circles: Circle2[], steps = 360): P2[] {
  const pts: P2[] = [];
  for (const c of circles) {
    if (!(c.r > 0)) {
      pts.push([c.x, c.y]);
      continue;
    }
    for (let k = 0; k < steps; k++) {
      const a = (k / steps) * Math.PI * 2;
      pts.push([c.x + Math.cos(a) * c.r, c.y + Math.sin(a) * c.r]);
    }
  }
  return convexHull(pts);
}

/** Andrew's monotone chain: the hull, counter-clockwise, without repeats. */
export function convexHull(points: P2[]): P2[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: P2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: P2[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** How far round a closed loop is. */
export function loopLength(loop: P2[]): number {
  let l = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    l += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return l;
}

/** A place on the loop: the segment it's on (from point `seg`), how far along it (0–1), and the point. */
interface At {
  seg: number;
  t: number;
  p: P2;
}

function pointAt(loop: P2[], dist: number): At {
  const L = loopLength(loop);
  let d = ((dist % L) + L) % L;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    const s = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (d <= s || i === loop.length - 1) {
      const t = s > 0 ? Math.min(1, d / s) : 0;
      return { seg: i, t, p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] };
    }
    d -= s;
  }
  return { seg: 0, t: 0, p: loop[0] };
}

/**
 * The next place round the loop exactly `pitch` from `from` in a straight
 * line (where the next piece's pivot goes), and the length of loop passed.
 */
function nextPivot(loop: P2[], from: At, pitch: number): { at: At; run: number } {
  const n = loop.length;
  const P = from.p;
  let run = 0;
  let seg = from.seg;
  let t0 = from.t;
  for (let k = 0; k <= n; k++) {
    const a = loop[seg], b = loop[(seg + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const s = Math.hypot(dx, dy);
    // |a + t·(b - a) - P| = pitch, for t past t0: the far root.
    const fx = a[0] - P[0], fy = a[1] - P[1];
    const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - pitch * pitch;
    const disc = B * B - 4 * A * C;
    if (A > 0 && disc >= 0) {
      const t = (-B + Math.sqrt(disc)) / (2 * A);
      if (t >= t0 - 1e-9 && t <= 1 + 1e-9) {
        const tt = Math.max(t0, Math.min(1, t));
        run += (tt - t0) * s;
        return { at: { seg, t: tt, p: [a[0] + dx * tt, a[1] + dy * tt] }, run };
      }
    }
    run += (1 - t0) * s;
    seg = (seg + 1) % n;
    t0 = 0;
  }
  return { at: from, run };
}

export interface ChainLayout {
  /** Each piece's start pivot; piece i's end pivot is piece i+1's start (the last's, the first's). */
  pivots: P2[];
  /** How far round the loop is. */
  length: number;
  /** How many pieces go round exactly (a fraction): the count that makes the track neither tight nor slack. */
  fits: number;
}

/** Pivots for `count` pieces `pitch` apart round the loop, the first `offset` along it. */
export function layChain(loop: P2[], pitch: number, count: number, offset: number): ChainLayout {
  const length = loopLength(loop);
  if (loop.length < 3 || !(pitch > 0) || !(length > 0)) return { pivots: [], length, fits: 0 };
  const first = pointAt(loop, offset);
  const pivots: P2[] = [first.p];
  let at = first;
  for (let i = 1; i < count; i++) {
    at = nextPivot(loop, at, pitch).at;
    pivots.push(at.p);
  }
  // How many fit: step round once from the first, counting.
  let gone = 0;
  let fits = 0;
  at = first;
  for (let i = 0; i < MAX_TRACK_PIECES * 4; i++) {
    const step = nextPivot(loop, at, pitch);
    if (!(step.run > 0)) break;
    if (gone + step.run >= length) {
      fits = i + (length - gone) / step.run;
      break;
    }
    gone += step.run;
    at = step.at;
  }
  return { pivots, length, fits };
}

/** The distance between a piece's pivots, across its axis. */
export function trackPitch(t: Pick<TrackSpec, "start" | "end" | "axis">): number {
  const a = new Vector3(...t.axis).normalize();
  const d = new Vector3(...t.end).sub(new Vector3(...t.start));
  return d.addScaledVector(a, -d.dot(a)).length();
}

/** The piece's own frame: along it (start to end), its axis, and the side that faces the wheels. */
function pieceFrame(t: TrackSpec): { d: Vector3; a: Vector3; o: Vector3 } {
  const a = new Vector3(...t.axis).normalize();
  const d = new Vector3(...t.end).sub(new Vector3(...t.start));
  d.addScaledVector(a, -d.dot(a)).normalize();
  return { d, a, o: a.clone().cross(d) };
}

/**
 * How far the piece reaches past its pivot line towards the wheels: the
 * lift that sets its inside face on their circles.
 */
export function insideReach(positions: ArrayLike<number>, t: TrackSpec): number {
  const { o } = pieceFrame(t);
  // With the piece turned over, its other side faces in.
  const k = t.flip ? -1 : 1;
  let most = 0;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const v = ((positions[i] - t.start[0]) * o.x + (positions[i + 1] - t.start[1]) * o.y + (positions[i + 2] - t.start[2]) * o.z) * k;
    if (v > most) most = v;
  }
  return Math.round(most * 100) / 100;
}

/** A wheel's circle, in the world: centre, axle, radius. */
export interface WorldCircle {
  centre: Vector3;
  normal: Vector3;
  radius: number;
}

export interface TrackLayout extends ChainLayout {
  /** Each piece's place: from its own frame to the world. */
  pieces: Matrix4[];
  pitch: number;
  /** The plane the track runs in (the pivots are in its u, v; the loop runs anticlockwise about its normal). */
  plane?: { origin: Vector3; normal: Vector3; u: Vector3; v: Vector3 };
}

/** Where every piece of the track goes, round the wheels' circles (in the world). */
export function layTrack(t: TrackSpec, wheels: WorldCircle[]): TrackLayout {
  const pitch = trackPitch(t);
  const empty: TrackLayout = { pieces: [], pivots: [], length: 0, fits: 0, pitch };
  if (wheels.length < 2 || !(pitch > 0.01)) return empty;
  // The plane the track runs in: the first wheel's circle.
  const O = wheels[0].centre.clone();
  const W = wheels[0].normal.clone().normalize();
  const u = new Vector3(1, 0, 0).cross(W);
  if (u.lengthSq() < 1e-6) u.set(0, 1, 0).cross(W);
  u.normalize();
  const v = W.clone().cross(u);
  const circles: Circle2[] = wheels.map(w => {
    const c = w.centre.clone().sub(O);
    return { x: c.dot(u), y: c.dot(v), r: Math.max(0, w.radius + t.lift) };
  });
  const loop = wrapLoop(circles);
  const chain = layChain(loop, pitch, Math.max(1, Math.min(MAX_TRACK_PIECES, Math.round(t.count))), t.offset);
  if (!chain.pivots.length) return { ...empty, length: chain.length };
  const to3 = (p: P2) => O.clone().addScaledVector(u, p[0]).addScaledVector(v, p[1]).addScaledVector(W, t.side);
  const own = pieceFrame(t);
  const B = new Matrix4().makeBasis(own.d, own.a, own.o);
  const Bt = B.clone().transpose();
  const start = new Vector3(...t.start);
  const n = chain.pivots.length;
  // Turned over, a piece stays where it was along the axle: its middle (0, 0, 0 in its frame) where it was.
  const across = t.flip ? -2 * start.dot(own.a) : 0;
  const pieces = chain.pivots.map((p, i) => {
    const P = to3(p);
    const next = n > 1 ? to3(chain.pivots[(i + 1) % n]) : P.clone().add(u);
    const d = next.sub(P).normalize();
    P.addScaledVector(W, across);
    // Its pins along the axle; the loop runs anticlockwise about W, so W × d points in, at the wheels.
    const a = t.flip ? W.clone().negate() : W.clone();
    const o = a.clone().cross(d);
    const R = new Matrix4().makeBasis(d, a, o).multiply(Bt);
    const at = P.sub(start.clone().applyMatrix4(R));
    return R.setPosition(at);
  });
  return { pieces, pivots: chain.pivots, length: chain.length, fits: chain.fits, pitch, plane: { origin: O.clone().addScaledVector(W, t.side), normal: W, u, v } };
}

/**
 * The track's triangles: the piece's (in its frame) once per place, each
 * moved by `frame` (the world to the track's own frame) times its place.
 */
export function trackTriangles(piece: ArrayLike<number>, places: Matrix4[], frame: Matrix4): Float32Array {
  const out = new Float32Array(piece.length * places.length);
  const e = new Matrix4();
  places.forEach((m, k) => {
    e.multiplyMatrices(frame, m);
    const s = e.elements;
    const base = k * piece.length;
    for (let i = 0; i + 2 < piece.length; i += 3) {
      const x = piece[i], y = piece[i + 1], z = piece[i + 2];
      out[base + i] = s[0] * x + s[4] * y + s[8] * z + s[12];
      out[base + i + 1] = s[1] * x + s[5] * y + s[9] * z + s[13];
      out[base + i + 2] = s[2] * x + s[6] * y + s[10] * z + s[14];
    }
  });
  return out;
}
