// A small animated GIF encoder, for the animated model (scene/animation.ts).
//
// Line-art pictures have few colours (white, black, greys where lines are
// smoothed, a fill or two), so one palette of up to 255 colours, picked from
// a few sample frames, holds them all without dithering. Each frame after
// the first keeps only what changed: the box round the changed pixels, with
// the pixels that didn't change see-through, so a still hold costs nothing
// and a slow explode costs little.

/** One palette for the whole animation: RGB triples, up to 255 (the last index is kept for "unchanged"). */
export interface GifPalette {
  colours: [number, number, number][];
  /** 15-bit colour (5 bits a channel) → palette index, filled in as colours turn up. */
  lookup: Int16Array;
}

const bin = (r: number, g: number, b: number) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

/**
 * The palette for these sample frames (RGBA, as getImageData gives): the
 * most used colours, each a little apart from the others, so a small but
 * different colour (a part's own fill) isn't crowded out by shades of grey.
 * See-through pixels count as `background`.
 */
export function paletteFor(samples: Uint8ClampedArray[], background: [number, number, number] = [255, 255, 255], max = 255): GifPalette {
  const count = new Float64Array(32768);
  const sum = new Float64Array(32768 * 3);
  for (const data of samples) {
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3] / 255;
      const r = Math.round(data[i] * a + background[0] * (1 - a));
      const g = Math.round(data[i + 1] * a + background[1] * (1 - a));
      const b = Math.round(data[i + 2] * a + background[2] * (1 - a));
      const k = bin(r, g, b);
      count[k]++;
      sum[k * 3] += r;
      sum[k * 3 + 1] += g;
      sum[k * 3 + 2] += b;
    }
  }
  const used: number[] = [];
  for (let k = 0; k < 32768; k++) if (count[k]) used.push(k);
  used.sort((a, b) => count[b] - count[a]);
  const colours: [number, number, number][] = [];
  const mean = (k: number): [number, number, number] => [Math.round(sum[k * 3] / count[k]), Math.round(sum[k * 3 + 1] / count[k]), Math.round(sum[k * 3 + 2] / count[k])];
  // Colours well apart first, then nearer, then the rest by use, to fill the palette.
  for (const gap of [96, 24, 0]) {
    for (const k of used) {
      if (colours.length >= max) break;
      const c = mean(k);
      if (colours.some(o => o[0] === c[0] && o[1] === c[1] && o[2] === c[2])) continue;
      if (gap && colours.some(o => dist2(o, c) < gap * gap)) continue;
      colours.push(c);
    }
  }
  if (!colours.length) colours.push(background);
  return { colours, lookup: new Int16Array(32768).fill(-1) };
}

function dist2(a: readonly number[], b: readonly number[]): number {
  // Weighted a little the way the eye is.
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return 2 * dr * dr + 4 * dg * dg + 3 * db * db;
}

/** The palette index nearest to this colour. */
export function nearest(p: GifPalette, r: number, g: number, b: number): number {
  const k = bin(r, g, b);
  let i = p.lookup[k];
  if (i >= 0) return i;
  let best = Infinity;
  const c = [r, g, b];
  i = 0;
  p.colours.forEach((o, j) => {
    const d = dist2(o, c);
    if (d < best) {
      best = d;
      i = j;
    }
  });
  p.lookup[k] = i;
  return i;
}

/** A frame (RGBA) as palette indices, see-through pixels taken as `background`. */
export function indexFrame(data: Uint8ClampedArray, p: GifPalette, background: [number, number, number] = [255, 255, 255]): Uint8Array {
  const out = new Uint8Array(data.length / 4);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    const a = data[i + 3];
    if (a === 255) out[j] = nearest(p, data[i], data[i + 1], data[i + 2]);
    else {
      const f = a / 255;
      out[j] = nearest(p, Math.round(data[i] * f + background[0] * (1 - f)), Math.round(data[i + 1] * f + background[1] * (1 - f)), Math.round(data[i + 2] * f + background[2] * (1 - f)));
    }
  }
  return out;
}

/** A growing byte buffer. */
class Bytes {
  buf = new Uint8Array(1 << 16);
  length = 0;
  private grow(n: number) {
    if (this.length + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }
  byte(b: number) {
    this.grow(1);
    this.buf[this.length++] = b & 0xff;
  }
  word(w: number) {
    this.byte(w);
    this.byte(w >> 8);
  }
  bytes(list: ArrayLike<number>) {
    this.grow(list.length);
    this.buf.set(list as Uint8Array, this.length);
    this.length += list.length;
  }
  ascii(s: string) {
    for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i));
  }
  done(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

/** GIF's LZW for these indices, in 255-byte sub-blocks, ending with the empty block. */
export function lzw(indices: Uint8Array, minCodeSize: number, out: Bytes): void {
  out.byte(minCodeSize);
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = end + 1;
  // The dictionary: (prefix code, next index) → code, as a flat table; the keys used are kept to clear it quickly.
  const table = new Int16Array(4096 * 256).fill(-1);
  const keys: number[] = [];
  let block = new Uint8Array(255);
  let blockLen = 0;
  let acc = 0;
  let bits = 0;
  const flushBlock = () => {
    if (!blockLen) return;
    out.byte(blockLen);
    out.bytes(block.subarray(0, blockLen));
    blockLen = 0;
  };
  const emit = (code: number) => {
    acc |= code << bits;
    bits += codeSize;
    while (bits >= 8) {
      block[blockLen++] = acc & 0xff;
      if (blockLen === 255) flushBlock();
      acc >>>= 8;
      bits -= 8;
    }
  };
  const reset = () => {
    for (const k of keys) table[k] = -1;
    keys.length = 0;
    codeSize = minCodeSize + 1;
    next = end + 1;
  };
  emit(clear);
  if (!indices.length) {
    emit(end);
  } else {
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i];
      const key = prefix * 256 + k;
      const found = table[key];
      if (found >= 0) {
        prefix = found;
        continue;
      }
      emit(prefix);
      if (next < 4096) {
        table[key] = next;
        keys.push(key);
        // The decoder widens its codes once the next code needs more bits.
        if (next === 1 << codeSize && codeSize < 12) codeSize++;
        next++;
      } else {
        emit(clear);
        reset();
      }
      prefix = k;
    }
    emit(prefix);
    emit(end);
  }
  if (bits > 0) {
    block[blockLen++] = acc & 0xff;
    if (blockLen === 255) flushBlock();
  }
  flushBlock();
  out.byte(0);
  block = new Uint8Array(0);
}

export interface GifFrame {
  /** Palette indices, width × height. */
  indices: Uint8Array;
  /** How long it shows, in milliseconds. */
  delay: number;
}

/**
 * Builds the animated GIF a frame at a time: `add` each frame (its palette
 * indices and how long it shows), then `finish`. It loops for ever.
 */
export class GifWriter {
  private out = new Bytes();
  private prev: Uint8Array | null = null;
  /** The last frame written, still open: its delay grows while frames don't change. */
  private pending: { indices: Uint8Array; delay: number } | null = null;
  private readonly transparent: number;
  private readonly minCodeSize: number;
  frames = 0;

  constructor(readonly width: number, readonly height: number, readonly palette: GifPalette) {
    const n = palette.colours.length + 1; // + "unchanged"
    let bitsPer = 1;
    while (1 << bitsPer < n) bitsPer++;
    this.transparent = palette.colours.length;
    this.minCodeSize = Math.max(2, bitsPer);
    const o = this.out;
    o.ascii("GIF89a");
    o.word(width);
    o.word(height);
    // A global colour table of 2^bitsPer entries.
    o.byte(0x80 | ((bitsPer - 1) << 4) | (bitsPer - 1));
    o.byte(0);
    o.byte(0);
    for (let i = 0; i < 1 << bitsPer; i++) {
      const c = palette.colours[i] || [0, 0, 0];
      o.byte(c[0]);
      o.byte(c[1]);
      o.byte(c[2]);
    }
    // Loop for ever (NETSCAPE2.0).
    o.byte(0x21);
    o.byte(0xff);
    o.byte(11);
    o.ascii("NETSCAPE2.0");
    o.byte(3);
    o.byte(1);
    o.word(0);
    o.byte(0);
  }

  add(frame: GifFrame): void {
    if (this.pending && sameFrame(this.pending.indices, frame.indices)) {
      this.pending.delay += frame.delay;
      return;
    }
    this.flush();
    this.pending = { indices: frame.indices, delay: frame.delay };
  }

  private flush(): void {
    const f = this.pending;
    if (!f) return;
    this.pending = null;
    const { width: w, height: h } = this;
    let x0 = 0;
    let y0 = 0;
    let x1 = w - 1;
    let y1 = h - 1;
    let data = f.indices;
    let transparent = false;
    const prev = this.prev;
    if (prev) {
      // The box round what changed; inside it, what didn't change is see-through.
      x0 = w;
      y0 = h;
      x1 = -1;
      y1 = -1;
      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
          if (prev[row + x] !== data[row + x]) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            y1 = y;
          }
        }
      }
      if (x1 < 0) {
        // Nothing changed (can't happen after `add`, but keep a 1×1 frame for its delay).
        x0 = x1 = y0 = y1 = 0;
      }
      const bw = x1 - x0 + 1;
      const bh = y1 - y0 + 1;
      const box = new Uint8Array(bw * bh);
      for (let y = 0; y < bh; y++) {
        const row = (y + y0) * w;
        for (let x = 0; x < bw; x++) {
          const i = row + x + x0;
          box[y * bw + x] = prev[i] === data[i] ? this.transparent : data[i];
        }
      }
      data = box;
      transparent = true;
    }
    const o = this.out;
    // Graphic control: leave the frame in place (disposal 1), its delay, and the see-through index.
    o.byte(0x21);
    o.byte(0xf9);
    o.byte(4);
    o.byte((1 << 2) | (transparent ? 1 : 0));
    o.word(Math.max(2, Math.round(f.delay / 10)));
    o.byte(transparent ? this.transparent : 0);
    o.byte(0);
    // Image descriptor, no local colour table.
    o.byte(0x2c);
    o.word(x0);
    o.word(y0);
    o.word(x1 - x0 + 1);
    o.word(y1 - y0 + 1);
    o.byte(0);
    lzw(data, this.minCodeSize, o);
    this.prev = f.indices;
    this.frames++;
  }

  /** The finished GIF. */
  finish(): Uint8Array {
    this.flush();
    this.out.byte(0x3b);
    return this.out.done();
  }
}

function sameFrame(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
