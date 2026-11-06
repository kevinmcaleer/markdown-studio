import { describe, expect, it } from "vitest";
import { fixingOwners, normalizeSteps, planSteps, readyToFit, stepOfParts, stepWarnings, suggestSteps, tidySteps } from "./buildSteps";
import { guideTools, normalizeGuide } from "./stepsSpec";
import { normalizeModel, type ScenePart } from "./model";

const part = (id: string, name: string, parent?: string, extra: Partial<ScenePart> = {}): ScenePart => ({ id, name, position: [0, 0, 0], rotation: [0, 0, 0], ...(parent ? { parent } : {}), ...extra });
const parts: ScenePart[] = [
  part("base", "base plate"),
  part("s1", "M3 screw", "base"),
  part("mount", "motor mount", "base"),
  part("s2", "M3 screw", "mount"),
  part("motor", "motor", "mount"),
  part("wheel", "wheel", "motor"),
  part("lid", "lid", "base"),
  part("loose", "spare nut"),
];
const small = new Set(["s1", "s2", "loose"]);
const fixing = (p: ScenePart) => small.has(p.id);
const shape = (plan: ReturnType<typeof planSteps>) => plan.map(s => ({ n: s.n, added: s.added.map(p => p.id), fixings: s.fixings.map(p => p.id), ...(s.title ? { title: s.title } : {}) }));

describe("normalizeSteps", () => {
  it("keeps each part in the first step that has it, and gives every step an id", () => {
    expect(normalizeSteps([{ id: "a", parts: ["x", "y"] }, { id: "a", parts: ["y", "z", 4], title: "  Lid  " }, "junk"])).toEqual([
      { id: "a", parts: ["x", "y"] },
      { id: "s2", parts: ["z"], title: "Lid" },
    ]);
  });
  it("is empty for anything that isn't a list", () => {
    expect(normalizeSteps({})).toEqual([]);
  });
});

describe("tidySteps", () => {
  it("drops parts gone from the model and views no longer saved", () => {
    expect(tidySteps([{ id: "a", parts: ["base", "gone"], view: "v9" }], parts, [{ id: "v1" }])).toEqual([{ id: "a", parts: ["base"] }]);
  });
});

describe("normalizeModel", () => {
  it("keeps the model's steps, tidied", () => {
    const m = normalizeModel({ version: 1, stamp: 2, parts, steps: [{ id: "a", parts: ["base", "nope"] }, { id: "b", parts: [] }] });
    expect(m?.steps).toEqual([{ id: "a", parts: ["base"] }, { id: "b", parts: [] }]);
  });
});

describe("fixingOwners", () => {
  it("finds the part each fixing goes with", () => {
    expect([...fixingOwners(parts, fixing)]).toEqual([["s1", "base"], ["s2", "mount"], ["loose", undefined]]);
  });
});

describe("planSteps", () => {
  it("fits the parts of each step, fixings with their part, and a step at the end for each part left out", () => {
    const steps = [
      { id: "a", parts: ["base", "lid"], title: "Base and lid" },
      { id: "b", parts: [] },
      { id: "c", parts: ["mount", "motor"] },
    ];
    expect(shape(planSteps({ parts, steps }, fixing))).toEqual([
      { n: 1, added: ["base", "lid"], fixings: ["s1", "loose"], title: "Base and lid" },
      { n: 2, added: ["mount", "motor"], fixings: ["s2"] },
      { n: 3, added: ["wheel"], fixings: [] },
    ]);
  });
  it("puts a fixing in the step it was picked for, not its part's", () => {
    const steps = [{ id: "a", parts: ["base", "mount", "motor", "wheel", "lid"] }, { id: "b", parts: ["s2"] }];
    expect(shape(planSteps({ parts, steps }, fixing))).toEqual([
      { n: 1, added: ["base", "mount", "motor", "wheel", "lid"], fixings: ["s1", "loose"] },
      { n: 2, added: [], fixings: ["s2"] },
    ]);
  });
  it("leaves out wires and the piece a track is made from", () => {
    const more = [...parts, part("w", "wire", undefined, { wire: { from: { part: "base", point: [0, 0, 0], normal: [0, 0, 1] }, to: { part: "lid", point: [0, 0, 0], normal: [0, 0, 1] } } as never })];
    const plan = planSteps({ parts: more, steps: [{ id: "a", parts: ["base", "mount", "motor", "wheel", "lid"] }] }, fixing);
    expect(plan.flatMap(s => s.added.map(p => p.id))).not.toContain("w");
  });
});

describe("suggestSteps", () => {
  it("makes the joint tree's steps, fixings left to follow their part", () => {
    expect(suggestSteps({ parts }, fixing).map(s => s.parts)).toEqual([["base", "mount"], ["motor"], ["wheel"], ["lid"]]);
  });
});

describe("stepOfParts", () => {
  it("puts each part in its step, fixings with their part, loose fixings first, and leaves the rest out", () => {
    const at = stepOfParts(parts, [{ id: "a", parts: ["base"] }, { id: "b", parts: ["mount"] }], fixing);
    expect([...at]).toEqual([["base", 0], ["s1", 0], ["mount", 1], ["s2", 1], ["loose", 0]]);
  });
});

describe("stepWarnings", () => {
  it("names a part joined to one fitted in a later step, or in none", () => {
    const at = stepOfParts(parts, [{ id: "a", parts: ["base"] }, { id: "b", parts: ["motor", "wheel"] }, { id: "c", parts: ["mount"] }], fixing);
    expect(stepWarnings(parts, at, 1)).toEqual([{ part: "motor", needs: "mount", later: 2 }]);
    expect(stepWarnings(parts, at, 2)).toEqual([]);
    const some = stepOfParts(parts, [{ id: "a", parts: ["motor"] }], fixing);
    expect(stepWarnings(parts, some, 0)).toEqual([{ part: "motor", needs: "mount", later: -1 }]);
  });
});

describe("readyToFit", () => {
  it("lets a part on only once what it's joined to is fitted", () => {
    expect(readyToFit(parts[2], new Set(), parts)).toBe(false);
    expect(readyToFit(parts[2], new Set(["base"]), parts)).toBe(true);
    expect(readyToFit(parts[0], new Set(), parts)).toBe(true);
  });
});

describe("guide tools", () => {
  it("keeps tools tidy: trimmed, no repeats, at most 12", () => {
    expect(normalizeGuide(undefined)).toBeUndefined();
    expect(normalizeGuide({})).toBeUndefined();
    expect(normalizeGuide({ tools: [" pliers ", "Pliers", 3, "", "wire  cutters"] })).toEqual({ tools: ["pliers", "wire cutters"] });
    expect(normalizeGuide({ tools: Array.from({ length: 20 }, (_, i) => `t${i}`) })!.tools).toHaveLength(12);
    expect(normalizeGuide({ tools: [] })).toEqual({ tools: [] });
  });
  it("lists the default three when none are set, symbols for the ones it knows", () => {
    expect(guideTools().map(t => t.kind)).toEqual(["screwdriver", "allen-key", "pliers"]);
    expect(guideTools({ tools: ["soldering-iron", "hammer", "Wire cutters"] })).toEqual([
      { kind: "soldering-iron", label: "Soldering iron" },
      { kind: "hammer", label: "Hammer" },
      { label: "Wire cutters" },
    ]);
    expect(guideTools({ tools: [] })).toEqual([]);
  });
  it("is kept in the project's model", () => {
    const m = normalizeModel({ version: 1, stamp: 1, parts: [{ id: "a", name: "A" }], guide: { tools: ["pliers"] } });
    expect(m!.guide).toEqual({ tools: ["pliers"] });
  });
});
