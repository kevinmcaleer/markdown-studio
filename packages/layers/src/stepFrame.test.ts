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

  it("counts a track as its pieces", () => {
    const track = { link: "l", count: 32, start: [0, 0, 0], end: [1, 0, 0], axis: [0, 1, 0], wheels: [], offset: 0, lift: 0, side: 0 };
    const s = { ...blankScene(), parts: [part("l", "link.stl", { hidden: true }), part("t", "", { data: "m1:x", track, highlight: true }), part("u", "", { data: "m1:y", track: { ...track, count: 30 }, highlight: true })] };
    expect(partsInStep(s).map(g => [g.part.name, g.count])).toEqual([["l", 62]]);
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

describe("fixings and the inventory", () => {
  it("counts small parts as fixings by their middle dimension", async () => {
    const { isFastener, inventoryOf } = await import("./stepFrame");
    expect(isFastener([5.5, 5.5, 20])).toBe(true); // an M3 screw, 20 long
    expect(isFastener([7, 7, 2.4])).toBe(true); // a nut
    expect(isFastener([40, 40, 3])).toBe(false); // a plate
    expect(isFastener([3, 60, 3])).toBe(true); // an axle
    const list = inventoryOf([part("a", "plate.stl", { hidden: true }), part("b", "screw.stl", { ghost: true }), part("c", "screw.stl"), part("d", "plate.stl")]);
    expect(list.map(g => [g.part.url, g.count])).toEqual([["plate.stl", 2], ["screw.stl", 2]]);
    // A track's piece is counted once per piece in it, not as a part of its own.
    const track = { link: "l", count: 32, start: [0, 0, 0], end: [1, 0, 0], axis: [0, 1, 0], wheels: [], offset: 0, lift: 0, side: 0 };
    const withTrack = inventoryOf([part("l", "link.stl", { hidden: true }), part("t", "", { data: "m1:x", track })]);
    expect(withTrack.map(g => [g.part.url, g.count])).toEqual([["link.stl", 32]]);
  });
});

describe("the screw inventory", () => {
  it("counts the screw tool's screws and inserts by kind, inserts last", async () => {
    const { screwInventoryOf } = await import("./stepFrame");
    const screw = (id: string, d: number, length: number, head: string, extra = {}) => ({ id, name: id, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], data: "x", screw: { d, length, head }, ...extra });
    const list = screwInventoryOf([
      screw("a", 3, 5.7, "insert"),
      screw("b", 3, 8, "countersunk"),
      screw("c", 3, 8, "countersunk"),
      part("plate", "plate.stl"),
      screw("d", 2, 6, "pan"),
      screw("e", 3, 5.7, "insert"),
      screw("f", 3, 10, "socket"),
      screw("g", 3, 12, "socket", { hidden: true }),
      screw("h", 2.5, 8, "countersunk"),
    ] as never);
    expect(list.map(g => [g.key, g.count])).toEqual([
      ["socket:3:10", 1],
      ["countersunk:2.5:8", 1],
      ["countersunk:3:8", 2],
      ["pan:2:6", 1],
      ["insert:3:5.7", 2],
    ]);
  });
});
