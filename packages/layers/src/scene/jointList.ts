import type { JointType, ScenePart } from "./model";

/** One joint a part has, as the Part inspector lists it. */
export interface PartJointEntry {
  /** The joint's id: the joined (child) part's id, since the joint is kept on it. */
  id: string;
  /** "on": this part is joined to `other`. "holds": `other` is joined to this part. */
  role: "on" | "holds";
  /** The part at the other end of the joint. */
  other: ScenePart;
  /** How it moves (a joint from before faces were picked is fixed). */
  type: JointType;
  /** Whether it comes apart in an exploded view (unticked in the tree: it stays assembled). */
  explodes: boolean;
}

/**
 * Every joint `id` has: the one joining it to its parent first, then the
 * parts joined to it in the scene's order. Wires and parts whose other end
 * is missing are left out, as the parts tree leaves them out.
 */
export function partJoints(parts: ScenePart[], id: string): PartJointEntry[] {
  const byId = new Map(parts.map(p => [p.id, p]));
  const me = byId.get(id);
  if (!me || me.wire) return [];
  const entry = (child: ScenePart, role: PartJointEntry["role"], other: ScenePart): PartJointEntry => ({
    id: child.id,
    role,
    other,
    type: (child.joint?.point && child.joint.type) || "fixed",
    explodes: child.explode !== 0,
  });
  const out: PartJointEntry[] = [];
  const parent = me.parent ? byId.get(me.parent) : undefined;
  if (parent && me.joint && parent.id !== me.id) out.push(entry(me, "on", parent));
  for (const c of parts) {
    if (c.id !== id && c.parent === id && c.joint && !c.wire) out.push(entry(c, "holds", c));
  }
  return out;
}
