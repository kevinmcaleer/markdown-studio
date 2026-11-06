// The wiring showcase ("/Wiring showcase" in the Markdown editor), as
// tnkr.ai shows a robot's wiring: the model in the see-through view (the
// printed parts as glass, the electronics solid), turning gently to and
// fro, while each wire grows out of its component along its route to
// where it ends, one setting off after another. Held finished, then the
// wires draw back in and the loop starts again. Encoded like the other
// animations (animation.ts): an MP4, or a GIF where the browser can't.

import type { Matrix4, OrthographicCamera } from "three";
import { ANIMATION_BACKGROUND, animationParts, animationStyle, ease, encodeFrames, fitPoints, middleOf, samplePoints, turnDirection, type Animation, type AnimationOptions } from "./animation";
import { wiresInOrder, type ProjectModel, type SceneCamera, type ScenePart, type Vec3 } from "./model";
import { cameraFor, LineArt, worldMatrices, type ModelStore } from "./render";
import { growsFromTo } from "./seeThrough";
import { wireLength } from "./wire";
import { loomsOf } from "./wireSpec";

/** How long each part of the loop lasts, in seconds (and how fast the wires run). */
export interface WiringTiming {
  /** The model alone, before the first wire sets off. */
  lead: number;
  /** Between one wire setting off and the next. */
  gap: number;
  /** The longest all the gaps together may take: with many wires, they set off closer together. */
  maxGaps: number;
  /** How fast a wire's tip runs along its route, mm a second... */
  speed: number;
  /** ...but each wire takes at least this long, and at most this. */
  minGrow: number;
  maxGrow: number;
  /** All the wires in, before they draw back. */
  hold: number;
  /** Drawing back into their components, together. */
  back: number;
  /** How far the view turns either way, in degrees. */
  sway: number;
}
export const WIRING_TIMING: WiringTiming = { lead: 0.6, gap: 0.35, maxGaps: 6, speed: 90, minGrow: 0.9, maxGrow: 2.4, hold: 2, back: 0.7, sway: 20 };

/** A wire's turn in the loop: when it sets off and how long it takes to grow, both in seconds. */
export interface WireTurn {
  id: string;
  start: number;
  grow: number;
}

/** When each wire (given its length, mm) sets off and how long it grows for, and how long the whole loop is. */
export function wiringPlan(wires: { id: string; length: number }[], timing: WiringTiming = WIRING_TIMING): { turns: WireTurn[]; total: number } {
  const gap = wires.length > 1 ? Math.min(timing.gap, timing.maxGaps / (wires.length - 1)) : 0;
  const turns = wires.map((w, i) => ({
    id: w.id,
    start: timing.lead + i * gap,
    grow: Math.max(timing.minGrow, Math.min(timing.maxGrow, (w.length > 0 ? w.length : 60) / timing.speed)),
  }));
  const done = turns.reduce((t, w) => Math.max(t, w.start + w.grow), timing.lead);
  return { turns, total: done + timing.hold + timing.back };
}

/** Quick off the mark, slowing as it arrives. */
const easeOut = (t: number) => 1 - Math.pow(1 - t, 2.2);

/** How far along each wire is grown (0 to 1) at `t` seconds into the loop. */
export function grownAt(turns: WireTurn[], total: number, t: number, timing: WiringTiming = WIRING_TIMING): number[] {
  const backFrom = total - timing.back;
  const back = t > backFrom ? 1 - ease(Math.min(1, (t - backFrom) / timing.back)) : 1;
  return turns.map(w => {
    const own = t <= w.start ? 0 : t >= w.start + w.grow ? 1 : easeOut((t - w.start) / w.grow);
    return Math.min(own, back);
  });
}

/** The view's turn (a share of a whole turn) at `t`: to and fro, ending where it started, so the loop is seamless. */
export function swayAt(t: number, total: number, timing: WiringTiming = WIRING_TIMING): number {
  return (timing.sway / 360) * Math.sin((2 * Math.PI * t) / total);
}

/**
 * The plugs on a wire's ends: those at the end it grows from (shown as it
 * sets off) and those at the end it grows to (shown as it gets there).
 */
export function wirePlugs(wire: ScenePart, parts: ScenePart[], fromTo: boolean): { first: string[]; last: string[] } {
  const byId = new Map(parts.map(p => [p.id, p]));
  const plug = (id: string) => (byId.get(id)?.plug ? [id] : []);
  const a = plug(wire.wire!.from.part);
  const b = plug(wire.wire!.to.part);
  return fromTo ? { first: b, last: a } : { first: a, last: b };
}

/** Draws the project's model as the wiring showcase and encodes it. `direction` is the view it sways about. */
export async function renderWiringAnimation(model: Pick<ProjectModel, "parts">, store: ModelStore, direction: Vec3, options: AnimationOptions = {}, timing: WiringTiming = WIRING_TIMING): Promise<Animation> {
  const width = Math.round(options.width ?? 800);
  const height = Math.round(options.height ?? 600);
  const fps = options.fps ?? 20;
  const parts = animationParts(model);
  const wires = wiresInOrder(parts);
  if (!wires.length) throw new Error("The project's model has no wires yet: add them in a 3D scene with the Wire tool (W).");
  const settled = await Promise.allSettled(parts.map(async part => ({ part, model: await store.get(part) })));
  const list = settled.flatMap(r => (r.status === "fulfilled" ? [r.value] : []));
  if (!list.length) throw new Error("None of the model's parts could be loaded.");
  const shown = list.map(x => x.part);
  const world: Map<string, Matrix4> = worldMatrices(shown, 0);
  const looms = loomsOf(shown);
  const fromTo = new Map(wires.map(w => [w.id, growsFromTo(w, shown, world)]));
  const plugs = new Map(wires.map(w => [w.id, wirePlugs(w, shown, fromTo.get(w.id)!)]));
  const { turns, total } = wiringPlan(wires.map(w => ({ id: w.id, length: wireLength(w, world, looms) })), timing);
  const n = Math.max(2, Math.round(total * fps));
  const step = 1000 / fps;
  const times = Array.from({ length: n }, (_, i) => (i / n) * total);

  const art = new LineArt();
  const bg = options.background || ANIMATION_BACKGROUND;
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  try {
    art.look = { seeThrough: true, bareWires: true };
    art.setParts(list, animationStyle(), 0);
    // One camera for the whole loop: about the model's middle, holding it (wires and all) at every angle of the sway.
    const pts = samplePoints(art);
    const middle = middleOf(pts);
    let size = 1;
    for (let i = 0; i <= 16; i++) size = Math.max(size, fitPoints(turnDirection(direction, ((i / 8 - 1) * timing.sway) / 360), pts, width / height, 1.1, middle).size);
    const cam: SceneCamera = { direction, target: middle, size };
    const radius = cam.size * 4 + Math.hypot(...cam.target);
    const max = Math.min(art.renderer.capabilities.maxTextureSize || 4096, 8192);
    // Drawn twice the size and shrunk, so its lines are smooth.
    const ss = Math.max(1, Math.min(2, max / Math.max(width, height)));
    const last = new Map<string, number>();
    const draw = (i: number): void => {
      const grown = grownAt(turns, total, times[i], timing);
      wires.forEach((w, k) => {
        const u = grown[k];
        const p = plugs.get(w.id)!;
        p.first.forEach(id => art.setShown(id, u > 0));
        p.last.forEach(id => art.setShown(id, u >= 0.98));
        art.setShown(w.id, u > 0);
        if (u > 0 && last.get(w.id) !== u) art.growWire(w, shown, 0, u, fromTo.get(w.id), world);
        last.set(w.id, u);
      });
      const camera: OrthographicCamera = cameraFor({ ...cam, direction: turnDirection(direction, swayAt(times[i], total, timing)) }, width / height, radius);
      art.draw(camera, width, height, ss);
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(art.renderer.domElement, 0, 0, width, height);
    };
    // A GIF's one palette from a few telling frames: the bare model, wires part way, all in.
    const at = (t: number) => Math.min(n - 1, Math.max(0, Math.round((t / total) * n)));
    const samples = [0, at(total * 0.35), at(total - timing.back - timing.hold / 2)];
    return await encodeFrames(out, times.map(() => step), draw, samples, { ...options, fps });
  } finally {
    art.dispose();
  }
}
