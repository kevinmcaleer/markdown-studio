// The step frame, as on a flat-pack sheet: which parts a step uses (with
// "2x" counts), arrows along the joints of parts drawn apart, and a "turn
// it" mark when a step looks from a different side than the project's
// chosen view. The pure parts live here; the editor draws them.

import type { ProjectModel, SceneData, ScenePart } from "./scene/model";
import { highlightedParts } from "./scene/model";

export interface PartCount {
  /** What makes two parts the same part: their file (and solid), or their carried data. */
  key: string;
  part: ScenePart;
  count: number;
}

/** What makes two parts the same part: the same file (and solid in it), or the same carried model. */
export function partKey(p: ScenePart): string {
  return p.url ? `url:${p.url}#${p.body ?? ""}` : `data:${p.data?.length || 0}:${p.data?.slice(0, 64) || ""}`;
}

/**
 * The parts a step uses: the highlighted parts, counted by kind, in the
 * order they appear. With nothing highlighted, every part shown (not a
 * ghost) counts instead, so a one-part first step still lists it.
 */
export function partsInStep(scene: SceneData): PartCount[] {
  const lit = highlightedParts(scene.parts);
  const shown = scene.parts.filter(p => !p.hidden && !p.ghost);
  const list = shown.some(p => lit.has(p.id)) ? shown.filter(p => lit.has(p.id)) : shown;
  const groups = new Map<string, PartCount>();
  for (const p of list) {
    const key = partKey(p);
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { key, part: p, count: 1 });
  }
  return [...groups.values()];
}

/** The angle, in degrees, between where two cameras look from. */
export function viewAngle(a: [number, number, number], b: [number, number, number]): number {
  const la = Math.hypot(...a) || 1;
  const lb = Math.hypot(...b) || 1;
  const dot = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb);
  return (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
}

/** How far a step has turned the model from the project's chosen view, or null when there is no chosen view. */
export function turnedFromDefault(scene: SceneData, model: ProjectModel | null | undefined): number | null {
  const v = model?.defaultView ? model.views?.find(x => x.id === model.defaultView) : undefined;
  if (!v) return null;
  return viewAngle(scene.camera.direction, v.camera.direction);
}

/** A step is "turned" when it looks from more than this many degrees off the chosen view. */
export const TURNED_DEGREES = 30;

/** Parts no more than this many mm across (their middle dimension) count as fixings: screws, nuts, pegs. */
export const FASTENER_MM = 12;

/** Whether a part of this size (mm) is a fixing: its middle dimension is small, whatever its length. */
export function isFastener(size: [number, number, number]): boolean {
  const s = [...size].sort((a, b) => a - b);
  return s[1] <= FASTENER_MM;
}

/** Every part, counted by kind, in model order: the parts list for a whole project. */
export function inventoryOf(parts: ScenePart[]): PartCount[] {
  const groups = new Map<string, PartCount>();
  for (const p of parts) {
    const key = partKey(p);
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { key, part: p, count: 1 });
  }
  return [...groups.values()];
}
