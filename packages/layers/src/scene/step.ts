// STEP files (.step, .stp) to parts. OpenCascade, compiled to WebAssembly
// (occt-import-js), reads the file in a worker so the page doesn't freeze,
// and turns each solid into triangles. Each solid comes in as its own part,
// named from the CAD assembly, where the CAD put it, and with the CAD's
// faces, so a joint catches on a real face rather than one guessed from
// the triangles.
//
// occt-import-js is LGPL: it is shipped as its own unchanged files beside
// the Layers modules (occt/), loaded only when a STEP file is opened.

/** One solid from a STEP file: world positions in mm, three corners a triangle. */
export interface StepBody {
  name: string;
  positions: Float32Array;
  /** The CAD face each triangle belongs to, or null when there are too many to number. */
  faces: Uint16Array | null;
}

export const isStepFile = (name: string) => /\.(step|stp)(\?|#|$)/i.test(name);

/** The parts of occt-import-js's result read here. */
interface OcctNode { name?: string; meshes?: number[]; children?: OcctNode[] }
interface OcctMesh {
  name?: string;
  attributes: { position: { array: ArrayLike<number> } };
  index?: { array: ArrayLike<number> };
  brep_faces?: { first: number; last: number }[];
}
interface OcctResult { success: boolean; root?: OcctNode; meshes?: OcctMesh[] }

/**
 * occt-import-js's result as bodies. It runs inside the worker too (from
 * its source text), so it uses nothing from outside itself.
 */
export function bodiesFromOcct(result: OcctResult): StepBody[] {
  const meshes = result.meshes || [];
  // Each mesh's name: the assembly node it hangs from, as CAD shows it in
  // its tree, since the solids themselves are mostly just "SOLID".
  const generic = /^(solid|body|shape|mesh|part|open cascade step translator.*|)$/i;
  const nameOf: string[] = [];
  const walk = (node: OcctNode, parent: string) => {
    const own = (node.name || "").trim();
    const label = own && !generic.test(own) ? own : parent;
    const list = node.meshes || [];
    for (const m of list) {
      const meshName = (meshes[m]?.name || "").trim();
      nameOf[m] = (meshName && !generic.test(meshName) ? meshName : label || "Part").replace(/_+/g, " ").replace(/\s+/g, " ").trim().slice(0, 110) || "Part";
    }
    for (const c of node.children || []) walk(c, label);
  };
  if (result.root) walk(result.root, "");
  const out: StepBody[] = [];
  // Names shared by several solids are numbered 1, 2, 3…
  const total = new Map<string, number>();
  meshes.forEach((_, m) => total.set(nameOf[m] || "Part", (total.get(nameOf[m] || "Part") || 0) + 1));
  const used = new Map<string, number>();
  meshes.forEach((mesh, m) => {
    const p = mesh.attributes.position.array;
    const idx = mesh.index ? mesh.index.array : null;
    const n = idx ? Math.floor(idx.length / 3) : Math.floor(p.length / 9);
    if (!n) return;
    const positions = new Float32Array(n * 9);
    for (let t = 0; t < n * 3; t++) {
      const v = idx ? idx[t] : t;
      positions[t * 3] = p[v * 3];
      positions[t * 3 + 1] = p[v * 3 + 1];
      positions[t * 3 + 2] = p[v * 3 + 2];
    }
    const brep = mesh.brep_faces || [];
    let faces: Uint16Array | null = null;
    if (brep.length && brep.length < 65535) {
      // 0xffff is "no face known".
      faces = new Uint16Array(n).fill(0xffff);
      brep.forEach((f, i) => {
        for (let t = Math.max(0, f.first); t <= f.last && t < n; t++) faces![t] = i;
      });
    }
    const base = nameOf[m] || "Part";
    const seen = (used.get(base) || 0) + 1;
    used.set(base, seen);
    const name = (total.get(base) || 0) > 1 ? `${base} ${seen}` : base;
    out.push({ name, positions, faces });
  });
  return out;
}

/**
 * A STEP file's solids as one model: a file is one part in a scene, as an
 * STL is. Each solid's CAD faces keep their own numbers, so joints still
 * catch on exact faces (unless the file has more faces than can be numbered).
 */
export function mergeBodies(bodies: StepBody[], name = "Part"): StepBody {
  if (bodies.length === 1) return bodies[0];
  let n = 0, faceCount = 0, faced = true;
  for (const b of bodies) {
    n += b.positions.length;
    if (!b.faces) faced = false;
    else faceCount += b.faces.reduce((m, f) => (f !== 0xffff && f + 1 > m ? f + 1 : m), 0);
  }
  if (faceCount >= 0xffff) faced = false;
  const positions = new Float32Array(n);
  const faces = faced ? new Uint16Array(n / 9) : null;
  let at = 0, base = 0;
  for (const b of bodies) {
    positions.set(b.positions, at);
    if (faces) {
      let most = 0;
      b.faces!.forEach((f, i) => {
        faces[at / 9 + i] = f === 0xffff ? 0xffff : base + f;
        if (f !== 0xffff && f + 1 > most) most = f + 1;
      });
      base += most;
    }
    at += b.positions.length;
  }
  return { name, positions, faces };
}

/** The worker's whole source: it loads OpenCascade from `base` and answers each file it is sent. */
function workerSource(): string {
  return `
const bodiesFromOcct = (${bodiesFromOcct.toString()});
let ready = null;
onmessage = async ev => {
  const { id, base, wasm, buffer } = ev.data;
  try {
    if (!ready) {
      importScripts(base + "occt-import-js.js" + wasm.slice(wasm.indexOf("?")));
      ready = occtimportjs({ locateFile: () => wasm });
    }
    const occt = await ready;
    const result = occt.ReadStepFile(new Uint8Array(buffer), { linearUnit: "millimeter", linearDeflectionType: "bounding_box_ratio", linearDeflection: 0.001, angularDeflection: 0.25 });
    if (!result || !result.success) throw new Error("That STEP file couldn't be read.");
    const bodies = bodiesFromOcct(result);
    const moved = [];
    for (const b of bodies) {
      moved.push(b.positions.buffer);
      if (b.faces) moved.push(b.faces.buffer);
    }
    postMessage({ id, bodies }, moved);
  } catch (e) {
    postMessage({ id, error: (e && e.message) || String(e) });
  }
};`;
}

/** Where occt/ is: beside this module, unless the host says otherwise. */
let occtBase = "";
export function setOcctBase(url: string): void {
  occtBase = url.endsWith("/") ? url : `${url}/`;
}
function baseUrl(): string {
  if (occtBase) return occtBase;
  const dir = "occt/";
  return new URL(dir, import.meta.url).href;
}

let worker: Worker | null = null;
let nextId = 1;
const waiting = new Map<number, { resolve: (b: StepBody[]) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  const blob = new Blob([workerSource()], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  const w = new Worker(url);
  URL.revokeObjectURL(url);
  w.onmessage = ev => {
    const { id, bodies, error } = ev.data as { id: number; bodies?: StepBody[]; error?: string };
    const job = waiting.get(id);
    if (!job) return;
    waiting.delete(id);
    if (error || !bodies) job.reject(new Error(error || "That STEP file couldn't be read."));
    else job.resolve(bodies);
  };
  w.onerror = ev => {
    ev.preventDefault();
    // A worker that fails to start (OpenCascade not found) fails every job; the next file tries afresh.
    for (const job of waiting.values()) job.reject(new Error("The STEP reader couldn't be loaded."));
    waiting.clear();
    w.terminate();
    if (worker === w) worker = null;
  };
  worker = w;
  return w;
}

/** The solids in a STEP file, read in a worker. */
export function readStep(buffer: ArrayBuffer): Promise<StepBody[]> {
  const head = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 200)));
  if (!/ISO-10303-21/.test(head)) return Promise.reject(new Error("That isn't a STEP file."));
  const base = baseUrl();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    // A copy goes (the host may keep its buffer). The files carry the Layers version, so a new OpenCascade isn't served from an old cache.
    getWorker().postMessage({ id, base, wasm: `${base}occt-import-js.wasm?v=${__LAYERS_VERSION__}`, buffer });
  });
}
