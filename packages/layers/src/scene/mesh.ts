// A model carried inside a graphic or the project's model, packed small:
// the triangles' corners welded into shared points (a mesh repeats each
// point about six times), as points plus indexes, then deflated. Lossless,
// and typically a fifth to a tenth of the binary STL it replaces. The
// string is "m1:" and base64; older graphics carry plain base64 binary STL,
// which still reads (see ModelStore.get). No three.js, so it can be tested.

import { fromBase64, parseStl, stlFaces, toBase64 } from "./stl";

const PREFIX = "m1:";
const MAGIC = 0x00314d4c; // "LM1\0"
const FACES = 1;
const SHORT = 2;

/** Whether `data` is a packed model (otherwise it's base64 binary STL). */
export function isPacked(data: string | undefined): boolean {
  return !!data && data.startsWith(PREFIX);
}

async function through(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(bytes as BodyInit).body!.pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

/** Triangle corners (and a STEP model's CAD face per triangle) as a packed string. */
export async function packMesh(pos: Float32Array, faces?: Uint16Array | null): Promise<string> {
  const corners = pos.length / 3;
  const nt = corners / 3;
  const bits = new Uint32Array(pos.buffer, pos.byteOffset, pos.length);
  const seen = new Map<string, number>();
  const index = new Uint32Array(corners);
  // The first corner at each point.
  const firsts: number[] = [];
  for (let c = 0; c < corners; c++) {
    const key = `${bits[c * 3]},${bits[c * 3 + 1]},${bits[c * 3 + 2]}`;
    let i = seen.get(key);
    if (i === undefined) {
      i = firsts.length;
      seen.set(key, i);
      firsts.push(c);
    }
    index[c] = i;
  }
  const nv = firsts.length;
  const short = nv <= 0xffff;
  const withFaces = !!faces && faces.length === nt;
  const size = 16 + nv * 12 + corners * (short ? 2 : 4) + (withFaces ? nt * 2 : 0);
  const buf = new ArrayBuffer(size + (size % 4 ? 4 - (size % 4) : 0));
  const head = new Uint32Array(buf, 0, 4);
  head.set([MAGIC, nv, nt, (withFaces ? FACES : 0) | (short ? SHORT : 0)]);
  // The points one axis at a time: x's then y's then z's deflate better than mixed.
  const xyz = new Float32Array(buf, 16, nv * 3);
  for (let i = 0; i < nv; i++) {
    const c = firsts[i];
    xyz[i] = pos[c * 3];
    xyz[nv + i] = pos[c * 3 + 1];
    xyz[nv * 2 + i] = pos[c * 3 + 2];
  }
  let at = 16 + nv * 12;
  if (short) new Uint16Array(buf, at, corners).set(index);
  else new Uint32Array(buf, at, corners).set(index);
  at += corners * (short ? 2 : 4);
  if (withFaces) new Uint16Array(buf, at, nt).set(faces!);
  return PREFIX + toBase64((await through(new Uint8Array(buf, 0, size), new CompressionStream("deflate-raw"))).buffer as ArrayBuffer);
}

/** A packed string back to triangle corners and faces. */
export async function unpackMesh(data: string): Promise<{ positions: Float32Array; faces: Uint16Array | null }> {
  if (!isPacked(data)) throw new Error("That isn't a packed model.");
  const bytes = await through(new Uint8Array(fromBase64(data.slice(PREFIX.length))), new DecompressionStream("deflate-raw"));
  // A copy, aligned, so the typed arrays below can sit on it.
  const buf = new ArrayBuffer(bytes.length + 4);
  new Uint8Array(buf).set(bytes);
  const [magic, nv, nt, flags] = new Uint32Array(buf, 0, 4);
  const short = !!(flags & SHORT);
  const withFaces = !!(flags & FACES);
  if (magic !== MAGIC || bytes.length !== 16 + nv * 12 + nt * 3 * (short ? 2 : 4) + (withFaces ? nt * 2 : 0)) throw new Error("That model couldn't be read.");
  const xyz = new Float32Array(buf, 16, nv * 3);
  let at = 16 + nv * 12;
  const index = short ? new Uint16Array(buf, at, nt * 3) : new Uint32Array(buf, at, nt * 3);
  at += nt * 3 * (short ? 2 : 4);
  const positions = new Float32Array(nt * 9);
  for (let c = 0; c < nt * 3; c++) {
    const i = index[c];
    if (i >= nv) throw new Error("That model couldn't be read.");
    positions[c * 3] = xyz[i];
    positions[c * 3 + 1] = xyz[nv + i];
    positions[c * 3 + 2] = xyz[nv * 2 + i];
  }
  const faces = withFaces ? new Uint16Array(buf, at, nt).slice() : null;
  return { positions, faces };
}

/** A part's model data packed: an older graphic's base64 STL is packed, a packed one is kept. */
export async function packData(data: string): Promise<string> {
  if (isPacked(data)) return data;
  const stl = fromBase64(data);
  return packMesh(parseStl(stl), stlFaces(stl));
}

/**
 * Packs the model data of parts saved before models were packed, in place
 * (copies sharing one STL are packed once). Returns whether any changed. A
 * model that can't be read is left as it is.
 */
export async function packParts(parts: { data?: string }[]): Promise<boolean> {
  const done = new Map<string, Promise<string>>();
  let changed = false;
  for (const p of parts) {
    if (!p.data || isPacked(p.data)) continue;
    let packed = done.get(p.data);
    if (!packed) {
      packed = packData(p.data).catch(() => "");
      done.set(p.data, packed);
    }
    const d = await packed;
    if (d) {
      p.data = d;
      changed = true;
    }
  }
  return changed;
}
