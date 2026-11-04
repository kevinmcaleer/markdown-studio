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
});
