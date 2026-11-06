// One grader per kind of case. A grader runs the real scene code on the
// case's input and checks what comes out against the case's `expect`.
// Each returns a list of checks (see score.ts); the runner averages them.

import { BufferAttribute, BufferGeometry, Matrix4, Quaternion, Vector3 } from "three";
import { jointPlace } from "../../src/scene/joint";
import { ARROW_FROM, ARROW_TO, behindModel, type ExplodeDir, followModel, lookOf, modelPart, normalizeScene, placeBeside, shownAs, type Box3, type ScenePart, type Vec3 } from "../../src/scene/model";
import { partsInStep } from "../../src/stepFrame";
import { staleScenes } from "../../src/doc";
import { arrowEnd, cameraFor, frameTight, localMatrix, worldMatrices, type Placed } from "../../src/scene/render";
import { fitDiameter, fitLength, holeDepth, isHoleSnap, type ScrewHead } from "../../src/scene/screw";
import { Topology, type Face, type Snap } from "../../src/scene/snaps";
import { sitDelta } from "../../src/scene/sit";
import { branchOf, smartExplode, type ExplodeShape } from "../../src/scene/explode";
import { layTrack, type TrackSpec } from "../../src/scene/track";
import { cableRadius, coreLines, leadLength, MIN_BEND, ringRadius, tightestBend, wireRoute } from "../../src/scene/wire";
import { mirrorPartner, mirrorPlane, mirrorPoint } from "../../src/scene/wireMirror";
import { coresOf, normalizeWire, type Looms } from "../../src/scene/wireSpec";
import { missingWires, type WiringInfo, type WiringPart } from "../../src/scene/wiring2d";
import { guessPins } from "../../src/scene/pinGuess";
import { planSteps, stepOfParts, stepWarnings, suggestSteps, type BuildStep } from "../../src/scene/buildSteps";
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
   * Build steps: from a model's parts (fixings named) and the steps picked
   * by hand, are the guide's pages the ones a person expects, does Suggest
   * steps make the order they'd build in, and is a part fitted before what
   * it's joined to caught?
   */
  steps(
    input: { parts: { id: string; parent?: string }[]; fixings?: string[]; steps?: BuildStep[] },
    expect: { pages?: { added: string[]; fixings: string[] }[]; suggest?: string[][]; warnings?: Record<string, string[]> },
  ) {
    const parts = input.parts.map(p => ({ name: p.id, position: [0, 0, 0], rotation: [0, 0, 0], ...p })) as ScenePart[];
    const small = new Set(input.fixings || []);
    const fixing = (p: ScenePart) => small.has(p.id);
    const steps = input.steps || [];
    const checks: Check[] = [];
    if (expect.pages) {
      const got = planSteps({ parts, steps }, fixing).map(s => ({ added: s.added.map(p => p.id), fixings: s.fixings.map(p => p.id) }));
      checks.push(same("the guide's pages", got, expect.pages, 2));
    }
    if (expect.suggest) checks.push(same("suggested steps", suggestSteps({ parts }, fixing).map(s => s.parts), expect.suggest));
    if (expect.warnings) {
      const at = stepOfParts(parts, steps, fixing);
      const got = Object.fromEntries(steps.map((_, i) => [String(i + 1), stepWarnings(parts, at, i).map(w => w.part)]).filter(([, w]) => (w as string[]).length));
      checks.push(same("parts fitted before what they're joined to", got, expect.warnings));
    }
    return checks;
  },
  /**
   * Snaps: click a face; are the snap points the joint tool offers there
   * the ones a person would expect (and no others of those kinds)?
   */
  snaps(input: { shape: ShapeSpec; click: Click }, expect: { curved?: boolean; snaps: { role: string; p: Vec3; n?: Vec3; radius?: number }[]; tol?: number; roles?: string[] }, ctx) {
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
      const hit = offered.find(s => !used.has(s) && s.role === want.role && Math.hypot(...s.p.map((v, i) => v - want.p[i])) <= tol && (want.radius === undefined || Math.abs((s.radius || 0) - want.radius) <= Math.max(tol, want.radius * 0.03)) && (want.n === undefined || s.n[0] * want.n[0] + s.n[1] * want.n[1] + s.n[2] * want.n[2] > 0.999));
      if (hit) used.add(hit);
      else missing.push(`${want.role} at ${show(want.p)}${want.n ? ` looking ${show(want.n)}` : ""}`);
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
  joint(input: { parent: CasePart; child: CasePart; parentClick: Click; childClick: Click; parentSnap?: string; childSnap?: string; spin?: number; gap?: number; offset?: Vec3 }, expect: { position: Vec3; rotation: Vec3; tol?: number; lowest?: number }, ctx) {
    const pp = centred(shapeTriangles(input.parent.shape, ctx.read));
    const cp = centred(shapeTriangles(input.child.shape, ctx.read));
    const pt = new Topology(pp), ct = new Topology(cp);
    const a = clickFace(pp, pt, input.parentClick), b = clickFace(cp, ct, input.childClick);
    const sa = a.face && nearestTo(a.face.snaps, a.point, input.parentSnap);
    const sb = b.face && nearestTo(b.face.snaps, b.point, input.childSnap);
    if (!sa || !sb) return [yes("finds a snap on each part", false, `${sa ? "" : "parent "}${sb ? "" : "child "}has none`)];
    const gap = input.gap || 0;
    const at = jointPlace({ point: sa.p, normal: sa.n, childPoint: sb.p, childNormal: sb.n, spin: input.spin || 0, gap, offset: input.offset });
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
      // A pin goes into its socket, so its case says how far below the face it reaches.
      near("stands off the face by the gap", lowest, expect.lowest ?? gap + (input.offset ? new Vector3(...input.offset).dot(n) : 0), tol),
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
  /**
   * A track's piece in the finished assembly: the piece a track was made
   * from is its template, so a scene (loaded on its own, or following the
   * project's model) never draws it, a picture drawn while it showed is
   * marked out of date, and a step counts the piece once per link.
   */
  trackPiece(input: { parts: (Partial<ScenePart> & { id: string })[]; stamp?: number }, expect: { hidden: string[]; shown: string[]; outOfDate: boolean; counts?: Record<string, number> }) {
    const stamp = input.stamp ?? 3;
    const full = input.parts.map((p, i) => ({ name: p.id, position: [i * 50, 0, 0], rotation: [0, 0, 0], url: `/${p.id}.stl`, ...p })) as ScenePart[];
    const raw = { version: 1, parts: structuredClone(full), model: { stamp } };
    const model = { version: 1 as const, stamp, parts: full.map(modelPart) };
    const loaded = normalizeScene(structuredClone(raw));
    const followed = followModel(normalizeScene(structuredClone(raw)), model);
    const hiddenIn = (parts: ScenePart[]) => new Set(parts.filter(p => p.hidden).map(p => p.id));
    const checks: Check[] = [];
    for (const [how, parts] of [["loaded", loaded.parts], ["following the model", followed.parts]] as const) {
      const h = hiddenIn(parts);
      const wrong = [...expect.hidden.filter(id => !h.has(id)).map(id => `${id} drawn`), ...expect.shown.filter(id => h.has(id)).map(id => `${id} hidden`)];
      checks.push(yes(`pieces kept out, ${how}`, !wrong.length, wrong.join(", ") || "as expected", 2));
    }
    const doc = { version: 1, width: 800, height: 600, objects: [{ type: "SceneLayer", scene: structuredClone(raw) }] };
    checks.push(same("old picture marked out of date", behindModel(raw as never, model), expect.outOfDate));
    checks.push(same("graphic counted out of date", staleScenes(doc as never, stamp) > 0, expect.outOfDate));
    checks.push(same("redrawn picture is up to date", behindModel(followed, model), false));
    if (expect.counts) {
      const got = Object.fromEntries(partsInStep(followed).map(c => [c.part.id, c.count]));
      checks.push(same("parts in the step", got, expect.counts));
    }
    return checks;
  },
  /**
   * Wires: lay a wire through its parts (placed, joined and exploded as
   * the case says), and check it does what a person drawing it would:
   * leaves each end straight out, passes over its waypoints without going
   * into the face, takes up its slack, bows the right way, and its ends
   * stay on their parts when the scene explodes.
   */
  wire(
    input: { parts: (Pick<ScenePart, "id" | "position"> & Partial<ScenePart>)[]; wire: unknown; explode?: number; /** Other wires by id, for one that runs along them. */ others?: Record<string, unknown> },
    expect: {
      leaves?: boolean; extra?: [number, number]; bow?: Vec3; through?: { at: Vec3; normal: Vec3 }[]; ends?: [Vec3, Vec3]; tol?: number;
      /** A cable: its wires at the plugs' pin spacing at each end, and gathered in the middle ("round": touching round it; "flat": side by side). */
      cable?: { pins?: boolean; gathered?: "round" | "flat" };
      /** In a loom: its middle this far (mm, between the middles) off wire `wire`'s line. */
      loom?: { wire: string; gap: number };
      /** Whether it bends tighter than MIN_BEND × its outer diameter. */
      tight?: boolean;
    },
  ) {
    const parts: ScenePart[] = input.parts.map(p => ({ name: p.id, rotation: [0, 0, 0], ...p }) as ScenePart);
    const spec = normalizeWire(input.wire);
    if (!spec) return [yes("the wire reads", false)];
    const looms: Looms = new Map();
    for (const [id, w] of Object.entries(input.others || {})) {
      const o = normalizeWire(w);
      if (o) looms.set(id, o);
    }
    const route = wireRoute(spec, worldMatrices(parts, input.explode || 0), looms);
    if (!route) return [yes("the wire can be laid", false)];
    const c = route.centre;
    const tol = expect.tol ?? 0.25;
    const checks: Check[] = [];
    const ends = [
      { p: c[0], next: c[Math.min(c.length - 1, 3)] },
      { p: c[c.length - 1], next: c[Math.max(0, c.length - 4)] },
    ];
    if (expect.leaves) {
      const mats = worldMatrices(parts, input.explode || 0);
      [spec.from, spec.to].forEach((e, i) => {
        const n = new Vector3(...e.normal).transformDirection(mats.get(e.part)!);
        const d = ends[i].next.clone().sub(ends[i].p).normalize();
        checks.push(atLeast(`leaves end ${i + 1} along its normal (cos)`, d.dot(n), 0.97, 0.3));
      });
    }
    if (expect.ends) expect.ends.forEach((want, i) => checks.push(nearPoint(`end ${i + 1} on its part (mm)`, ends[i].p.toArray(), want, 0.01, 2)));
    if (expect.extra) {
      // The extra over the same wire pulled tight.
      const tight = wireRoute({ ...spec, slack: 0 }, worldMatrices(parts, input.explode || 0))!;
      checks.push(near("slack taken up (extra mm)", route.length - tight.length, expect.extra[0], expect.extra[1]));
    }
    if (expect.bow) {
      // The middle of the wire, against the middle of its ends: which way it bows.
      const mid = c[Math.floor(c.length / 2)].clone().sub(c[0].clone().lerp(c[c.length - 1], 0.5));
      const want = new Vector3(...expect.bow).normalize();
      checks.push(atLeast("bows the right way (cos)", mid.lengthSq() > 1e-6 ? mid.normalize().dot(want) : 0, 0.9, 0.5));
    }
    for (const [i, t] of (expect.through || []).entries()) {
      const at = new Vector3(...t.at);
      const n = new Vector3(...t.normal).normalize();
      let best = Infinity;
      let side = 0;
      for (const p of c) {
        const d = p.distanceTo(at.clone().addScaledVector(n, cableRadius(spec)));
        if (d < best) {
          best = d;
          side = p.clone().sub(at).dot(n);
        }
      }
      checks.push(near(`passes waypoint ${i + 1} (mm)`, best, 0, tol, 2));
      // Its middle a radius off the face: lying on it, not sunk into it.
      checks.push(atLeast(`lies on the face at waypoint ${i + 1}, not in it (mm off)`, side, cableRadius(spec) - 0.05, cableRadius(spec)));
    }
    if (expect.cable) {
      const lines = coreLines(spec, route);
      const n = coresOf(spec).length;
      checks.push(same("wires in the cable", lines.length, n));
      if (expect.cable.pins) {
        [spec.from, spec.to].forEach((e, k) => {
          const at = k === 0 ? 0 : c.length - 1;
          const want = Math.max(spec.diameter, e.pitch || spec.diameter);
          let worst = 0;
          for (let i = 1; i < n; i++) worst = Math.max(worst, Math.abs(lines[i][at].distanceTo(lines[i - 1][at]) - want));
          checks.push(near(`wires at plug ${k + 1}'s pin spacing (mm off)`, worst, 0, 0.05, 2));
        });
      }
      if (expect.cable.gathered) {
        const mid = Math.floor(c.length / 2);
        let worst = 0;
        if (expect.cable.gathered === "round") {
          const ring = ringRadius(n, spec.diameter / 2);
          for (const l of lines) worst = Math.max(worst, Math.abs(l[mid].distanceTo(c[mid]) - ring));
        } else {
          for (let i = 1; i < n; i++) worst = Math.max(worst, Math.abs(lines[i][mid].distanceTo(lines[i - 1][mid]) - spec.diameter));
        }
        checks.push(near(`wires touching in the middle, ${expect.cable.gathered} (mm off)`, worst, 0, 0.05, 2));
        // No two wires through each other anywhere.
        let overlap = 0;
        for (let j = 0; j < c.length; j++) {
          for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) overlap = Math.max(overlap, spec.diameter - lines[a][j].distanceTo(lines[b][j]));
        }
        checks.push(near("no wire runs through another (mm into it)", Math.max(0, overlap), 0, 0.05, 2));
      }
    }
    if (expect.loom) {
      const other = looms.get(expect.loom.wire);
      const line = other && wireRoute(other, worldMatrices(parts, input.explode || 0));
      if (!line) checks.push(yes("the loom's wire can be laid", false));
      else {
        const q = c[Math.floor(c.length / 2)];
        let best = Infinity;
        for (let i = 1; i < line.centre.length; i++) {
          const a = line.centre[i - 1];
          const ab = line.centre[i].clone().sub(a);
          const t = Math.max(0, Math.min(1, q.clone().sub(a).dot(ab) / (ab.lengthSq() || 1)));
          best = Math.min(best, a.clone().addScaledVector(ab, t).distanceTo(q));
        }
        checks.push(near("runs beside the loom's wire in the middle (mm between them)", best, expect.loom.gap, 0.15, 2));
      }
    }
    if (expect.tight !== undefined) {
      const outer = cableRadius(spec) * 2;
      const bend = tightestBend(route, outer);
      const tight = !!bend && bend.radius < MIN_BEND * outer;
      checks.push(yes(expect.tight ? "warns of a too-tight bend" : "no too-tight bend", tight === expect.tight, bend ? `${bend.radius.toFixed(1)} mm` : "none"));
    }
    void leadLength;
    return checks;
  },
  /**
   * Mirror a wire: each part it touches finds its partner on the other
   * side of the model, and each end and waypoint lands where the mirror
   * puts it, on that partner.
   */
  mirror(
    input: { parts: (Pick<ScenePart, "id" | "position"> & Partial<ScenePart>)[]; points: { part: string; point: Vec3; normal?: Vec3 }[]; tolerance?: number },
    expect: { plane?: number; points: { part: string; at: Vec3; normal?: Vec3 }[] },
  ) {
    const parts: ScenePart[] = input.parts.map(p => ({ name: p.id, rotation: [0, 0, 0], ...p }) as ScenePart);
    const world = worldMatrices(parts, 0, false);
    const plane = mirrorPlane(parts, world);
    const checks: Check[] = [];
    if (expect.plane !== undefined) checks.push(near("mirror across the middle (x mm)", plane, expect.plane, 0.01));
    input.points.forEach((q, i) => {
      const want = expect.points[i];
      const to = mirrorPartner(parts, world, q.part, plane, input.tolerance ?? 5);
      checks.push(yes(`point ${i + 1} goes to ${want.part}`, to === want.part, `went to ${to}`));
      if (!to) return;
      const m = mirrorPoint(q.point, q.normal, world.get(q.part)!, world.get(to)!, plane);
      const at = new Vector3(...m.point).applyMatrix4(world.get(to)!);
      checks.push(nearPoint(`point ${i + 1} where the mirror puts it (mm)`, at.toArray(), want.at, 0.01, 2));
      if (want.normal && m.normal) {
        const n = new Vector3(...m.normal).transformDirection(world.get(to)!);
        checks.push(atLeast(`point ${i + 1}'s face turned the mirror's way (cos)`, n.dot(new Vector3(...want.normal).normalize()), 0.999, 0.9));
      }
    });
    return checks;
  },
  /**
   * The 2D wiring diagram's cables "Add missing wires" makes in 3D: which
   * ones (by their connections, in each cable's pin order), and how many it
   * can't for want of a socket.
   */
  /**
   * A wiring step in the Assembly guide: the step's wire and its plugs
   * drawn, earlier wires (and their plugs) grey, later ones out, every
   * other part grey.
   */
  wireStep(input: { parts: (Pick<ScenePart, "id" | "position"> & Partial<ScenePart>)[]; wireStep: string }, expect: { shown: string[]; ghost: string[]; hidden: string[] }) {
    const parts: ScenePart[] = input.parts.map(p => ({ name: p.id, rotation: [0, 0, 0], ...p }) as ScenePart);
    const look = lookOf({ parts, wireStep: input.wireStep });
    const as = (id: string) => {
      const p = parts.find(x => x.id === id);
      if (!p) return "missing";
      const s = shownAs(p, look);
      return s.hidden ? "hidden" : s.ghost ? "ghost" : "shown";
    };
    return [
      ...expect.shown.map(id => yes(`${id} drawn`, as(id) === "shown", as(id))),
      ...expect.ghost.map(id => yes(`${id} grey`, as(id) === "ghost", as(id))),
      ...expect.hidden.map(id => yes(`${id} not there yet`, as(id) === "hidden", as(id))),
    ];
  },
  diagram(input: { info: WiringInfo; parts: (Pick<ScenePart, "id" | "position"> & Partial<ScenePart>)[] }, expect: { wires: string[][]; skipped: number; colours?: string[][]; ends?: string[][] }) {
    const parts: ScenePart[] = input.parts.map(p => ({ name: p.id, rotation: [0, 0, 0], ...p }) as ScenePart);
    const got = missingWires(input.info, parts);
    const checks: Check[] = [
      same("cables it adds", got.wires.length, expect.wires.length),
      same("cables it can't (no socket)", got.skipped, expect.skipped),
    ];
    expect.wires.forEach((ids, i) => {
      const w = got.wires[i];
      checks.push(yes(`cable ${i + 1}'s wires in pin order`, !!w && w.cores.map(c => c.connection).join(",") === ids.join(","), w ? w.cores.map(c => c.connection).join(",") : "missing"));
      const want = expect.colours?.[i];
      if (want) checks.push(yes(`cable ${i + 1} coloured as the diagram`, !!w && w.cores.map(c => c.color).join(",") === want.join(","), w ? w.cores.map(c => c.color).join(",") : "missing"));
      // Where each end is: a socket's id, "#n" its pin along a plug (pin 1 is 0), either way round.
      const ends = expect.ends?.[i];
      if (ends) {
        const got2 = w ? [`${w.from.socket.id}${w.fromIndex !== undefined ? `#${w.fromIndex}` : ""}`, `${w.to.socket.id}${w.toIndex !== undefined ? `#${w.toIndex}` : ""}`].sort().join(" ") : "missing";
        checks.push(yes(`cable ${i + 1} ends on its pins`, got2 === [...ends].sort().join(" "), got2));
      }
    });
    return checks;
  },

  /**
   * Sit on part: a joined part slides along its joint's normal until it
   * rests on the part it's joined to. Shapes are where they're written (not
   * centred); the parent may be several shapes (a tray's floor and walls).
   */
  /**
   * Finding a part's pins on its model from its 2D picture: each pin (x, y
   * fractions of the picture, top view) lands where a person would put the
   * wire's end, in the model file's own frame, facing the way the wire
   * leaves. `expect.pins: null`: the model isn't drawn the picture's way
   * round, so none are guessed.
   */
  pins(
    input: { shape: ShapeSpec; size: [number, number]; pins: { name: string; x: number; y: number }[] },
    expect: { pins: Record<string, { at: Vec3; normal?: Vec3 }> | null; tol?: number },
    ctx,
  ) {
    const raw = shapeTriangles(input.shape, ctx.read);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < raw.length; i += 3) for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], raw[i + k]);
      hi[k] = Math.max(hi[k], raw[i + k]);
    }
    const centre = lo.map((v, k) => (v + hi[k]) / 2) as Vec3;
    const size = lo.map((v, k) => hi[k] - v) as Vec3;
    const part: WiringPart = { id: "p", name: "Part", size: input.size, ports: [{ id: "header-1", name: "Header", pins: input.pins }] };
    const got = guessPins(part, centred(raw), centre, size);
    if (expect.pins === null) return [yes("leaves the pins to be placed by hand", got === null, got ? `guessed ${got.length}` : "none")];
    if (!got) return [yes("finds the pins", false, "the model wasn't taken as drawn the picture's way round")];
    const tol = expect.tol ?? 0.3;
    return Object.entries(expect.pins).flatMap(([name, want]) => {
      const g = got.find(x => x.pin === name);
      if (!g) return [yes(`${name} found`, false, "not found")];
      const at = g.point.map((v, k) => v + centre[k]);
      const checks = [nearPoint(`${name} where the wire ends (mm)`, at, want.at, tol, 2)];
      if (want.normal) checks.push(nearPoint(`${name} faces the way the wire leaves`, g.normal, want.normal, 0.1));
      return checks;
    });
  },

  sit(input: { parent: ShapeSpec[]; child: ShapeSpec; position: Vec3; rotation?: Vec3; normal: Vec3 }, expect: { move: number | null; tol?: number }, ctx) {
    const pieces = input.parent.map(s => shapeTriangles(s, ctx.read));
    const pp = new Float32Array(pieces.reduce((n, p) => n + p.length, 0));
    pieces.reduce((at, p) => (pp.set(p, at), at + p.length), 0);
    const cp = shapeTriangles(input.child, ctx.read);
    const m = localMatrix({ position: input.position, rotation: input.rotation || [0, 0, 0] });
    const move = sitDelta(pp, cp, m, input.normal);
    if (expect.move === null) return [yes("finds nothing beneath", move === null, move === null ? "nothing" : `moved ${show(move)} mm`)];
    if (move === null) return [yes("finds the part beneath", false, "found nothing")];
    const tol = expect.tol ?? 0.1;
    // Moved by that much, a second press has nothing left to do: it touches.
    const n = new Vector3(...input.normal).normalize();
    const after = m.clone().premultiply(new Matrix4().makeTranslation(n.x * move, n.y * move, n.z * move));
    const again = sitDelta(pp, cp, after, input.normal) ?? NaN;
    return [
      near("moves along the joint (mm)", move, expect.move, tol, 2),
      near("then rests touching (a second press moves mm)", again, 0, tol),
    ];
  },

  /**
   * Smart explode: which way a joined part should come off so it doesn't
   * run through the other parts. Parts are boxes (centred on their middle);
   * a joined part's position is in its parent's frame, as a scene keeps it.
   */
  explode(
    input: { parts: { id: string; box?: Vec3; shape?: ShapeSpec; position: Vec3; rotation?: Vec3; parent?: string; normal?: Vec3; distance?: number; hidden?: boolean }[]; part: string },
    expect: { dir: ExplodeDir | ExplodeDir[] },
    ctx,
  ) {
    const parts: ScenePart[] = input.parts.map(p => ({
      id: p.id,
      name: p.id,
      position: p.position,
      rotation: p.rotation || [0, 0, 0],
      ...(p.hidden ? { hidden: true } : {}),
      ...(p.parent ? { parent: p.parent, joint: { normal: p.normal || [0, 0, 1], distance: p.distance ?? 30 } } : {}),
    }));
    // Each part's model, centred on its middle as a scene keeps it.
    const shapes = new Map(input.parts.map(p => {
      const tri = centred(shapeTriangles(p.shape || { box: p.box! }, ctx.read));
      const size: Vec3 = [0, 1, 2].map(k => {
        let hi = -Infinity;
        for (let i = k; i < tri.length; i += 3) hi = Math.max(hi, tri[i]);
        return hi * 2;
      }) as Vec3;
      return [p.id, { size, triangles: tri }] as [string, ExplodeShape];
    }));
    const sizes = new Map([...shapes].map(([id, s]) => [id, s.size] as [string, Vec3]));
    const choice = smartExplode(parts, worldMatrices(parts, 0, false), shapes, input.part);
    if (!choice) return [yes("works out a way", false, "no answer")];
    const want = Array.isArray(expect.dir) ? expect.dir : [expect.dir];
    // Slid all the way out that way, it's clear of every other part.
    const part = parts.find(p => p.id === input.part)!;
    part.joint!.explodeDir = choice.dir;
    const branch = branchOf(parts, input.part);
    const box = (p: ScenePart, m: Matrix4) => {
      const h = new Vector3(...sizes.get(p.id)!).multiplyScalar(0.5);
      const corners = [0, 1, 2, 3, 4, 5, 6, 7].map(k => new Vector3(k & 1 ? h.x : -h.x, k & 2 ? h.y : -h.y, k & 4 ? h.z : -h.z).applyMatrix4(m));
      return { min: corners.reduce((a, c) => a.min(c), corners[0].clone()), max: corners.reduce((a, c) => a.max(c), corners[0].clone()) };
    };
    const out = worldMatrices(parts.map(p => (branch.has(p.id) ? p : { ...p, explode: 0 })), 1);
    const rest = worldMatrices(parts, 0, false);
    let hits = "";
    for (const q of parts) {
      if (q.hidden || branch.has(q.id)) continue;
      const b = box(q, rest.get(q.id)!);
      for (const id of branch) {
        const a = box(parts.find(p => p.id === id)!, out.get(id)!);
        const o = ["x", "y", "z"].every(k => Math.min(a.max[k as "x"], b.max[k as "x"]) - Math.max(a.min[k as "x"], b.min[k as "x"]) > 1e-6);
        if (o) hits = q.id;
      }
    }
    return [
      yes("comes off the way a person would", want.includes(choice.dir), `went ${choice.dir}, wanted ${want.join(" or ")}`, 2),
      yes("ends clear of the other parts", !hits, hits ? `still in ${hits}` : ""),
    ];
  },
};
