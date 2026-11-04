import { describe, expect, it } from "vitest";
import { isPacked, packData, packMesh, packParts, unpackMesh } from "./mesh";
import { meshTable, restoreParts } from "./meshTable";
import { normalizeModel, packModel, partsDiffer, type ScenePart } from "./model";
import { toBase64, toBinaryStl } from "./stl";
import { normalizeDoc, packDoc, type LayersDoc } from "../doc";

/** A cube's 12 triangles, corners repeated as an STL has them. */
function cube(size = 10): Float32Array {
  const v = (x: number, y: number, z: number) => [x * size, y * size, z * size];
  const quads = [
    [v(0, 0, 0), v(1, 0, 0), v(1, 1, 0), v(0, 1, 0)],
    [v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1)],
    [v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1)],
    [v(0, 1, 0), v(1, 1, 0), v(1, 1, 1), v(0, 1, 1)],
    [v(0, 0, 0), v(0, 1, 0), v(0, 1, 1), v(0, 0, 1)],
    [v(1, 0, 0), v(1, 1, 0), v(1, 1, 1), v(1, 0, 1)],
  ];
  const out: number[] = [];
  for (const [a, b, c, d] of quads) out.push(...a, ...b, ...c, ...a, ...c, ...d);
  return Float32Array.from(out);
}

/** A finely divided sheet, so welding has plenty to share. */
function sheet(n: number): Float32Array {
  const out: number[] = [];
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const p = (a: number, b: number) => [a * 0.37, b * 0.37, Math.sin(a * 0.1) * Math.cos(b * 0.1) * 3];
      out.push(...p(i, j), ...p(i + 1, j), ...p(i + 1, j + 1), ...p(i, j), ...p(i + 1, j + 1), ...p(i, j + 1));
    }
  return Float32Array.from(out);
}

describe("packed models", () => {
  it("round-trips the corners exactly", async () => {
    const pos = cube();
    const data = await packMesh(pos);
    expect(isPacked(data)).toBe(true);
    const back = await unpackMesh(data);
    expect(Array.from(back.positions)).toEqual(Array.from(pos));
    expect(back.faces).toBeNull();
  });

  it("keeps a STEP model's CAD faces", async () => {
    const pos = cube();
    const faces = Uint16Array.from({ length: 12 }, (_, i) => Math.floor(i / 2));
    const back = await unpackMesh(await packMesh(pos, faces));
    expect(Array.from(back.faces!)).toEqual(Array.from(faces));
  });

  it("uses 32-bit indexes past 65535 points", async () => {
    const pos = sheet(260); // 261² points
    const back = await unpackMesh(await packMesh(pos));
    expect(back.positions.length).toBe(pos.length);
    expect(back.positions[back.positions.length - 1]).toBe(pos[pos.length - 1]);
  });

  it("is much smaller than the base64 STL it replaces", async () => {
    const pos = sheet(120);
    const stl = toBase64(toBinaryStl(pos));
    const data = await packData(stl);
    expect(data.length).toBeLessThan(stl.length / 3);
    const back = await unpackMesh(data);
    expect(Array.from(back.positions)).toEqual(Array.from(pos));
  });

  it("packs older parts in place, copies once, and leaves packed ones", async () => {
    const stl = toBase64(toBinaryStl(cube()));
    const packed = await packMesh(cube(5));
    const parts: { data?: string }[] = [{ data: stl }, { data: stl }, { data: packed }, {}, { data: "not a model" }];
    expect(await packParts(parts)).toBe(true);
    expect(isPacked(parts[0].data)).toBe(true);
    expect(parts[1].data).toBe(parts[0].data);
    expect(parts[2].data).toBe(packed);
    expect(parts[3].data).toBeUndefined();
    expect(parts[4].data).toBe("not a model");
    expect(await packParts(parts)).toBe(false);
  });
});

describe("mesh table", () => {
  const part = (id: string, data?: string): ScenePart => ({ id, name: id, position: [0, 0, 0], rotation: [0, 0, 0], ...(data ? { data } : {}) });

  it("keeps each model once and puts them back", () => {
    const t = meshTable();
    const parts = t.parts([part("a", "AAA"), part("b", "AAA"), part("c", "BBB"), part("d")] as unknown as Record<string, unknown>[]);
    expect(t.size()).toBe(2);
    expect(parts.map(p => p.mesh)).toEqual(["m1", "m1", "m2", undefined]);
    expect(parts.some(p => "data" in p)).toBe(false);
    expect(restoreParts(parts, t.meshes).map(p => p.data)).toEqual(["AAA", "AAA", "BBB", undefined]);
  });

  it("saves a project model packed and reads it back", () => {
    const model = { version: 1 as const, stamp: 3, parts: [part("a", "AAA"), part("b", "AAA")] };
    const saved = JSON.parse(JSON.stringify(packModel(model)));
    expect(Object.keys(saved.meshes)).toHaveLength(1);
    const back = normalizeModel(saved)!;
    expect(back.parts.map(p => p.data)).toEqual(["AAA", "AAA"]);
    expect(back.parts.some(p => "mesh" in p)).toBe(false);
  });

  it("saves a graphic's scenes, in groups too, with each model once", () => {
    const scene = { version: 1, parts: [part("a", "AAA"), part("b", "AAA")] };
    const doc: LayersDoc = {
      app: "layers", version: 1, width: 100, height: 100, background: "",
      objects: [
        { type: "SceneLayer", scene },
        { type: "Group", objects: [{ type: "SceneLayer", scene: structuredClone(scene) }] },
        { type: "Rect" },
      ],
    };
    const text = JSON.stringify(packDoc(doc));
    expect(text.match(/AAA/g)).toHaveLength(1);
    // The document handed in isn't changed.
    expect((doc.objects[0].scene as typeof scene).parts[0].data).toBe("AAA");
    const back = normalizeDoc(JSON.parse(text))!;
    expect(back).not.toHaveProperty("meshes");
    const inner = (back.objects[1].objects as Record<string, unknown>[])[0].scene as typeof scene;
    expect(inner.parts.map(p => p.data)).toEqual(["AAA", "AAA"]);
  });

  it("doesn't count a model's packing as the part changing", () => {
    expect(partsDiffer([part("a", "AAA")], [part("a", "m1:xyz")])).toBe(false);
    expect(partsDiffer([part("a", "AAA")], [{ ...part("a", "AAA"), name: "new" }])).toBe(true);
  });
});
