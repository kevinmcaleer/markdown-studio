// The animated model ("/Animated model" in the Markdown editor): the
// project's whole model, fully assembled, coming apart along its joints
// (each part the way its joint's "Comes off" sends it, tracks opening into
// chains), turning once round while apart, then going back together, on a
// loop. Drawn in the line-art style, a frame at a time, kept fitted to the
// picture as it comes apart, and saved as an animated GIF, which plays
// wherever a picture shows (the published page, a phone, a feed) with no
// 3D viewer to load.

import { Matrix4, OrthographicCamera, Vector3 } from "three";
import { GifWriter, indexFrame, paletteFor } from "../gif";
import { blankScene, type ProjectModel, type SceneCamera, type SceneStyle, type Vec3 } from "./model";
import { cameraFor, LineArt, type ModelStore } from "./render";
import { trackPieces } from "./trackSpec";

/** How long each part of the loop lasts, in seconds. */
export interface AnimationTiming {
  /** Shown fully assembled. */
  hold: number;
  /** Coming apart (and, at the end, going back together). */
  explode: number;
  /** Still, apart, before and after the turn. */
  pause: number;
  /** Turning once round, apart. */
  turn: number;
}
export const ANIMATION_TIMING: AnimationTiming = { hold: 1.2, explode: 1.6, pause: 0.4, turn: 5 };

export type AnimationPhase = "hold" | "explode" | "pause" | "turn" | "rest" | "together";

/** One frame of the loop: how far apart (0–1), how far round (0–1 of a turn), and how long it shows. */
export interface AnimationFrame {
  phase: AnimationPhase;
  explode: number;
  turn: number;
  /** Milliseconds. */
  delay: number;
}

/** Slow in, slow out. */
export const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * The loop's frames at `fps`: a still assembled frame (held), the explode,
 * a still pause, the turn, a pause, then back together. The last frame of
 * the turn stops short of a whole turn, so the loop doesn't show the same
 * picture twice.
 */
export function animationFrames(fps = 15, timing: AnimationTiming = ANIMATION_TIMING): AnimationFrame[] {
  const step = 1000 / fps;
  const out: AnimationFrame[] = [];
  const run = (phase: AnimationPhase, seconds: number, at: (t: number) => { explode: number; turn: number }) => {
    const n = Math.max(1, Math.round(seconds * fps));
    for (let i = 1; i <= n; i++) out.push({ phase, ...at(i / n), delay: step });
  };
  out.push({ phase: "hold", explode: 0, turn: 0, delay: Math.max(step, timing.hold * 1000) });
  run("explode", timing.explode, t => ({ explode: ease(t), turn: 0 }));
  out.push({ phase: "pause", explode: 1, turn: 0, delay: Math.max(step, timing.pause * 1000) });
  // A whole turn ends where it started: that frame is the pause after it.
  const n = Math.max(2, Math.round(timing.turn * fps));
  for (let i = 1; i < n; i++) out.push({ phase: "turn", explode: 1, turn: ease(i / n), delay: step });
  out.push({ phase: "rest", explode: 1, turn: 0, delay: Math.max(step, timing.pause * 1000) });
  // Back together: the explode backwards, ending just before assembled (the first frame is that).
  const m = Math.max(1, Math.round(timing.explode * fps));
  for (let i = m - 1; i >= 1; i--) out.push({ phase: "together", explode: ease(i / m), turn: 0, delay: step });
  return out;
}

/** The view direction turned `turn` of a whole turn about the up axis (Z). */
export function turnDirection(direction: Vec3, turn: number): Vec3 {
  const a = turn * Math.PI * 2;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const [x, y, z] = direction;
  return [x * c - y * s, x * s + y * c, z];
}

/**
 * The camera that holds these points (mm, in the world) from `direction`,
 * with `margin` round them: centred on them, or, given `target`, about
 * that point (so a turn about it never needs to move the camera).
 */
export function fitPoints(direction: Vec3, points: Float32Array, aspect: number, margin = 1.06, target?: Vec3): SceneCamera {
  const c = cameraFor({ direction, target: [0, 0, 0], size: 1 }, 1, 1);
  c.updateMatrixWorld();
  const e = c.matrixWorldInverse.elements;
  // Into the camera's view: x across, y up, z along the view.
  const view = (x: number, y: number, z: number): [number, number, number] => [e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]];
  if (target) {
    const [tx, ty] = view(...target);
    let half = 1;
    for (let i = 0; i < points.length; i += 3) {
      const [x, y] = view(points[i], points[i + 1], points[i + 2]);
      half = Math.max(half, Math.abs(y - ty), Math.abs(x - tx) / aspect);
    }
    return { direction: [...direction] as Vec3, target: [...target] as Vec3, size: half * margin };
  }
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < points.length; i += 3) {
    const p = view(points[i], points[i + 1], points[i + 2]);
    for (let k = 0; k < 3; k++) {
      if (p[k] < lo[k]) lo[k] = p[k];
      if (p[k] > hi[k]) hi[k] = p[k];
    }
  }
  if (!isFinite(lo[0])) return { direction: [...direction] as Vec3, target: [0, 0, 0], size: 50 };
  const mid = new Vector3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2).applyMatrix4(c.matrixWorld);
  const half = Math.max((hi[1] - lo[1]) / 2, (hi[0] - lo[0]) / 2 / aspect, 1);
  return { direction: [...direction] as Vec3, target: [mid.x, mid.y, mid.z], size: half * margin };
}

/** The middle of the box round these points. */
export function middleOf(points: Float32Array): Vec3 {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < points.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = points[i + k];
      if (v < lo[k]) lo[k] = v;
      if (v > hi[k]) hi[k] = v;
    }
  }
  return isFinite(lo[0]) ? [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2] : [0, 0, 0];
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Each frame's camera. While it comes apart it's kept fitted to the parts
 * (as the Explode slider keeps them), easing into the one camera that
 * holds the exploded model at every angle of the turn, about its middle,
 * so the turn neither zooms nor drifts.
 */
export function animationCameras(frames: AnimationFrame[], direction: Vec3, pointsAt: (explode: number) => Float32Array, aspect: number, margin = 1.06): SceneCamera[] {
  const apart = pointsAt(1);
  const middle = middleOf(apart);
  let size = 1;
  for (let i = 0; i < 48; i++) size = Math.max(size, fitPoints(turnDirection(direction, i / 48), apart, aspect, margin, middle).size);
  // Each frame of the turn too, for its exact angle.
  for (const f of frames) if (f.phase === "turn") size = Math.max(size, fitPoints(turnDirection(direction, f.turn), apart, aspect, margin, middle).size);
  const turning: SceneCamera = { direction, target: middle, size };
  const cache = new Map<number, SceneCamera>();
  return frames.map(f => {
    if (f.explode >= 1) return { ...turning, direction: turnDirection(direction, f.turn) };
    let cam = cache.get(f.explode);
    if (!cam) {
      const pts = pointsAt(f.explode);
      const tight = fitPoints(direction, pts, aspect, margin);
      const target: Vec3 = [0, 1, 2].map(k => lerp(tight.target[k], middle[k], f.explode)) as Vec3;
      // Whatever the blend, the parts stay in the picture.
      const needed = fitPoints(direction, pts, aspect, margin, target).size;
      cam = { direction, target, size: Math.max(needed, lerp(tight.size, size, f.explode)) };
      cache.set(f.explode, cam);
    }
    return cam;
  });
}

/** Bigger than this, the animation is drawn again smaller (picture uploads stop at 10 MB). */
export const MAX_GIF_BYTES = 8 * 1024 * 1024;

/** The Assembly step template's page grey, so the animation sits with the step pictures. */
export const ANIMATION_BACKGROUND = "#ececec";

export interface AnimationOptions {
  /** The picture's size, in pixels. */
  width?: number;
  height?: number;
  fps?: number;
  /** The background; the Assembly step template's grey by default. */
  background?: string;
  /** Says how far it has got. */
  progress?(done: number, total: number): void;
  /** True once the caller has gone (the editor closed): it stops. */
  cancelled?(): boolean;
}

export interface Animation {
  gif: Blob;
  width: number;
  height: number;
  frames: number;
}

/**
 * The parts as the animation shows them: every part the model shows, none
 * ghosted or picked out, all coming apart together. A track's piece (the
 * one Make track repeated) is left out: the track stands for it.
 */
export function animationParts(model: Pick<ProjectModel, "parts">) {
  const pieces = trackPieces(model.parts);
  return model.parts
    .filter(p => !p.hidden && !pieces.has(p.id))
    .map(p => {
      const out = structuredClone(p);
      delete out.hidden;
      delete out.ghost;
      delete out.highlight;
      delete out.explode;
      return out;
    });
}

/** The style the animation is drawn in: the scenes' line art, without draft lines (solid arrows show where each part goes). */
export function animationStyle(): SceneStyle {
  return { ...blankScene().style, draft: false };
}

/** Up to `max` of the meshes' points, where they're drawn now (an even spread, for framing). */
function samplePoints(art: LineArt, max = 40000): Float32Array {
  const { meshes, points } = art.placed();
  let total = 0;
  for (const m of meshes) total += m.geometry.getAttribute("position")?.count || 0;
  const stride = Math.max(1, Math.ceil(total / max));
  const out: number[] = [];
  const v = new Vector3();
  for (const { geometry, matrix } of meshes) {
    const pos = geometry.getAttribute("position");
    if (!pos) continue;
    for (let i = 0; i < pos.count; i += stride) {
      v.fromBufferAttribute(pos, i).applyMatrix4(matrix as Matrix4);
      out.push(v.x, v.y, v.z);
    }
  }
  // The arrows' ends too, so an arrow is never cut off at the edge.
  for (const p of points) out.push(p.x, p.y, p.z);
  return new Float32Array(out);
}

/**
 * Draws the project's model as the looping animation and encodes it as a
 * GIF. `direction` is the view it starts (and ends) from.
 */
export async function renderAnimation(model: Pick<ProjectModel, "parts">, store: ModelStore, direction: Vec3, options: AnimationOptions = {}): Promise<Animation> {
  const width = Math.round(options.width ?? 800);
  const height = Math.round(options.height ?? 600);
  const parts = animationParts(model);
  if (!parts.length) throw new Error("The project's model has no parts to show.");
  const settled = await Promise.allSettled(parts.map(async part => ({ part, model: await store.get(part) })));
  const list = settled.flatMap(r => (r.status === "fulfilled" ? [r.value] : []));
  if (!list.length) throw new Error("None of the model's parts could be loaded.");
  const style = animationStyle();
  const frames = animationFrames(options.fps ?? 15);
  const art = new LineArt();
  const bg = options.background || ANIMATION_BACKGROUND;
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  try {
    const shown = list.map(x => x.part);
    // Solid arrows along each gap, as on the assembly guide's steps.
    art.arrows = true;
    art.setParts(list, style, 0);
    const pointsAt = (e: number) => {
      art.move(shown, e);
      return samplePoints(art);
    };
    // A little room round the parts, for their outlines.
    const cameras = animationCameras(frames, direction, pointsAt, width / height, 1.1);
    const max = Math.min(art.renderer.capabilities.maxTextureSize || 4096, 8192);
    // Drawn twice the size and shrunk, so its lines are smooth.
    const ss = Math.max(1, Math.min(2, max / Math.max(width, height)));
    const radius = (cam: SceneCamera) => cam.size * 4 + Math.hypot(...cam.target);
    const draw = (i: number): Uint8ClampedArray => {
      const f = frames[i];
      art.move(shown, f.explode);
      const camera: OrthographicCamera = cameraFor(cameras[i], width / height, radius(cameras[i]));
      art.draw(camera, width, height, ss);
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(art.renderer.domElement, 0, 0, width, height);
      return ctx.getImageData(0, 0, width, height).data;
    };
    const rgb = hexRgb(bg);
    // One palette from a few telling frames: assembled, apart, part way round.
    const samples = [0, frames.findIndex(f => f.phase === "pause"), ...[0.25, 0.5, 0.75].map(t => frames.findIndex(f => f.phase === "turn" && f.turn >= t))].filter(i => i >= 0);
    const palette = paletteFor(samples.map(i => draw(i).slice()), rgb);
    const gif = new GifWriter(width, height, palette);
    for (let i = 0; i < frames.length; i++) {
      if (options.cancelled?.()) throw new Error("Stopped.");
      gif.add({ indices: indexFrame(draw(i), palette, rgb), delay: frames[i].delay });
      options.progress?.(i + 1, frames.length);
      // Let the page breathe between frames.
      if (i % 4 === 3) await new Promise(r => setTimeout(r, 0));
    }
    const bytes = gif.finish();
    return { gif: new Blob([bytes as BlobPart], { type: "image/gif" }), width, height, frames: frames.length };
  } finally {
    art.dispose();
  }
}

function hexRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [255, 255, 255];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
