// A Layers graphic is an ordinary PNG that carries its own source: the layer
// document rides in a compressed iTXt chunk (keyword "layers") just before
// IEND. Image viewers, browsers and servers that store files byte for byte
// ignore it, so the picture works anywhere and can always be opened again.

export const CHUNK_KEYWORD = "layers";

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 8 && SIGNATURE.every((b, i) => bytes[i] === b);
}

interface Chunk {
  type: string;
  /** Offset of the chunk's length field. */
  start: number;
  /** Offset just past its CRC. */
  end: number;
  data: Uint8Array;
}

function* chunks(bytes: Uint8Array): Generator<Chunk> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  while (at + 12 <= bytes.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const end = at + 12 + length;
    if (end > bytes.length) return;
    yield { type, start: at, end, data: bytes.subarray(at + 8, at + 8 + length) };
    if (type === "IEND") return;
    at = end;
  }
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
const deflate = (b: Uint8Array) => pipe(b, new CompressionStream("deflate"));
const inflate = (b: Uint8Array) => pipe(b, new DecompressionStream("deflate"));

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** The iTXt chunk's data for `text`: keyword, compressed flag/method, empty language and translated keyword. */
async function itxt(text: string): Promise<Uint8Array> {
  const key = new TextEncoder().encode(CHUNK_KEYWORD);
  const body = await deflate(new TextEncoder().encode(text));
  const out = new Uint8Array(key.length + 5 + body.length);
  out.set(key, 0);
  // keyword\0, compression flag 1, method 0 (zlib), language "" \0, translated keyword "" \0
  out.set([0, 1, 0, 0, 0], key.length);
  out.set(body, key.length + 5);
  return out;
}

/** `png` with `text` stored in it under the "layers" keyword (any earlier copy replaced). */
export async function writeText(png: Uint8Array, text: string): Promise<Uint8Array> {
  if (!isPng(png)) throw new Error("Not a PNG");
  const parts: Uint8Array[] = [png.subarray(0, 8)];
  const chunk = makeChunk("iTXt", await itxt(text));
  let wrote = false;
  for (const c of chunks(png)) {
    if (c.type === "iTXt" && keywordOf(c.data) === CHUNK_KEYWORD) continue;
    if (c.type === "IEND") {
      parts.push(chunk);
      wrote = true;
    }
    parts.push(png.subarray(c.start, c.end));
  }
  if (!wrote) throw new Error("PNG has no IEND chunk");
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function keywordOf(data: Uint8Array): string {
  const nul = data.indexOf(0);
  return nul < 0 ? "" : new TextDecoder().decode(data.subarray(0, nul));
}

/** The text stored under the "layers" keyword, or null when the PNG has none. */
export async function readText(png: Uint8Array): Promise<string | null> {
  if (!isPng(png)) return null;
  for (const c of chunks(png)) {
    if (c.type !== "iTXt" || keywordOf(c.data) !== CHUNK_KEYWORD) continue;
    let at = c.data.indexOf(0) + 1;
    const compressed = c.data[at] === 1;
    at += 2;
    // language tag, then translated keyword, each NUL-terminated
    at = c.data.indexOf(0, at) + 1;
    at = c.data.indexOf(0, at) + 1;
    if (at <= 0) return null;
    const body = c.data.subarray(at);
    try {
      return new TextDecoder().decode(compressed ? await inflate(body) : body);
    } catch {
      return null;
    }
  }
  return null;
}
