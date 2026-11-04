import { describe, expect, it } from "vitest";
import { coverScene, guideSteps, stepScene, stepTitle, treeOrder } from "./guide";
import { blankScene, type ScenePart } from "./model";

const part = (id: string, name: string, parent?: string): ScenePart => ({ id, name, position: [0, 0, 0], rotation: [0, 0, 0], ...(parent ? { parent } : {}) });
const parts: ScenePart[] = [
  part("base", "base plate"),
  part("s1", "M3 screw", "base"),
  part("mount", "motor mount", "base"),
  part("s2", "M3 screw", "mount"),
  part("s3", "M3 screw", "mount"),
  part("motor", "motor", "mount"),
  part("wheel", "wheel", "motor"),
  part("loose", "spare nut"),
];
const small = new Set(["s1", "s2", "s3", "loose"]);
const fixing = (p: ScenePart) => small.has(p.id);

describe("treeOrder", () => {
  it("walks each root and its children depth first, in model order", () => {
    expect(treeOrder(parts).map(p => p.id)).toEqual(["base", "s1", "mount", "s2", "s3", "motor", "wheel", "loose"]);
  });
  it("treats a part whose parent is missing as a root, and never loses a loop", () => {
    const loop = [part("a", "a", "b"), part("b", "b", "a"), part("c", "c", "gone")];
    expect(treeOrder(loop).map(p => p.id).sort()).toEqual(["a", "b", "c"]);
  });
});

describe("guideSteps", () => {
  it("fits one part per step, the second onto the first, with fixings beside their part", () => {
    const steps = guideSteps({ parts }, fixing);
    expect(steps.map(s => ({ n: s.n, added: s.added.map(p => p.id), fixings: s.fixings.map(p => p.id) }))).toEqual([
      { n: 1, added: ["base", "mount"], fixings: ["s1", "s2", "s3", "loose"] },
      { n: 2, added: ["motor"], fixings: [] },
      { n: 3, added: ["wheel"], fixings: [] },
    ]);
  });
  it("has no steps when every part is a fixing", () => {
    expect(guideSteps({ parts: [part("a", "nut")] }, () => true)).toEqual([]);
  });
  it("leaves hidden parts out", () => {
    const steps = guideSteps({ parts: [part("a", "a"), { ...part("b", "b", "a"), hidden: true }, part("c", "c", "a")] }, () => false);
    expect(steps.map(s => s.added.map(p => p.id))).toEqual([["a", "c"]]);
  });
});

describe("stepScene", () => {
  const steps = guideSteps({ parts }, fixing);
  const cam = blankScene().camera;
  const style = blankScene().style;
  it("highlights and explodes the step's parts, ghosts earlier ones and hides later ones", () => {
    const s = stepScene({ parts }, steps, 2, cam, style);
    const by = Object.fromEntries(s.parts.map(p => [p.id, p]));
    expect(by.motor).toMatchObject({ highlight: true, explode: 1 });
    expect(by.motor.ghost).toBeUndefined();
    expect(by.base).toMatchObject({ ghost: true, highlight: false, explode: 0 });
    expect(by.s2).toMatchObject({ ghost: true });
    expect(by.wheel.hidden).toBe(true);
    expect(s.explode).toBe(0);
    expect(s.camera).toEqual(cam);
  });
  it("drops what the model's parts showed before", () => {
    const shown: ScenePart[] = [{ ...part("a", "a"), ghost: true, highlight: true }, { ...part("b", "b", "a"), hidden: true }];
    const s = stepScene({ parts: shown }, guideSteps({ parts: shown }, () => false), 1, cam, style);
    expect(s.parts[0]).toMatchObject({ highlight: true, explode: 1 });
    expect(s.parts[0].ghost).toBeUndefined();
  });
  it("covers with everything fitted and nothing highlighted", () => {
    const c = coverScene({ parts }, cam, style);
    expect(c.parts).toHaveLength(8);
    expect(c.parts.every(p => p.highlight === false && p.explode === 0 && !p.ghost && !p.hidden)).toBe(true);
  });
});

describe("stepTitle", () => {
  const steps = guideSteps({ parts }, fixing);
  it("names the parts fitted", () => {
    expect(stepTitle(steps[0])).toBe("Base plate and motor mount");
    expect(stepTitle(steps[1])).toBe("Motor");
    expect(stepTitle({ n: 1, added: [part("a", "leg"), part("b", "leg"), part("c", "foot"), part("d", "toe")], fixings: [] })).toBe("Leg and 2 more");
  });
});
