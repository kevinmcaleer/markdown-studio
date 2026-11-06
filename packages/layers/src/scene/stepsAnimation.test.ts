import { describe, expect, it } from "vitest";
import { STEPS_TIMING, stepsFrames } from "./stepsAnimation";

describe("stepsFrames", () => {
  it("shows each step apart, then puts it together, ending on the finished model", () => {
    const frames = stepsFrames(3, 10);
    expect(new Set(frames.map(f => f.step))).toEqual(new Set([0, 1, 2]));
    for (const step of [0, 1, 2]) {
      const mine = frames.filter(f => f.step === step);
      expect(mine.find(f => f.glide === 1)!.explode).toBe(1);
      expect(mine[mine.length - 1].explode).toBe(0);
    }
    // The finished model held, then once more so a player shows the hold in full.
    expect(frames[frames.length - 2]).toMatchObject({ step: 2, explode: 0, glide: 1, delay: STEPS_TIMING.end * 1000 });
    expect(frames[frames.length - 1]).toMatchObject({ step: 2, explode: 0, delay: 100 });
  });

  it("glides the view only between steps, never into the first", () => {
    const frames = stepsFrames(2, 10);
    expect(frames.filter(f => f.step === 0).every(f => f.glide === 1)).toBe(true);
    const glide = frames.filter(f => f.step === 1 && f.glide < 1);
    expect(glide.length).toBe(Math.round(STEPS_TIMING.glide * 10) - 1);
    expect(glide.every(f => f.explode === 1)).toBe(true);
  });

  it("lasts about as long as Play steps", () => {
    const t = STEPS_TIMING;
    const ms = stepsFrames(4, 24).reduce((a, f) => a + f.delay, 0);
    const want = 4 * (t.hold + t.move) + 3 * (t.glide + t.rest) + t.end + 1 / 24;
    expect(Math.abs(ms / 1000 - want)).toBeLessThan(0.1);
  });
});
