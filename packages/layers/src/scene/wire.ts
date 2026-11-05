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

import { CatmullRomCurve3, Matrix3, Matrix4, Vector3 } from "three";
import type { ScenePart } from "./model";
import type { WireEnd, WireSpec } from "./wireSpec";

/** Mm a wire runs straight out of each end before it bends. */
export function leadLength(spec: Pick<WireSpec, "diameter">): number {
  return Math.max(3, spec.diameter * 2);
}

export interface WireRoute {
  /** The points the curve goes through, in the world. */
  controls: Vector3[];
  /** The wire's middle, sampled evenly along it. */
  centre: Vector3[];
  /** Its length along the middle, mm. */
  length: number;
}

interface Anchor {
  p: Vector3;
  /** The way out of the face (none for a free waypoint). */
  n: Vector3 | null;
}

function anchor(e: Pick<WireEnd, "part" | "point"> & { normal?: WireEnd["normal"] }, mats: Map<string, Matrix4>): Anchor | null {
  const m = mats.get(e.part);
  if (!m) return null;
  const p = new Vector3(...e.point).applyMatrix4(m);
  const n = e.normal ? new Vector3(...e.normal).applyMatrix3(new Matrix3().setFromMatrix4(m)).normalize() : null;
  return { p, n };
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
export function wireRoute(spec: WireSpec, mats: Map<string, Matrix4>): WireRoute | null {
  const a = anchor(spec.from, mats);
  const b = anchor(spec.to, mats);
  if (!a || !b || !a.n || !b.n) return null;
  const r = spec.diameter / 2;
  const lead = leadLength(spec);
  // The run between the two leads: waypoints on faces lifted by the radius, free ones placed after.
  const mid: (Anchor | { lift: number })[] = [];
  for (const w of spec.waypoints) {
    if (w.part && w.point) {
      const at = anchor({ part: w.part, point: w.point, normal: w.normal }, mats);
      if (!at) continue;
      if (at.n) at.p.addScaledVector(at.n, r);
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
  const spans = run.slice(1).map((q, i) => q.p.distanceTo(run[i].p));
  const total = spans.reduce((s, x) => s + x, 0);
  const bows = run.slice(1).map((p1, i) => {
    const p0 = run[i];
    const L = spans[i];
    const s = total > 1e-6 ? (spec.slack * L) / total : 0;
    const h = Math.sqrt((3 * L * s) / 8);
    if (L <= 0.5 || h <= 0.05) return null;
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
  return { controls, centre, length };
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

/** The wire's model in the world, for the parts placed by `mats` (empty when it can't be laid). */
export function wireTriangles(part: ScenePart, mats: Map<string, Matrix4>): Float32Array {
  if (!part.wire) return new Float32Array(0);
  const route = wireRoute(part.wire, mats);
  return route ? tubeTriangles(route.centre, part.wire.diameter / 2) : new Float32Array(0);
}

/** How long a wire is between its ends, mm (0 when it can't be laid). */
export function wireLength(part: ScenePart, mats: Map<string, Matrix4>): number {
  return part.wire ? wireRoute(part.wire, mats)?.length || 0 : 0;
}
