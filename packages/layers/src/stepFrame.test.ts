import { describe, expect, it } from "vitest";
import { blankScene } from "./scene/model";
import { partsInStep, turnedFromDefault, viewAngle } from "./stepFrame";

const part = (id: string, url: string, extra = {}) => ({ id, name: id, url, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], ...extra });

describe("partsInStep", () => {
  it("counts the highlighted parts by kind", () => {
    const s = { ...blankScene(), parts: [part("a", "plate.stl", { highlight: true }), part("b", "screw.stl", { highlight: true }), part("c", "screw.stl", { highlight: true }), part("d", "base.stl", { ghost: true }), part("e", "nut.stl")] };
    const got = partsInStep(s);
    expect(got.map(g => [g.part.name, g.count])).toEqual([["a", 1], ["b", 2]]);
  });

  it("lists every shown part when nothing is highlighted", () => {
    const s = { ...blankScene(), parts: [part("a", "plate.stl"), part("b", "screw.stl"), part("c", "screw.stl", { hidden: true }), part("d", "base.stl", { ghost: true })] };
    expect(partsInStep(s).map(g => [g.part.name, g.count])).toEqual([["a", 1], ["b", 1]]);
  });

  it("follows a highlighted branch", () => {
    const s = { ...blankScene(), parts: [part("a", "plate.stl", { highlight: true }), part("b", "screw.stl", { parent: "a" }), part("c", "nut.stl")] };
    expect(partsInStep(s).map(g => g.part.name)).toEqual(["a", "b"]);
  });
});

describe("turnedFromDefault", () => {
  it("measures the turn from the chosen view", () => {
    expect(viewAngle([1, 0, 0], [0, 1, 0])).toBeCloseTo(90);
    const model = { version: 1 as const, stamp: 1, parts: [], views: [{ id: "v1", name: "Front left", camera: { direction: [1, -1, 0.8] as [number, number, number], target: [0, 0, 0] as [number, number, number], size: 50 } }], defaultView: "v1" };
    const s = blankScene();
    s.camera.direction = [1, -1, 0.8];
    expect(turnedFromDefault(s, model)).toBeCloseTo(0);
    s.camera.direction = [-1, -1, 0.8];
    expect(turnedFromDefault(s, model)).toBeGreaterThan(60);
    expect(turnedFromDefault(s, { ...model, defaultView: undefined })).toBeNull();
  });
});
