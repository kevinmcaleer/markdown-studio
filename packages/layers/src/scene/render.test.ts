import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { magnifiedCamera, pagePoints, selectedFill, worldMatrices } from "./render";
import type { ScenePart } from "./model";
import { HIGHLIGHT } from "./model";

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

describe("pagePoints", () => {
  const scene = () => ({
    version: 1 as const, explode: 1,
    camera: { direction: [0, -1, 0] as [number, number, number], target: [0, 0, 0] as [number, number, number], size: 100 },
    style: { preset: "line-art", fill: "#fff", line: "#000", lineWidth: 1, outline: 3, crease: 30, highlight: "#9db8f5", ghost: "#aaa" },
    parts: [],
  });

  it("puts a scene point on the picture as fractions", () => {
    // Looking from -Y at a 100 mm half-height view: the target is the middle, 50 mm up is the top edge.
    const [mid, top] = pagePoints(scene(), [[0, 0, 0], [0, 0, 100]], 2);
    expect(mid.x).toBeCloseTo(0.5);
    expect(mid.y).toBeCloseTo(0.5);
    expect(top.y).toBeCloseTo(0);
  });
});

describe("magnifiedCamera", () => {
  const cam = { direction: [0, -1, 0] as [number, number, number], target: [0, 0, 0] as [number, number, number], size: 50 };
  it("looks from the same side, as many times closer as the zoom, whatever the circle's size", () => {
    const c = magnifiedCamera(cam, { x: 0.5, y: 0.5 }, 2, { w: 800, h: 400 }, { w: 200, h: 200 });
    expect(c.direction).toEqual(cam.direction);
    // The source shows 100 mm over 400 px; the circle shows 200 px at twice that scale: 50 mm, so half that is 25.
    expect(c.size).toBeCloseTo(12.5);
    expect(c.target.map(n => Math.round(n * 1000) / 1000)).toEqual([0, 0, 0]);
  });
  it("centres on the spot: right and up from the picture's middle", () => {
    const c = magnifiedCamera(cam, { x: 1, y: 0 }, 1, { w: 800, h: 400 }, { w: 400, h: 400 });
    // Looking along -Y (from +Y... the camera sits at -Y looking toward +Y): right is -X there, up is +Z.
    expect(Math.abs(c.target[0])).toBeCloseTo(100);
    expect(c.target[2]).toBeCloseTo(50);
    expect(c.size).toBeCloseTo(50);
  });
});

describe("selectedFill", () => {
  const light = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    return ((n >> 16) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114) / 255;
  };

  it("is a clearly darker shade of the highlight, so a picked part stands out in a highlighted branch", () => {
    const sel = selectedFill(HIGHLIGHT);
    expect(sel).not.toBe(HIGHLIGHT);
    expect(light(HIGHLIGHT) - light(sel)).toBeGreaterThan(0.2);
  });

  it("goes lighter instead for an already dark highlight", () => {
    expect(light(selectedFill("#202060"))).toBeGreaterThan(light("#202060"));
  });
});
