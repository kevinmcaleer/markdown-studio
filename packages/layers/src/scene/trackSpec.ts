// A track's settings, as saved on its part (see track.ts for how it's
// laid). No three.js here, so it loads with the editor.

import type { Vec3 } from "./model";

/** A circle picked on a wheel: its centre, its axle, its radius (a rim or hole snap). */
export interface TrackWheel {
  id: string;
  point: Vec3;
  normal: Vec3;
  radius: number;
}

export interface TrackSpec {
  /** The part repeated (the track piece). */
  link: string;
  count: number;
  /** The piece's pivots, in its frame: where it joins the piece before, and the piece after. */
  start: Vec3;
  end: Vec3;
  /** The way the pivots' pins run, in the piece's frame. */
  axis: Vec3;
  wheels: TrackWheel[];
  /** Mm the pieces are moved on round the loop (lines teeth up with holes). */
  offset: number;
  /** Mm the pivots sit outside the wheels' circles. */
  lift: number;
  /** Mm along the axle, from the first wheel's circle. */
  side: number;
  /** Turned over: the piece's other side faces the wheels. */
  flip?: boolean;
}

const finite = (n: unknown, f: number, lo = -1e5, hi = 1e5) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : f;
};
const v3 = (v: unknown): Vec3 | null => (Array.isArray(v) && v.length === 3 && v.every(n => Number.isFinite(Number(n))) ? (v.map(Number) as Vec3) : null);

/** The most pieces a track may have. */
export const MAX_TRACK_PIECES = 400;

/** `value` as a track's settings, or null when it isn't one. */
export function normalizeTrack(value: unknown): TrackSpec | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const start = v3(v.start), end = v3(v.end), axis = v3(v.axis);
  if (typeof v.link !== "string" || !v.link || !start || !end || !axis || !Array.isArray(v.wheels)) return null;
  const wheels: TrackWheel[] = [];
  for (const w of v.wheels as Record<string, unknown>[]) {
    const point = v3(w?.point), normal = v3(w?.normal), radius = Number(w?.radius);
    if (typeof w?.id === "string" && point && normal && Number.isFinite(radius) && radius > 0) wheels.push({ id: w.id.slice(0, 40), point, normal, radius });
  }
  const t: TrackSpec = {
    link: v.link.slice(0, 40),
    count: Math.round(finite(v.count, 20, 1, MAX_TRACK_PIECES)),
    start,
    end,
    axis,
    wheels: wheels.slice(0, 12),
    offset: finite(v.offset, 0),
    lift: finite(v.lift, 0),
    side: finite(v.side, 0),
  };
  if (v.flip) t.flip = true;
  return t;
}

