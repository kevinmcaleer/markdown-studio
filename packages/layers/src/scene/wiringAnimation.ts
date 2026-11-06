// The wiring showcase ("/Wiring showcase" in the Markdown editor), as
// tnkr.ai shows a robot's wiring: the model in the see-through view (the
// printed parts as glass, the electronics solid), turning gently to and
// fro, while each wire grows out of its component along its route to
// where it ends, one setting off after another, the camera easing in to
// follow the growing wires' tips. Held finished (the camera pulled back
// to the whole model), then the wires draw back in and the loop starts
// again. Encoded like the other
// animations (animation.ts): an MP4, or a GIF where the browser can't.

import type { Matrix4, OrthographicCamera } from "three";
import { ANIMATION_BACKGROUND, animationParts, animationStyle, ease, encodeFrames, fitPoints, middleOf, samplePoints, turnDirection, type Animation, type AnimationOptions } from "./animation";
import { wiresInOrder, type ProjectModel, type SceneCamera, type ScenePart, type Vec3 } from "./model";
import { cameraFor, LineArt, worldMatrices, type ModelStore } from "./render";
import { growsFromTo } from "./seeThrough";
import { wireLength, wireRoute } from "./wire";
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
export const WIRING_TIMING: WiringTiming = { lead: 1, gap: 0.35, maxGaps: 6, speed: 90, minGrow: 0.9, maxGrow: 2.4, hold: 2, back: 0.7, sway: 20 };

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

/** How the camera follows the growing wires. */
export interface WiringFollow {
  /** How much of a wire (shares of its length) behind its tip and ahead of it the camera holds. */
  behind: number;
  ahead: number;
  /** How far the camera's middle leans from that stretch's middle to the tip (0 to 1). */
  pull: number;
  /** The closest it comes in: a share of the whole model's view. */
  closest: number;
  /** Room round what it holds. */
  margin: number;
  /** How smoothly it moves: the spread of its easing, in seconds. */
  smooth: number;
}
export const WIRING_FOLLOW: WiringFollow = { behind: 0.5, ahead: 0.3, pull: 0.35, closest: 0.38, margin: 1.35, smooth: 0.5 };

/** The point `u` (0 to 1) of the way along a line sampled evenly along its length. */
export function pointAlong(line: Vec3[], u: number): Vec3 {
  if (line.length === 1) return line[0];
  const x = Math.max(0, Math.min(1, u)) * (line.length - 1);
  const i = Math.min(line.length - 2, Math.floor(x));
  const f = x - i;
  const a = line[i];
  const b = line[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** A loop's values eased by a bell curve `sigma` frames wide, wrapping round (the loop's end runs into its start). */
function smoothLoop(values: number[], sigma: number): number[] {
  const n = values.length;
  if (sigma < 0.5 || n < 3) return values.slice();
  const r = Math.min(Math.floor(n / 2), Math.ceil(sigma * 3));
  const w = Array.from({ length: 2 * r + 1 }, (_, k) => Math.exp(-((k - r) ** 2) / (2 * sigma * sigma)));
  const sum = w.reduce((a, b) => a + b, 0);
  return values.map((_, i) => {
    let v = 0;
    for (let k = -r; k <= r; k++) v += w[k + r] * values[(((i + k) % n) + n) % n];
    return v / sum;
  });
}

/** The highest value within `r` frames either side, wrapping round. */
function widenLoop(values: number[], r: number): number[] {
  const n = values.length;
  return values.map((_, i) => {
    let v = -Infinity;
    for (let k = -r; k <= r; k++) v = Math.max(v, values[(((i + k) % n) + n) % n]);
    return v;
  });
}

/**
 * Each frame's camera middle and size as it follows the wires: on the
 * whole model (`home`) before the first wire sets off and once they're
 * all in, and in between leaning in on the stretch of each growing wire
 * round its tip (`lines` run from where each wire grows from, evenly
 * sampled, in the world). Eased so it glides from wire to wire and arrives
 * a little before each sets off, and never loses a growing tip off the
 * edge.
 */
export function followCameras(lines: (Vec3[] | null)[], turns: WireTurn[], total: number, times: number[], direction: Vec3, aspect: number, home: { target: Vec3; size: number }, timing: WiringTiming = WIRING_TIMING, follow: WiringFollow = WIRING_FOLLOW): { target: Vec3; size: number }[] {
  const n = times.length;
  const fps = n / total;
  const backFrom = total - timing.back;
  const dirs = times.map(t => turnDirection(direction, swayAt(t, total, timing)));
  const tips: Vec3[][] = [];
  const want = times.map((t, i) => {
    const grown = grownAt(turns, total, t, timing);
    const pts: number[] = [];
    const here: Vec3[] = [];
    turns.forEach((w, k) => {
      const line = lines[k];
      if (!line?.length || t <= w.start || t >= w.start + w.grow || t >= backFrom) return;
      const u = grown[k];
      const steps = 12;
      const a = Math.max(0, u - follow.behind);
      const b = Math.min(1, u + follow.ahead);
      for (let j = 0; j <= steps; j++) pts.push(...pointAlong(line, a + ((b - a) * j) / steps));
      here.push(pointAlong(line, u));
    });
    tips.push(here);
    if (!here.length) return { target: home.target, size: home.size };
    const p = new Float32Array(pts);
    const mid = middleOf(p);
    const tip = here.reduce<Vec3>((s, q) => [s[0] + q[0] / here.length, s[1] + q[1] / here.length, s[2] + q[2] / here.length], [0, 0, 0]);
    const target: Vec3 = [0, 1, 2].map(c => mid[c] + (tip[c] - mid[c]) * follow.pull) as Vec3;
    const size = fitPoints(dirs[i], p, aspect, follow.margin, target).size;
    return { target, size: Math.max(home.size * follow.closest, Math.min(home.size, size)) };
  });
  const sigma = follow.smooth * fps;
  const xs = [0, 1, 2].map(c => smoothLoop(want.map(w => w.target[c]), sigma));
  let sizes = smoothLoop(want.map(w => Math.log(w.size)), sigma).map(Math.exp);
  // Never a growing tip off the edge: widened where one would be, then eased again.
  const need = sizes.map((s, i) => (tips[i].length ? Math.max(s, fitPoints(dirs[i], new Float32Array(tips[i].flat()), aspect, 1.12, [xs[0][i], xs[1][i], xs[2][i]]).size) : s));
  if (need.some((s, i) => s > sizes[i] * 1.001)) {
    const eased = smoothLoop(widenLoop(need.map(Math.log), Math.ceil(sigma * 1.5)), sigma / 2).map(Math.exp);
    sizes = eased.map((s, i) => Math.max(s, need[i]));
  }
  return times.map((_, i) => ({ target: [xs[0][i], xs[1][i], xs[2][i]] as Vec3, size: sizes[i] }));
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
  // Each wire's middle line from the end it grows from, for the camera to follow.
  const lines = turns.map((_, k) => {
    const w = wires[k];
    const centre = wireRoute(w.wire!, world, looms)?.centre;
    if (!centre?.length) return null;
    const line = centre.map(v => [v.x, v.y, v.z] as Vec3);
    return fromTo.get(w.id) ? line.reverse() : line;
  });
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
    // The whole-model camera: about the model's middle, holding it (wires and all) at every angle of the sway.
    const pts = samplePoints(art);
    const middle = middleOf(pts);
    let size = 1;
    for (let i = 0; i <= 16; i++) size = Math.max(size, fitPoints(turnDirection(direction, ((i / 8 - 1) * timing.sway) / 360), pts, width / height, 1.1, middle).size);
    const cam: SceneCamera = { direction, target: middle, size };
    const radius = cam.size * 4 + Math.hypot(...cam.target);
    // Leaning in on each wire as it grows, back out to that between.
    const follows = followCameras(lines, turns, total, times, direction, width / height, cam, timing);
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
      const camera: OrthographicCamera = cameraFor({ ...follows[i], direction: turnDirection(direction, swayAt(times[i], total, timing)) }, width / height, radius);
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
