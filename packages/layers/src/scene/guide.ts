// The assembly guide, as a flat-pack booklet: from the project's model, one
// step per part (the first step fits the second part onto the first), its
// fixings folded into the step of the part they're joined to, the parts of
// earlier steps drawn as ghosts, the step's own parts highlighted and drawn
// apart along their joints. The pure planning lives here; the editor draws
// the pages (see assemblyGuide in editor.ts).

import type { ProjectModel, SceneCamera, SceneData, ScenePart, SceneStyle } from "./model";
import { blankScene } from "./model";

export interface GuideStep {
  /** The step's number, from 1. */
  n: number;
  /** The parts fitted in this step (not its fixings), in model order. */
  added: ScenePart[];
  /** Its fixings: the small parts joined to the parts fitted here. */
  fixings: ScenePart[];
}

/**
 * The parts in tree order: each part without a parent, followed by its
 * children (and theirs), depth first, each list in model order. A part
 * whose parent isn't in the list counts as a root.
 */
export function treeOrder(parts: ScenePart[]): ScenePart[] {
  const ids = new Set(parts.map(p => p.id));
  const children = new Map<string, ScenePart[]>();
  const roots: ScenePart[] = [];
  for (const p of parts) {
    if (p.parent && ids.has(p.parent) && p.parent !== p.id) (children.get(p.parent) || children.set(p.parent, []).get(p.parent)!).push(p);
    else roots.push(p);
  }
  const out: ScenePart[] = [];
  const seen = new Set<string>();
  const walk = (p: ScenePart) => {
    if (seen.has(p.id)) return;
    seen.add(p.id);
    out.push(p);
    for (const c of children.get(p.id) || []) walk(c);
  };
  roots.forEach(walk);
  // Parts in a loop of parents (never valid, but never lost either).
  parts.forEach(walk);
  return out;
}

/**
 * The steps of the guide. `fixing` says which parts are fixings (screws,
 * nuts, pegs): each goes with the step of the nearest part up its chain of
 * parents that isn't one (or the first step). Hidden parts are left out.
 */
export function guideSteps(model: Pick<ProjectModel, "parts">, fixing: (p: ScenePart) => boolean): GuideStep[] {
  const order = treeOrder(model.parts).filter(p => !p.hidden);
  const byId = new Map(order.map(p => [p.id, p]));
  const big = order.filter(p => !fixing(p));
  if (!big.length) return [];
  const groups: ScenePart[][] = [];
  big.forEach((p, i) => {
    // The first step fits the second part onto the first: a part alone is no step.
    if (i === 1) groups[0].push(p);
    else groups.push([p]);
  });
  const stepOf = new Map<string, number>();
  groups.forEach((g, i) => g.forEach(p => stepOf.set(p.id, i)));
  const steps: GuideStep[] = groups.map((added, i) => ({ n: i + 1, added, fixings: [] }));
  for (const p of order) {
    if (!fixing(p)) continue;
    let at: ScenePart | undefined = p;
    let depth = 0;
    while (at && fixing(at) && depth++ < 64) at = at.parent ? byId.get(at.parent) : undefined;
    steps[at ? (stepOf.get(at.id) ?? 0) : 0].fixings.push(p);
  }
  return steps;
}

/** What a part shows in a scene, as the guide sets it (the model's own showing is dropped). */
function showing(p: ScenePart): ScenePart {
  const out = structuredClone(p);
  delete out.hidden;
  delete out.ghost;
  delete out.highlight;
  delete out.explode;
  return out;
}

/**
 * The scene for one step: the step's parts and fixings highlighted and
 * drawn apart along their joints, the parts of earlier steps as ghosts,
 * later parts hidden. Everything else (camera, style) is given.
 */
export function stepScene(model: Pick<ProjectModel, "parts">, steps: GuideStep[], n: number, camera: SceneCamera, style: SceneStyle): SceneData {
  const now = new Set<string>();
  const before = new Set<string>();
  for (const s of steps) {
    const ids = [...s.added, ...s.fixings].map(p => p.id);
    if (s.n === n) ids.forEach(id => now.add(id));
    else if (s.n < n) ids.forEach(id => before.add(id));
  }
  const parts = model.parts.map(p => {
    const out = showing(p);
    if (now.has(p.id)) {
      out.highlight = true;
      out.explode = 1;
    } else if (before.has(p.id)) {
      out.ghost = true;
      out.highlight = false;
      out.explode = 0;
    } else out.hidden = true;
    return out;
  });
  return { ...blankScene(), parts, camera: structuredClone(camera), style: structuredClone(style), explode: 0, arrows: true };
}

/** The scene for the cover: everything fitted, nothing highlighted. */
export function coverScene(model: Pick<ProjectModel, "parts">, camera: SceneCamera, style: SceneStyle): SceneData {
  const parts = model.parts.filter(p => !p.hidden).map(p => ({ ...showing(p), highlight: false, explode: 0 }));
  return { ...blankScene(), parts, camera: structuredClone(camera), style: structuredClone(style), explode: 0 };
}

/** A step's heading: the names of the parts it fits, "Bracket plate and motor mount", or with "and 2 more". */
export function stepTitle(step: GuideStep): string {
  const names = [...new Set(step.added.map(p => (p.name || "part").trim()))];
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  if (names.length <= 2) return cap(names.join(" and "));
  return cap(`${names[0]} and ${names.length - 1} more`);
}
