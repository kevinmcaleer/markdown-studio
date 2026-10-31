// The layer document: what a graphic is made of. `objects` are Fabric.js
// object records (with each layer's `name`, `locked` and `hidden`), so the
// editor can load them straight back. Pictures are carried inside as data
// URLs, so a graphic never depends on another file.

import { readText, writeText } from "./png";

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
    objects: v.objects.filter((o): o is Record<string, unknown> => !!o && typeof o === "object"),
  };
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
  return writeText(png, JSON.stringify(doc));
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
