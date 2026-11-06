// The build steps as a movie (the Steps strip's "Save as movie"): what
// Play steps shows, drawn a frame at a time and saved as a video. Each step
// is shown with its parts drawn apart (earlier steps' parts ghosted, later
// ones not there yet), then its parts go together; the view glides from one
// step's framing to the next. An MP4 where the browser can encode one, else
// an animated GIF.

import { OrthographicCamera } from "three";
import { mp4Config } from "../mp4";
import { ANIMATION_BACKGROUND, ease, encodeFrames } from "./animation";
import type { SceneCamera, ScenePart, SceneStyle, Vec3 } from "./model";
import { cameraFor, frameAll, LineArt, type ModelStore } from "./render";

/** How long each piece of a step lasts, in seconds (as Play steps shows it). */
export interface StepsTiming {
  /** The view gliding from the last step's framing to this one's. */
  glide: number;
  /** This step's parts shown apart, before they move. */
  hold: number;
  /** Its parts going together. */
  move: number;
  /** Together, before the next step. */
  rest: number;
  /** The finished model, at the end. */
  end: number;
}
export const STEPS_TIMING: StepsTiming = { glide: 0.5, hold: 0.6, move: 0.9, rest: 0.4, end: 2 };

/** One frame of the movie: the step shown, how far apart its parts are (1 apart, 0 fitted), and the camera's way from the last step's (0) to this one's (1). */
export interface StepsFrame {
  step: number;
  explode: number;
  glide: number;
  /** Milliseconds. */
  delay: number;
}

/** The movie's frames at `fps` for `count` steps. A still stretch is one frame shown longer. */
export function stepsFrames(count: number, fps = 24, timing: StepsTiming = STEPS_TIMING): StepsFrame[] {
  const ms = 1000 / fps;
  const out: StepsFrame[] = [];
  const n = (s: number) => Math.max(1, Math.round(s * fps));
  for (let step = 0; step < count; step++) {
    // The first step starts framed; later ones glide over from the last.
    if (step) for (let i = 1, g = n(timing.glide); i <= g; i++) out.push({ step, explode: 1, glide: ease(i / g), delay: ms });
    out.push({ step, explode: 1, glide: 1, delay: Math.max(ms, timing.hold * 1000) });
    for (let i = 1, m = n(timing.move); i <= m; i++) out.push({ step, explode: 1 - ease(i / m), glide: 1, delay: ms });
    const last = step === count - 1;
    out.push({ step, explode: 0, glide: 1, delay: Math.max(ms, (last ? timing.end : timing.rest) * 1000) });
  }
  // The same picture once more: a video's last frame often shows only for an instant, and the finished model should stay up.
  if (out.length) out.push({ ...out[out.length - 1], delay: ms });
  return out;
}

/** A step as the movie draws it: every part, as shown in it (hidden, ghosted, highlighted), and the ids of the parts that go on in it. */
export interface MovieStep {
  parts: ScenePart[];
  moving: string[];
}

export interface StepsMovieOptions {
  /** "auto" (the default): an MP4 where the browser can encode one, else a GIF. */
  format?: "auto" | "mp4" | "gif";
  background?: string;
  progress?(done: number, total: number): void;
  cancelled?(): boolean;
}

export interface StepsMovie {
  blob: Blob;
  type: "video/mp4" | "image/gif";
  width: number;
  height: number;
  frames: number;
}

/** The MP4's size and speed; a GIF (far bigger for each pixel and frame) is smaller and slower. */
const MP4 = { width: 1280, height: 720, fps: 24 };
const GIF = { width: 960, height: 540, fps: 12 };

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function between(a: SceneCamera, b: SceneCamera, t: number): SceneCamera {
  return { direction: b.direction, target: [0, 1, 2].map(k => lerp(a.target[k], b.target[k], t)) as Vec3, size: lerp(a.size, b.size, t) };
}

/** Draws the steps, one after another, from `direction`, and encodes them as a movie. */
export async function renderStepsMovie(steps: MovieStep[], style: SceneStyle, direction: Vec3, store: ModelStore, options: StepsMovieOptions = {}): Promise<StepsMovie> {
  if (!steps.length) throw new Error("There are no steps to show.");
  const format = options.format ?? "auto";
  const config = format === "gif" ? null : await mp4Config(MP4.width, MP4.height, MP4.fps);
  if (format === "mp4" && !config) throw new Error("This browser can't make an MP4 video.");
  const { width, height, fps } = config ? MP4 : GIF;
  const aspect = width / height;
  const frames = stepsFrames(steps.length, fps);
  const bg = options.background || ANIMATION_BACKGROUND;

  // Each step framed round itself, apart and together (as its strip card and guide page are).
  const cameras: SceneCamera[] = [];
  const start: SceneCamera = { direction, target: [0, 0, 0], size: 50 };
  for (const s of steps) {
    const together = s.parts.map(p => (s.moving.includes(p.id) ? { ...p, explode: 0 } : p));
    const scene = (parts: ScenePart[]) => ({ version: 1 as const, parts, camera: start, style, explode: 0 });
    cameras.push(await frameAll(start, [scene(s.parts), scene(together)], store, aspect, 1.15));
  }

  // Every part's model, loaded once.
  const models = new Map<string, Awaited<ReturnType<ModelStore["get"]>>>();
  for (const p of steps[0].parts) {
    try {
      models.set(p.id, await store.get(p));
    } catch {
      // A part whose model can't be read is left out.
    }
  }

  const art = new LineArt();
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  try {
    art.arrows = true;
    const max = Math.min(art.renderer.capabilities.maxTextureSize || 4096, 8192);
    const ss = Math.max(1, Math.min(2, max / Math.max(width, height)));
    let shownStep = -1;
    let parts: ScenePart[] = [];
    const draw = (i: number): void => {
      const f = frames[i];
      if (f.step !== shownStep) {
        shownStep = f.step;
        parts = steps[f.step].parts.map(p => ({ ...p }));
        art.setParts(parts.flatMap(part => (models.has(part.id) ? [{ part, model: models.get(part.id)! }] : [])), style, 0);
      }
      const moving = new Set(steps[f.step].moving);
      for (const p of parts) if (moving.has(p.id)) p.explode = f.explode;
      art.move(parts, 0);
      const cam = f.step ? between(cameras[f.step - 1], cameras[f.step], f.glide) : cameras[0];
      const camera: OrthographicCamera = cameraFor(cam, aspect, cam.size * 4 + Math.hypot(...cam.target));
      art.draw(camera, width, height, ss);
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(art.renderer.domElement, 0, 0, width, height);
    };
    // The GIF's palette from each step apart and the model finished.
    const apart = frames.flatMap((f, i) => (f.explode === 1 && f.glide === 1 ? [i] : []));
    const samples = [...new Set([...Array.from({ length: Math.min(7, apart.length) }, (_, k) => apart[Math.floor((k * apart.length) / Math.min(7, apart.length))]), frames.length - 1])];
    // An MP4 at its size and speed where the browser can make one (checked above), else a GIF at its own.
    return await encodeFrames(out, frames.map(f => f.delay), draw, samples, { format: format === "mp4" ? "mp4" : config ? "auto" : "gif", fps, background: bg, progress: options.progress, cancelled: options.cancelled });
  } finally {
    art.dispose();
  }
}
