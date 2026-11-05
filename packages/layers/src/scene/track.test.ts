import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { convexHull, insideReach, layChain, layTrack, loopLength, normalizeTrack, trackPitch, trackTriangles, wrapLoop, type TrackSpec } from "./track";

const spec = (over: Partial<TrackSpec> = {}): TrackSpec => ({
  link: "p1",
  count: 20,
  start: [-5, 0, 0],
  end: [5, 0, 0],
  axis: [0, 1, 0],
  wheels: [],
  offset: 0,
  lift: 0,
  side: 0,
  ...over,
});

describe("track", () => {
  it("wraps two circles like a belt", () => {
    const loop = wrapLoop([{ x: 0, y: 0, r: 10 }, { x: 100, y: 0, r: 10 }]);
    // Two straights and a circle's worth of round ends.
    expect(loopLength(loop)).toBeCloseTo(200 + 2 * Math.PI * 10, 0);
  });

  it("keeps only the hull", () => {
    const hull = convexHull([[0, 0], [10, 0], [10, 10], [0, 10], [5, 5]]);
    expect(hull).toHaveLength(4);
  });

  it("lays pieces a pitch apart and counts how many fit", () => {
    const loop = wrapLoop([{ x: 0, y: 0, r: 20 }, { x: 150, y: 0, r: 20 }]);
    const c = layChain(loop, 10, 10, 0);
    expect(c.pivots).toHaveLength(10);
    for (let i = 1; i < c.pivots.length; i++) {
      const [a, b] = [c.pivots[i - 1], c.pivots[i]];
      expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeCloseTo(10, 3);
    }
    // A little under the loop's length over the pitch (chords cut the corners).
    const L = 300 + 2 * Math.PI * 20;
    expect(c.fits).toBeGreaterThan(L / 10 - 0.5);
    expect(c.fits).toBeLessThan(L / 10 + 0.01);
  });

  it("measures the pitch across the pins", () => {
    expect(trackPitch({ start: [0, 0, 0], end: [12, 3, 0], axis: [0, 1, 0] })).toBeCloseTo(12);
  });

  it("puts each piece's pivots on the next one's", () => {
    const t = spec({ count: 30 });
    const wheels = [
      { centre: new Vector3(0, 0, 0), normal: new Vector3(0, 1, 0), radius: 20 },
      { centre: new Vector3(120, 0, 0), normal: new Vector3(0, 1, 0), radius: 20 },
    ];
    const lay = layTrack(t, wheels);
    expect(lay.pieces).toHaveLength(30);
    for (let i = 0; i + 1 < lay.pieces.length; i++) {
      const end = new Vector3(...t.end).applyMatrix4(lay.pieces[i]);
      const nextStart = new Vector3(...t.start).applyMatrix4(lay.pieces[i + 1]);
      expect(end.distanceTo(nextStart)).toBeLessThan(1e-3);
      // In the wheels' plane, its pins along their axle.
      expect(nextStart.y).toBeCloseTo(0, 4);
      const pin = new Vector3(...t.axis).transformDirection(lay.pieces[i]);
      expect(Math.abs(pin.y)).toBeCloseTo(1, 4);
    }
    // The pieces' insides (a × d: -Z in the piece) face the wheels: a piece on the bottom run faces up.
    const bottom = lay.pieces.find(m => new Vector3().setFromMatrixPosition(m).z < -10 && Math.abs(new Vector3().setFromMatrixPosition(m).x - 60) < 20)!;
    const inside = new Vector3(0, 0, -1).transformDirection(bottom);
    expect(inside.z).toBeCloseTo(1, 3);
  });

  it("turns a piece over in place along the axle", () => {
    const wheels = [
      { centre: new Vector3(0, 0, 0), normal: new Vector3(0, 1, 0), radius: 20 },
      { centre: new Vector3(120, 0, 0), normal: new Vector3(0, 1, 0), radius: 20 },
    ];
    // Pivots on a pin end 4 mm off the piece's middle, along the axle.
    const t = spec({ start: [-5, 4, 0], end: [5, 4, 0] });
    const mid = (f: boolean) => new Vector3().setFromMatrixPosition(layTrack({ ...t, flip: f }, wheels).pieces[0]).y;
    expect(mid(true)).toBeCloseTo(mid(false), 4);
  });

  it("finds the lift that sets the piece's inside on the wheels", () => {
    // A piece reaching 3 mm to its inside (a × d: -Z here) and 1 mm the other way.
    const pos = [-5, 0, -3, 5, 0, 1, 0, 1, 0];
    expect(insideReach(pos, spec())).toBe(3);
    expect(insideReach(pos, spec({ flip: true }))).toBe(1);
  });

  it("copies the piece's triangles to every place", () => {
    const lay = layTrack(spec({ count: 4 }), [
      { centre: new Vector3(0, 0, 0), normal: new Vector3(0, 1, 0), radius: 5 },
      { centre: new Vector3(30, 0, 0), normal: new Vector3(0, 1, 0), radius: 5 },
    ]);
    const tri = trackTriangles(new Float32Array(9), lay.pieces, lay.pieces[0].clone().identity());
    expect(tri).toHaveLength(36);
  });

  it("reads saved settings, dropping what's broken", () => {
    expect(normalizeTrack({ link: "p1" })).toBeNull();
    const t = normalizeTrack({ ...spec(), count: 9999, wheels: [{ id: "w", point: [0, 0, 0], normal: [0, 0, 1], radius: 10 }, { id: "x", radius: -1 }] });
    expect(t?.count).toBe(400);
    expect(t?.wheels).toHaveLength(1);
  });
});
