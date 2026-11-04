import { describe, expect, it } from "vitest";
import { bounds, fromBase64, parseStl, toBase64, toBinaryStl } from "./stl";

const tri = [0, 0, 0, 10, 0, 0, 0, 20, 5];
const ascii = `solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 20 5\nendloop\nendfacet\nendsolid t\n`;

describe("STL", () => {
  it("reads text STL", () => {
    expect([...parseStl(new TextEncoder().encode(ascii).buffer as ArrayBuffer)]).toEqual(tri);
  });

  it("reads binary STL, even with a header starting 'solid'", () => {
    const buf = toBinaryStl(Float32Array.from(tri));
    new Uint8Array(buf).set(new TextEncoder().encode("solid exported"), 0);
    expect([...parseStl(buf)]).toEqual(tri);
  });

  it("refuses things that aren't STL", () => {
    expect(() => parseStl(new TextEncoder().encode("hello").buffer as ArrayBuffer)).toThrow(/isn't an STL/);
    expect(() => parseStl(new TextEncoder().encode("solid x\nendsolid").buffer as ArrayBuffer)).toThrow(/couldn't be read/);
  });

  it("finds the box round a model", () => {
    expect(bounds(Float32Array.from(tri))).toEqual({ min: [0, 0, 0], max: [10, 20, 5] });
  });

  it("round-trips base64", () => {
    const buf = toBinaryStl(Float32Array.from(tri));
    expect(new Uint8Array(fromBase64(toBase64(buf)))).toEqual(new Uint8Array(buf));
  });
});
