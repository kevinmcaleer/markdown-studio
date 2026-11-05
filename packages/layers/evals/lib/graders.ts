// One grader per kind of case. A grader runs the real scene code on the
// case's input and checks what comes out against the case's `expect`.
// Each returns a list of checks (see score.ts); the runner averages them.

import { BufferAttribute, BufferGeometry, Matrix4, Quaternion, Vector3 } from "three";
import { jointPlace } from "../../src/scene/joint";
import { ARROW_FROM, ARROW_TO, placeBeside, type Box3, type ScenePart, type Vec3 } from "../../src/scene/model";
import { arrowEnd, cameraFor, frameTight, localMatrix, worldMatrices, type Placed } from "../../src/scene/render";
import { fitDiameter, fitLength, holeDepth, isHoleSnap, type ScrewHead } from "../../src/scene/screw";
import { Topology, type Face, type Snap } from "../../src/scene/snaps";
import { layTrack, type TrackSpec } from "../../src/scene/track";
import { atLeast, type Check, near, nearPoint, same, show, yes } from "./score";
import { centred, type ReadFile, shapeTriangles, type ShapeSpec } from "./shapes";

export interface Ctx {
  read: ReadFile;
}
type Grader = (input: any, expect: any, ctx: Ctx) => Check[];

// ------------------------------------------------------------ helpers

/** A click: a point to aim at, and the way the camera looks (straight down by default). */
interface Click {
  at: Vec3;
  looking?: Vec3;
}

/** The nearest triangle a ray from `from` along `dir` goes through, and how far along. */
function rayHit(pos: ArrayLike<number>, from: Vector3, dir: Vector3): { t: number; tri: number } | null {
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), e1 = new Vector3(), e2 = new Vector3(), p = new Vector3(), s = new Vector3(), q = new Vector3();
  let best: { t: number; tri: number } | null = null;
  for (let i = 0; i + 8 < pos.length; i += 9) {
    a.set(pos[i], pos[i + 1], pos[i + 2]);
    b.set(pos[i + 3], pos[i + 4], pos[i + 5]);
    c.set(pos[i + 6], pos[i + 7], pos[i + 8]);
    e1.subVectors(b, a);
    e2.subVectors(c, a);
    p.crossVectors(dir, e2);
    const det = e1.dot(p);
    if (Math.abs(det) < 1e-12) continue;
    s.subVectors(from, a);
    const u = s.dot(p) / det;
    if (u < -1e-9 || u > 1 + 1e-9) continue;
    q.crossVectors(s, e1);
    const v = dir.dot(q) / det;
    if (v < -1e-9 || u + v > 1 + 1e-9) continue;
    const t = e2.dot(q) / det;
    if (t > 1e-6 && (!best || t < best.t)) best = { t, tri: i / 9 };
  }
  return best;
}

/** The face a click lands on, as the scene's picking finds it. */
function clickFace(pos: Float32Array, topo: Topology, click: Click): { face: Face | null; point: Vec3 } {
  const dir = new Vector3(...(click.looking || [0, 0, -1])).normalize();
  const from = new Vector3(...click.at).addScaledVector(dir, -1000);
  const hit = rayHit(pos, from, dir);
  if (!hit) return { face: null, point: click.at };
  return { face: topo.faceAt(hit.tri), point: from.addScaledVector(dir, hit.t).toArray() as Vec3 };
}

/** The snap nearest a point (of one role, when given). */
function nearestTo(snaps: Snap[], p: Vec3, role?: string): Snap | null {
  let best: Snap | null = null;
  let bestD = Infinity;
  for (const s of snaps) {
    if (role && s.role !== role) continue;
    const d = Math.hypot(s.p[0] - p[0], s.p[1] - p[1], s.p[2] - p[2]);
    if (d < bestD) [best, bestD] = [s, d];
  }
  return best;
}

const geometryOf = (pos: Float32Array) => {
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(pos, 3));
  return g;
};

interface CasePart {
  id?: string;
  shape: ShapeSpec;
  position?: Vec3;
  rotation?: Vec3;
  parent?: string;
  joint?: ScenePart["joint"];
}

/** The case's parts as scene parts, each with its model's triangles (centred, as a scene keeps them). */
function sceneParts(list: CasePart[], ctx: Ctx): { parts: ScenePart[]; models: Map<string, Float32Array> } {
  const models = new Map<string, Float32Array>();
  const parts = list.map((p, i): ScenePart => {
    const id = p.id || `p${i + 1}`;
    models.set(id, centred(shapeTriangles(p.shape, ctx.read)));
    return { id, name: id, position: p.position || [0, 0, 0], rotation: p.rotation || [0, 0, 0], ...(p.parent ? { parent: p.parent, joint: p.joint } : {}) };
  });
  return { parts, models };
}

/** Every part's triangles, moved to where it is drawn. */
function worldTriangles(parts: ScenePart[], models: Map<string, Float32Array>, explode = 0): Float32Array {
  const m = worldMatrices(parts, explode);
  const out: number[] = [];
  const v = new Vector3();
  for (const part of parts) {
    const pos = models.get(part.id)!;
    for (let i = 0; i < pos.length; i += 3) out.push(...v.set(pos[i], pos[i + 1], pos[i + 2]).applyMatrix4(m.get(part.id)!).toArray());
  }
  return Float32Array.from(out);
}

const angleBetween = (a: Matrix4, b: Matrix4) => {
  const qa = new Quaternion().setFromRotationMatrix(a), qb = new Quaternion().setFromRotationMatrix(b);
  return (qa.angleTo(qb) * 180) / Math.PI;
};

// ------------------------------------------------------------ the graders

export const GRADERS: Record<string, Grader> = {
  /**
   * Snaps: click a face; are the snap points the joint tool offers there
   * the ones a person would expect (and no others of those kinds)?
   */
  snaps(input: { shape: ShapeSpec; click: Click }, expect: { curved?: boolean; snaps: { role: string; p: Vec3; radius?: number }[]; tol?: number; roles?: string[] }, ctx) {
    const pos = shapeTriangles(input.shape, ctx.read);
    const topo = new Topology(pos);
    const { face } = clickFace(pos, topo, input.click);
    if (!face) return [yes("click lands on a face", false)];
    const tol = expect.tol ?? 0.05;
    const roles = new Set(expect.roles || expect.snaps.map(s => s.role));
    const offered = face.snaps.filter(s => roles.has(s.role));
    const used = new Set<Snap>();
    const missing: string[] = [];
    for (const want of expect.snaps) {
      const hit = offered.find(s => !used.has(s) && s.role === want.role && Math.hypot(...s.p.map((v, i) => v - want.p[i])) <= tol && (want.radius === undefined || Math.abs((s.radius || 0) - want.radius) <= Math.max(tol, want.radius * 0.03)));
      if (hit) used.add(hit);
      else missing.push(`${want.role} at ${show(want.p)}`);
    }
    const extra = offered.filter(s => !used.has(s)).map(s => `${s.role} at ${show(s.p)}`);
    const checks: Check[] = [
      { name: "offers every snap expected", score: expect.snaps.length ? used.size / expect.snaps.length : 1, detail: missing.length ? `missing ${missing.join("; ")}` : `all ${expect.snaps.length}`, weight: 2 },
      { name: "no unexpected snaps", score: offered.length ? used.size / offered.length : 1, detail: extra.length ? `extra ${extra.join("; ")}` : "none" },
    ];
    if (expect.curved !== undefined) checks.push(same("flat or curved face", face.curved ? "curved" : "flat", expect.curved ? "curved" : "flat"));
    return checks;
  },

  /** Auto screw: click a hole; does the screw tool pick the size and length a person would buy? */
  screw(input: { shape: ShapeSpec; click: Click; head?: ScrewHead }, expect: { d: number; length: number; through?: boolean }, ctx) {
    const pos = shapeTriangles(input.shape, ctx.read);
    const topo = new Topology(pos);
    const { face, point } = clickFace(pos, topo, input.click);
    const hole = face ? nearestTo(face.snaps.filter(isHoleSnap), point) : null;
    if (!hole) return [yes("finds the hole clicked", false, "no round hole on that face")];
    const head = input.head || "socket";
    const d = fitDiameter(hole.radius || 1.5, head);
    const depth = holeDepth(topo, hole.p, hole.n, hole.radius || d / 2);
    const length = fitLength(d, depth, head);
    const checks = [same("screw size", `M${d}`, `M${expect.d}`, 2), same("screw length", length, expect.length, 2)];
    if (expect.through !== undefined) checks.push(same("hole right through", depth.through, expect.through));
    checks.push({ name: "hole depth measured", score: 1, detail: `${show(depth.depth)} mm, ${depth.through ? "through" : "blind"}`, weight: 0 });
    return checks;
  },

  /** Join: pick a snap on each part; does the child land flush where it should? */
  joint(input: { parent: CasePart; child: CasePart; parentClick: Click; childClick: Click; parentSnap?: string; childSnap?: string; spin?: number; gap?: number }, expect: { position: Vec3; rotation: Vec3; tol?: number }, ctx) {
    const pp = centred(shapeTriangles(input.parent.shape, ctx.read));
    const cp = centred(shapeTriangles(input.child.shape, ctx.read));
    const pt = new Topology(pp), ct = new Topology(cp);
    const a = clickFace(pp, pt, input.parentClick), b = clickFace(cp, ct, input.childClick);
    const sa = a.face && nearestTo(a.face.snaps, a.point, input.parentSnap);
    const sb = b.face && nearestTo(b.face.snaps, b.point, input.childSnap);
    if (!sa || !sb) return [yes("finds a snap on each part", false, `${sa ? "" : "parent "}${sb ? "" : "child "}has none`)];
    const gap = input.gap || 0;
    const at = jointPlace({ point: sa.p, normal: sa.n, childPoint: sb.p, childNormal: sb.n, spin: input.spin || 0, gap });
    const tol = expect.tol ?? 0.05;
    const got = localMatrix(at), want = localMatrix({ position: expect.position, rotation: expect.rotation });
    // Flush: the child's face turned to look straight back at the parent's.
    const cn = new Vector3(...sb.n).transformDirection(got);
    const facing = cn.dot(new Vector3(...sa.n).normalize());
    // Not inside each other: the child's lowest point along the parent's face normal against the face.
    const n = new Vector3(...sa.n).normalize();
    let lowest = Infinity;
    const v = new Vector3();
    for (let i = 0; i < cp.length; i += 3) lowest = Math.min(lowest, v.set(cp[i], cp[i + 1], cp[i + 2]).applyMatrix4(got).sub(new Vector3(...sa.p)).dot(n));
    return [
      nearPoint("child position", at.position, expect.position, tol, 2),
      near("child turned right (degrees off)", angleBetween(got, want), 0, 0.5, 2),
      near("faces meet flush", facing, -1, 0.001),
      near("stands off the face by the gap", lowest, gap, tol),
    ];
  },

  /** A new part: does it land beside the others, not on top of them and not far away? */
  placement(input: { existing: Box3[]; at: Vec3; size: Vec3; gap?: number }, expect: { position?: Vec3; keepsOwnSpot?: boolean; tol?: number }) {
    const gap = input.gap ?? 10;
    const got = placeBeside(input.existing, input.at, input.size, gap);
    const half = input.size.map(s => s / 2);
    const box: Box3 = { min: got.map((g, i) => g - half[i]) as Vec3, max: got.map((g, i) => g + half[i]) as Vec3 };
    const overlap = (o: Box3) => box.min.every((m, i) => m < o.max[i] - 1e-6 && box.max[i] > o.min[i] + 1e-6);
    const group: Box3 = {
      min: [0, 1, 2].map(i => Math.min(...input.existing.map(b => b.min[i]))) as Vec3,
      max: [0, 1, 2].map(i => Math.max(...input.existing.map(b => b.max[i]))) as Vec3,
    };
    // How far the new part's box is from the group's (0 when they touch or overlap).
    const away = Math.hypot(...[0, 1, 2].map(i => Math.max(0, group.min[i] - box.max[i], box.min[i] - group.max[i])));
    const checks: Check[] = [
      yes("not on top of another part", !input.existing.some(overlap), input.existing.some(overlap) ? "overlaps" : "clear", 2),
      { name: "close to the other parts", score: away <= 2 * gap + 1e-6 ? 1 : Math.max(0, 1 - (away - 2 * gap) / (4 * gap)), detail: `${show(away)} mm from the group (want ≤ ${2 * gap})`, weight: 2 },
    ];
    if (expect.keepsOwnSpot !== undefined) {
      const kept = got.every((g, i) => Math.abs(g - input.at[i]) < 1e-6);
      checks.push(same("keeps its own spot", kept, expect.keepsOwnSpot));
    }
    if (expect.position) checks.push(nearPoint("position", got, expect.position, expect.tol ?? 0.5));
    return checks;
  },

  /** Fit: does the camera fill the picture with the parts, cutting none off? */
  fit(input: { parts: CasePart[]; camera: { direction: Vec3 }; aspect?: number; explode?: number }, expect: { fill?: number }, ctx) {
    const { parts, models } = sceneParts(input.parts, ctx);
    const aspect = input.aspect ?? 4 / 3;
    const m = worldMatrices(parts, input.explode || 0);
    const meshes: Placed[] = parts.map(p => ({ geometry: geometryOf(models.get(p.id)!), matrix: m.get(p.id)! }));
    const cam = frameTight({ direction: input.camera.direction, target: [0, 0, 0], size: 100 }, meshes, aspect);
    const c = cameraFor(cam, aspect, 1000);
    c.updateMatrixWorld();
    const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    const v = new Vector3();
    const all = worldTriangles(parts, models, input.explode || 0);
    for (let i = 0; i < all.length; i += 3) {
      v.set(all[i], all[i + 1], all[i + 2]).project(c);
      lo[0] = Math.min(lo[0], v.x);
      lo[1] = Math.min(lo[1], v.y);
      hi[0] = Math.max(hi[0], v.x);
      hi[1] = Math.max(hi[1], v.y);
    }
    // In the picture's own units: -1 to 1 across and up.
    const reach = Math.max(-lo[0], -lo[1], hi[0], hi[1]);
    const fill = Math.max(hi[0] - lo[0], hi[1] - lo[1]) / 2;
    const off = Math.hypot((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2);
    return [
      { name: "nothing cut off", score: reach <= 1 + 1e-6 ? 1 : Math.max(0, 1 - (reach - 1) / 0.05), detail: `parts reach ${show(reach * 100)}% of the way to the edge`, weight: 2 },
      atLeast("fills the picture", fill, expect.fill ?? 0.9, 0.3, 2),
      near("centred", off, 0, 0.02),
    ];
  },

  /** Assembly arrows: is the head always in sight, and the arrow no shorter than it needs to be? */
  arrow(input: { parts: CasePart[]; camera: { direction: Vec3 }; from: Vec3; to: Vec3; headLen?: number; f0?: number; f1?: number }, expect: { shortened?: boolean }, ctx) {
    const { parts, models } = sceneParts(input.parts, ctx);
    const world = worldTriangles(parts, models);
    const look = new Vector3(...input.camera.direction).normalize().negate();
    const from = new Vector3(...input.from), to = new Vector3(...input.to);
    const gap = from.distanceTo(to);
    const axis = to.clone().sub(from).normalize();
    const at = (f: number) => from.clone().addScaledVector(axis, gap * f);
    // In sight: nothing between the point and the camera (a point on a face counts as seen).
    const seen = (p: Vector3) => {
      const hit = rayHit(world, p.clone().addScaledVector(look, -1000), look);
      return !hit || hit.t >= 1000 - 0.01;
    };
    const headLen = input.headLen ?? 8;
    const f0 = input.f0 ?? ARROW_FROM;
    const f1 = input.f1 ?? ARROW_TO;
    const end = arrowEnd(f0, f1, gap, headLen, f => seen(at(f)));
    const len = gap * (end - f0);
    // The head as drawn: it shrinks on a short arrow.
    const hl = headLen * Math.min(1, len / (headLen * 1.6));
    const samples = [0, 0.25, 0.5, 0.75, 1].map(k => at(end - (hl * k) / gap));
    const headSeen = samples.filter(seen).length / samples.length;
    // The longest it could be: the line in sight from its tail.
    let run = f0;
    for (let f = f0; f <= f1 + 1e-9; f += 0.002) {
      if (!seen(at(f))) break;
      run = f;
    }
    const best = gap * (run - f0);
    const checks: Check[] = [
      { name: "head in sight", score: headSeen, detail: `${Math.round(headSeen * 100)}% of the head can be seen`, weight: 3 },
      atLeast("arrow kept as long as it can be", len, Math.min(gap * (f1 - f0), best - headLen), headLen),
    ];
    if (expect.shortened !== undefined) checks.push(same("shortened", end < f1 - 1e-6, expect.shortened));
    return checks;
  },

  /** Make track: are the pieces a pitch apart, round the wheels, and does the loop close? */
  track(input: { wheels: { centre: Vec3; radius: number }[]; axle?: Vec3; pitch: number; count: number; lift?: number; offset?: number }, expect: { fits?: number; closes?: boolean }) {
    const axle = input.axle || [0, 1, 0];
    const t: TrackSpec = {
      link: "link",
      count: input.count,
      start: [-input.pitch / 2, 0, 0],
      end: [input.pitch / 2, 0, 0],
      axis: [0, 1, 0],
      wheels: [],
      offset: input.offset || 0,
      lift: input.lift || 0,
      side: 0,
    };
    const wheels = input.wheels.map(w => ({ centre: new Vector3(...w.centre), normal: new Vector3(...axle), radius: w.radius }));
    const lay = layTrack(t, wheels);
    if (!lay.pieces.length) return [yes("lays a track", false)];
    const starts = lay.pieces.map(m => new Vector3(...t.start).applyMatrix4(m));
    const ends = lay.pieces.map(m => new Vector3(...t.end).applyMatrix4(m));
    let worst = 0;
    for (let i = 0; i < starts.length; i++) worst = Math.max(worst, Math.abs(starts[i].distanceTo(ends[i]) - input.pitch));
    for (let i = 0; i + 1 < starts.length; i++) worst = Math.max(worst, ends[i].distanceTo(starts[i + 1]));
    // No pivot inside a wheel (it would cut through the wheel).
    const n = new Vector3(...axle).normalize();
    const inside = starts.filter(p => wheels.some(w => {
      const d = p.clone().sub(w.centre);
      d.addScaledVector(n, -d.dot(n));
      return d.length() < w.radius + (input.lift || 0) - 0.05;
    })).length;
    const checks: Check[] = [
      near("pieces join up (worst gap, mm)", worst, 0, 0.01, 2),
      { name: "no piece cuts into a wheel", score: 1 - inside / starts.length, detail: `${inside} of ${starts.length} inside a wheel`, weight: 2 },
    ];
    if (expect.fits !== undefined) checks.push(near("pieces that fit round", lay.fits, expect.fits, 0.5));
    if (expect.closes !== undefined) {
      const close = ends[ends.length - 1].distanceTo(starts[0]);
      checks.push({ name: "loop closes", score: expect.closes ? Math.max(0, 1 - close / (input.pitch * 0.25)) : close > input.pitch * 0.25 ? 1 : 0, detail: `last piece ends ${show(close)} mm from the first` });
    }
    return checks;
  },
};
