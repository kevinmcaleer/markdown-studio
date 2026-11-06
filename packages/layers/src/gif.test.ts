import { describe, expect, it } from "vitest";
import { GifWriter, indexFrame, paletteFor } from "./gif";

/** A small GIF reader for the tests: each frame's full picture as palette indices (see-through keeps what was there). */
function decode(bytes: Uint8Array) {
  let p = 0;
  const u8 = () => bytes[p++];
  const u16 = () => bytes[p++] | (bytes[p++] << 8);
  const sig = String.fromCharCode(...bytes.slice(0, 6));
  p = 6;
  const w = u16();
  const h = u16();
  const flags = u8();
  p += 2;
  const size = 1 << ((flags & 7) + 1);
  const palette: number[][] = [];
  for (let i = 0; i < size; i++) palette.push([u8(), u8(), u8()]);
  const canvas = new Uint8Array(w * h);
  const frames: { pixels: Uint8Array; delay: number }[] = [];
  let loop = false;
  let gce = { transparent: -1, delay: 0 };
  for (;;) {
    const b = u8();
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = u8();
      if (label === 0xf9) {
        u8();
        const f = u8();
        const delay = u16() * 10;
        const t = u8();
        u8();
        gce = { transparent: f & 1 ? t : -1, delay };
      } else {
        for (let n = u8(); n; n = u8()) {
          if (label === 0xff && String.fromCharCode(...bytes.slice(p, p + 11)) === "NETSCAPE2.0") loop = true;
          p += n;
        }
      }
      continue;
    }
    if (b !== 0x2c) throw new Error(`bad block ${b}`);
    const x0 = u16();
    const y0 = u16();
    const fw = u16();
    const fh = u16();
    u8();
    const min = u8();
    const data: number[] = [];
    for (let n = u8(); n; n = u8()) for (let i = 0; i < n; i++) data.push(u8());
    // LZW
    const clear = 1 << min;
    const end = clear + 1;
    let codeSize = min + 1;
    let dict: number[][] = [];
    const resetDict = () => {
      dict = [];
      for (let i = 0; i < clear; i++) dict.push([i]);
      dict.push([], []);
      codeSize = min + 1;
    };
    resetDict();
    const out: number[] = [];
    let bit = 0;
    let prev: number[] | null = null;
    for (;;) {
      let code = 0;
      for (let i = 0; i < codeSize; i++) {
        code |= ((data[bit >> 3] >> (bit & 7)) & 1) << i;
        bit++;
      }
      if (code === clear) {
        resetDict();
        prev = null;
        continue;
      }
      if (code === end) break;
      let entry: number[];
      if (code < dict.length) entry = dict[code];
      else if (prev) entry = [...prev, prev[0]];
      else throw new Error("bad code");
      out.push(...entry);
      if (prev && dict.length < 4096) dict.push([...prev, entry[0]]);
      if (dict.length === 1 << codeSize && codeSize < 12) codeSize++;
      prev = entry;
    }
    expect(out.length).toBe(fw * fh);
    for (let y = 0; y < fh; y++)
      for (let x = 0; x < fw; x++) {
        const v = out[y * fw + x];
        if (v !== gce.transparent) canvas[(y + y0) * w + x + x0] = v;
      }
    frames.push({ pixels: canvas.slice(), delay: gce.delay });
  }
  return { sig, w, h, palette, frames, loop };
}

const rgba = (w: number, h: number, at: (x: number, y: number) => [number, number, number]) => {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = at(x, y);
      d.set([r, g, b, 255], (y * w + x) * 4);
    }
  return d;
};

describe("gif", () => {
  it("writes frames a GIF reader reads back, looping, with their delays", () => {
    const w = 37;
    const h = 23;
    const frames = [0, 5, 11].map(shift => rgba(w, h, (x, y) => ((x + shift) % 9 < 3 ? [0, 0, 0] : y % 7 === 0 ? [120, 120, 120] : [255, 255, 255])));
    const palette = paletteFor(frames);
    const gif = new GifWriter(w, h, palette);
    frames.forEach((f, i) => gif.add({ indices: indexFrame(f, palette), delay: 100 * (i + 1) }));
    const out = decode(gif.finish());
    expect(out.sig).toBe("GIF89a");
    expect([out.w, out.h, out.loop]).toEqual([w, h, true]);
    expect(out.frames.map(f => f.delay)).toEqual([100, 200, 300]);
    frames.forEach((f, i) => {
      const want = indexFrame(f, palette);
      expect(Array.from(out.frames[i].pixels)).toEqual(Array.from(want));
      // The colours are the frame's own.
      const [r, g, b] = out.palette[out.frames[i].pixels[0]];
      expect([r, g, b]).toEqual(Array.from(f.slice(0, 3)));
    });
  });

  it("holds an unchanged frame longer rather than writing it again", () => {
    const f = rgba(8, 8, x => (x < 4 ? [0, 0, 0] : [255, 255, 255]));
    const palette = paletteFor([f]);
    const gif = new GifWriter(8, 8, palette);
    gif.add({ indices: indexFrame(f, palette), delay: 100 });
    gif.add({ indices: indexFrame(f, palette), delay: 100 });
    const out = decode(gif.finish());
    expect(out.frames.map(x => x.delay)).toEqual([200]);
  });

  it("keeps a big noisy frame right (the code table fills and starts again)", () => {
    const w = 160;
    const h = 120;
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) & 255;
    const f = rgba(w, h, () => [rnd(), rnd(), rnd()]);
    const palette = paletteFor([f]);
    expect(palette.colours.length).toBe(255);
    const gif = new GifWriter(w, h, palette);
    gif.add({ indices: indexFrame(f, palette), delay: 50 });
    const out = decode(gif.finish());
    expect(Array.from(out.frames[0].pixels)).toEqual(Array.from(indexFrame(f, palette)));
  });

  it("keeps a small odd colour apart from the greys", () => {
    const f = rgba(50, 50, (x, y) => (x === 3 && y === 3 ? [200, 30, 30] : [(x * 5) % 256, (x * 5) % 256, (x * 5) % 256]));
    const palette = paletteFor([f], [255, 255, 255], 32);
    expect(palette.colours.some(c => c[0] > 150 && c[1] < 80)).toBe(true);
  });
});
