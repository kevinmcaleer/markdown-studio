import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { bodiesFromOcct, isStepFile, mergeBodies, type StepBody } from "./step";
import { stlFaces, toBinaryStl, parseStl } from "./stl";
import { Topology } from "./snaps";

// The real OpenCascade reader, run in node, on the CAx-IF test files that come with it.
const require = createRequire(import.meta.url);
const dir = join(dirname(require.resolve("occt-import-js")), "..", "test", "testfiles");
let occt: { ReadStepFile(content: Uint8Array, params: unknown): never };
const read = (file: string): StepBody[] => bodiesFromOcct(occt.ReadStepFile(readFileSync(join(dir, file)), null));

beforeAll(async () => {
  occt = await require("occt-import-js")();
});

describe("STEP files", () => {
  it("knows a STEP file's name", () => {
    expect(isStepFile("arm.STEP")).toBe(true);
    expect(isStepFile("/files/arm.stp?v=2")).toBe(true);
    expect(isStepFile("arm.stl")).toBe(false);
  });

  it("brings each solid of an assembly in as its own part, named from the CAD tree", () => {
    const bodies = read("cax-if/as1_pe_203.stp");
    expect(bodies.length).toBe(18);
    const names = bodies.map(b => b.name);
    expect(names[0]).toBe("PLATE");
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("L BRACKET ASSEMBLY ASM 14");
    expect(names).toContain("ROD ASM 3");
    for (const b of bodies) {
      expect(b.positions.length % 9).toBe(0);
      expect(b.faces?.length).toBe(b.positions.length / 9);
      expect([...b.faces!].every(f => f !== 0xffff)).toBe(true);
    }
  });

  it("makes one part of an assembly, each solid's faces still its own", () => {
    const bodies = read("cax-if/as1_pe_203.stp");
    const whole = mergeBodies(bodies, "as1");
    const tris = bodies.reduce((n, b) => n + b.positions.length / 9, 0);
    expect(whole.name).toBe("as1");
    expect(whole.positions.length).toBe(tris * 9);
    expect(whole.faces!.length).toBe(tris);
    const faces = bodies.reduce((n, b) => n + new Set(b.faces).size, 0);
    expect(new Set(whole.faces).size).toBe(faces);
    // The plate's holes still offer their centres in the whole.
    const topo = new Topology(whole.positions, whole.faces);
    let holes = 0;
    for (let t = 0; t < bodies[0].positions.length / 9; t++) holes = Math.max(holes, topo.faceAt(t)!.snaps.filter(s => s.role === "hole").length);
    expect(holes).toBeGreaterThan(0);
  });

  it("gives millimetres whatever the file's units", () => {
    const [cube] = read("cube-units/cube-m.step");
    expect(Math.max(...cube.positions)).toBeCloseTo(1000, 3);
  });

  it("keeps the CAD faces through the STL carried in a graphic", () => {
    const [cube] = read("cube-units/cube-mm.step");
    const stl = toBinaryStl(cube.positions, cube.faces);
    expect([...parseStl(stl)]).toEqual([...cube.positions]);
    expect([...stlFaces(stl)!]).toEqual([...cube.faces!]);
    // A plain STL carries none.
    expect(stlFaces(toBinaryStl(cube.positions))).toBeNull();
  });

  it("picks a whole CAD face, with a round hole's centre on it", () => {
    // The rounded cube: flat faces each one CAD face, fillets between.
    const [b] = read("rounded-cube/rounded-cube.step");
    const topo = new Topology(b.positions, b.faces);
    for (let t = 0; t < topo.triangles; t += 7) {
      const face = topo.faceAt(t)!;
      const id = b.faces![t];
      expect(face.tris.every(x => b.faces![x] === id) || face.curved).toBe(true);
    }
    // The plate of the assembly has holes: its top face offers their centres.
    const plate = read("cax-if/as1_pe_203.stp")[0];
    const pt = new Topology(plate.positions, plate.faces);
    let holes = 0;
    for (let t = 0; t < pt.triangles; t++) holes = Math.max(holes, pt.faceAt(t)!.snaps.filter(s => s.role === "hole").length);
    expect(holes).toBeGreaterThan(0);
  });
});
