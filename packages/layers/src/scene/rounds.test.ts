import { describe, expect, it } from "vitest";
import { roundEdges } from "./rounds";

type P = [number, number];

/** A prism: the outline (counter-clockwise, seen from above) pushed up `h`, with fan caps. */
function prism(outline: P[], h: number): Float32Array {
  const out: number[] = [];
  const tri = (...v: number[][]) => v.forEach(p => out.push(...p));
  const n = outline.length;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = outline[i], [bx, by] = outline[(i + 1) % n];
    tri([ax, ay, 0], [bx, by, 0], [bx, by, h]);
    tri([ax, ay, 0], [bx, by, h], [ax, ay, h]);
  }
  const [cx, cy] = [outline.reduce((s, p) => s + p[0], 0) / n, outline.reduce((s, p) => s + p[1], 0) / n];
  for (let i = 0; i < n; i++) {
    const [ax, ay] = outline[i], [bx, by] = outline[(i + 1) % n];
    tri([cx, cy, h], [ax, ay, h], [bx, by, h]);
    tri([cx, cy, 0], [bx, by, 0], [ax, ay, 0]);
  }
  return new Float32Array(out);
}

const arc = (cx: number, cy: number, r: number, from: number, to: number, steps: number): P[] =>
  Array.from({ length: steps + 1 }, (_, i) => {
    const a = from + ((to - from) * i) / steps;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });

/** Lines as [x, y] of their lower end, rounded, sorted. */
const feet = (lines: Float32Array) => {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 6) out.push(`${Math.round(lines[i])},${Math.round(lines[i + 1])}`);
  return [...new Set(out)].sort();
};

describe("roundEdges", () => {
  it("draws a line where each flat side of a stadium turns into its round ends", () => {
    // 40 long, 20 wide: flat sides from x -20 to 20, half circles of radius 10 at each end.
    const outline = [...arc(20, 0, 10, -Math.PI / 2, Math.PI / 2, 12), ...arc(-20, 0, 10, Math.PI / 2, (3 * Math.PI) / 2, 12)];
    const lines = roundEdges(prism(outline, 5), 30);
    expect(lines.length / 6).toBe(4);
    expect(feet(lines)).toEqual(["-20,-10", "-20,10", "20,-10", "20,10"]);
  });

  it("draws nothing on a box: its folds get fold lines already", () => {
    expect(roundEdges(prism([[-10, -10], [10, -10], [10, 10], [-10, 10]], 5), 30).length).toBe(0);
  });

  it("draws nothing on a cylinder, which has no flat side", () => {
    expect(roundEdges(prism(arc(0, 0, 10, 0, 2 * Math.PI, 32).slice(0, 32), 20), 30).length).toBe(0);
  });

  it("leaves out a gentle bend that hardly turns", () => {
    // A flat side, then a 12° bend over 4 facets, then another flat side.
    const t = (12 * Math.PI) / 180;
    const bend = arc(0, 95, 100, -Math.PI / 2, -Math.PI / 2 + t, 4).slice(1);
    const [ex, ey] = bend[bend.length - 1];
    const far: P = [ex + 10 * Math.cos(t), ey + 10 * Math.sin(t)];
    const outline: P[] = [[-30, -5], [0, -5], ...bend, far, [far[0], 20], [-30, 20]];
    expect(roundEdges(prism(outline, 5), 30).length).toBe(0);
  });

  it("finds the round's lines however sharp the folds must be", () => {
    const outline = [...arc(20, 0, 10, -Math.PI / 2, Math.PI / 2, 6), ...arc(-20, 0, 10, Math.PI / 2, (3 * Math.PI) / 2, 6)];
    // 30° facets: under a 45° crease they're soft, so the round's lines are drawn.
    expect(roundEdges(prism(outline, 5), 45).length / 6).toBe(4);
    // Under a 20° crease every facet edge is a fold line already: nothing more to add.
    expect(roundEdges(prism(outline, 5), 20).length).toBe(0);
  });
});
