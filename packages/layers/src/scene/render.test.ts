import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { worldMatrices } from "./render";
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
