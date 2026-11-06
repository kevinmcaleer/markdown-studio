import { describe, expect, it } from "vitest";
import { Matrix4, Vector3 } from "three";
import { clearRun, routeRound, solidGrid, type Solid } from "./wireAvoid";
import { roundCorners, routeWire, wireHitsParts } from "./wireRouting";
import type { WireSpec } from "./wireSpec";
import { wireRoute } from "./wire";

/** A closed box's triangles, from `min` to `max`. */
function box(min: [number, number, number], max: [number, number, number]): Float32Array {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const c = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [0, 4, 7, 3]];
  const out: number[] = [];
  for (const [a, b, d, e] of quads) out.push(...c[a], ...c[b], ...c[d], ...c[a], ...c[d], ...c[e]);
  return new Float32Array(out);
}

const I = new Matrix4();
// A base plate, with a wall standing up across its middle.
const solids: Solid[] = [
  { part: "base", positions: box([-60, -30, -5], [60, 30, 0]), matrix: I },
  { part: "wall", positions: box([-3, -30, 0], [3, 30, 40]), matrix: I },
];

describe("routing round parts", () => {
  const g = solidGrid(solids)!;

  it("sees that the straight run goes through the wall", () => {
    expect(clearRun(g, new Vector3(-30, 0, 5), new Vector3(30, 0, 5), 2)).toBe(false);
    expect(clearRun(g, new Vector3(-30, 0, 50), new Vector3(30, 0, 50), 2)).toBe(true);
  });

  it("goes over (or round) the wall, never through it", () => {
    const pts = routeRound(g, { p: new Vector3(-30, 0, 5), n: new Vector3(0, 0, 1) }, { p: new Vector3(30, 0, 5), n: new Vector3(0, 0, 1) }, 2)!;
    expect(pts.length).toBeGreaterThan(0);
    const all = [new Vector3(-30, 0, 5), ...pts, new Vector3(30, 0, 5)];
    for (let i = 1; i < all.length - 1; i++) expect(clearRun(g, all[i], all[i + 1], 1.5)).toBe(true);
  });

  it("leaves a clear run alone", () => {
    expect(routeRound(g, { p: new Vector3(-30, 0, 5), n: null }, { p: new Vector3(-10, 0, 5), n: null }, 2)).toEqual([]);
  });

  it("gives a wire waypoints on the parts that keep it off them", () => {
    const mats = new Map([["base", I], ["wall", I]]);
    const spec: WireSpec = {
      from: { part: "base", point: [-30, 0, 0], normal: [0, 0, 1] },
      to: { part: "base", point: [30, 0, 0], normal: [0, 0, 1] },
      waypoints: [],
      color: "#d22",
      diameter: 1.6,
      slack: 10,
    };
    expect(wireHitsParts(spec, mats, g)).toBe(true);
    const got = routeWire(spec, mats, g)!;
    expect(got.clear).toBe(true);
    expect(got.stuck).toBe(0);
    expect(got.waypoints.every(w => w.auto && (w.part === "wall" || w.part === "base"))).toBe(true);
    const routed = { ...spec, waypoints: got.waypoints };
    expect(wireHitsParts(routed, mats, g)).toBe(false);
    // Over the wall's top, or round its end.
    expect(wireRoute(routed, mats)!.centre.some(p => p.z > 40 || Math.abs(p.y) > 30)).toBe(true);
  });

  it("keeps waypoints put in by hand, and replaces its own", () => {
    const mats = new Map([["base", I], ["wall", I]]);
    const spec: WireSpec = {
      from: { part: "base", point: [-30, 0, 0], normal: [0, 0, 1] },
      to: { part: "base", point: [30, 0, 0], normal: [0, 0, 1] },
      waypoints: [{ part: "wall", point: [0, 0, 40], normal: [0, 0, 1] }, { part: "base", point: [1, 1, 1], auto: true }],
      color: "#d22",
      diameter: 1.6,
      slack: 0,
    };
    const got = routeWire(spec, mats, g)!;
    expect(got.waypoints.filter(w => !w.auto)).toEqual([spec.waypoints[0]]);
    expect(got.waypoints.some(w => w.auto && w.point?.[0] === 1 && w.point?.[1] === 1)).toBe(false);
  });

  it("rounds a corner by cutting it back along both stretches", () => {
    const pts = roundCorners([new Vector3(0, 0, 0), new Vector3(20, 0, 0), new Vector3(20, 20, 0)], 5);
    expect(pts.length).toBe(4);
    // A right angle: cut back 5 mm (radius × tan 45°) each way.
    expect(pts[1].distanceTo(new Vector3(15, 0, 0))).toBeLessThan(1e-6);
    expect(pts[2].distanceTo(new Vector3(20, 5, 0))).toBeLessThan(1e-6);
    // A straight run isn't touched.
    expect(roundCorners([new Vector3(0, 0, 0), new Vector3(10, 0, 0), new Vector3(20, 0, 0)], 5).length).toBe(3);
  });
});
