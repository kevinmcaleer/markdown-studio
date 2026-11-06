// "Route round parts": a wire's waypoints worked out so it runs round the
// model's solid parts rather than through them (see wireAvoid.ts for how a
// way round is found). Waypoints put in by hand stay where they are: each
// stretch between them is routed by itself. Waypoints made by an earlier
// routing (`auto`) are replaced.

import { Matrix4, Vector3 } from "three";
import { alongside, anchor, cableRadius, leadLength, MIN_BEND, wireRoute } from "./wire";
import { clearance, findWay, nearestPart, SQUEEZE_ROOM, tighten, WIRE_ROOM, type RouteEnd, type SolidGrid, type Way } from "./wireAvoid";
import type { Looms, WireSpec, WireWaypoint } from "./wireSpec";

export interface RoutedWire {
  waypoints: WireWaypoint[];
  /** How many stretches couldn't be routed round (left straight). */
  stuck: number;
  /** Whether the drawn wire, bows and all, stays off every part. */
  clear: boolean;
}

/** The longest straight stretch tried, in turn, until the drawn wire (which bows with its slack) stays clear. */
const RUNS = [Infinity, 40, 20, 10];

/**
 * Each corner of the run cut back along both its stretches, as far as a
 * bend `radius` round needs (up to most of the shorter stretch), so the
 * smooth curve through the points turns round it instead of kinking.
 * `pts` runs from one fixed point to the next; only the ones between move.
 */
export function roundCorners(pts: Vector3[], radius: number): Vector3[] {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], p = pts[i], b = pts[i + 1];
    const u = p.clone().sub(a), w = b.clone().sub(p);
    const la = u.length(), lb = w.length();
    if (la < 1e-6 || lb < 1e-6) continue;
    u.divideScalar(la);
    w.divideScalar(lb);
    const turn = Math.acos(Math.max(-1, Math.min(1, u.dot(w))));
    if (turn < 0.05) {
      out.push(p);
      continue;
    }
    const cut = Math.min(radius * Math.tan(turn / 2), la * 0.45, lb * 0.45);
    out.push(p.clone().addScaledVector(u, -cut), p.clone().addScaledVector(w, cut));
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/**
 * `spec`'s waypoints routed round the solids in `g`, with its parts placed by
 * `mats` (assembled). `room`: mm more to keep off the parts, for wires that
 * run beside this one. Null when its ends aren't there.
 */
export function routeWire(spec: WireSpec, mats: Map<string, Matrix4>, g: SolidGrid, looms?: Looms, room = 0): RoutedWire | null {
  const a = anchor(spec.from, mats);
  const b = anchor(spec.to, mats);
  if (!a?.n || !b?.n) return null;
  const r = cableRadius(spec);
  const lead = leadLength({ diameter: r * 2 });
  const keep = r + WIRE_ROOM + room;
  // Through a hole or slot, it may squeeze down to this.
  const hard = r + SQUEEZE_ROOM + room;
  const own = spec.waypoints.filter(w => !w.auto);
  // The fixed points in order: each lead's end, each waypoint on a face (lifted off it),
  // and each stretch beside another wire (from where it joins to where it leaves).
  // Next to a free (bowed) waypoint, the stretches either side are left as they are.
  type Fixed = { at: RouteEnd | null; out?: RouteEnd; way?: WireWaypoint };
  const fixed: Fixed[] = [{ at: { p: a.p.clone().addScaledVector(a.n, lead), n: a.n } }];
  for (const w of own) {
    const last = fixed[fixed.length - 1];
    if (w.along) {
      const loom = looms?.get(w.along.wire);
      const prev = last.out ?? last.at;
      const beside = loom && loom !== spec && prev ? alongside(w.along, { ...loom, waypoints: loom.waypoints.filter(x => !x.along) }, mats, r, prev.p) : [];
      fixed.push(beside.length ? { at: { p: beside[0].p, n: null }, out: { p: beside[beside.length - 1].p, n: null }, way: w } : { at: null, way: w });
    } else if (w.part && w.point) {
      const at = anchor({ part: w.part, point: w.point, normal: w.normal }, mats);
      if (at?.n) at.p.addScaledVector(at.n, r);
      fixed.push({ at: at ? { p: at.p, n: at.n } : null, way: w });
    } else fixed.push({ at: null, way: w });
  }
  fixed.push({ at: { p: b.p.clone().addScaledVector(b.n, lead), n: b.n } });
  const toWay = (p: Vector3): WireWaypoint => {
    const part = nearestPart(g, p) ?? spec.from.part;
    const m = mats.get(part) ?? mats.get(spec.from.part)!;
    const q = p.clone().applyMatrix4(m.clone().invert());
    const round = (x: number) => Math.round(x * 100) / 100;
    return { part, point: [round(q.x), round(q.y), round(q.z)], auto: true };
  };
  // Corners rounded to the gentlest bend the wire wants, if that stays clear; else as found.
  const bend = MIN_BEND * r * 2 * 1.2;
  const tries = RUNS.flatMap(maxRun => [{ maxRun, round: true }, { maxRun, round: false }]);
  // Each stretch's way found once; pulled tight differently on each try.
  const found = new Map<number, Way | null>();
  const wayFor = (i: number) => {
    if (!found.has(i)) found.set(i, findWay(g, (fixed[i].out ?? fixed[i].at)!, fixed[i + 1].at!, keep, hard));
    return found.get(i)!;
  };
  let best: RoutedWire | null = null;
  for (const { maxRun, round } of tries) {
    const ways: WireWaypoint[] = [];
    let stuck = 0;
    for (let i = 0; i < fixed.length - 1; i++) {
      const s = fixed[i], e = fixed[i + 1];
      const from = s.out ?? s.at;
      if (from && e.at) {
        // Leaving a waypoint on a face, the way off it is along its normal; arriving, back along it.
        const to = { p: e.at.p, n: e.at.n };
        const way = wayFor(i);
        const pts = way ? tighten(g, way, maxRun) : null;
        if (pts) ways.push(...(round ? roundCorners([from.p, ...pts, to.p], bend).slice(1, -1) : pts).map(toWay));
        else stuck++;
      }
      if (e.way) ways.push(e.way);
    }
    const route = wireRoute({ ...spec, waypoints: ways }, mats, looms);
    // The drawn wire, away from its plugs and the faces it is held to, off every surface by about its radius.
    const near = heldNear(spec, mats, a.p, b.p, lead, r + WIRE_ROOM);
    const clear = !!route && route.centre.every(p => near(p) || clearance(g, p) + g.cell * 0.5 >= r * 0.9);
    best = { waypoints: ways, stuck, clear };
    if (clear) break;
  }
  return best;
}

/** Whether a wire's drawn run passes through a solid, away from its plugs. */
export function wireHitsParts(spec: WireSpec, mats: Map<string, Matrix4>, g: SolidGrid, looms?: Looms): boolean {
  const a = anchor(spec.from, mats);
  const b = anchor(spec.to, mats);
  const route = wireRoute(spec, mats, looms);
  if (!a || !b || !route) return false;
  const r = cableRadius(spec);
  const lead = leadLength({ diameter: r * 2 });
  const near = heldNear(spec, mats, a.p, b.p, lead, r + WIRE_ROOM);
  return route.centre.some(p => !near(p) && clearance(g, p) < g.cell * 0.5);
}

/** Whether a point of a wire is where it is meant to touch a part: by a plug, or by a waypoint put on a face by hand. */
function heldNear(spec: WireSpec, mats: Map<string, Matrix4>, a: Vector3, b: Vector3, lead: number, keep: number): (p: Vector3) => boolean {
  const held = spec.waypoints.flatMap(w => (!w.auto && w.part && w.point && w.normal ? [anchor({ part: w.part, point: w.point }, mats)?.p] : [])).filter((p): p is Vector3 => !!p);
  return p => p.distanceTo(a) < lead + keep * 2 || p.distanceTo(b) < lead + keep * 2 || held.some(h => p.distanceTo(h) < keep * 2);
}

/** Mm more a wire keeps off the parts, so the wires running beside it (in `looms`) clear them too. */
export function followRoom(id: string, looms: Looms): number {
  let room = 0;
  for (const w of looms.values()) if (w.waypoints.some(x => x.along?.wire === id)) room = Math.max(room, cableRadius(w) * 2);
  return room;
}

/**
 * Wires in the order to route them: each wire after the ones it runs beside
 * (whose new way it then follows), and with them the wires beside any of
 * `wires` (which move when it does), from `all`.
 */
export function routeOrder<T extends { id: string; wire?: WireSpec }>(wires: T[], all: T[]): T[] {
  const byId = new Map(all.filter(p => p.wire).map(p => [p.id, p]));
  const want = new Set(wires.filter(w => w.wire).map(w => w.id));
  // Followers come along (and their followers).
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of byId.values())
      if (!want.has(p.id) && p.wire!.waypoints.some(x => x.along && want.has(x.along.wire))) {
        want.add(p.id);
        grew = true;
      }
  }
  const out: T[] = [];
  const done = new Set<string>();
  const visit = (id: string, seen: Set<string>) => {
    const p = byId.get(id);
    if (!p || done.has(id) || seen.has(id)) return;
    seen.add(id);
    for (const x of p.wire!.waypoints) if (x.along && want.has(x.along.wire)) visit(x.along.wire, seen);
    done.add(id);
    out.push(p);
  };
  for (const id of want) visit(id, new Set());
  return out;
}
