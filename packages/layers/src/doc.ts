// The layer document: what a graphic is made of. `objects` are Fabric.js
// object records (with each layer's `name`, `locked` and `hidden`), so the
// editor can load them straight back. Pictures are carried inside as data
// URLs, so a graphic never depends on another file.

import { readText, writeText } from "./png";
import { meshTable, restoreParts, type Meshes } from "./scene/meshTable";
import { showsTrackPiece } from "./scene/trackSpec";

export const DOC_APP = "layers";
export const DOC_VERSION = 1;

export interface LayersDoc {
  app: typeof DOC_APP;
  version: number;
  width: number;
  height: number;
  /** A CSS colour, or "" for a see-through background. */
  background: string;
  title?: string;
  objects: Record<string, unknown>[];
}

export interface SizePreset {
  id: string;
  label: string;
  width: number;
  height: number;
}

export const SIZES: SizePreset[] = [
  { id: "wide", label: "Wide 16:9", width: 1600, height: 900 },
  { id: "photo", label: "Photo 4:3", width: 1600, height: 1200 },
  { id: "square", label: "Square", width: 1200, height: 1200 },
  { id: "banner", label: "Banner 3:1", width: 1800, height: 600 },
  { id: "tall", label: "Portrait 3:4", width: 1200, height: 1600 },
];

export const MIN_SIDE = 100;
export const MAX_SIDE = 4000;

export function clampSide(n: number): number {
  if (!Number.isFinite(n)) return SIZES[0].width;
  return Math.max(MIN_SIDE, Math.min(MAX_SIDE, Math.round(n)));
}

export function blankDoc(size: Pick<SizePreset, "width" | "height"> = SIZES[0], background = "#ffffff"): LayersDoc {
  return { app: DOC_APP, version: DOC_VERSION, width: size.width, height: size.height, background, objects: [] };
}

/** `value` as a document, or null when it isn't one. */
export function normalizeDoc(value: unknown): LayersDoc | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<LayersDoc>;
  if (v.app !== DOC_APP || !Array.isArray(v.objects)) return null;
  return {
    app: DOC_APP,
    version: typeof v.version === "number" ? v.version : DOC_VERSION,
    width: clampSide(Number(v.width)),
    height: clampSide(Number(v.height)),
    background: typeof v.background === "string" ? v.background : "#ffffff",
    ...(typeof v.title === "string" && v.title ? { title: v.title } : {}),
    objects: unpackObjects(v.objects.filter((o): o is Record<string, unknown> => !!o && typeof o === "object"), (v as { meshes?: unknown }).meshes),
  };
}

/** The 3D scenes' parts in `objects` with their model data back from a saved `meshes` table (see packDoc). */
function unpackObjects(objects: Record<string, unknown>[], meshes: unknown): Record<string, unknown>[] {
  if (!meshes || typeof meshes !== "object") return objects;
  return objects.map(o => {
    if (!o || typeof o !== "object") return o;
    let out = o;
    if (String(o.type).toLowerCase() === "scenelayer" && o.scene && typeof o.scene === "object") {
      const scene = o.scene as { parts?: unknown };
      if (Array.isArray(scene.parts)) out = { ...out, scene: { ...scene, parts: restoreParts(scene.parts as Record<string, unknown>[], meshes) } };
    }
    if (Array.isArray(o.objects)) out = { ...out, objects: unpackObjects(o.objects as Record<string, unknown>[], meshes) };
    return out;
  });
}

/**
 * `doc` as it is saved: each model its 3D scenes carry kept once, in a
 * `meshes` table the parts point at, however many copies of a part or
 * scenes showing it there are. normalizeDoc puts them back.
 */
export function packDoc(doc: LayersDoc): LayersDoc & { meshes?: Meshes } {
  const table = meshTable();
  const walk = (objects: Record<string, unknown>[]): Record<string, unknown>[] =>
    objects.map(o => {
      let out = o;
      if (String(o.type).toLowerCase() === "scenelayer" && o.scene && typeof o.scene === "object") {
        const scene = o.scene as { parts?: unknown };
        if (Array.isArray(scene.parts)) out = { ...out, scene: { ...scene, parts: table.parts(scene.parts as Record<string, unknown>[]) } };
      }
      if (Array.isArray(o.objects)) out = { ...out, objects: walk(o.objects as Record<string, unknown>[]) };
      return out;
    });
  const objects = walk(doc.objects);
  return table.size() ? { ...doc, objects, meshes: table.meshes } : doc;
}

export function parseDoc(text: string | null): LayersDoc | null {
  if (!text) return null;
  try {
    return normalizeDoc(JSON.parse(text));
  } catch {
    return null;
  }
}

/** The PNG `png` with `doc` stored inside it. */
export async function embedDoc(png: Uint8Array, doc: LayersDoc): Promise<Uint8Array> {
  return writeText(png, JSON.stringify(packDoc(doc)));
}

/** The document stored in a PNG's bytes, or null for an ordinary picture. */
export async function extractDoc(bytes: Uint8Array): Promise<LayersDoc | null> {
  return parseDoc(await readText(bytes));
}

/** The document in the picture at `url`, or null (not a Layers PNG, or it couldn't be fetched). */
export async function readDoc(url: string, fetchImage: (url: string) => Promise<Blob> = defaultFetch): Promise<LayersDoc | null> {
  try {
    const blob = await fetchImage(url);
    return extractDoc(new Uint8Array(await blob.arrayBuffer()));
  } catch {
    return null;
  }
}

export async function defaultFetch(url: string): Promise<Blob> {
  const resp = await fetch(url, { credentials: "include" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.blob();
}

/** A short file name for a graphic titled `title`. */
export function fileName(title: string | undefined): string {
  const slug = (title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${slug || "graphic"}.layers.png`;
}

/** Saved PNGs stay under this, below the 10 MB image upload limit. */
export const MAX_EXPORT_BYTES = 9_000_000;

/**
 * The scales to try when saving a W×H page, best first: 2× (a long side of
 * at most 4096 px, which every browser's canvas can hold), then 1.5× and 1×.
 */
export function exportScales(w: number, h: number): number[] {
  const best = Math.max(1, Math.min(2, 4096 / Math.max(w, h, 1)));
  return [...new Set([best, Math.min(best, 1.5), 1])];
}

// ------------------------------------------------------------ 3D scenes in a document

type SceneRecord = Record<string, unknown> & { scene?: { model?: { stamp?: number }; parts?: Record<string, unknown>[]; wireStep?: string } };
function* sceneRecords(objects: Record<string, unknown>[]): Generator<SceneRecord> {
  for (const o of objects) {
    if (String(o.type).toLowerCase() === "scenelayer" && o.scene && typeof o.scene === "object") yield o as SceneRecord;
    if (Array.isArray(o.objects)) yield* sceneRecords(o.objects as Record<string, unknown>[]);
  }
}

/** How many of the graphic's 3D scenes were drawn from a version of the project's model older than `stamp`. */
export function staleScenes(doc: LayersDoc | null, stamp: number): number {
  if (!doc) return 0;
  let n = 0;
  for (const o of sceneRecords(doc.objects)) {
    const at = o.scene?.model?.stamp;
    // A picture showing a track's piece beside its track is out of date too: pieces are kept out now.
    if (typeof at === "number" && (at < stamp || showsTrackPiece(o.scene?.parts))) n++;
  }
  // The screw inventory counts once, however many layers it has.
  const inv = inventoryStamp(doc);
  if (typeof inv === "number" && inv < stamp) n++;
  return n;
}

/** The model's stamp the graphic's screw inventory was drawn from (undefined: none, or not from a model). */
function inventoryStamp(doc: LayersDoc): number | undefined {
  for (const o of doc.objects) {
    const inv = o.inventory as { kind?: string; stamp?: unknown } | undefined;
    if (inv && inv.kind === "screws" && typeof inv.stamp === "number") return inv.stamp;
  }
  return undefined;
}

/** Whether the graphic has a screw inventory (it follows the project's model, as 3D scenes do). */
export function hasInventory(doc: LayersDoc | null): boolean {
  return !!doc && doc.objects.some(o => (o.inventory as { kind?: string } | undefined)?.kind === "screws");
}

/** Whether the graphic has a 3D scene. */
export function hasScene(doc: LayersDoc | null): boolean {
  return !!doc && !sceneRecords(doc.objects).next().done;
}

/**
 * The next assembly step after `doc`: its 3D scenes' shown parts become
 * ghosts (fitted already) with nothing highlighted, drawn fitted (a screw
 * drawn out of its hole in this step is in it in the next), and its step
 * numbers go up by one. A wiring step (scene.wireStep) moves on to the
 * next wire instead. Its pictures need drawing again (mount with
 * updateScenes).
 */
export function nextStepDoc(doc: LayersDoc): LayersDoc {
  const out = structuredClone(doc);
  for (const o of sceneRecords(out.objects)) {
    const scene = o.scene;
    // A wiring step goes on to the next wire; after the last, a plain step.
    if (scene?.wireStep) {
      const wires = (scene.parts || []).filter(p => p.wire);
      const next = wires[wires.findIndex(w => w.id === scene.wireStep) + 1];
      if (next) {
        scene.wireStep = String(next.id);
        continue;
      }
      delete scene.wireStep;
    }
    for (const p of scene?.parts || []) {
      delete p.highlight;
      if (!p.hidden) {
        p.ghost = true;
        p.explode = 0;
      }
    }
  }
  return bumpStep(out);
}

/**
 * A copy of the step `doc` to go straight after it: the same 3D scenes and
 * drawing, untouched (its own copy, so changing it changes nothing else),
 * with its step numbers one on.
 */
export function duplicateStepDoc(doc: LayersDoc): LayersDoc {
  return bumpStep(structuredClone(doc));
}

/** Puts `out`'s step numbers (badges, and a title that ends in a number) up by one, in place. */
function bumpStep(out: LayersDoc): LayersDoc {
  const bump = (objects: Record<string, unknown>[]) => {
    for (const o of objects) {
      if (typeof o.badge === "number" && o.badge > 0 && Array.isArray(o.objects)) {
        const n = Math.min(999, o.badge + 1);
        o.badge = n;
        if (typeof o.name === "string" && /^Step \d+$/.test(o.name)) o.name = `Step ${n}`;
        for (const c of o.objects as Record<string, unknown>[]) {
          if (typeof c.text === "string" && /^\d+$/.test(c.text)) {
            c.text = String(n);
            c.fontSize = n > 99 ? 30 : n > 9 ? 36 : 44;
          }
        }
      } else if (Array.isArray(o.objects)) bump(o.objects as Record<string, unknown>[]);
    }
  };
  bump(out.objects);
  // A title that ends in a number counts on too: "Step 3" → "Step 4".
  if (out.title) out.title = out.title.replace(/(\d+)(\D*)$/, (_, d: string, rest: string) => `${Number(d) + 1}${rest}`);
  return out;
}

/**
 * The graphic's step badges: the highest number (where the next step counts
 * on from), and the one badge's number when it follows its place in the
 * write-up (one badge, not pinned by hand). Null when it has no badge.
 */
export function stepBadge(doc: LayersDoc | null): { last: number; auto: number | null } | null {
  if (!doc) return null;
  const list = doc.objects.filter(o => typeof o.badge === "number" && o.badge > 0);
  if (!list.length) return null;
  const last = Math.max(...list.map(o => o.badge as number));
  return { last, auto: list.length === 1 && !list[0].badgePinned ? (list[0].badge as number) : null };
}
