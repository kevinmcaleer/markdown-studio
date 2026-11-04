import { describe, expect, it } from "vitest";
import { arcArrow, area2, CROSS, CURVED_SOLID, HELP, NO_SIGN, pathOf, ROTATE, TICK } from "./symbols";

const rings = (d: string) =>
  d.split("Z").filter(s => s.trim()).map(s => {
    const n = s.replace(/[ML]/g, " ").trim().split(/\s+/).map(Number);
    const pts = [];
    for (let i = 0; i < n.length; i += 2) pts.push({ x: n[i], y: n[i + 1] });
    return pts;
  });

describe("symbols", () => {
  it("winds filled rings clockwise and holes the other way", () => {
    const sq = [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 0 }];
    const hole = [{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 8 }, { x: 2, y: 8 }];
    const [a, b] = rings(pathOf([sq], [hole]));
    expect(area2(a)).toBeGreaterThan(0);
    expect(area2(b)).toBeLessThan(0);
  });

  it("ends a curved arrow at its point", () => {
    const pts = arcArrow(0, 0, 100, 0, 90, 20, 30, 50);
    expect(pts.some(p => Math.abs(p.x) < 1e-9 && Math.abs(p.y - 100) < 1e-9)).toBe(true);
    // Nothing goes past the point.
    expect(Math.max(...pts.map(p => Math.atan2(p.y, p.x)))).toBeLessThanOrEqual(Math.PI / 2 + 1e-9);
  });

  it("gives every symbol a usable path", () => {
    for (const d of [TICK, CROSS, CURVED_SOLID, ROTATE, NO_SIGN, HELP]) {
      expect(d).toMatch(/^M [-\d.]+ [-\d.]+/);
      expect(d).not.toMatch(/NaN/);
    }
  });
});

describe("figures and tools", () => {
  it("gives every figure and tool a usable path", async () => {
    const m = await import("./symbols");
    for (const d of [m.FIGURE, m.TWO_PEOPLE, m.CAREFUL, m.POINTING_HAND, m.SCREWDRIVER, m.ALLEN_KEY, m.PLIERS, m.SOLDERING_IRON, m.GLUE_GUN, m.HAMMER, m.PRINTER_3D, m.SCREW, m.NUT]) {
      expect(d).toMatch(/^M [-\d.]+ [-\d.]+/);
      expect(d).not.toMatch(/NaN/);
    }
  });

  it("draws a bar with round ends of the right width", async () => {
    const { bar } = await import("./symbols");
    const pts = bar({ x: 0, y: 0 }, { x: 100, y: 0 }, 20);
    expect(Math.max(...pts.map(p => p.y))).toBeCloseTo(10, 5);
    expect(Math.min(...pts.map(p => p.y))).toBeCloseTo(-10, 5);
    expect(Math.max(...pts.map(p => p.x))).toBeCloseTo(110, 5);
    expect(Math.min(...pts.map(p => p.x))).toBeCloseTo(-10, 5);
  });

  it("cuts the robot's eyes out of its head", async () => {
    const { robot, area2, pathOf } = await import("./symbols");
    const r = robot(0, 0);
    expect(r.holes.length).toBe(4);
    expect(r.fill.length).toBeGreaterThan(8);
    const d = pathOf(r.fill, r.holes);
    const ringsOf = d.split("Z").filter(x => x.trim()).map(x => {
      const n = x.replace(/[ML]/g, " ").trim().split(/\s+/).map(Number);
      const out = [];
      for (let i = 0; i < n.length; i += 2) out.push({ x: n[i], y: n[i + 1] });
      return out;
    });
    // Fill rings first, clockwise; then the holes, anticlockwise.
    expect(ringsOf.slice(0, r.fill.length).every(x => area2(x) > 0)).toBe(true);
    expect(ringsOf.slice(r.fill.length).every(x => area2(x) < 0)).toBe(true);
  });
});
