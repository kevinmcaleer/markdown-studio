import { describe, expect, it } from "vitest";
import { Matrix4, Vector3 } from "three";
import { layChain, layTrack, trackTriangles, wrapLoop, type TrackSpec, type WorldCircle } from "./track";
import { movePieces, openChain, trackOpener, trackOpening } from "./trackOpen";

const loop = wrapLoop([{ x: 0, y: 0, r: 20 }, { x: 120, y: 0, r: 20 }]);
const chain = layChain(loop, 10, 30, 0);
const near = (a: number[], b: number[], d = 1e-6) => Math.hypot(a[0] - b[0], a[1] - b[1]) < d;

describe("track opening", () => {
  it("is closed below the threshold and open all the way at 1", () => {
    expect(trackOpening(0)).toBe(0);
    expect(trackOpening(0.4)).toBe(0);
    expect(trackOpening(1)).toBe(1);
    const mid = trackOpening(0.7);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  it("leaves the chain closed at 0", () => {
    const o = openChain(chain.pivots, [0, 1], 0)!;
    o.at.forEach((p, k) => expect(near(p, chain.pivots[k])).toBe(true));
    o.turn.forEach(t => expect(t).toBeCloseTo(0, 9));
  });

  it("breaks at the top, keeps the bottom still and the links their length", () => {
    const o = openChain(chain.pivots, [0, 1], 1)!;
    const n = chain.pivots.length;
    // The break is on the top run.
    expect(chain.pivots[o.first][1]).toBeGreaterThan(15);
    // The piece opposite the break hasn't moved.
    const anchor = (o.first + Math.floor(n / 2)) % n;
    expect(near(o.at[anchor], chain.pivots[anchor])).toBe(true);
    // Every link but the broken one keeps its length.
    for (let j = 0; j < n - 1; j++) {
      const a = (o.first + j) % n, b = (o.first + j + 1) % n;
      const was = Math.hypot(chain.pivots[b][0] - chain.pivots[a][0], chain.pivots[b][1] - chain.pivots[a][1]);
      expect(Math.hypot(o.at[b][0] - o.at[a][0], o.at[b][1] - o.at[a][1])).toBeCloseTo(was, 6);
    }
  });

  it("turns the loose ends up and apart", () => {
    const o = openChain(chain.pivots, [0, 1], 1)!;
    const n = chain.pivots.length;
    const first = o.first, last = (o.first + n - 1) % n;
    // The last piece's end, and the first piece's start: the two loose ends.
    const dir = (k: number) => o.turn[k] + Math.atan2(chain.pivots[(k + 1) % n][1] - chain.pivots[k][1], chain.pivots[(k + 1) % n][0] - chain.pivots[k][0]);
    // The last piece heads up; the first piece heads down from its loose end (so it points up).
    expect(Math.sin(dir(last))).toBeGreaterThan(0.8);
    expect(Math.sin(dir(first))).toBeLessThan(-0.8);
    const lastEnd = [o.at[last][0] + 10 * Math.cos(dir(last)), o.at[last][1] + 10 * Math.sin(dir(last))];
    const gap = Math.hypot(lastEnd[0] - o.at[first][0], lastEnd[1] - o.at[first][1]);
    expect(gap).toBeGreaterThan(20);
  });

  it("moves each piece of a track's model by itself, closed exactly at 0", () => {
    const spec: TrackSpec = { link: "p", count: 24, start: [-4, 0, 0], end: [4, 0, 0], axis: [0, 1, 0], wheels: [
      { id: "a", point: [0, 0, 0], normal: [0, 1, 0], radius: 15 },
      { id: "b", point: [0, 0, 0], normal: [0, 1, 0], radius: 15 },
    ], offset: 0, lift: 0, side: 0 };
    const world = new Map<string, Matrix4>([
      ["a", new Matrix4()],
      ["b", new Matrix4().makeTranslation(80, 0, 0)],
      ["t", new Matrix4().makeTranslation(40, 0, 0)],
    ]);
    const circles: WorldCircle[] = [
      { centre: new Vector3(0, 0, 0), normal: new Vector3(0, 1, 0), radius: 15 },
      { centre: new Vector3(80, 0, 0), normal: new Vector3(0, 1, 0), radius: 15 },
    ];
    // A piece: one triangle round its pivots.
    const piece = new Float32Array([-4, 0, 0, 4, 0, 0, 0, 0, 2]);
    const lay = layTrack(spec, circles);
    const toOwn = world.get("t")!.clone().invert();
    const tri = trackTriangles(piece, lay.pieces, toOwn);
    const opener = trackOpener("t", spec, tri.length / 9, world)!;
    expect(opener).toBeTruthy();
    expect(Array.from(movePieces(tri, opener.moves(0)))).toEqual(Array.from(tri).map(v => expect.closeTo(v, 4)));
    const open = movePieces(tri, opener.moves(1));
    // Up is +Z, the plane is X–Z: the ends rise above the closed loop's top.
    let topWas = -Infinity, topNow = -Infinity;
    for (let i = 2; i < tri.length; i += 3) {
      topWas = Math.max(topWas, tri[i]);
      topNow = Math.max(topNow, open[i]);
    }
    expect(topNow).toBeGreaterThan(topWas + 3);
    // Too few pieces, or a model that doesn't split into its pieces: no opening.
    expect(trackOpener("t", { ...spec, count: 4 }, 4, world)).toBeNull();
    expect(trackOpener("t", spec, tri.length / 9 + 1, world)).toBeNull();
  });
});
