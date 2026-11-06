// Which way a joined part comes off in an exploded view.
//
// By default a part slides out along its joint: the parent's picked face
// normal. That's right for a part sat on a face, but not when the face picked
// was a side (a pin, a rim, a wall), and the part then flies off sideways
// through its neighbours. So a joint can say which way it comes off instead
// (`joint.explodeDir`): the other way, or along one of the world's axes. And
// "Smart" works out the way that's clear: the one where the part (and
// what's joined to it) runs into the least of the other parts on its way out.

import { Box3, Matrix4, Triangle, Vector3 } from "three";
import type { ExplodeDir, PartJoint, ScenePart, Vec3 } from "./model";

export const EXPLODE_DIRS: { id: ExplodeDir; label: string; detail: string }[] = [
  { id: "joint", label: "Along the joint", detail: "Out from the face it's joined to" },
  { id: "reverse", label: "The other way", detail: "Back through the face it's joined to" },
  { id: "+z", label: "Up (+Z)", detail: "Straight up" },
  { id: "-z", label: "Down (−Z)", detail: "Straight down" },
  { id: "+x", label: "+X", detail: "Along the world's X axis" },
  { id: "-x", label: "−X", detail: "Back along the world's X axis" },
  { id: "+y", label: "+Y", detail: "Along the world's Y axis" },
  { id: "-y", label: "−Y", detail: "Back along the world's Y axis" },
];

const AXES: Record<Exclude<ExplodeDir, "reverse" | "joint">, Vec3> = {
  "+x": [1, 0, 0],
  "-x": [-1, 0, 0],
  "+y": [0, 1, 0],
  "-y": [0, -1, 0],
  "+z": [0, 0, 1],
  "-z": [0, 0, -1],
};

/** A short name for the way a joint comes off, for buttons and notes. */
export function explodeDirLabel(dir: ExplodeDir | undefined): string {
  return EXPLODE_DIRS.find(d => d.id === (dir || "joint"))?.label || "Along the joint";
}

/**
 * The way a joined part comes off, as a unit vector in its parent's frame
 * (where the joint's normal is). `parentWorld` is the parent's place in the
 * world, so a world axis stays that axis however the parent is turned.
 */
export function explodeVector(joint: Pick<PartJoint, "normal" | "explodeDir">, parentWorld?: Matrix4): Vector3 {
  const n = new Vector3(...joint.normal).normalize();
  const dir = joint.explodeDir;
  if (!dir || dir === "joint") return n;
  if (dir === "reverse") return n.negate();
  const axis = new Vector3(...AXES[dir]);
  return parentWorld ? axis.transformDirection(parentWorld.clone().invert()) : axis;
}

/** A part's model for Smart explode: its size, and its triangles (centred, three corners each) when known. */
export interface ExplodeShape {
  size: Vec3;
  triangles?: ArrayLike<number>;
}

/** Every part joined to this one, however far down, and the part itself. */
export function branchOf(parts: ScenePart[], id: string): Set<string> {
  const out = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of parts) if (p.parent && out.has(p.parent) && !out.has(p.id)) out.add(p.id), (grew = true);
  }
  return out;
}

export interface ExplodeChoice {
  /** The way it should come off. */
  dir: ExplodeDir;
  /** How much of the other parts' surface it runs into on the way out, for each way tried, per mm² of its own box (0: clear). */
  costs: Record<string, number>;
}

/** The ways tried, in the order they're preferred when two are as clear. */
const TRIED: ExplodeDir[] = ["joint", "+z", "reverse", "+x", "-x", "+y", "-y", "-z"];
/** How much clearer another way must be before it wins over along the joint. */
const SWITCH = 0.05;

/** A box's twelve triangles, for a part with no triangles to hand. */
function boxTriangles(size: Vec3): Float32Array {
  const [x, y, z] = size.map(v => v / 2);
  const c = (i: number): number[] => [i & 1 ? x : -x, i & 2 ? y : -y, i & 4 ? z : -z];
  const quads = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
  return new Float32Array(quads.flatMap(([a, b, d, e]) => [...c(a), ...c(b), ...c(d), ...c(a), ...c(d), ...c(e)]));
}

/** One part's triangles in the world, with each one's box, worked out once for every joint tried. */
interface Solid {
  id: string;
  box: Box3;
  tri: Float32Array;
  /** Per triangle: min x, y, z, max x, y, z. */
  bounds: Float32Array;
  area: Float32Array;
}

function solidOf(id: string, shape: ExplodeShape, m: Matrix4): Solid {
  const src = shape.triangles && shape.triangles.length >= 9 ? shape.triangles : boxTriangles(shape.size);
  const n = Math.floor(src.length / 9);
  const tri = new Float32Array(n * 9);
  const bounds = new Float32Array(n * 6);
  const area = new Float32Array(n);
  const v = new Vector3(), a = new Vector3(), b = new Vector3();
  const box = new Box3();
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < 3; k++) {
      v.set(src[t * 9 + k * 3], src[t * 9 + k * 3 + 1], src[t * 9 + k * 3 + 2]).applyMatrix4(m);
      tri.set([v.x, v.y, v.z], t * 9 + k * 3);
      box.expandByPoint(v);
    }
    for (let k = 0; k < 3; k++) {
      const p = [tri[t * 9 + k], tri[t * 9 + 3 + k], tri[t * 9 + 6 + k]];
      bounds[t * 6 + k] = Math.min(...p);
      bounds[t * 6 + 3 + k] = Math.max(...p);
    }
    a.set(tri[t * 9 + 3] - tri[t * 9], tri[t * 9 + 4] - tri[t * 9 + 1], tri[t * 9 + 5] - tri[t * 9 + 2]);
    b.set(tri[t * 9 + 6] - tri[t * 9], tri[t * 9 + 7] - tri[t * 9 + 1], tri[t * 9 + 8] - tri[t * 9 + 2]);
    area[t] = a.cross(b).length() / 2;
  }
  return { id, box, tri, bounds, area };
}

/**
 * Smart explode for a whole scene: the parts' triangles are put in the
 * world once (assembled), then `choose` works out each joint's way.
 *
 * A way is scored by how much of the other parts' surface the part (and
 * what's joined to it) would run into, slid out its explode distance that
 * way. Its box is shrunk a little and starts a little way out, so the faces
 * it rests on or against don't count, only what lies ahead of it: a floor
 * beneath, a wall beside, a lid above. Along the joint wins unless another
 * way is clearly clearer, and up beats the rest when they tie.
 *
 * `world` is every part's place assembled (worldMatrices(parts, 0, false)).
 * Parts with no shape (wires) are left out.
 */
export function explodeChooser(parts: ScenePart[], world: Map<string, Matrix4>, shapes: Map<string, ExplodeShape>): (id: string) => ExplodeChoice | null {
  const solids = new Map<string, Solid>();
  for (const p of parts) {
    const shape = shapes.get(p.id);
    const m = world.get(p.id);
    if (shape && m && !p.hidden && !p.wire) solids.set(p.id, solidOf(p.id, shape, m));
  }
  const triangle = new Triangle();
  const { a: tri, b: tri2, c: tri3 } = triangle;
  return (id: string) => {
    const part = parts.find(p => p.id === id);
    if (!part?.parent || !part.joint || part.joint.distance <= 0) return null;
    const parentWorld = world.get(part.parent);
    if (!parentWorld) return null;
    const branch = branchOf(parts, id);
    const moving = new Box3();
    for (const b of branch) {
      const s = solids.get(b);
      if (s) moving.union(s.box);
    }
    if (moving.isEmpty()) return null;
    // Shrunk, so what it touches at rest along its sides doesn't count.
    const size = moving.getSize(new Vector3());
    moving.expandByVector(new Vector3(...size.toArray().map(v => -Math.min(0.3, v / 4))));
    const s2 = moving.getSize(new Vector3());
    const skin = 2 * (s2.x * s2.y + s2.y * s2.z + s2.z * s2.x) || 1;
    const costs: Record<string, number> = {};
    for (const dir of TRIED) {
      const d = explodeVector({ normal: part.joint.normal, explodeDir: dir }, parentWorld).transformDirection(parentWorld);
      const start = moving.clone().translate(d.clone().multiplyScalar(0.5));
      const region = start.clone().union(moving.clone().translate(d.clone().multiplyScalar(part.joint.distance)));
      let hit = 0;
      for (const s of solids.values()) {
        if (branch.has(s.id) || !s.box.intersectsBox(region)) continue;
        const { bounds: bb, tri: t } = s;
        for (let i = 0; i < s.area.length; i++) {
          const o = i * 6;
          if (bb[o] > region.max.x || bb[o + 3] < region.min.x || bb[o + 1] > region.max.y || bb[o + 4] < region.min.y || bb[o + 2] > region.max.z || bb[o + 5] < region.min.z) continue;
          tri.fromArray(t, i * 9);
          tri2.fromArray(t, i * 9 + 3);
          tri3.fromArray(t, i * 9 + 6);
          if (region.intersectsTriangle(triangle)) hit += s.area[i];
        }
      }
      costs[dir] = hit / skin;
    }
    let best: ExplodeDir = "joint";
    for (const dir of TRIED) if (costs[dir] < costs[best] - 1e-9) best = dir;
    // The way it naturally comes off: along the joint, unless it plainly
    // sits on one side of its parent and the joint points elsewhere (a
    // shield joined by its edge, still sat on top of its board).
    let natural: ExplodeDir = "joint";
    const own = solids.get(id), under = solids.get(part.parent);
    const side = own && under ? stackedSide(own.box, under.box) : null;
    if (side) {
      const n = explodeVector(part.joint, parentWorld).transformDirection(parentWorld);
      if (n.dot(new Vector3(...AXES[side])) < 0.7) natural = side;
    }
    if (costs[natural] - costs[best] < SWITCH) best = natural;
    return { dir: best, costs };
  };
}

/**
 * The side of its parent a part plainly sits on: the axis they meet across
 * (overlapping least), where the part sticks out past the parent on one
 * side only. Null when it sits inside it (a board in a tub) or it can't tell.
 */
export function stackedSide(part: Box3, parent: Box3): Exclude<ExplodeDir, "joint" | "reverse"> | null {
  const EPS = 0.01;
  let best: Exclude<ExplodeDir, "joint" | "reverse"> | null = null;
  let least = Infinity;
  (["x", "y", "z"] as const).forEach(k => {
    const over = Math.min(part.max[k], parent.max[k]) - Math.max(part.min[k], parent.min[k]);
    const plus = part.max[k] > parent.max[k] + EPS;
    const minus = part.min[k] < parent.min[k] - EPS;
    if (plus === minus) return;
    if (over < least) {
      least = over;
      best = `${plus ? "+" : "-"}${k}` as Exclude<ExplodeDir, "joint" | "reverse">;
    }
  });
  return best;
}

/** Smart explode for one joint (see explodeChooser). */
export function smartExplode(parts: ScenePart[], world: Map<string, Matrix4>, shapes: Map<string, ExplodeShape>, id: string): ExplodeChoice | null {
  return explodeChooser(parts, world, shapes)(id);
}
