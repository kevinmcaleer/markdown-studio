// Mirroring a wire to the other side of the model: the left leg's wiring
// made again on the right leg. The mirror is the model's YZ plane (through
// the middle of its parts, across X). Each part a wire touches has its
// partner on the other side: the part whose middle is nearest where the
// mirror puts this one's. A point on a part goes to the mirrored point, in
// its partner's frame, so the new wire follows the partner as it moves.

import { Matrix3, Matrix4, Vector3 } from "three";
import { isWiring, type ScenePart, type Vec3 } from "./model";

const r3 = (n: number, places: number) => {
  const f = 10 ** places;
  const v = Math.round(n * f) / f;
  return Object.is(v, -0) ? 0 : v;
};

/** Where the mirror is: x across the middle of the parts (not their wiring), as placed by `world`. */
export function mirrorPlane(parts: ScenePart[], world: Map<string, Matrix4>): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of parts) {
    if (isWiring(p)) continue;
    const m = world.get(p.id);
    if (!m) continue;
    const x = m.elements[12];
    lo = Math.min(lo, x);
    hi = Math.max(hi, x);
  }
  return Number.isFinite(lo) ? (lo + hi) / 2 : 0;
}

/**
 * The part on the other side of the mirror from `id`: the one whose middle
 * is nearest the mirrored middle, within `tolerance` mm (null when none is).
 * A part on the mirror is its own partner.
 */
export function mirrorPartner(parts: ScenePart[], world: Map<string, Matrix4>, id: string, plane: number, tolerance: number): string | null {
  const m = world.get(id);
  if (!m) return null;
  const at = new Vector3().setFromMatrixPosition(m);
  at.x = 2 * plane - at.x;
  let best: string | null = null;
  let bestD = tolerance;
  for (const p of parts) {
    if (isWiring(p)) continue;
    const q = world.get(p.id);
    if (!q) continue;
    const d = new Vector3().setFromMatrixPosition(q).distanceTo(at);
    if (d <= bestD) {
      best = p.id;
      bestD = d;
    }
  }
  return best;
}

/** A point and its face's normal on one part, mirrored onto another (each in its own part's frame). */
export function mirrorPoint(point: Vec3, normal: Vec3 | undefined, from: Matrix4, to: Matrix4, plane: number): { point: Vec3; normal?: Vec3 } {
  const w = new Vector3(...point).applyMatrix4(from);
  w.x = 2 * plane - w.x;
  const back = to.clone().invert();
  const local = w.applyMatrix4(back);
  const out: { point: Vec3; normal?: Vec3 } = { point: [r3(local.x, 3), r3(local.y, 3), r3(local.z, 3)] };
  if (normal) {
    const n = new Vector3(...normal).applyMatrix3(new Matrix3().setFromMatrix4(from)).normalize();
    n.x = -n.x;
    n.applyMatrix3(new Matrix3().setFromMatrix4(back)).normalize();
    out.normal = [r3(n.x, 5), r3(n.y, 5), r3(n.z, 5)];
  }
  return out;
}
