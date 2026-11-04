// Joining one part to another, face to face: the same maths as Snakie's
// Build workspace "Add joint" (Snakie src/renderer/src/components/
// robot-joint-frame.ts, #354). Pick a face on each part; the child turns so
// its face looks straight back at the parent's (they meet flush) and moves
// so its picked point lands on the parent's. It can then spin about the
// shared face normal and stand off along it by a gap.
//
// Points and normals are in each part's own frame (its middle at 0, 0, 0).
// The result is the child's place in the parent's frame, as a part's
// position (mm) and rotation (roll, pitch, yaw in degrees, URDF order).

import { Euler, Quaternion, Vector3 } from "three";
import type { ScenePart, Vec3 } from "./model";

const DEG = Math.PI / 180;

export interface JointPicks {
  /** The picked point and outward face normal on the parent, in the parent's frame. */
  point: Vec3;
  normal: Vec3;
  /** The picked point and outward face normal on the child, in the child's frame. */
  childPoint: Vec3;
  childNormal: Vec3;
  /** Degrees about the shared normal. */
  spin: number;
  /** Millimetres the child stands off the parent's face. */
  gap: number;
}

export function jointPlace(j: JointPicks): { position: Vec3; rotation: Vec3 } {
  const pn = new Vector3(...j.normal).normalize();
  const cn = new Vector3(...j.childNormal).normalize();
  // Turn the child so its face looks opposite the parent's (a flush fit)…
  const q = new Quaternion().setFromUnitVectors(cn, pn.clone().negate());
  // …then spin it about the shared normal.
  if (j.spin) q.premultiply(new Quaternion().setFromAxisAngle(pn, j.spin * DEG));
  // So that position + R·childPoint = point + gap·normal.
  const rc = new Vector3(...j.childPoint).applyQuaternion(q);
  const target = new Vector3(...j.point).addScaledVector(pn, j.gap);
  const e = new Euler().setFromQuaternion(q, "ZYX");
  const r = (n: number) => Math.round(n * 1000) / 1000 + 0;
  return {
    position: [r(target.x - rc.x), r(target.y - rc.y), r(target.z - rc.z)],
    rotation: [r(e.x / DEG), r(e.y / DEG), r(e.z / DEG)],
  };
}

/** Puts a joined part where its joint says. */
export function applyJoint(part: ScenePart): void {
  const j = part.joint;
  if (!j || !j.point || !j.childPoint || !j.childNormal) return;
  const at = jointPlace({ point: j.point, normal: j.normal, childPoint: j.childPoint, childNormal: j.childNormal, spin: j.spin || 0, gap: j.gap || 0 });
  part.position = at.position;
  part.rotation = at.rotation;
}
