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
