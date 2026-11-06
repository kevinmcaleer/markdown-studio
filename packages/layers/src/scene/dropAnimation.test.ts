import { describe, expect, it } from "vitest";
import { DROP_BOUNCES, DROP_TIMING, dropFrames, dropHeight, dropLift, dropOrder, dropPlan, liftsAt, settleTime, type PartSpan } from "./dropAnimation";
import type { ScenePart } from "./model";

const part = (id: string, extra: Partial<ScenePart> = {}): ScenePart => ({ id, name: id, position: [0, 0, 0], rotation: [0, 0, 0], ...extra });
const spans = (o: Record<string, number>) => new Map<string, PartSpan>(Object.entries(o).map(([k, lo]) => [k, { lo, hi: lo + 10 }]));

describe("dropOrder", () => {
  it("builds up from the bottom", () => {
    const parts = [part("top"), part("base"), part("middle")];
    expect(dropOrder(parts, spans({ top: 40, base: 0, middle: 20 }))).toEqual([["base"], ["middle"], ["top"]]);
  });

  it("never drops a part before the part it's joined to", () => {
    // The wheel hangs below the chassis it's on, but the chassis comes first.
    const parts = [part("chassis"), part("wheel", { parent: "chassis" })];
    expect(dropOrder(parts, spans({ chassis: 10, wheel: -5 }))).toEqual([["chassis"], ["wheel"]]);
  });

  it("drops matching parts on the same part together", () => {
    const parts = [part("plate"), part("s1", { parent: "plate", url: "/m/screw.stl" }), part("s2", { parent: "plate", url: "/m/screw.stl" }), part("motor", { parent: "plate", url: "/m/motor.stl" })];
    expect(dropOrder(parts, spans({ plate: 0, s1: 5, s2: 6, motor: 8 }))).toEqual([["plate"], ["s1", "s2"], ["motor"]]);
  });

  it("drops matching parts on matching parts together (a wheel on each motor)", () => {
    const parts = [part("base"), part("m1", { parent: "base", url: "/m.stl" }), part("m2", { parent: "base", url: "/m.stl" }), part("w1", { parent: "m1", url: "/w.stl" }), part("w2", { parent: "m2", url: "/w.stl" })];
    expect(dropOrder(parts, spans({ base: 10, m1: 0, m2: 0, w1: 0, w2: 0 }))).toEqual([["base"], ["m1", "m2"], ["w1", "w2"]]);
  });

  it("follows the build steps when there are some", () => {
    const parts = [part("base"), part("arm", { parent: "base" }), part("screw", { parent: "arm", url: "/s.stl" }), part("lid", { parent: "base" })];
    // The lid is put in step 0, the arm in step 1; the arm's screw goes with it.
    const order = dropOrder(parts, spans({ base: 0, arm: 5, screw: 6, lid: 30 }), new Map([["base", 0], ["lid", 0], ["arm", 1]]));
    expect(order).toEqual([["base"], ["lid"], ["arm"], ["screw"]]);
  });
});

describe("dropLift", () => {
  const height = 300;
  const size = 50;

  it("starts at the top and speeds up as it falls", () => {
    expect(dropLift(0, height, size)).toBe(height);
    const a = height - dropLift(0.1, height, size);
    const b = dropLift(0.1, height, size) - dropLift(0.2, height, size);
    expect(b).toBeGreaterThan(a);
    expect(dropLift(DROP_TIMING.fall, height, size)).toBeCloseTo(0, 6);
  });

  it("bounces, lower each time, then stops where it fits", () => {
    const peaks: number[] = [];
    let last = 0;
    let rising = false;
    for (let t = DROP_TIMING.fall; t < 2; t += 0.002) {
      const z = dropLift(t, height, size);
      expect(z).toBeGreaterThanOrEqual(0);
      if (z < last && rising) peaks.push(last);
      rising = z > last;
      last = z;
    }
    expect(peaks.length).toBe(DROP_BOUNCES.length);
    peaks.forEach((p, i) => expect(p).toBeCloseTo(DROP_BOUNCES[i] * size, 0));
    expect(dropLift(settleTime(DROP_TIMING, height, size) + 0.01, height, size)).toBe(0);
  });
});

describe("dropHeight", () => {
  it("is out of the picture, more so looking down on the model", () => {
    expect(dropHeight([0, -1, 0], 50)).toBeCloseTo(115);
    expect(dropHeight([1, -1, 1], 50)).toBeGreaterThan(dropHeight([0, -1, 0], 50));
  });
});

describe("dropPlan and dropFrames", () => {
  it("staggers each set, quicker with many parts", () => {
    const few = dropPlan([["a"], ["b"], ["c"]]);
    expect(few.starts).toEqual([DROP_TIMING.empty, DROP_TIMING.empty + DROP_TIMING.gap, DROP_TIMING.empty + 2 * DROP_TIMING.gap]);
    const many = dropPlan(Array.from({ length: 61 }, (_, i) => [`p${i}`]));
    expect(many.starts[60] - many.starts[0]).toBeCloseTo(DROP_TIMING.maxGaps);
  });

  it("goes empty, falling, then the finished model held", () => {
    const plan = dropPlan([["a"], ["b"]], DROP_TIMING, 1);
    const frames = dropFrames(plan, 10);
    expect(frames[0]).toEqual({ t: 0, delay: DROP_TIMING.empty * 1000 });
    expect(frames[frames.length - 1]).toEqual({ t: plan.settled, delay: DROP_TIMING.hold * 1000 });
    frames.slice(1).forEach((f, i) => expect(f.t).toBeGreaterThan(frames[i].t));
  });

  it("hides a part until it sets off, then lifts it", () => {
    const plan = dropPlan([["a"], ["b", "c"]], DROP_TIMING, 1);
    const early = liftsAt(plan, plan.starts[1] - 0.01, 200, 50);
    expect(early.get("a")).toBeGreaterThan(0);
    expect(early.get("b")).toBeNull();
    const late = liftsAt(plan, plan.settled, 200, 50);
    expect([...late.values()]).toEqual([0, 0, 0]);
  });
});
