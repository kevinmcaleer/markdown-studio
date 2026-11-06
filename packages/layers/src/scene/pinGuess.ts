// Finding a part's pins on its 3D model from its 2D pinout (no three.js here).
//
// A catalog part's 2D picture is its top view, and its model is drawn in the
// same frame (the Snakie library's: mm, Z up, the footprint centred on the
// origin, width along x, height along y, the top of the picture at +y). So a
// pin at (x, y) on the picture (fractions of its width and height) is above
// the model at ((x - 0.5) * width, (0.5 - y) * height): straight down from
// there, the first thing hit is the pin's top (a header pin's tip, a pad, a
// terminal). A pin off the model's top (a motor's tabs on its end) lands on
// the nearest corner of the model to that spot, facing out.
//
// Scenes move a model to the middle of its box, so the spot is taken off by
// the model's `centre` (where the box's middle was in the file).

import type { Vec3 } from "./model";
import { BARE_PIN, newSocketId, type PartSocket } from "./wireSpec";
import type { WiringPart } from "./wiring2d";

/** A pin found on the model, as a bare pin socket would have it. */
export interface PinGuess {
  port: string;
  pin: string;
  /** Where on the model (its centred frame). */
  point: Vec3;
  normal: Vec3;
  /** True: straight down from the pin, on the model's top; false: the nearest corner (check it). */
  onTop: boolean;
}

/**
 * Whether a model is drawn in its 2D picture's frame: its box as wide and as
 * tall as the part (within a quarter, or 3 mm). A file drawn another way
 * round (or another size) isn't, and its pins are placed by hand.
 */
export function fitsPicture(size: Vec3, part: Pick<WiringPart, "size">): boolean {
  if (!part.size) return false;
  const [w, h] = part.size;
  const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(3, 0.25 * b);
  return w > 0 && h > 0 && near(size[0], w) && near(size[1], h);
}

/** Where a pin at (x, y) on the picture is above the model, in its centred frame. */
export function pictureToModel(x: number, y: number, part: Pick<WiringPart, "size">, centre: Vec3): [number, number] {
  const [w, h] = part.size!;
  return [(x - 0.5) * w - centre[0], (0.5 - y) * h - centre[1]];
}

/**
 * Each of the part's pins with a place on its picture, found on the model
 * (`pos`: its triangles' corners, centred; `centre`, `size`: its box as
 * read). Null when the model isn't drawn in the picture's frame.
 * `skip`: pins already placed, by name.
 */
export function guessPins(part: WiringPart, pos: ArrayLike<number>, centre: Vec3, size: Vec3, skip: Set<string> = new Set()): PinGuess[] | null {
  if (!fitsPicture(size, part)) return null;
  const out: PinGuess[] = [];
  const seen = new Set<string>();
  for (const port of part.ports) {
    for (const q of port.pins) {
      if (q.x === undefined || q.y === undefined || skip.has(q.name) || seen.has(q.name)) continue;
      seen.add(q.name);
      const [x, y] = pictureToModel(q.x, q.y, part, centre);
      const top = dropOnto(pos, x, y);
      if (top) out.push({ port: port.id, pin: q.name, point: top.point, normal: top.normal, onTop: true });
      else out.push({ port: port.id, pin: q.name, ...nearestOut(pos, x, y, size), onTop: false });
    }
  }
  return out;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** The highest point of the model straight down at (x, y), and its face's normal (pointing up); null off the model. */
export function dropOnto(pos: ArrayLike<number>, x: number, y: number): { point: Vec3; normal: Vec3 } | null {
  let best = -Infinity;
  let normal: Vec3 = [0, 0, 1];
  for (let i = 0; i + 8 < pos.length; i += 9) {
    const ax = pos[i], ay = pos[i + 1], bx = pos[i + 3], by = pos[i + 4], cx = pos[i + 6], cy = pos[i + 7];
    // Quick reject on the triangle's box.
    if (x < Math.min(ax, bx, cx) || x > Math.max(ax, bx, cx) || y < Math.min(ay, by, cy) || y > Math.max(ay, by, cy)) continue;
    const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(d) < 1e-12) continue;
    const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
    const v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
    const w = 1 - u - v;
    if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue;
    const z = u * pos[i + 2] + v * pos[i + 5] + w * pos[i + 8];
    if (z <= best) continue;
    best = z;
    // The face's normal, turned up (seen from above).
    const e1 = [bx - ax, by - ay, pos[i + 5] - pos[i + 2]];
    const e2 = [cx - ax, cy - ay, pos[i + 8] - pos[i + 2]];
    let n: Vec3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const l = Math.hypot(...n) || 1;
    n = n.map(c => c / l) as Vec3;
    if (n[2] < 0) n = n.map(c => -c) as Vec3;
    // A wall seen edge-on: say up.
    normal = n[2] < 0.2 ? [0, 0, 1] : (n.map(r3) as Vec3);
  }
  return best > -Infinity ? { point: [r3(x), r3(y), r3(best)], normal } : null;
}

/**
 * Off the model's top: the side the spot is towards (its biggest share of the
 * model's half-size) faces out, and of the model's corners near the spot
 * (within 2 mm of the nearest, seen from above), the ones furthest out that
 * way are the pin's end (a tab's tip): their middle.
 */
function nearestOut(pos: ArrayLike<number>, x: number, y: number, size: Vec3): { point: Vec3; normal: Vec3 } {
  const sx = x / Math.max(1e-6, size[0] / 2), sy = y / Math.max(1e-6, size[1] / 2);
  const normal: Vec3 = Math.abs(sx) >= Math.abs(sy) ? [Math.sign(sx) || 1, 0, 0] : [0, Math.sign(sy) || 1, 0];
  let nearest = Infinity;
  for (let i = 0; i + 2 < pos.length; i += 3) nearest = Math.min(nearest, Math.hypot(pos[i] - x, pos[i + 1] - y));
  const near: number[] = [];
  let out = -Infinity;
  for (let i = 0; i + 2 < pos.length; i += 3) {
    if (Math.hypot(pos[i] - x, pos[i + 1] - y) > nearest + 2) continue;
    near.push(i);
    out = Math.max(out, pos[i] * normal[0] + pos[i + 1] * normal[1]);
  }
  // Each corner once (a corner is in several triangles).
  const keys = new Set<string>();
  const tip = near.filter(i => {
    if (pos[i] * normal[0] + pos[i + 1] * normal[1] < out - 0.05) return false;
    const k = `${r3(pos[i])},${r3(pos[i + 1])},${r3(pos[i + 2])}`;
    if (keys.has(k)) return false;
    keys.add(k);
    return true;
  });
  const mid = [0, 1, 2].map(k => tip.reduce((a, i) => a + pos[i + k], 0) / (tip.length || 1));
  return { point: mid.map(r3) as Vec3, normal };
}

/** Found pins as bare pin sockets, added to `sockets` (each with a new id). */
export function guessedSockets(guesses: PinGuess[], sockets: PartSocket[] | undefined, label: (pin: string) => string = p => p): PartSocket[] {
  const out = [...(sockets || [])];
  for (const g of guesses) {
    const s: PartSocket = { id: newSocketId(out), point: g.point, normal: g.normal, connector: BARE_PIN, pin: g.pin, name: label(g.pin) };
    if (!g.port.startsWith("pin:")) s.port = g.port;
    out.push(s);
  }
  return out;
}
