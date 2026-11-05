// The browser half of the picture eval (run by evals/pictures.mjs): draws a
// case's scene with the real renderer, and compares two pictures.

import type { BufferGeometry } from "three";
import { applyPreset, blankScene, type SceneData, type ScenePart, type Vec3 } from "../../src/scene/model";
import { frameTight, ModelStore, modelFromPositions, renderPicture, worldMatrices, type Placed } from "../../src/scene/render";
import { shapeTriangles, type ShapeSpec } from "../lib/shapes";

interface PictureCase {
  scene: {
    parts: (Omit<Partial<ScenePart>, "id"> & { id: string; shape: ShapeSpec })[];
    /** Where the camera looks from; `fit` frames the parts as the Fit button does. */
    camera: { direction: Vec3; target?: Vec3; size?: number; fit?: boolean };
    style?: string;
    explode?: number;
    arrows?: boolean;
  };
  size?: [number, number];
}

async function render(c: PictureCase): Promise<string> {
  const files = new Map<string, ArrayBuffer>();
  for (const p of c.scene.parts) if ("stl" in p.shape && !files.has(p.shape.stl)) files.set(p.shape.stl, await (await fetch(`../${p.shape.stl}`)).arrayBuffer());
  const store = new ModelStore(async () => new ArrayBuffer(0));
  const [w, h] = c.size || [640, 480];
  const scene: SceneData = { ...blankScene(), explode: c.scene.explode || 0, arrows: !!c.scene.arrows };
  if (c.scene.style) scene.style = applyPreset(scene.style, c.scene.style);
  const meshes: { part: ScenePart; geometry: BufferGeometry }[] = [];
  scene.parts = c.scene.parts.map(({ shape, ...rest }) => {
    const part: ScenePart = { name: rest.id, position: [0, 0, 0], rotation: [0, 0, 0], ...rest };
    const model = modelFromPositions(shapeTriangles(shape, path => files.get(path)!));
    store.put(part, model);
    meshes.push({ part, geometry: model.geometry });
    return part;
  });
  const cam = { direction: c.scene.camera.direction, target: c.scene.camera.target || [0, 0, 0], size: c.scene.camera.size || 60 } as SceneData["camera"];
  if (c.scene.camera.fit) {
    const m = worldMatrices(scene.parts, scene.explode);
    const placed: Placed[] = meshes.filter(x => !x.part.hidden).map(x => ({ geometry: x.geometry, matrix: m.get(x.part.id)! }));
    scene.camera = frameTight(cam, placed, w / h);
  } else scene.camera = cam;
  const canvas = await renderPicture(scene, store, w, h, 1);
  return canvas.toDataURL("image/png");
}

const pixels = async (url: string) => {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  return { w: img.width, h: img.height, data: ctx.getImageData(0, 0, img.width, img.height).data };
};

/**
 * How alike two pictures are: of the pixels with a line or a tint in either
 * picture, the share that match (each colour within `tolerance` of 255). Also a
 * picture of the differences: red where they differ, the approved picture
 * faint behind.
 */
async function compare(got: string, approved: string, tolerance = 48): Promise<{ score: number; differ: number; ink: number; diff: string }> {
  const a = await pixels(got), b = await pixels(approved);
  if (a.w !== b.w || a.h !== b.h) return { score: 0, differ: -1, ink: -1, diff: got };
  const out = document.createElement("canvas");
  out.width = a.w;
  out.height = a.h;
  const ctx = out.getContext("2d")!;
  const img = ctx.createImageData(a.w, a.h);
  let ink = 0, differ = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    // Lines and tints count; the plain white fill and the see-through background don't
    // (else a big white part would hide a change to its lines).
    const inked = (d: Uint8ClampedArray) => d[i + 3] > 8 && Math.min(d[i], d[i + 1], d[i + 2]) < 230;
    const drawn = inked(a.data) || inked(b.data);
    let off = 0;
    for (let k = 0; k < 4; k++) off = Math.max(off, Math.abs(a.data[i + k] - b.data[i + k]));
    const bad = drawn && off > tolerance;
    if (drawn) ink++;
    if (bad) differ++;
    const grey = 255 - (b.data[i + 3] / 255) * (255 - (b.data[i] + b.data[i + 1] + b.data[i + 2]) / 3) * 0.3;
    img.data.set(bad ? [230, 30, 30, 255] : [grey, grey, grey, 255], i);
  }
  ctx.putImageData(img, 0, 0);
  return { score: ink ? 1 - differ / ink : 1, differ, ink, diff: out.toDataURL("image/png") };
}

Object.assign(window, { evalRender: render, evalCompare: compare, evalReady: true });
document.getElementById("status")!.textContent = "ready";
