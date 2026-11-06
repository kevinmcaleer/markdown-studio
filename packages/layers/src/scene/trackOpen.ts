// A track coming off its wheels, as it's really put on: a long string of
// pieces whose two ends are brought round and joined. Exploded all the way,
// the chain lies open under the wheels' loop with its loose ends at the top,
// turned up and apart; as the explode comes down the ends swing round and
// meet, and the closed track slides on to the wheels.
//
// The track's model is its pieces one after another (track.ts
// trackTriangles), so each piece's triangles can be moved by themselves:
// turned about its start pivot and carried along the chain.

import { Matrix4, Vector3 } from "three";
import { layTrack, type P2, type WorldCircle } from "./track";
import { MAX_TRACK_PIECES, type TrackSpec } from "./trackSpec";

/** Below this much explode the track is closed; above it, it opens, all the way at 1. */
export const TRACK_CLOSED_BY = 0.4;

/** How open a track is (0 closed, 1 open all the way) at an explode of `explode`. */
export function trackOpening(explode: number): number {
  const t = Math.max(0, Math.min(1, (explode - TRACK_CLOSED_BY) / (1 - TRACK_CLOSED_BY)));
  return t * t * (3 - 2 * t);
}

/** How far each loose end turns up, all the way open. */
const CURL = Math.PI / 2;

export interface OpenChain {
  /** Each piece's turn (radians, anticlockwise), by its index round the loop. */
  turn: number[];
  /** Each piece's start pivot, open. */
  at: P2[];
  /** The piece after the break: the chain runs from it round to the one before it. */
  first: number;
}

/**
 * The chain opened by `f` (0–1): broken at the pivot at the top (the most
 * `up`), its middle piece (the bottom) staying put, the pieces nearest each
 * loose end turned outward so the ends point up and apart. `pivots` go
 * anticlockwise round the loop; each piece runs from its pivot to the next.
 */
export function openChain(pivots: P2[], up: P2, f: number): OpenChain | null {
  const n = pivots.length;
  if (n < 6) return null;
  const ul = Math.hypot(up[0], up[1]);
  const U: P2 = ul > 1e-6 ? [up[0] / ul, up[1] / ul] : [0, 1];
  const S: P2 = [U[1], -U[0]];
  const h = pivots.map(p => p[0] * U[0] + p[1] * U[1]);
  const s = pivots.map(p => p[0] * S[0] + p[1] * S[1]);
  const top = Math.max(...h);
  const lo = Math.min(...s), hi = Math.max(...s);
  const pitch = Math.hypot(pivots[1][0] - pivots[0][0], pivots[1][1] - pivots[0][1]) || 1;
  // The break: the pivot at the top, nearest the middle of the top run.
  let first = 0;
  let best = Infinity;
  pivots.forEach((_, k) => {
    if (h[k] < top - pitch * 0.35) return;
    const d = Math.abs(s[k] - (lo + hi) / 2);
    if (d < best) {
      best = d;
      first = k;
    }
  });
  const idx = (j: number) => (first + j) % n;
  const mid = Math.floor(n / 2);
  const K = Math.max(2, Math.min(6, Math.round(n / 10), mid - 1));
  // Joint j is between chain pieces j-1 and j; the K at each end bend outward (clockwise).
  const bend = (j: number) => (j <= K || j >= n - K ? (-CURL / K) * f : 0);
  const r = new Array<number>(n).fill(0);
  for (let j = mid + 1; j < n; j++) r[j] = r[j - 1] + bend(j);
  for (let j = mid - 1; j >= 0; j--) r[j] = r[j + 1] - bend(j + 1);
  const at: P2[] = new Array(n);
  at[mid] = [...pivots[idx(mid)]];
  const turned = (v: P2, a: number): P2 => [v[0] * Math.cos(a) - v[1] * Math.sin(a), v[0] * Math.sin(a) + v[1] * Math.cos(a)];
  const link = (j: number): P2 => {
    const a = pivots[idx(j)], b = pivots[idx(j + 1)];
    return [b[0] - a[0], b[1] - a[1]];
  };
  for (let j = mid + 1; j < n; j++) {
    const d = turned(link(j - 1), r[j - 1]);
    at[j] = [at[j - 1][0] + d[0], at[j - 1][1] + d[1]];
  }
  for (let j = mid - 1; j >= 0; j--) {
    const d = turned(link(j), r[j]);
    at[j] = [at[j + 1][0] - d[0], at[j + 1][1] - d[1]];
  }
  const out: OpenChain = { turn: new Array(n), at: new Array(n), first };
  for (let j = 0; j < n; j++) {
    out.turn[idx(j)] = r[j];
    out.at[idx(j)] = at[j];
  }
  return out;
}

export interface TrackOpener {
  count: number;
  /** Each piece's move from where it is closed to where it is open by `f`, in the track's own frame. */
  moves(f: number): Matrix4[];
  /** Each piece's place (closed) from the first piece's, in the track's own frame. */
  fromFirst: Matrix4[];
}

/**
 * How a track's pieces open, from where its wheels are (`world`: every
 * part assembled). Null when the track can't be opened (too few pieces, or
 * its model doesn't match its settings).
 */
export function trackOpener(trackId: string, spec: TrackSpec, triangles: number, world: Map<string, Matrix4>, up = new Vector3(0, 0, 1)): TrackOpener | null {
  const count = Math.max(1, Math.min(MAX_TRACK_PIECES, Math.round(spec.count)));
  if (count < 6 || triangles % count) return null;
  const own = world.get(trackId);
  if (!own) return null;
  const circles: WorldCircle[] = [];
  for (const w of spec.wheels) {
    const at = world.get(w.id);
    if (!at) return null;
    circles.push({ centre: new Vector3(...w.point).applyMatrix4(at), normal: new Vector3(...w.normal).transformDirection(at), radius: w.radius });
  }
  const lay = layTrack(spec, circles);
  const plane = lay.plane;
  if (!plane || lay.pieces.length !== count) return null;
  const toOwn = own.clone().invert();
  const local = lay.pieces.map(m => toOwn.clone().multiply(m));
  const back = local[0].clone().invert();
  const fromFirst = local.map(m => m.clone().multiply(back));
  const upIn: P2 = [up.dot(plane.u), up.dot(plane.v)];
  // Flat (the track's plane level), "up" is out of the plane: the ends still bend outward, from the top of its u, v.
  const flat = Math.hypot(upIn[0], upIn[1]) < 0.2;
  const to3 = (p: P2) => plane.origin.clone().addScaledVector(plane.u, p[0]).addScaledVector(plane.v, p[1]);
  return {
    count,
    fromFirst,
    moves(f: number): Matrix4[] {
      const open = f > 0 ? openChain(lay.pivots, flat ? [0, 1] : upIn, f) : null;
      if (!open) return local.map(() => new Matrix4());
      return lay.pivots.map((p, k) => {
        const from = to3(p), to = to3(open.at[k]);
        // In the world: about the piece's pivot, along the axle; then carried to its open place.
        const m = new Matrix4().makeTranslation(to.x, to.y, to.z)
          .multiply(new Matrix4().makeRotationAxis(plane.normal, open.turn[k]))
          .multiply(new Matrix4().makeTranslation(-from.x, -from.y, -from.z));
        return toOwn.clone().multiply(m).multiply(own);
      });
    },
  };
}

/** The track's corners, each piece's moved by its move (the pieces one after another, as the model has them). */
export function movePieces(src: ArrayLike<number>, moves: Matrix4[], out = new Float32Array(src.length)): Float32Array {
  const per = src.length / moves.length;
  moves.forEach((m, k) => {
    const e = m.elements;
    for (let i = k * per; i < (k + 1) * per; i += 3) {
      const x = src[i], y = src[i + 1], z = src[i + 2];
      out[i] = e[0] * x + e[4] * y + e[8] * z + e[12];
      out[i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      out[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
  });
  return out;
}

/** The first piece's fold lines copied to every piece, each moved by its move. */
export function movePieceLines(first: ArrayLike<number>, opener: Pick<TrackOpener, "fromFirst">, moves: Matrix4[]): Float32Array {
  const out = new Float32Array(first.length * moves.length);
  const m = new Matrix4();
  moves.forEach((mv, k) => {
    m.multiplyMatrices(mv, opener.fromFirst[k]);
    const e = m.elements;
    const base = k * first.length;
    for (let i = 0; i + 2 < first.length; i += 3) {
      const x = first[i], y = first[i + 1], z = first[i + 2];
      out[base + i] = e[0] * x + e[4] * y + e[8] * z + e[12];
      out[base + i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      out[base + i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
  });
  return out;
}
