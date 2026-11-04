import { BoxGeometry, type BufferGeometry, ExtrudeGeometry, LatheGeometry, Path, Shape, Vector2 } from "three";
import { describe, expect, it } from "vitest";
import { Topology, type Snap } from "./snaps";

const soup = (g: BufferGeometry) => (g.index ? g.toNonIndexed() : g).getAttribute("position").array as ArrayLike<number>;
const r = (v: number[]) => v.map(n => Math.round(n * 100) / 100 + 0);
/** The first triangle whose normal is `n`. */
function triFacing(t: Topology, n: [number, number, number], where = (_: number) => true): number {
  for (let i = 0; i < t.triangles; i++) {
    const m = t.normalOf(i);
    if (Math.abs(m[0] - n[0]) < 1e-3 && Math.abs(m[1] - n[1]) < 1e-3 && Math.abs(m[2] - n[2]) < 1e-3 && where(i)) return i;
  }
  return -1;
}
const of = (snaps: Snap[], role: string) => snaps.filter(s => s.role === role);

describe("snaps", () => {
  it("finds a box face's middle, corners and edge middles", () => {
    const t = new Topology(soup(new BoxGeometry(40, 20, 10, 3, 2, 1)));
    const face = t.faceAt(triFacing(t, [0, 0, 1]))!;
    expect(face.curved).toBe(false);
    expect(face.tris.length).toBe(12);
    expect(of(face.snaps, "centre").map(s => r(s.p))).toEqual([[0, 0, 5]]);
    expect(of(face.snaps, "corner").length).toBe(4);
    expect(of(face.snaps, "edge").map(s => r(s.p)).sort()).toEqual([[-20, 0, 5], [0, -10, 5], [0, 10, 5], [20, 0, 5]].sort());
    face.snaps.forEach(s => expect(r(s.n)).toEqual([0, 0, 1]));
  });

  it("finds a round hole in a flat face", () => {
    const plate = new Shape().moveTo(-20, -10).lineTo(20, -10).lineTo(20, 10).lineTo(-20, 10).lineTo(-20, -10);
    plate.holes.push(new Path().absarc(8, 2, 3, 0, Math.PI * 2, true));
    const t = new Topology(soup(new ExtrudeGeometry(plate, { depth: 5, bevelEnabled: false, curveSegments: 32 })));
    const face = t.faceAt(triFacing(t, [0, 0, 1]))!;
    const holes = of(face.snaps, "hole");
    expect(holes.length).toBe(1);
    expect(r(holes[0].p)).toEqual([8, 2, 5]);
    expect(holes[0].radius).toBeCloseTo(3, 1);
    expect(of(face.snaps, "corner").length).toBe(4);
  });

  it("snaps on a face with a square hole through it (a frame)", () => {
    const plate = new Shape().moveTo(-20, -10).lineTo(20, -10).lineTo(20, 10).lineTo(-20, 10).lineTo(-20, -10);
    plate.holes.push(new Path().moveTo(-5, -4).lineTo(-5, 4).lineTo(5, 4).lineTo(5, -4).lineTo(-5, -4));
    const t = new Topology(soup(new ExtrudeGeometry(plate, { depth: 5, bevelEnabled: false })));
    const face = t.faceAt(triFacing(t, [0, 0, 1]))!;
    expect(of(face.snaps, "corner").length).toBe(4);
    expect(of(face.snaps, "pocket").map(s => r(s.p))).toEqual([[0, 0, 5]]);
  });

  it("still snaps a face whose border is broken by an unwelded corner", () => {
    // A box's top face, with one corner of one triangle moved 0.01 mm: that
    // seam no longer welds, so the border runs out instead of coming back
    // round. Exported STLs do this, above all inside a recess, and the face
    // used to light up with no anchor points on it (Kev, 2026-11-04).
    const pos = Float32Array.from(soup(new BoxGeometry(40, 20, 10, 3, 2, 1)));
    const top = (t: number) => pos[t * 9 + 2] === 5 && pos[t * 9 + 5] === 5 && pos[t * 9 + 8] === 5;
    let moved = -1;
    for (let t = 0; t < pos.length / 9 && moved < 0; t++) {
      if (!top(t)) continue;
      for (let k = 0; k < 3; k++) {
        // A corner on the outer edge of the face, shared with the triangle beside it.
        const x = pos[t * 9 + k * 3], y = pos[t * 9 + k * 3 + 1];
        if (Math.abs(y) !== 10 || Math.abs(x) === 20) continue;
        pos[t * 9 + k * 3] = x + 0.01;
        moved = t;
        break;
      }
    }
    expect(moved).toBeGreaterThanOrEqual(0);
    const t = new Topology(pos);
    const face = t.faceAt(triFacing(t, [0, 0, 1], i => i !== moved))!;
    expect(face.tris.length).toBeGreaterThan(8);
    expect(of(face.snaps, "centre").length).toBe(1);
    expect(of(face.snaps, "corner").length).toBeGreaterThanOrEqual(3);
    // Nothing is called a hole from a border that never closed.
    expect(of(face.snaps, "hole").length + of(face.snaps, "pocket").length).toBe(0);
  });

  it("snaps a small flat face above shallow sides (not read as a round one)", () => {
    // A 2x2 pad 1 mm above a 20x20 base, with sides sloping 6°: the pad's
    // smooth neighbourhood runs all the way down the sides, so the pad used
    // to be read as a facet of a round surface and offered nothing to click
    // (Kev, 2026-11-04). It is a flat face with a middle and four corners.
    const tri = (a: number[], b: number[], c: number[]) => [...a, ...b, ...c];
    const top = [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
    const low = [[-10, -10, 0], [10, -10, 0], [10, 10, 0], [-10, 10, 0]];
    const pos: number[] = [...tri(top[0], top[1], top[2]), ...tri(top[0], top[2], top[3])];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      pos.push(...tri(top[j], top[i], low[i]), ...tri(top[j], low[i], low[j]));
    }
    const t = new Topology(pos);
    const face = t.faceAt(triFacing(t, [0, 0, 1]))!;
    expect(face.curved).toBe(false);
    expect(face.tris.length).toBe(2);
    expect(of(face.snaps, "centre").map(s => r(s.p))).toEqual([[0, 0, 1]]);
    expect(of(face.snaps, "corner").length).toBe(4);
    expect(of(face.snaps, "edge").length).toBe(4);
  });

  it("finds a screw's neck on its shank, facing down the shank", () => {
    // Shank radius 1.5 from y=0 to 10, head radius 5 from 10 to 13; Y is the axis.
    const pts = [[0, 0], [1.5, 0], [1.5, 10], [5, 10], [5, 13], [0, 13]].map(([x, y]) => new Vector2(x, y));
    const t = new Topology(soup(new LatheGeometry(pts, 32)));
    const onShank = (i: number) => {
      const p = t.point(t.corner[i * 3]);
      return Math.abs(Math.hypot(p[0], p[2]) - 1.5) < 0.01 && Math.abs(t.normalOf(i)[1]) < 0.01;
    };
    let seed = -1;
    for (let i = 0; i < t.triangles && seed < 0; i++) if (onShank(i)) seed = i;
    const face = t.faceAt(seed)!;
    expect(face.curved).toBe(true);
    const rims = of(face.snaps, "rim").sort((a, b) => a.p[1] - b.p[1]);
    expect(rims.length).toBe(2);
    expect(r(rims[1].p)).toEqual([0, 10, 0]);
    expect(rims[1].radius).toBeCloseTo(1.5, 1);
    // Both the neck and the tip face down the shank (-Y): the head's
    // underside and the tip's end look that way.
    expect(r(rims[1].n)).toEqual([0, -1, 0]);
    expect(r(rims[0].n)).toEqual([0, -1, 0]);
    // The head's top is a round flat face (with slivers at its middle): just its centre.
    const top = t.faceAt(triFacing(t, [0, 1, 0], i => t.area[i] > 0 && t.point(t.corner[i * 3])[1] > 12))!;
    expect(top.curved).toBe(false);
    expect(top.snaps.map(s => [s.role, ...r(s.p)])).toEqual([["centre", 0, 13, 0]]);
    expect(top.snaps[0].radius).toBeCloseTo(5, 1);
  });

  it("finds the rim of a hole from inside it, facing out", () => {
    const plate = new Shape().moveTo(-20, -10).lineTo(20, -10).lineTo(20, 10).lineTo(-20, 10).lineTo(-20, -10);
    plate.holes.push(new Path().absarc(0, 0, 3, 0, Math.PI * 2, true));
    const t = new Topology(soup(new ExtrudeGeometry(plate, { depth: 5, bevelEnabled: false, curveSegments: 32 })));
    let seed = -1;
    for (let i = 0; i < t.triangles && seed < 0; i++) {
      const p = t.point(t.corner[i * 3]);
      if (Math.abs(Math.hypot(p[0], p[1]) - 3) < 0.01 && Math.abs(t.normalOf(i)[2]) < 0.01) seed = i;
    }
    const face = t.faceAt(seed)!;
    expect(face.curved).toBe(true);
    const top = of(face.snaps, "rim").find(s => s.p[2] > 4)!;
    expect(r(top.p)).toEqual([0, 0, 5]);
    expect(r(top.n)).toEqual([0, 0, 1]);
  });
});
