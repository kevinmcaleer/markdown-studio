import { describe, expect, it } from "vitest";
import { nextStepDoc, duplicateStepDoc, staleScenes, hasScene, blankDoc } from "../doc";
import { behindModel, blankScene, followModel, modelOf, normalizeModel, normalizeScene, partsDiffer, type ScenePart } from "./model";

const part = (id: string, over: Partial<ScenePart> = {}): ScenePart => ({ id, name: id, url: `/m/${id}.stl`, position: [0, 0, 0], rotation: [0, 0, 0], ...over });

describe("the project model", () => {
  it("keeps only what parts are, not what a scene shows", () => {
    const scene = { ...blankScene(), parts: [part("a", { hidden: true, ghost: true }), part("b", { highlight: true })] };
    const m = modelOf(scene, 5);
    expect(m.stamp).toBe(5);
    expect(m.parts[0]).toEqual(part("a"));
    expect(partsDiffer(m.parts, scene.parts)).toBe(false);
    expect(partsDiffer(m.parts, [part("a", { position: [1, 0, 0] }), part("b")])).toBe(true);
  });

  it("normalizes, and refuses what isn't one", () => {
    expect(normalizeModel(null)).toBeNull();
    expect(normalizeModel({ stamp: "x" })).toBeNull();
    const m = normalizeModel({ stamp: 3, parts: [{ id: "a", name: "A", hidden: true }] })!;
    expect(m.stamp).toBe(3);
    expect(m.parts[0].hidden).toBeUndefined();
  });

  it("a scene follows the model, keeping what it shows; new parts start hidden", () => {
    const scene = { ...blankScene(), model: { stamp: 1 }, parts: [part("a", { ghost: true }), part("gone")] };
    const model = { version: 1 as const, stamp: 2, parts: [part("a", { position: [5, 0, 0] }), part("new")] };
    const s = followModel(scene, model);
    expect(s.parts.map(p => p.id)).toEqual(["a", "new"]);
    expect(s.parts[0]).toMatchObject({ ghost: true, position: [5, 0, 0] });
    expect(s.parts[1].hidden).toBe(true);
    expect(s.model).toEqual({ stamp: 2 });
    expect(s.camera).toEqual(scene.camera);
    // A scene not yet using the model shows all of it.
    expect(followModel(blankScene(), model).parts.every(p => !p.hidden)).toBe(true);
  });

  it("knows when a scene is behind, and keeps model through normalizeScene", () => {
    const s = normalizeScene({ ...blankScene(), model: { stamp: 4 } });
    expect(s.model).toEqual({ stamp: 4 });
    expect(behindModel(s, { stamp: 5 })).toBe(true);
    expect(behindModel(s, { stamp: 4 })).toBe(false);
    expect(behindModel(blankScene(), { stamp: 9 })).toBe(false);
  });
});

describe("documents with scenes", () => {
  const doc = () => ({
    ...blankDoc(),
    title: "Step 2",
    objects: [
      { type: "SceneLayer", scene: { ...blankScene(), model: { stamp: 1 }, parts: [part("a", { highlight: true }), part("b", { hidden: true })] } },
      { type: "Group", badge: 2, name: "Step 2", objects: [{ type: "Circle" }, { type: "Text", text: "2", fontSize: 44 }] },
    ],
  });

  it("counts stale scenes", () => {
    expect(hasScene(doc())).toBe(true);
    expect(hasScene(blankDoc())).toBe(false);
    expect(staleScenes(doc(), 2)).toBe(1);
    expect(staleScenes(doc(), 1)).toBe(0);
  });

  it("makes the next step: shown parts ghosted, numbers up", () => {
    const d = nextStepDoc(doc());
    const parts = (d.objects[0] as { scene: { parts: ScenePart[] } }).scene.parts;
    expect(parts[0]).toMatchObject({ ghost: true, explode: 0 });
    expect(parts[0].highlight).toBeUndefined();
    expect(parts[1].ghost).toBeUndefined();
    const g = d.objects[1] as { badge: number; name: string; objects: { text?: string }[] };
    expect(g.badge).toBe(3);
    expect(g.name).toBe("Step 3");
    expect(g.objects[1].text).toBe("3");
    expect(d.title).toBe("Step 3");
  });

  it("duplicates a step: the same scene, its own copy, numbers up", () => {
    const src = doc();
    const before = JSON.stringify(src);
    const d = duplicateStepDoc(src);
    const parts = (d.objects[0] as { scene: { parts: ScenePart[] } }).scene.parts;
    const was = (src.objects[0] as { scene: { parts: ScenePart[] } }).scene.parts;
    expect(parts).toEqual(was);
    expect(parts[0]).not.toBe(was[0]);
    parts[0].hidden = true;
    expect(JSON.stringify(src)).toBe(before);
    const g = d.objects[1] as { badge: number; name: string; objects: { text?: string }[] };
    expect(g.badge).toBe(3);
    expect(g.name).toBe("Step 3");
    expect(g.objects[1].text).toBe("3");
    expect(d.title).toBe("Step 3");
  });
});

describe("stepBadge", () => {
  it("finds the step number and whether it follows its place", async () => {
    const { stepBadge, blankDoc } = await import("../doc");
    expect(stepBadge(blankDoc())).toBeNull();
    expect(stepBadge({ ...blankDoc(), objects: [{ type: "Group", badge: 3 }] })).toEqual({ last: 3, auto: 3 });
    expect(stepBadge({ ...blankDoc(), objects: [{ type: "Group", badge: 3, badgePinned: true }] })).toEqual({ last: 3, auto: null });
    expect(stepBadge({ ...blankDoc(), objects: [{ type: "Group", badge: 1 }, { type: "Group", badge: 2 }] })).toEqual({ last: 2, auto: null });
  });
});
