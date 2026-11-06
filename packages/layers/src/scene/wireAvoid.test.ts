import { describe, expect, it } from "vitest";
import { Matrix4, Vector3 } from "three";
import { clearRun, findWay, routeRound, solidGrid, tighten, type Solid } from "./wireAvoid";
import { followRoom, roundCorners, routeOrder, routeWire, wireHitsParts } from "./wireRouting";
import { loomsOf } from "./wireSpec";
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

  it("routes the ends of a wire running beside another, after that one, with room for both", () => {
    const mats = new Map([["base", I], ["wall", I]]);
    const lead: WireSpec = {
      from: { part: "base", point: [-30, 0, 0], normal: [0, 0, 1] },
      to: { part: "base", point: [30, 0, 0], normal: [0, 0, 1] },
      waypoints: [],
      color: "#d22",
      diameter: 1.6,
      slack: 10,
    };
    const beside: WireSpec = {
      ...lead,
      from: { part: "base", point: [-30, 6, 0], normal: [0, 0, 1] },
      to: { part: "base", point: [30, 6, 0], normal: [0, 0, 1] },
      waypoints: [{ along: { wire: "a", from: 0.75, to: 0.9 } }],
      color: "#222",
    };
    const parts = [{ id: "b", wire: beside }, { id: "a", wire: lead }];
    // The one it runs beside first; and asking for just that one brings its follower.
    expect(routeOrder(parts, parts).map(p => p.id)).toEqual(["a", "b"]);
    expect(routeOrder([parts[1]], parts).map(p => p.id)).toEqual(["a", "b"]);
    expect(followRoom("a", loomsOf(parts))).toBeCloseTo(1.6);
    expect(followRoom("b", loomsOf(parts))).toBe(0);
    const a = routeWire(lead, mats, g, loomsOf(parts), followRoom("a", loomsOf(parts)))!;
    parts[1].wire = { ...lead, waypoints: a.waypoints };
    const looms = loomsOf(parts);
    expect(wireHitsParts(beside, mats, g, looms)).toBe(true);
    const b = routeWire(beside, mats, g, looms)!;
    expect(b.waypoints.filter(w => w.along)).toEqual(beside.waypoints);
    expect(wireHitsParts({ ...beside, waypoints: b.waypoints }, mats, g, looms)).toBe(false);
  });

  describe("tight gaps", () => {
    // A 6 mm wall 50 mm high across a wide plate, with a 4 mm slot at y 0 and an 8 mm one at y 10.
    const slotted: Solid[] = [
      { part: "base", positions: box([-60, -100, -5], [60, 100, 0]), matrix: I },
      { part: "w1", positions: box([-3, -100, 0], [3, -2, 50]), matrix: I },
      { part: "w2", positions: box([-3, 2, 0], [3, 6, 50]), matrix: I },
      { part: "w3", positions: box([-3, 14, 0], [3, 100, 50]), matrix: I },
    ];
    const sg = solidGrid(slotted)!;
    const up = new Vector3(0, 0, 1);
    const through = (pts: Vector3[], a: Vector3, b: Vector3) => {
      const all = [a, ...pts, b];
      for (let i = 1; i < all.length; i++) {
        const p = all[i - 1], q = all[i];
        if ((p.x < 0) !== (q.x < 0)) return p.y + ((q.y - p.y) * (0 - p.x)) / (q.x - p.x);
      }
      return NaN;
    };

    it("threads a snug slot rather than climbing the wall, but never closer than the wire's radius", () => {
      // Too snug for the full room (3 mm a side), roomy enough for the wire (1.2).
      const a = new Vector3(-25, -20, 3), b = new Vector3(25, -20, 3);
      const strict = findWay(sg, { p: a, n: up }, { p: b, n: up }, 3)!;
      const soft = findWay(sg, { p: a, n: up }, { p: b, n: up }, 3, 1.2)!;
      expect(soft.score!).toBeLessThan(strict.score! - 5);
      const pts = tighten(sg, soft);
      expect(Math.abs(through(pts, a, b))).toBeLessThan(2);
      expect(Math.max(...[a, ...pts, b].map(p => p.z))).toBeLessThan(20);
      // Too snug even for that: over the top or by the wide slot.
      const fat = tighten(sg, findWay(sg, { p: a, n: up }, { p: b, n: up }, 3.4, 3)!);
      expect(Math.abs(through(fat, a, b))).toBeGreaterThan(2);
    });

    it("takes a roomy gap over a snug one when it's not much further", () => {
      const a = new Vector3(-25, 0, 3), b = new Vector3(25, 0, 3);
      const pts = tighten(sg, findWay(sg, { p: a, n: up }, { p: b, n: up }, 3, 1.2)!);
      const y = through(pts, a, b);
      expect(y).toBeGreaterThan(7);
      expect(y).toBeLessThan(13);
    });
  });
});
