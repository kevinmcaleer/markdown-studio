// How a wire is drawn: the line it runs along, and the tube round that line.
//
// The wire leaves each end straight out along the end's normal (a lead
// leaves a plug's back straight), passes through its waypoints, each lifted
// off its face by the wire's radius so it lies on the face rather than in
// it, and takes up its slack by bowing each free span out: away from the
// faces either side, or down when they face each other, by as much as makes
// the span `slack` longer (a parabola's sag). A smooth curve (centripetal
// Catmull-Rom) through those points is the wire's middle, and a round tube
// along it, with flat ends, is its model.
//
// Every point belongs to a part, so the line is worked out again from the
// parts' places whenever they move: across an exploded joint, the free span
// stretches, as a real wire does.

import { CatmullRomCurve3, Color, Matrix3, Matrix4, Vector3 } from "three";
import type { ScenePart } from "./model";
import { BUNDLE_TWIST, coresOf, type Looms, type WireAlong, type WireEnd, type WireSpec } from "./wireSpec";

/** Mm a wire runs straight out of each end before it bends. */
export function leadLength(spec: Pick<WireSpec, "diameter">): number {
  return Math.max(3, spec.diameter * 2);
}

/** How far off the route a cable's wires sit, round it: touching, `n` of them each `r` across the middle. */
export function ringRadius(n: number, r: number): number {
  if (n <= 1) return 0;
  return n === 2 ? r : r / Math.sin(Math.PI / n);
}

/** How far a wire (or a cable's bundle) stands off a face it lies on. */
export function cableRadius(spec: Pick<WireSpec, "diameter" | "cores" | "lay">): number {
  const r = spec.diameter / 2;
  const n = spec.cores && spec.cores.length > 1 ? spec.cores.length : 1;
  // A flat cable lies on its face; a bundle on its round.
  return spec.lay === "flat" ? r : ringRadius(n, r) + r;
}

export interface WireRoute {
  /** The points the curve goes through, in the world. */
  controls: Vector3[];
  /** The wire's middle, sampled evenly along it. */
  centre: Vector3[];
  /** Its length along the middle, mm. */
  length: number;
  /** Each end's row of pins in the world (for a cable's wires to leave side by side), when it has one. */
  rows: [Vector3 | null, Vector3 | null];
}

export interface Anchor {
  p: Vector3;
  /** The way out of the face (none for a free waypoint). */
  n: Vector3 | null;
  row?: Vector3 | null;
  /** Held beside another wire (in a loom): the span to the next tied point doesn't bow. */
  tied?: boolean;
  /** Put there by routing round the parts: the spans either side run straight, as routed (a bow could sag into a part). */
  auto?: boolean;
}

/**
 * The points a wire of radius `r` passes running beside `loom` (another
 * wire, as laid by `mats`) along `along`'s stretch of it, touching it, on
 * the side it comes from (`from`, the point before). None when the other
 * wire can't be laid.
 */
export function alongside(along: WireAlong, loom: WireSpec, mats: Map<string, Matrix4>, r: number, from: Vector3): Anchor[] {
  const route = wireRoute(loom, mats);
  if (!route || route.centre.length < 2) return [];
  const c = route.centre;
  // By length along it (its samples aren't evenly spread over the whole).
  const run = [0];
  for (let i = 1; i < c.length; i++) run.push(run[i - 1] + c[i].distanceTo(c[i - 1]));
  const total = run[run.length - 1] || 1;
  const at = (t: number) => {
    const want = Math.max(0, Math.min(1, t)) * total;
    let i = 0;
    while (i < c.length - 2 && run[i + 1] < want) i++;
    const f = (want - run[i]) / (run[i + 1] - run[i] || 1);
    return { p: c[i].clone().lerp(c[i + 1], Math.max(0, Math.min(1, f))), t: c[i + 1].clone().sub(c[i]) };
  };
  const span = Math.abs(along.to - along.from) * route.length;
  const n = Math.max(2, Math.min(30, Math.ceil(span / Math.max(4, loom.diameter * 3)) + 1));
  const gap = cableRadius(loom) + r;
  const out: Anchor[] = [];
  let side: Vector3 | null = null;
  for (let k = 0; k < n; k++) {
    const { p, t } = at(along.from + ((along.to - along.from) * k) / (n - 1));
    // The same side all the way: the last way across, square to here.
    side = across(t, side || from.clone().sub(p));
    out.push({ p: p.addScaledVector(side, gap), n: null, tied: true });
  }
  return out;
}

export function anchor(e: Pick<WireEnd, "part" | "point"> & { normal?: WireEnd["normal"]; row?: WireEnd["row"] }, mats: Map<string, Matrix4>): Anchor | null {
  const m = mats.get(e.part);
  if (!m) return null;
  const p = new Vector3(...e.point).applyMatrix4(m);
  const turn = new Matrix3().setFromMatrix4(m);
  const n = e.normal ? new Vector3(...e.normal).applyMatrix3(turn).normalize() : null;
  const row = e.row ? new Vector3(...e.row).applyMatrix3(turn).normalize() : null;
  return { p, n, row };
}

/** A way across `chord`, as close to `want` as can be (down, failing that, then anything). */
function across(chord: Vector3, want: Vector3 | null): Vector3 {
  const c = chord.clone().normalize();
  for (const w of [want, new Vector3(0, 0, -1), new Vector3(1, 0, 0), new Vector3(0, 1, 0)]) {
    if (!w || w.lengthSq() < 1e-12) continue;
    const d = w.clone().addScaledVector(c, -w.dot(c));
    if (d.lengthSq() > 0.04 * w.lengthSq()) return d.normalize();
  }
  return new Vector3(0, 0, 1);
}

/**
 * The wire's line through the parts, placed by `mats` (each part's place in
 * the world, as worldMatrices gives). Null when one of its ends' parts isn't
 * there.
 */
export function wireRoute(spec: WireSpec, mats: Map<string, Matrix4>, looms?: Looms): WireRoute | null {
  const a = anchor(spec.from, mats);
  const b = anchor(spec.to, mats);
  if (!a || !b || !a.n || !b.n) return null;
  const r = cableRadius(spec);
  const lead = leadLength({ diameter: r * 2 });
  // The run between the two leads: waypoints on faces lifted by the radius, free ones placed after.
  const mid: (Anchor | { lift: number })[] = [];
  for (const w of spec.waypoints) {
    if (w.along) {
      // Beside another wire for a stretch (that wire laid as it is, not along any of its own).
      const loom = looms?.get(w.along.wire);
      if (!loom || loom === spec) continue;
      const before = [...mid].reverse().find((m): m is Anchor => "p" in m)?.p || a.p.clone().addScaledVector(a.n, lead);
      mid.push(...alongside(w.along, { ...loom, waypoints: loom.waypoints.filter(x => !x.along) }, mats, r, before));
      continue;
    }
    if (w.part && w.point) {
      const at = anchor({ part: w.part, point: w.point, normal: w.normal }, mats);
      if (!at) continue;
      if (at.n) at.p.addScaledVector(at.n, r);
      if (w.auto) at.auto = true;
      mid.push(at);
    } else if (typeof w.lift === "number") mid.push({ lift: w.lift });
  }
  const run: Anchor[] = [{ p: a.p.clone().addScaledVector(a.n, lead), n: a.n }];
  const placed = mid.map(m => ("p" in m ? m : null));
  for (let i = 0; i < mid.length; i++) {
    const m = mid[i];
    if ("p" in m) {
      run.push(m);
      continue;
    }
    // Free: up from the line between the nearest placed points either side.
    const before = run[run.length - 1].p;
    let after = b.p.clone().addScaledVector(b.n, lead);
    for (let k = i + 1; k < mid.length; k++) {
      const q = placed[k];
      if (q) {
        after = q.p;
        break;
      }
    }
    run.push({ p: before.clone().lerp(after, 0.5).add(new Vector3(0, 0, m.lift)), n: null });
  }
  run.push({ p: b.p.clone().addScaledVector(b.n, lead), n: b.n });
  // Slack bows each span, shared out by length: a point off the middle of
  // each, as far as a parabola sags with that much extra. The curve through
  // them isn't quite a parabola, so the bow is scaled until the wire really
  // is `slack` longer than pulled tight.
  // Spans held in a loom don't bow, so they don't share in the slack.
  const spans = run.slice(1).map((q, i) => ((q.tied && run[i].tied) || q.auto || run[i].auto ? 0 : q.p.distanceTo(run[i].p)));
  const total = spans.reduce((s, x) => s + x, 0);
  const bows = run.slice(1).map((p1, i) => {
    const p0 = run[i];
    const L = spans[i];
    const s = total > 1e-6 ? (spec.slack * L) / total : 0;
    const h = Math.sqrt((3 * L * s) / 8);
    if (L <= 0.5 || h <= 0.05 || (p0.tied && p1.tied) || p0.auto || p1.auto) return null;
    const want = new Vector3();
    if (p0.n) want.add(p0.n);
    if (p1.n) want.add(p1.n);
    const dir = across(p1.p.clone().sub(p0.p), want.lengthSq() > 0.01 ? want : null);
    return { mid: p0.p.clone().lerp(p1.p, 0.5), dir, h };
  });
  const controlsFor = (k: number) => {
    const body: Vector3[] = [run[0].p];
    run.slice(1).forEach((p1, i) => {
      const b = bows[i];
      if (b && k > 0) body.push(b.mid.clone().addScaledVector(b.dir, b.h * k));
      body.push(p1.p);
    });
    // Points on top of each other make the curve kink: dropped.
    return [a.p.clone(), ...body, b.p.clone()].filter((p, i, all) => i === 0 || p.distanceTo(all[i - 1]) > 1e-3);
  };
  const curveOf = (pts: Vector3[]) => new CatmullRomCurve3(pts, false, "centripetal");
  let controls = controlsFor(1);
  if (controls.length < 2) return null;
  let curve = curveOf(controls);
  if (bows.some(Boolean) && spec.slack > 0) {
    const tight = curveOf(controlsFor(0)).getLength();
    const want = tight + spec.slack;
    // Secant steps on the bow's scale: a few are plenty.
    let k0 = 0, l0 = tight, k1 = 1, l1 = curve.getLength();
    for (let i = 0; i < 6 && Math.abs(l1 - want) > 0.05; i++) {
      const k = Math.max(0, Math.min(4, k1 + ((want - l1) * (k1 - k0)) / (l1 - l0 || 1e-9)));
      k0 = k1;
      l0 = l1;
      k1 = k;
      controls = controlsFor(k1);
      curve = curveOf(controls);
      l1 = curve.getLength();
    }
  }
  const length = curve.getLength();
  // Samples evenly spread in each stretch between points, so every point the wire passes through is one of them.
  const per = Math.max(2, Math.ceil(Math.max(24, Math.min(600, length / Math.max(0.4, spec.diameter * 0.6))) / (controls.length - 1)));
  const centre = curve.getPoints(per * (controls.length - 1));
  return { controls, centre, length, rows: [a.row || null, b.row || null] };
}

/** Frames carried along a line without twisting (parallel transport): the way across at each point, starting from `start`. */
function frames(centre: Vector3[], start: Vector3 | null): { t: Vector3[]; n: Vector3[]; b: Vector3[] } {
  const count = centre.length;
  const t = centre.map((_, i) => {
    const d = centre[Math.min(count - 1, i + 1)].clone().sub(centre[Math.max(0, i - 1)]);
    return d.lengthSq() > 1e-12 ? d.normalize() : new Vector3(0, 0, 1);
  });
  const n: Vector3[] = [];
  const b: Vector3[] = [];
  let cur = across(t[0], start);
  for (let i = 0; i < count; i++) {
    if (i > 0) {
      cur = cur.clone().addScaledVector(t[i], -cur.dot(t[i]));
      if (cur.lengthSq() < 1e-10) cur = across(t[i], null);
      cur.normalize();
    }
    n.push(cur);
    b.push(t[i].clone().cross(cur).normalize());
  }
  return { t, n, b };
}

const smooth = (x: number) => {
  const c = Math.max(0, Math.min(1, x));
  return c * c * (3 - 2 * c);
};

/**
 * Where each of a cable's wires runs, pin 1's first: one line for a single
 * wire (the route's middle). A cable's wires leave each plug side by side
 * at its pins' spacing, then gather over the first few mm: round the
 * middle, touching and turning round each other by `twist` (a bundle), or
 * side by side and turned from one plug's row to the other's (flat, as a
 * servo lead).
 */
export function coreLines(spec: WireSpec, route: WireRoute): Vector3[][] {
  const cores = coresOf(spec);
  const count = cores.length;
  if (count < 2) return [route.centre];
  const centre = route.centre;
  const r = spec.diameter / 2;
  const { n, b } = frames(centre, route.rows[0]);
  const s: number[] = [0];
  for (let i = 1; i < centre.length; i++) s.push(s[i - 1] + centre[i].distanceTo(centre[i - 1]));
  const L = s[s.length - 1] || 1;
  // The far plug's row, as an angle round the line in the frames carried there.
  const last = centre.length - 1;
  const rowB = route.rows[1];
  const far = rowB ? Math.atan2(rowB.dot(b[last]), rowB.dot(n[last])) : 0;
  // A plug's pins are no closer than its wires are thick.
  const pitchA = Math.max(spec.diameter, spec.from.pitch || spec.diameter);
  const pitchB = Math.max(spec.diameter, spec.to.pitch || spec.diameter);
  const gather = Math.min(L / 3, Math.max(6, leadLength({ diameter: cableRadius(spec) * 2 }) * 2));
  const flat = spec.lay === "flat";
  // The turn along the cable: about its twist, but ending where the far
  // plug's row is (whole turns more or less), so its wires meet that plug's
  // pins in order rather than crossing over each other to reach them.
  const want = (((spec.twist ?? (flat ? 0 : BUNDLE_TWIST)) * Math.PI) / 180 / 100) * L;
  const turn = far + 2 * Math.PI * Math.round((want - far) / (2 * Math.PI));
  const ring = ringRadius(count, r);
  // Each wire's place round a bundle, in the order its pin is along the
  // plug's row, so they gather without passing through each other. A small
  // phase keeps no two places level across the row.
  const phase = Math.PI / (2 * count);
  const slots = Array.from({ length: count }, (_, i) => (2 * Math.PI * i) / count + phase).sort((x, y) => Math.cos(x) - Math.cos(y));
  const lines: Vector3[][] = cores.map(() => []);
  for (let j = 0; j < centre.length; j++) {
    let wa = 1 - smooth(s[j] / gather);
    let wb = 1 - smooth((L - s[j]) / gather);
    if (wa + wb > 1) {
      const k = wa + wb;
      wa /= k;
      wb /= k;
    }
    const mid = 1 - wa - wb;
    const dir = (angle: number) => n[j].clone().multiplyScalar(Math.cos(angle)).addScaledVector(b[j], Math.sin(angle));
    const rowAt0 = n[j];
    const rowAt1 = dir(far);
    for (let i = 0; i < count; i++) {
      const k = i - (count - 1) / 2;
      const off = new Vector3();
      if (flat) {
        // Side by side all along, turning from the first plug's row to the far one's.
        const angle = turn * (s[j] / L);
        const pitch = wa * pitchA + wb * pitchB + mid * spec.diameter;
        off.addScaledVector(dir(angle), k * pitch);
      } else {
        off.addScaledVector(rowAt0, k * pitchA * wa).addScaledVector(rowAt1, k * pitchB * wb);
        off.addScaledVector(dir(slots[i] + turn * (s[j] / L)), ring * mid);
      }
      lines[i].push(centre[j].clone().add(off));
    }
  }
  return lines;
}

/** Sides round a wire's tube: enough that it reads round, with no fold lines along it. */
export const TUBE_SIDES = 16;

/**
 * A round tube of `radius` along `centre`, closed with flat ends, as
 * triangles (nine numbers each, in the world). Its rings are carried along
 * without twisting (parallel transport), so the sides don't spiral.
 */
export function tubeTriangles(centre: Vector3[], radius: number, sides = TUBE_SIDES): Float32Array {
  const n = centre.length;
  if (n < 2) return new Float32Array(0);
  const tangents = centre.map((_, i) => {
    const t = centre[Math.min(n - 1, i + 1)].clone().sub(centre[Math.max(0, i - 1)]);
    return t.lengthSq() > 1e-12 ? t.normalize() : new Vector3(0, 0, 1);
  });
  // The first ring's frame: any normal across the first tangent, then carried along.
  let normal = across(tangents[0], new Vector3(0, 0, 1));
  const rings: Vector3[][] = [];
  for (let i = 0; i < n; i++) {
    const t = tangents[i];
    if (i > 0) {
      normal.addScaledVector(t, -normal.dot(t));
      if (normal.lengthSq() < 1e-10) normal = across(t, null);
      normal.normalize();
    }
    const bi = t.clone().cross(normal).normalize();
    const ring: Vector3[] = [];
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      ring.push(centre[i].clone().addScaledVector(normal, Math.cos(a) * radius).addScaledVector(bi, Math.sin(a) * radius));
    }
    rings.push(ring);
  }
  const out: number[] = [];
  const push = (...vs: Vector3[]) => vs.forEach(v => out.push(v.x, v.y, v.z));
  for (let i = 0; i + 1 < n; i++) {
    for (let k = 0; k < sides; k++) {
      const a = rings[i][k], b = rings[i][(k + 1) % sides], c = rings[i + 1][(k + 1) % sides], d = rings[i + 1][k];
      push(a, b, c, a, c, d);
    }
  }
  // Flat ends, facing out along the line.
  for (let k = 0; k < sides; k++) {
    push(centre[0], rings[0][(k + 1) % sides], rings[0][k]);
    push(centre[n - 1], rings[n - 1][k], rings[n - 1][(k + 1) % sides]);
  }
  return new Float32Array(out);
}

/**
 * The first `upto` (0 to 1) of a line, by its length, so a growing wire
 * grows smoothly: its points spread evenly along that stretch, as many as
 * the share of the line's own (so a cable's cores keep the same count).
 */
export function growLine(line: Vector3[], upto: number): Vector3[] {
  if (upto >= 1 || line.length < 2) return line;
  const run = [0];
  for (let i = 1; i < line.length; i++) run.push(run[i - 1] + line[i].distanceTo(line[i - 1]));
  const want = Math.max(0, upto) * run[run.length - 1];
  const n = Math.max(2, Math.ceil(line.length * Math.max(0, upto)) + 1);
  const out: Vector3[] = [];
  let j = 1;
  for (let k = 0; k < n; k++) {
    // A hair along, so the tip never sits on the start.
    const at = Math.max(want, 1e-3) * (k / (n - 1));
    while (j < line.length - 1 && run[j] < at) j++;
    const d = run[j] - run[j - 1];
    out.push(line[j - 1].clone().lerp(line[j], d > 0 ? Math.min(1, (at - run[j - 1]) / d) : 0));
  }
  return out;
}

export interface WireMesh {
  /** Triangles in the world, nine numbers each. */
  positions: Float32Array;
  /** Each corner's colour (r, g, b, 0 to 1): its wire's. */
  colors: Float32Array;
}

/** The wire's (or cable's) model in the world, each wire in its colour, for the parts placed by `mats` (empty when it can't be laid). */
export function wireMesh(part: ScenePart, mats: Map<string, Matrix4>, upto = 1, looms?: Looms, fromTo = false): WireMesh {
  const empty = { positions: new Float32Array(0), colors: new Float32Array(0) };
  if (!part.wire || upto <= 0) return empty;
  const route = wireRoute(part.wire, mats, looms);
  if (!route) return empty;
  const cores = coresOf(part.wire);
  // Grown part of the way along (as it's put in, in the assembly playback), from its `from` end or, `fromTo`, its `to` end.
  const cut = (line: Vector3[]) => (upto >= 1 ? line : fromTo ? growLine([...line].reverse(), upto).reverse() : growLine(line, upto));
  const tubes = coreLines(part.wire, route).map(line => tubeTriangles(cut(line), part.wire!.diameter / 2));
  const total = tubes.reduce((t, x) => t + x.length, 0);
  const positions = new Float32Array(total);
  const colors = new Float32Array(total);
  const c = new Color();
  let at = 0;
  tubes.forEach((tube, i) => {
    positions.set(tube, at);
    c.set(cores[i].color);
    for (let k = 0; k < tube.length; k += 3) {
      colors[at + k] = c.r;
      colors[at + k + 1] = c.g;
      colors[at + k + 2] = c.b;
    }
    at += tube.length;
  });
  return { positions, colors };
}

/** The wire's model in the world, for the parts placed by `mats` (empty when it can't be laid). */
export function wireTriangles(part: ScenePart, mats: Map<string, Matrix4>, looms?: Looms): Float32Array {
  return wireMesh(part, mats, 1, looms).positions;
}

/** How long a wire is between its ends, mm (0 when it can't be laid). */
export function wireLength(part: ScenePart, mats: Map<string, Matrix4>, looms?: Looms): number {
  return part.wire ? wireRoute(part.wire, mats, looms)?.length || 0 : 0;
}

/** A wire's bend is too tight below this many times its outer diameter (a usual rule for hook-up wire and ribbon). */
export const MIN_BEND = 3;

/**
 * The tightest bend along a route: how far it turns within a stretch of
 * `MIN_BEND` × 2 diameters, as the radius of the arc that turns as much in
 * as long (a wire at its minimum radius turns two radians in that), and
 * where. A plain corner out of a plug is no worry; a hairpin is. Null when
 * the route is too short to tell.
 */
export function tightestBend(route: Pick<WireRoute, "centre" | "length">, diameter: number): { radius: number; at: Vector3 } | null {
  const c = route.centre;
  if (c.length < 3 || route.length <= 0) return null;
  const run = [0];
  for (let i = 1; i < c.length; i++) run.push(run[i - 1] + c[i].distanceTo(c[i - 1]));
  const window = Math.min(route.length, MIN_BEND * 2 * Math.max(diameter, 0.3));
  const dir = (i: number) => c[Math.min(i + 1, c.length - 1)].clone().sub(c[Math.max(0, Math.min(i, c.length - 2))]).normalize();
  let best: { radius: number; at: Vector3 } | null = null;
  let j = 0;
  for (let i = 0; i < c.length - 1; i++) {
    while (j < c.length - 2 && run[j] - run[i] < window) j++;
    const len = run[j] - run[i];
    if (len < window * 0.5) break;
    const turn = dir(i).angleTo(dir(j));
    if (turn < 1e-3) continue;
    const radius = len / turn;
    if (!best || radius < best.radius) best = { radius, at: c[Math.round((i + j) / 2)].clone() };
  }
  return best;
}
