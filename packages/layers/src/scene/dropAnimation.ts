// The drop-in animation ("/Dropping model" in the Markdown editor): the
// project's model built up a part at a time, each part falling in from
// above the picture and bouncing to a stop where it fits, then held
// finished before the loop starts again. The view never moves; only the
// parts do, each straight down the up axis (Z).
//
// This file plans the motion (which parts fall when, and how high each one
// is at any moment); the drawing and encoding are animation.ts's.

import { type Box3, type Matrix4, type OrthographicCamera } from "three";
import { ANIMATION_BACKGROUND, animationParts, animationStyle, encodeFrames, fitPoints, samplePoints, type Animation, type AnimationOptions } from "./animation";
import { stepIndex } from "./buildSteps";
import type { ProjectModel, ScenePart, Vec3 } from "./model";
import type { BuildStep } from "./stepsSpec";
import { cameraFor, LineArt, worldMatrices, type ModelStore } from "./render";

/** How long each part of the loop lasts, in seconds. */
export interface DropTiming {
  /** A part's fall, from out of the picture to where it fits. */
  fall: number;
  /** Between one part (or set of matching parts) setting off and the next. */
  gap: number;
  /** The longest all the gaps together may take: with many parts, they come quicker. */
  maxGaps: number;
  /** Finished, before the loop starts again. */
  hold: number;
  /** Empty, at the very start. */
  empty: number;
}
export const DROP_TIMING: DropTiming = { fall: 0.5, gap: 0.45, maxGaps: 9, hold: 2, empty: 0.3 };

/** Each bounce's height, as a share of the picture's half-height (the camera's size); each one smaller. */
export const DROP_BOUNCES = [0.14, 0.045, 0.012];

/** Where a part sits, fully assembled, in the world: the bottom and top of its box, in mm. */
export interface PartSpan {
  lo: number;
  hi: number;
}

/**
 * A part's sameness: matching parts on matching parts (two wheels, each on
 * its own motor; four screws in the one plate) fall together.
 */
function looksOf(parts: ScenePart[]): Map<string, string> {
  const byId = new Map(parts.map(p => [p.id, p]));
  const out = new Map<string, string>();
  const look = (p: ScenePart, depth: number): string => {
    let k = out.get(p.id);
    if (k !== undefined) return k;
    const what = p.screw ? JSON.stringify(p.screw) : p.url ? `${p.url}#${p.body ?? ""}` : p.data ? `${p.data.length}:${p.data.slice(0, 64)}` : "";
    const parent = p.parent ? byId.get(p.parent) : undefined;
    k = what ? `${parent && depth < 64 ? look(parent, depth + 1) : ""}>${what}` : `#${p.id}`;
    out.set(p.id, k);
    return k;
  };
  parts.forEach(p => look(p, 0));
  return out;
}

/**
 * The order the parts fall in, as sets that fall together. A part never
 * falls before the part it's joined to. With build steps, a step's parts
 * fall before the next step's (a part no step has goes with the part it's
 * joined to, or at the end); otherwise, and within a step, the lowest part
 * goes first, so the model builds up from the bottom.
 */
export function dropOrder(parts: ScenePart[], spans: Map<string, PartSpan>, steps?: Map<string, number>): string[][] {
  const byId = new Map(parts.map(p => [p.id, p]));
  const stepOf = (p: ScenePart): number => {
    for (let q: ScenePart | undefined = p, n = 0; q && n < 64; q = q.parent ? byId.get(q.parent) : undefined, n++) {
      const s = steps?.get(q.id);
      if (s !== undefined) return s;
    }
    return Infinity;
  };
  const looks = looksOf(parts);
  const groups = new Map<string, ScenePart[]>();
  for (const p of parts) {
    const k = looks.get(p.id)!;
    const g = groups.get(k);
    if (g) g.push(p);
    else groups.set(k, [p]);
  }
  // A set splits if its members are in different steps.
  const sets: ScenePart[][] = [];
  for (const g of groups.values()) {
    const bySteps = new Map<number, ScenePart[]>();
    for (const p of g) {
      const s = stepOf(p);
      bySteps.set(s, [...(bySteps.get(s) || []), p]);
    }
    sets.push(...bySteps.values());
  }
  const info = sets.map(set => ({
    set,
    step: Math.min(...set.map(stepOf)),
    lo: Math.min(...set.map(p => spans.get(p.id)?.lo ?? 0)),
    // Joined to a part that is in the model (not itself, nor one of its set).
    needs: [...new Set(set.flatMap(p => (p.parent && byId.has(p.parent) && !set.some(q => q.id === p.parent) ? [p.parent] : [])))],
  }));
  const placed = new Set<string>();
  const out: string[][] = [];
  const left = new Set(info.map((_, i) => i));
  while (left.size) {
    let best = -1;
    for (const i of left) {
      if (!info[i].needs.every(id => placed.has(id))) continue;
      if (best < 0 || info[i].step < info[best].step || (info[i].step === info[best].step && info[i].lo < info[best].lo - 1e-6)) best = i;
    }
    // A loop of joints (shouldn't happen): take the lowest anyway.
    if (best < 0) for (const i of left) if (best < 0 || info[i].lo < info[best].lo) best = i;
    left.delete(best);
    info[best].set.forEach(p => placed.add(p.id));
    out.push(info[best].set.map(p => p.id));
  }
  return out;
}

export interface DropPlan {
  /** The sets of parts, in the order they fall. */
  order: string[][];
  /** When each set sets off, in seconds from the start of the loop. */
  starts: number[];
  /** When the last part has stopped bouncing. */
  settled: number;
  /** The whole loop. */
  total: number;
  timing: DropTiming;
}

/** How long a part takes from setting off to stopping, given the fall's height and the camera's size. */
export function settleTime(timing: DropTiming, height: number, size: number): number {
  const g = (2 * height) / (timing.fall * timing.fall);
  return timing.fall + DROP_BOUNCES.reduce((t, b) => t + 2 * Math.sqrt((2 * b * size) / g), 0);
}

export function dropPlan(order: string[][], timing: DropTiming = DROP_TIMING, settle = timing.fall + 0.5): DropPlan {
  const gap = order.length > 1 ? Math.min(timing.gap, timing.maxGaps / (order.length - 1)) : 0;
  const starts = order.map((_, i) => timing.empty + i * gap);
  const settled = (starts.length ? starts[starts.length - 1] : timing.empty) + settle;
  return { order, starts, settled, total: settled + timing.hold, timing };
}

/**
 * How high above where it fits a falling part is, `t` seconds after it set
 * off: falling from `height` (speeding up, as things do), then bouncing,
 * lower each time, to a stop. `size` is the camera's size (the picture's
 * half-height in mm), so the bounces look the same whatever the model's size.
 */
export function dropLift(t: number, height: number, size: number, fall = DROP_TIMING.fall): number {
  if (t <= 0) return height;
  const g = (2 * height) / (fall * fall);
  if (t < fall) return height - 0.5 * g * t * t;
  let s = t - fall;
  for (const b of DROP_BOUNCES) {
    const v = Math.sqrt(2 * g * b * size);
    const d = (2 * v) / g;
    if (s < d) return Math.max(0, v * s - 0.5 * g * s * s);
    s -= d;
  }
  return 0;
}

/**
 * How far to drop from so a part starts out of the picture: the picture's
 * whole height and a bit, as seen from `direction` (looking more down
 * on the model, a fall along Z crosses the picture more slowly).
 */
export function dropHeight(direction: [number, number, number], size: number, span = 0): number {
  const len = Math.hypot(...direction) || 1;
  const across = Math.sqrt(Math.max(0, 1 - (direction[2] / len) ** 2));
  return (2.3 * size) / Math.max(0.3, across) + span;
}

/** One frame of the loop: its time (s) and how long it shows (ms). */
export interface DropFrame {
  t: number;
  delay: number;
}

/**
 * The loop's frames at `fps`: the empty start, the parts falling and
 * bouncing, then the finished model held (one long frame).
 */
export function dropFrames(plan: DropPlan, fps = 15): DropFrame[] {
  const step = 1000 / fps;
  const out: DropFrame[] = [{ t: 0, delay: Math.max(step, plan.timing.empty * 1000) }];
  const first = plan.starts[0] ?? plan.timing.empty;
  const n = Math.max(1, Math.ceil((plan.settled - first) * fps));
  for (let i = 0; i < n; i++) out.push({ t: first + i / fps, delay: step });
  out.push({ t: plan.settled, delay: Math.max(step, plan.timing.hold * 1000) });
  return out;
}

/**
 * Each part's lift at time `t` (mm above where it fits), or null for a
 * part that hasn't set off yet (not shown).
 */
export function liftsAt(plan: DropPlan, t: number, height: number, size: number): Map<string, number | null> {
  const out = new Map<string, number | null>();
  plan.order.forEach((set, i) => {
    const since = t - plan.starts[i];
    const lift = since < 0 ? null : dropLift(since, height, size, plan.timing.fall);
    set.forEach(id => out.set(id, lift));
  });
  return out;
}

// ------------------------------------------------------------ drawing it

/** The parts' places, assembled, and the bottom and top of each one's box (world Z, mm). */
export function assembledSpans(parts: ScenePart[], world: Map<string, Matrix4>, boxes: Map<string, Box3>): Map<string, PartSpan> {
  const out = new Map<string, PartSpan>();
  for (const p of parts) {
    const m = world.get(p.id);
    const b = boxes.get(p.id);
    if (!m || !b || b.isEmpty()) continue;
    const w = b.clone().applyMatrix4(m);
    out.set(p.id, { lo: w.min.z, hi: w.max.z });
  }
  return out;
}

/**
 * Draws the project's model as the drop-in loop and encodes it (an MP4,
 * or a GIF where the browser can't make one),
 * seen from `direction` the whole time. With build steps, the parts fall
 * step by step.
 */
export async function renderDropAnimation(model: Pick<ProjectModel, "parts"> & { steps?: BuildStep[] }, store: ModelStore, direction: Vec3, options: AnimationOptions = {}): Promise<Animation> {
  const width = Math.round(options.width ?? 800);
  const height = Math.round(options.height ?? 600);
  const parts = animationParts(model);
  if (!parts.length) throw new Error("The project's model has no parts to show.");
  const settled = await Promise.allSettled(parts.map(async part => ({ part, model: await store.get(part) })));
  const list = settled.flatMap(r => (r.status === "fulfilled" ? [r.value] : []));
  if (!list.length) throw new Error("None of the model's parts could be loaded.");
  const shown = list.map(x => x.part);
  const art = new LineArt();
  const bg = options.background || ANIMATION_BACKGROUND;
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  try {
    art.setParts(list, animationStyle(), 0);
    const world = worldMatrices(shown, 0);
    const boxes = new Map(list.map(({ part, model }) => {
      model.geometry.computeBoundingBox();
      return [part.id, model.geometry.boundingBox!] as const;
    }));
    // Framed round the finished model, with room over it for the bounces.
    const camera = fitPoints(direction, samplePoints(art), width / height, 1.12);
    const fall = dropHeight(direction, camera.size);
    const order = dropOrder(shown, assembledSpans(shown, world, boxes), model.steps?.some(st => st.parts.length) ? stepIndex(model.steps) : undefined);
    const plan = dropPlan(order, DROP_TIMING, settleTime(DROP_TIMING, fall, camera.size));
    const frames = dropFrames(plan, options.fps ?? 15);
    const radius = camera.size * 4 + Math.hypot(...camera.target) + fall;
    const cam: OrthographicCamera = cameraFor(camera, width / height, radius);
    const max = Math.min(art.renderer.capabilities.maxTextureSize || 4096, 8192);
    const ss = Math.max(1, Math.min(2, max / Math.max(width, height)));
    const draw = (i: number): void => {
      art.lift(world, liftsAt(plan, frames[i].t, fall, camera.size));
      art.draw(cam, width, height, ss);
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(art.renderer.domElement, 0, 0, width, height);
    };
    // The GIF's palette from the finished model and part way through.
    return await encodeFrames(out, frames.map(f => f.delay), draw, [frames.length - 1, Math.floor(frames.length / 2)], options);
  } finally {
    art.dispose();
  }
}
