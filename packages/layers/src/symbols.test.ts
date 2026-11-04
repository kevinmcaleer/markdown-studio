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
