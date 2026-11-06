// The step frame, as on a flat-pack sheet: which parts a step uses (with
// "2x" counts), arrows along the joints of parts drawn apart, and a "turn
// it" mark when a step looks from a different side than the project's
// chosen view. The pure parts live here; the editor draws them.

import type { ProjectModel, SceneData, ScenePart } from "./scene/model";
import { highlightedParts } from "./scene/model";
import { trackPieces } from "./scene/trackSpec";
import { normalizeScrew, type ScrewHead, type ScrewSpec } from "./scene/screw";

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
 * Parts counted by kind. A track (Make track) counts as its piece, once
 * per piece in it, so a step or parts list says "32x" of the link, not
 * "1x" of the whole track. `all` is where its piece is looked up.
 */
function countByKind(list: ScenePart[], all: ScenePart[]): PartCount[] {
  const byId = new Map(all.map(p => [p.id, p]));
  const groups = new Map<string, PartCount>();
  for (const p of list) {
    const piece = p.track ? byId.get(p.track.link) : undefined;
    const part = piece || p;
    const n = piece ? Math.max(1, p.track!.count) : 1;
    const key = partKey(part);
    const g = groups.get(key);
    if (g) g.count += n;
    else groups.set(key, { key, part, count: n });
  }
  return [...groups.values()];
}

/**
 * The parts a step uses: the highlighted parts, counted by kind, in the
 * order they appear. With nothing highlighted, every part shown (not a
 * ghost) counts instead, so a one-part first step still lists it.
 */
export function partsInStep(scene: SceneData): PartCount[] {
  const lit = highlightedParts(scene.parts);
  // A wire isn't a part to fetch: it's laid between them (wiring steps come later).
  // A track's piece, shown while its track is, counts with the track.
  const pieces = trackPieces(scene.parts);
  const shown = scene.parts.filter(p => !p.hidden && !p.ghost && !p.wire && !pieces.has(p.id));
  const list = shown.some(p => lit.has(p.id)) ? shown.filter(p => lit.has(p.id)) : shown;
  return countByKind(list, scene.parts);
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
/** ...and no more than this thick (their smallest dimension): a screw, nut or peg is thin one way, a motor isn't. */
export const FASTENER_THIN_MM = 8;

/**
 * Whether a part of this size (mm) is a fixing: its middle dimension is
 * small, whatever its length, and it's thin one way. A small motor (an N20
 * gearmotor, 12 × 10 × 34) is a part, not a fixing.
 */
export function isFastener(size: [number, number, number]): boolean {
  const s = [...size].sort((a, b) => a - b);
  return s[1] <= FASTENER_MM && s[0] <= FASTENER_THIN_MM;
}

/** Every part, counted by kind, in model order: the parts list for a whole project. */
export function inventoryOf(parts: ScenePart[]): PartCount[] {
  const pieces = trackPieces(parts);
  return countByKind(parts.filter(p => !p.wire && !pieces.has(p.id)), parts);
}

/** One kind of screw (or heat-set insert) in the project, with how many it uses. */
export interface ScrewCount {
  /** "insert:3:5.7", "countersunk:3:8": what makes two screws the same screw. */
  key: string;
  screw: ScrewSpec;
  /** One of them, to draw. */
  part: ScenePart;
  count: number;
}

const HEAD_ORDER: ScrewHead[] = ["socket", "button", "countersunk", "pan", "insert"];

/**
 * The screw inventory: every screw and heat-set insert the screw tool put
 * in, counted by kind (head, size and length), hidden parts left out.
 * Screws come by head, then size, then length; inserts last.
 */
export function screwInventoryOf(parts: ScenePart[]): ScrewCount[] {
  const groups = new Map<string, ScrewCount>();
  for (const p of parts) {
    if (p.hidden) continue;
    const screw = normalizeScrew(p.screw);
    if (!screw) continue;
    const key = `${screw.head}:${screw.d}:${screw.length}`;
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { key, screw, part: p, count: 1 });
  }
  return [...groups.values()].sort((a, b) => HEAD_ORDER.indexOf(a.screw.head) - HEAD_ORDER.indexOf(b.screw.head) || a.screw.d - b.screw.d || a.screw.length - b.screw.length);
}
