// STL files (binary or text) to triangle corner positions, and the model
// carried inside a graphic as base64. No three.js, so it can be tested.

export const MAX_TRIANGLES = 3_000_000;

/** Every triangle's three corners, as x, y, z floats. */
export function parseStl(buffer: ArrayBuffer): Float32Array {
  const bytes = new Uint8Array(buffer);
  if (bytes.length >= 84) {
    const dv = new DataView(buffer);
    const n = dv.getUint32(80, true);
    // A binary STL is exactly its header, count and 50 bytes a triangle,
    // even when its header starts with "solid" (many exporters do that).
    if (84 + n * 50 === bytes.length) {
      if (n > MAX_TRIANGLES) throw new Error(tooBig(n));
      const out = new Float32Array(n * 9);
      for (let i = 0; i < n; i++) {
        const o = 84 + i * 50 + 12;
        for (let k = 0; k < 9; k++) out[i * 9 + k] = dv.getFloat32(o + k * 4, true);
      }
      return out;
    }
  }
  const text = new TextDecoder().decode(bytes);
  if (!/^\s*solid/.test(text)) throw new Error("That isn't an STL file.");
  const out: number[] = [];
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push(Number(m[1]), Number(m[2]), Number(m[3]));
    if (out.length > MAX_TRIANGLES * 9) throw new Error(tooBig(out.length / 9));
  }
  if (!out.length || out.length % 9 || out.some(n => !Number.isFinite(n))) throw new Error("That STL file couldn't be read.");
  return Float32Array.from(out);
}

const tooBig = (n: number) => `That model has ${Math.round(n / 1000)}k triangles, more than ${MAX_TRIANGLES / 1_000_000} million. Simplify it in your CAD or slicer first.`;

/** The box round some corner positions. */
export function bounds(pos: Float32Array): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = pos[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  if (!pos.length) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}

/** Models carried inside a graphic are kept to this size (packed, see mesh.ts). */
export const MAX_EMBED = 6_000_000;

export const tooBigToCarry = (name: string, bytes: number) =>
  `${name} is ${(bytes / 1e6).toFixed(1)} MB even packed small. Models carried in a graphic can be up to ${MAX_EMBED / 1e6} MB: add it to your project's files and pick it from there, or simplify it.`;

export function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64: string): ArrayBuffer {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}

/** A binary STL's header when it carries each triangle's CAD face (see toBinaryStl). */
const FACES_MARK = "layers-faces";

/**
 * Corner positions as a binary STL: a text STL is about five times bigger,
 * so an uploaded model carried inside a graphic costs less. `faces` (a STEP
 * model's CAD face for each triangle) go in each triangle's two spare
 * bytes, marked in the header so other files' bytes aren't read as faces.
 */
export function toBinaryStl(pos: Float32Array, faces?: Uint16Array | null): ArrayBuffer {
  const n = pos.length / 9;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  if (faces && faces.length === n) {
    for (let i = 0; i < FACES_MARK.length; i++) dv.setUint8(i, FACES_MARK.charCodeAt(i));
  }
  dv.setUint32(80, n, true);
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12; // normals left at 0: readers work them out
    for (let k = 0; k < 9; k++) dv.setFloat32(o + k * 4, pos[i * 9 + k], true);
    if (faces && faces.length === n) dv.setUint16(o + 36, faces[i], true);
  }
  return buf;
}

/** The CAD face of each triangle, when a binary STL made by toBinaryStl carries them. */
export function stlFaces(buffer: ArrayBuffer): Uint16Array | null {
  if (buffer.byteLength < 84) return null;
  const head = new Uint8Array(buffer, 0, FACES_MARK.length);
  if (!head.every((c, i) => c === FACES_MARK.charCodeAt(i))) return null;
  const dv = new DataView(buffer);
  const n = dv.getUint32(80, true);
  if (84 + n * 50 !== buffer.byteLength) return null;
  const out = new Uint16Array(n);
  for (let i = 0; i < n; i++) out[i] = dv.getUint16(84 + i * 50 + 48, true);
  return out;
}
