import { describe, expect, it } from "vitest";
import { isPng, readText, writeText } from "./png";
import { blankDoc, embedDoc, extractDoc, fileName, normalizeDoc, parseDoc } from "./doc";

// A 1×1 transparent PNG.
const PIXEL = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="),
  c => c.charCodeAt(0),
);

describe("png text chunk", () => {
  it("round-trips text and keeps the picture a PNG", async () => {
    const out = await writeText(PIXEL, "héllo ✓");
    expect(isPng(out)).toBe(true);
    expect(out.length).toBeGreaterThan(PIXEL.length);
    expect(await readText(out)).toBe("héllo ✓");
    // The chunk goes in before IEND, which stays last.
    expect(new TextDecoder().decode(out.subarray(out.length - 8, out.length - 4))).toBe("IEND");
  });

  it("replaces an earlier copy rather than adding a second", async () => {
    const once = await writeText(PIXEL, "one");
    const twice = await writeText(once, "two");
    expect(await readText(twice)).toBe("two");
    const count = new TextDecoder("latin1").decode(twice).split("iTXtlayers").length - 1;
    expect(count).toBe(1);
  });

  it("gives null for a plain PNG or something else", async () => {
    expect(await readText(PIXEL)).toBeNull();
    expect(await readText(new Uint8Array([1, 2, 3]))).toBeNull();
    await expect(writeText(new Uint8Array([1, 2, 3]), "x")).rejects.toThrow();
  });

  it("writes a CRC other readers accept", async () => {
    const out = await writeText(PIXEL, "crc");
    // zlib's crc32 of "iTXt" + data, checked against node's.
    const { crc32 } = await import("node:zlib");
    const view = new DataView(out.buffer);
    let at = 8;
    while (at < out.length) {
      const len = view.getUint32(at);
      const crc = view.getUint32(at + 8 + len);
      expect(crc).toBe(crc32(out.subarray(at + 4, at + 8 + len)) >>> 0);
      at += 12 + len;
    }
  });
});

describe("layer documents", () => {
  it("embeds and extracts a document", async () => {
    const doc = { ...blankDoc(), title: "Wiring", objects: [{ type: "Rect", left: 1 }] };
    const png = await embedDoc(PIXEL, doc);
    expect(await extractDoc(png)).toEqual(doc);
    expect(await extractDoc(PIXEL)).toBeNull();
  });

  it("normalizes what it reads", () => {
    expect(normalizeDoc(null)).toBeNull();
    expect(normalizeDoc({ app: "other", objects: [] })).toBeNull();
    const d = normalizeDoc({ app: "layers", width: 99999, height: "x", objects: [null, { a: 1 }] });
    expect(d).toMatchObject({ width: 4000, height: 1600, background: "#ffffff", objects: [{ a: 1 }] });
    expect(parseDoc("{")).toBeNull();
  });

  it("names files from the title", () => {
    expect(fileName("Robot arm: wiring!")).toBe("robot-arm-wiring.layers.png");
    expect(fileName("")).toBe("graphic.layers.png");
  });
});
