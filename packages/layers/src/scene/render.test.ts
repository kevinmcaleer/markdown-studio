import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { pagePoints, stepArrows, worldMatrices } from "./render";
import type { ScenePart } from "./model";

const at = (m: { elements: ArrayLike<number> }, p: [number, number, number]) => new Vector3(...p).applyMatrix4(m as never).toArray().map(n => Math.round(n * 1000) / 1000 + 0);

describe("worldMatrices", () => {
  const parts: ScenePart[] = [
    { id: "base", name: "Base", position: [100, 0, 0], rotation: [0, 0, 90] },
    { id: "arm", name: "Arm", position: [10, 0, 0], rotation: [0, 0, 0], parent: "base", joint: { normal: [0, 0, 1], distance: 50 } },
  ];

  it("turns a part about its middle (roll, pitch, then yaw)", () => {
    const m = worldMatrices([{ id: "a", name: "A", position: [0, 0, 0], rotation: [90, 0, 90] }]).get("a")!;
    // Roll 90 about X takes +Y to +Z; yaw 90 about Z then leaves +Z alone.
    expect(at(m, [0, 1, 0])).toEqual([0, 0, 1]);
    // +X: roll leaves it, yaw takes it to +Y.
    expect(at(m, [1, 0, 0])).toEqual([0, 1, 0]);
  });

  it("puts a joined part in its parent's frame", () => {
    const m = worldMatrices(parts).get("arm")!;
    // 10 along the base's X, which the base's yaw turned to +Y.
    expect(at(m, [0, 0, 0])).toEqual([100, 10, 0]);
  });

  it("explodes a joined part along its joint", () => {
    expect(at(worldMatrices(parts, 0.5).get("arm")!, [0, 0, 0])).toEqual([100, 10, 25]);
    expect(at(worldMatrices(parts, 1).get("base")!, [0, 0, 0])).toEqual([100, 0, 0]);
  });

  it("explodes a joint by its own amount, unless asked where it is assembled", () => {
    const own = parts.map(p => (p.id === "arm" ? { ...p, explode: 1 } : p));
    expect(at(worldMatrices(own, 0).get("arm")!, [0, 0, 0])).toEqual([100, 10, 50]);
    expect(at(worldMatrices(own, 0.5).get("arm")!, [0, 0, 0])).toEqual([100, 10, 50]);
    expect(at(worldMatrices(own, 0, false).get("arm")!, [0, 0, 0])).toEqual([100, 10, 0]);
  });
});

describe("jointPlace", () => {
  it("fits the child's face flush against the parent's, then spins and stands off", async () => {
    const { jointPlace } = await import("./joint");
    // Parent's top face at z = 5; child's bottom face at z = -2 in its own frame.
    const flush = jointPlace({ point: [0, 0, 5], normal: [0, 0, 1], childPoint: [0, 0, -2], childNormal: [0, 0, -1], spin: 0, gap: 0 });
    expect(flush).toEqual({ position: [0, 0, 7], rotation: [0, 0, 0] });
    const off = jointPlace({ point: [0, 0, 5], normal: [0, 0, 1], childPoint: [0, 0, -2], childNormal: [0, 0, -1], spin: 90, gap: 3 });
    expect(off).toEqual({ position: [0, 0, 10], rotation: [0, 0, 90] });
    // A side face meeting a top face turns the child over.
    const side = jointPlace({ point: [0, 0, 5], normal: [0, 0, 1], childPoint: [4, 0, 0], childNormal: [1, 0, 0], spin: 0, gap: 0 });
    const m = worldMatrices([{ id: "c", name: "C", position: side.position, rotation: side.rotation }]).get("c")!;
    expect(at(m, [4, 0, 0])).toEqual([0, 0, 5]);
    expect(at(m, [5, 0, 0])).toEqual([0, 0, 4]);
  });
});

describe("stepArrows", () => {
  const scene = () => ({
    version: 1 as const, explode: 1,
    camera: { direction: [0, -1, 0] as [number, number, number], target: [0, 0, 0] as [number, number, number], size: 100 },
    style: { preset: "line-art", fill: "#fff", line: "#000", lineWidth: 1, outline: 3, crease: 30, highlight: "#9db8f5", ghost: "#aaa" },
    parts: [
      { id: "base", name: "Base", position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] },
      { id: "peg", name: "Peg", position: [0, 0, 10] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], parent: "base", joint: { normal: [0, 0, 1] as [number, number, number], distance: 50, childPoint: [0, 0, 0] as [number, number, number], type: "revolute" as const } },
    ],
  });

  it("puts a scene point on the picture as fractions", () => {
    // Looking from -Y at a 100 mm half-height view: the target is the middle, 50 mm up is the top edge.
    const [mid, top] = pagePoints(scene(), [[0, 0, 0], [0, 0, 100]], 2);
    expect(mid.x).toBeCloseTo(0.5);
    expect(mid.y).toBeCloseTo(0.5);
    expect(top.y).toBeCloseTo(0);
  });

  it("draws an arrow from the exploded part down its joint to where it fits", () => {
    const [a] = stepArrows(scene(), 1);
    expect(a.name).toBe("Peg");
    expect(a.turns).toBe(true);
    // From 60 mm up (10 + 50 exploded) to 10 mm up: downwards on the page.
    expect(a.from.y).toBeLessThan(a.to.y);
    expect(a.to.y - a.from.y).toBeCloseTo(0.25);
  });

  it("gives nothing for ghosts, hidden parts or an assembled scene", () => {
    const s = scene();
    s.explode = 0;
    expect(stepArrows(s, 1)).toEqual([]);
    const g = scene();
    (g.parts[1] as ScenePart).ghost = true;
    expect(stepArrows(g, 1)).toEqual([]);
  });
});
