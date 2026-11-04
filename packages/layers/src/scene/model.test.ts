import { describe, expect, it } from "vitest";
import { applyPreset, blankScene, newPartId, normalizeScene, partName, placeBeside, wrapAngle } from "./model";

describe("normalizeScene", () => {
  it("gives a blank scene for nonsense", () => {
    expect(normalizeScene(null)).toEqual(blankScene());
    expect(normalizeScene("x").parts).toEqual([]);
  });

  it("keeps parts and puts out-of-range values right", () => {
    const s = normalizeScene({
      parts: [{ id: "a", name: "Base", url: "/m/base.stl", position: [1, 2, "x"], rotation: [190, -540, 45], highlight: 1 }],
      camera: { direction: [0, 0, 0], target: [1, 2, 3], size: -4 },
      style: { fill: "red", line: "#000", outline: 99, crease: 0 },
      explode: 3,
    });
    expect(s.parts[0]).toEqual({ id: "a", name: "Base", url: "/m/base.stl", position: [1, 2, 0], rotation: [-170, -180, 45], highlight: true });
    expect(s.camera.direction).toEqual(blankScene().camera.direction);
    expect(s.camera.size).toBe(1);
    expect(s.style.fill).toBe("#ffffff");
    expect(s.style.line).toBe("#000");
    expect(s.style.outline).toBe(20);
    expect(s.style.crease).toBe(1);
    expect(s.explode).toBe(1);
  });

  it("drops joins to missing parts and loops", () => {
    const s = normalizeScene({
      parts: [
        { id: "a", parent: "b" },
        { id: "b", parent: "a", joint: { normal: [0, 0, 0], distance: 20 } },
        { id: "c", parent: "zz" },
        { id: "d", parent: "a" },
      ],
    });
    const by = Object.fromEntries(s.parts.map(p => [p.id, p]));
    expect(by.a.parent === undefined || by.b.parent === undefined).toBe(true);
    expect(by.c.parent).toBeUndefined();
    expect(by.d.parent).toBe("a");
    expect(by.b.joint).toEqual({ normal: [0, 0, 1], distance: 20 });
  });
});

describe("helpers", () => {
  it("wraps angles to -180..180", () => {
    expect(wrapAngle(0)).toBe(0);
    expect(wrapAngle(181)).toBe(-179);
    expect(wrapAngle(-180)).toBe(-180);
    expect(wrapAngle(720 + 90)).toBe(90);
  });

  it("names parts from files", () => {
    expect(partName("/files/left_wheel-2.STL?v=3")).toBe("left wheel 2");
    expect(partName(".stl")).toBe("Part");
  });

  it("picks an unused id", () => {
    expect(newPartId([])).toBe("p1");
    expect(newPartId([{ id: "p2" }, { id: "p3" }] as never)).toBe("p4");
  });

  it("keeps the highlight colour when changing preset", () => {
    const s = { ...blankScene().style, highlight: "#ff0000" };
    const t = applyPreset(s, "silhouette");
    expect(t.preset).toBe("silhouette");
    expect(t.crease).toBe(180);
    expect(t.highlight).toBe("#ff0000");
    expect(applyPreset(s, "nope")).toBe(s);
  });

  it("places a new part where its file has it unless that overlaps", () => {
    expect(placeBeside([], [5, 5, 5], [10, 10, 10])).toEqual([5, 5, 5]);
    const existing = [{ min: [-10, -10, 0], max: [10, 10, 20] } as never];
    expect(placeBeside(existing, [100, 0, 0], [10, 10, 10])).toEqual([100, 0, 0]);
    expect(placeBeside(existing, [0, 0, 5], [20, 6, 10])).toEqual([10 + 10 + 10, 0, 5]);
  });
});
