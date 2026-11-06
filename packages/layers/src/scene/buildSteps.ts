// Build steps: the order the project's model goes together in, picked by
// hand. The whole model is built once (parts and joints); then each step
// says which parts are fitted in it. The workspace shows a step as its
// guide page will (earlier steps ghosted, this step's parts highlighted and
// drawn apart along their joints), and the assembly guide draws one page
// per step. With no steps, the guide makes its own from the joint tree
// (guideSteps in guide.ts).
//
// Fixings (screws, nuts: see isFastener) needn't be put in a step: one left
// out goes in the step of the part it's joined to.

import { guideSteps, treeOrder, type GuideStep } from "./guide";
import type { ProjectModel, ScenePart } from "./model";
import { trackPieces } from "./trackSpec";
import { newStepId, type BuildStep } from "./stepsSpec";

export { normalizeSteps, newStepId, tidySteps, normalizeGuide, MAX_GUIDE_TOOLS, MAX_TOOL_LENGTH, type BuildStep, type GuideSettings } from "./stepsSpec";
export { guideTools } from "../tools";

/** Which step (its index) each part was put in by hand. */
export function stepIndex(steps: BuildStep[]): Map<string, number> {
  const out = new Map<string, number>();
  steps.forEach((s, i) => s.parts.forEach(id => out.has(id) || out.set(id, i)));
  return out;
}

/** The parts a step can hold: not wires, not the piece a track is made from. */
export function steppable(parts: ScenePart[]): ScenePart[] {
  const pieces = trackPieces(parts);
  return treeOrder(parts).filter(p => !p.wire && !pieces.has(p.id));
}

/**
 * For each fixing, the part it goes with: the nearest part up its chain of
 * parents that isn't a fixing (undefined when there's none).
 */
export function fixingOwners(parts: ScenePart[], fixing: (p: ScenePart) => boolean): Map<string, string | undefined> {
  const byId = new Map(parts.map(p => [p.id, p]));
  const out = new Map<string, string | undefined>();
  for (const p of parts) {
    if (!fixing(p)) continue;
    let at: ScenePart | undefined = p;
    let depth = 0;
    while (at && fixing(at) && depth++ < 64) at = at.parent ? byId.get(at.parent) : undefined;
    out.set(p.id, at && !fixing(at) ? at.id : undefined);
  }
  return out;
}

export interface PlannedStep extends GuideStep {
  /** The step it came from (none: a part no step had, given a step of its own at the end). */
  stepId?: string;
  title?: string;
  view?: string;
}

/**
 * The guide's steps from the model's build steps. Each step fits the parts
 * put in it; a fixing no step has goes with the part it's joined to; a part
 * no step has gets a step of its own at the end (so nothing is left out).
 * Steps with nothing in them are skipped, and the rest numbered from 1.
 */
export function planSteps(model: Pick<ProjectModel, "parts"> & { steps?: BuildStep[] }, fixing: (p: ScenePart) => boolean): PlannedStep[] {
  const steps = model.steps || [];
  const parts = steppable(model.parts);
  const at = stepIndex(steps);
  const owners = fixingOwners(model.parts, fixing);
  const planned: PlannedStep[] = steps.map(s => ({ n: 0, added: [], fixings: [], stepId: s.id, ...(s.title ? { title: s.title } : {}), ...(s.view ? { view: s.view } : {}) }));
  const extra = new Map<string, PlannedStep>();
  // The step a part (by id) ends up in.
  const home = new Map<string, PlannedStep>();
  const loose: ScenePart[] = [];
  for (const p of parts) {
    if (fixing(p)) continue;
    const i = at.get(p.id);
    let step = i === undefined ? undefined : planned[i];
    if (!step) {
      step = { n: 0, added: [], fixings: [] };
      extra.set(p.id, step);
    }
    step.added.push(p);
    home.set(p.id, step);
  }
  for (const p of parts) {
    if (!fixing(p)) continue;
    const i = at.get(p.id);
    const owner = owners.get(p.id);
    const step = i !== undefined ? planned[i] : owner ? home.get(owner) : undefined;
    if (step) step.fixings.push(p);
    else loose.push(p);
  }
  const out = [...planned, ...extra.values()].filter(s => s.added.length || s.fixings.length);
  // Fixings joined to nothing, in no step, are laid out with the first step (as the guide does with no steps).
  if (loose.length) {
    if (!out.length) out.push({ n: 0, added: [], fixings: [] });
    out[0].fixings.push(...loose);
  }
  out.forEach((s, i) => (s.n = i + 1));
  return out;
}

/** Steps worked out from the joint tree (as the guide does with none), for Suggest steps. */
export function suggestSteps(model: Pick<ProjectModel, "parts">, fixing: (p: ScenePart) => boolean): BuildStep[] {
  // What a scene shows of the parts (hidden in a step's picture) doesn't count.
  const parts = steppable(model.parts).map(p => {
    const o = { ...p };
    delete o.hidden;
    return o;
  });
  const out: BuildStep[] = [];
  for (const g of guideSteps({ parts }, fixing)) out.push({ id: newStepId(out), parts: g.added.map(p => p.id) });
  return out;
}

/**
 * Which step (its index in `steps`) each part shows up in: the step it was
 * put in, or for a fixing in none, its part's step (the first step when
 * it's joined to nothing). Parts in no step aren't in the map.
 */
export function stepOfParts(parts: ScenePart[], steps: BuildStep[], fixing: (p: ScenePart) => boolean): Map<string, number> {
  const at = stepIndex(steps);
  const out = new Map<string, number>();
  const owners = fixingOwners(parts, fixing);
  for (const p of steppable(parts)) {
    const i = at.get(p.id);
    if (i !== undefined) out.set(p.id, i);
    else if (fixing(p)) {
      const owner = owners.get(p.id);
      const j = owner ? at.get(owner) : 0;
      if (j !== undefined) out.set(p.id, j);
    }
  }
  return out;
}

export interface StepWarning {
  part: string;
  /** What it's joined to that isn't fitted yet. */
  needs: string;
  /** The step that is fitted in (its index), or -1 when no step has it. */
  later: number;
}

/**
 * Parts in step `i` (see stepOfParts) that are joined to a part fitted
 * later, or not at all: they'd float in the picture, with nothing to fit
 * them to.
 */
export function stepWarnings(parts: ScenePart[], at: Map<string, number>, i: number): StepWarning[] {
  const byId = new Map(parts.map(p => [p.id, p]));
  const pieces = trackPieces(parts);
  const out: StepWarning[] = [];
  for (const p of parts) {
    if (at.get(p.id) !== i || !p.parent) continue;
    const parent = byId.get(p.parent);
    if (!parent || parent.wire || pieces.has(parent.id)) continue;
    const k = at.get(p.parent) ?? -1;
    if (k < 0 || k > i) out.push({ part: p.id, needs: p.parent, later: k });
  }
  return out;
}

/**
 * Recording steps: whether a part can be fitted yet, given the parts fitted
 * so far. A part joined to another can't go on before it.
 */
export function readyToFit(part: ScenePart, fitted: Set<string>, parts: ScenePart[]): boolean {
  if (!part.parent) return true;
  const parent = parts.find(p => p.id === part.parent);
  if (!parent || parent.wire || trackPieces(parts).has(parent.id)) return true;
  return fitted.has(parent.id);
}
