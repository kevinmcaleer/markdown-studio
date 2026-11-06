import { Box3, Matrix4, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { explodeVector, stackedSide } from "./explode";
import { normalizeScene, type ScenePart } from "./model";
import { worldMatrices } from "./render";

const near = (v: Vector3, want: [number, number, number]) => v.toArray().forEach((x, i) => expect(x).toBeCloseTo(want[i], 6));

describe("explodeVector", () => {
  it("goes along the joint by default, or the other way", () => {
    near(explodeVector({ normal: [0, 2, 0] }), [0, 1, 0]);
    near(explodeVector({ normal: [0, 1, 0], explodeDir: "joint" }), [0, 1, 0]);
    near(explodeVector({ normal: [0, 1, 0], explodeDir: "reverse" }), [0, -1, 0]);
  });

  it("keeps a world axis that axis however the parent is turned", () => {
    // Parent turned a quarter about x: its own +y is the world's +z.
    const parent = new Matrix4().makeRotationX(Math.PI / 2).setPosition(5, 6, 7);
    const local = explodeVector({ normal: [1, 0, 0], explodeDir: "+z" }, parent);
    near(local.clone().transformDirection(parent), [0, 0, 1]);
    near(local, [0, 1, 0]);
  });
});

describe("worldMatrices with an explode direction", () => {
  it("slides the part the way its joint says", () => {
    const parts: ScenePart[] = [
      { id: "a", name: "a", position: [0, 0, 0], rotation: [90, 0, 0] },
      { id: "b", name: "b", position: [0, 0, 0], rotation: [0, 0, 0], parent: "a", joint: { normal: [1, 0, 0], distance: 10, explodeDir: "+z" } },
    ];
    const m = worldMatrices(parts, 1).get("b")!;
    near(new Vector3().setFromMatrixPosition(m), [0, 0, 10]);
  });
});

describe("stackedSide", () => {
  it("finds the side a part sits on, and none when it's inside", () => {
    const board = new Box3(new Vector3(-25, -15, 0), new Vector3(25, 15, 2));
    expect(stackedSide(new Box3(new Vector3(-25, -15, 3), new Vector3(25, 15, 13)), board)).toBe("+z");
    expect(stackedSide(new Box3(new Vector3(25, -5, 0), new Vector3(35, 5, 2)), board)).toBe("+x");
    const tub = new Box3(new Vector3(-30, -20, 0), new Vector3(30, 20, 20));
    expect(stackedSide(new Box3(new Vector3(-20, -10, 2), new Vector3(20, 10, 4)), tub)).toBeNull();
  });
});

describe("explodeDir in a saved scene", () => {
  it("keeps a known way and drops a made-up one", () => {
    const scene = normalizeScene({
      parts: [
        { id: "a", name: "a", position: [0, 0, 0], rotation: [0, 0, 0] },
        { id: "b", name: "b", position: [0, 0, 0], rotation: [0, 0, 0], parent: "a", joint: { normal: [0, 0, 1], distance: 5, explodeDir: "+x", explodeAuto: true } },
        { id: "c", name: "c", position: [0, 0, 0], rotation: [0, 0, 0], parent: "a", joint: { normal: [0, 0, 1], distance: 5, explodeDir: "sideways" } },
      ],
    });
    expect(scene.parts[1].joint).toMatchObject({ explodeDir: "+x", explodeAuto: true });
    expect(scene.parts[2].joint?.explodeDir).toBeUndefined();
  });
});
