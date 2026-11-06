import { describe, expect, it } from "vitest";
import { partJoints } from "./jointList";
import type { ScenePart } from "./model";

const part = (id: string, over: Partial<ScenePart> = {}): ScenePart => ({ id, name: id, position: [0, 0, 0], rotation: [0, 0, 0], ...over });
const joint = { normal: [0, 0, 1] as [number, number, number], distance: 10, point: [0, 0, 0] as [number, number, number] };

describe("partJoints", () => {
  const parts = [
    part("chassis"),
    part("battery", { parent: "chassis", joint }),
    part("wheel", { parent: "chassis", joint: { ...joint, type: "revolute" }, explode: 0 }),
    part("tyre", { parent: "wheel", joint: { ...joint, type: "prismatic" } }),
    part("lead", { parent: "chassis", joint, wire: { color: "#f00" } as ScenePart["wire"] }),
    part("loose"),
  ];

  it("lists the parts joined to a part, in order", () => {
    const js = partJoints(parts, "chassis");
    expect(js.map(j => [j.id, j.role, j.other.id, j.type, j.explodes])).toEqual([
      ["battery", "holds", "battery", "fixed", true],
      ["wheel", "holds", "wheel", "revolute", false],
    ]);
  });

  it("puts a part's own joint first, then the ones on it", () => {
    const js = partJoints(parts, "wheel");
    expect(js.map(j => [j.id, j.role, j.other.id, j.type])).toEqual([
      ["wheel", "on", "chassis", "revolute"],
      ["tyre", "holds", "tyre", "prismatic"],
    ]);
  });

  it("has nothing for a part on its own, a wire or a missing id", () => {
    expect(partJoints(parts, "loose")).toEqual([]);
    expect(partJoints(parts, "lead")).toEqual([]);
    expect(partJoints(parts, "nope")).toEqual([]);
  });

  it("calls a joint without picked faces fixed, and skips a missing parent", () => {
    const ps = [part("a"), part("b", { parent: "a", joint: { normal: [0, 0, 1], distance: 5, type: "revolute" } }), part("c", { parent: "gone", joint })];
    expect(partJoints(ps, "b")[0].type).toBe("fixed");
    expect(partJoints(ps, "c")).toEqual([]);
  });
});
