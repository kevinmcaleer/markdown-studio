import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { followModel, normalizeScene, normalizeSection, sectionKeeps, sectionOrigin, type SectionPlane } from "./model";
import { clipPlane } from "./render";

describe("section view", () => {
  const s: SectionPlane = { point: [0, 0, 10], normal: [0, 0, 1], offset: -4 };

  it("keeps a section through normalizeScene, and drops a broken one", () => {
    expect(normalizeScene({ section: { point: [1, 2, 3], normal: [0, 0, 2], offset: 5, plain: true } }).section).toEqual({ point: [1, 2, 3], normal: [0, 0, 1], offset: 5, plain: true });
    expect(normalizeScene({ section: { point: [1, 2, 3], normal: [0, 0, 0] } }).section).toBeUndefined();
    expect(normalizeScene({}).section).toBeUndefined();
    expect(normalizeSection({ normal: [1, 0, 0], offset: "x" })).toEqual({ point: [0, 0, 0], normal: [1, 0, 0], offset: 0 });
  });

  it("slides the plane along the face's normal and cuts away the normal's side", () => {
    expect(sectionOrigin(s)).toEqual([0, 0, 6]);
    expect(sectionKeeps(s, [5, 5, 5])).toBe(true);
    expect(sectionKeeps(s, [0, 0, 6])).toBe(true);
    expect(sectionKeeps(s, [0, 0, 7])).toBe(false);
    expect(sectionKeeps(undefined, [0, 0, 100])).toBe(true);
  });

  it("clips with three.js on the same side as sectionKeeps", () => {
    const p = clipPlane({ point: [3, 0, 0], normal: [1, 0, 0], offset: 2 });
    // three keeps what lies on its plane's positive side.
    expect(p.distanceToPoint(new Vector3(4, 0, 0))).toBeGreaterThan(0);
    expect(p.distanceToPoint(new Vector3(6, 0, 0))).toBeLessThan(0);
  });

  it("is the scene's own: following the project model keeps it", () => {
    const scene = normalizeScene({ parts: [{ id: "a", name: "A" }], section: s });
    const out = followModel({ ...scene, model: { stamp: 1 } }, { version: 1, stamp: 2, parts: [{ id: "a", name: "A", position: [0, 0, 0], rotation: [0, 0, 0] }] });
    expect(out.section).toEqual(s);
  });
});
