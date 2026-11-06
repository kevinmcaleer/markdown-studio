import { describe, expect, it } from "vitest";
import { dropOnto, fitsPicture, guessedSockets, guessPins } from "./pinGuess";
import type { WiringPart } from "./wiring2d";
import type { Vec3 } from "./model";

/** A box's 12 triangles, outward. */
function box(min: Vec3, max: Vec3): number[] {
  const [a, b, c] = min, [d, e, f] = max;
  const v = [[a, b, c], [d, b, c], [d, e, c], [a, e, c], [a, b, f], [d, b, f], [d, e, f], [a, e, f]];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  return quads.flatMap(([p, q, r, s]) => [p, q, r, p, r, s].flatMap(i => v[i]));
}

/** Corners moved to the box's middle, as a scene reads a model; with that middle and the size. */
function centred(raw: number[]): { pos: Float32Array; centre: Vec3; size: Vec3 } {
  const min = [0, 1, 2].map(i => Math.min(...raw.filter((_, j) => j % 3 === i)));
  const max = [0, 1, 2].map(i => Math.max(...raw.filter((_, j) => j % 3 === i)));
  const centre = min.map((m, i) => (m + max[i]) / 2) as Vec3;
  return { pos: Float32Array.from(raw.map((v, j) => v - centre[j % 3])), centre, size: max.map((m, i) => m - min[i]) as Vec3 };
}

// A 20 x 10 mm board, 1.6 thick, centred, with a header pin 8 mm tall at a
// quarter of the way across, half way down the picture.
const board = [...box([-10, -5, 0], [10, 5, 1.6]), ...box([-5.3, -0.3, 1.6], [-4.7, 0.3, 9.6])];
const part: WiringPart = {
  id: "b1", name: "Board", size: [20, 10],
  ports: [{ id: "header-1", name: "Header 1", pins: [{ name: "D1", x: 0.25, y: 0.5 }, { name: "GND", x: 0.75, y: 0.25 }, { name: "NC" }] }],
};

describe("pinGuess", () => {
  it("drops a pin onto the top of what's under it", () => {
    const m = centred(board);
    const got = guessPins(part, m.pos, m.centre, m.size)!;
    expect(got.map(g => g.pin)).toEqual(["D1", "GND"]); // NC has no place on the picture
    const d1 = got[0];
    expect(d1.onTop).toBe(true);
    // The pin's tip (the model's top is 9.6 - its middle, 4.8).
    expect(d1.point[0]).toBeCloseTo(-5, 3);
    expect(d1.point[1]).toBeCloseTo(0, 3);
    expect(d1.point[2]).toBeCloseTo(4.8, 3);
    expect(d1.normal).toEqual([0, 0, 1]);
    // GND: on the board's face, 2.5 mm up the picture's top half.
    expect(got[1].point[0]).toBeCloseTo(5, 3);
    expect(got[1].point[1]).toBeCloseTo(2.5, 3);
    expect(got[1].point[2]).toBeCloseTo(1.6 - 4.8, 3);
  });

  it("leaves pins already placed", () => {
    const m = centred(board);
    expect(guessPins(part, m.pos, m.centre, m.size, new Set(["D1"]))!.map(g => g.pin)).toEqual(["GND"]);
  });

  it("finds a pin off the top (a motor's tab on its end) on the nearest corner, facing out", () => {
    // A 12 x 35 motor with a tab sticking out of its -y end, and a shaft past +y that moves the box's middle.
    const raw = [...box([-6, -15.4, 0], [6, 17.5, 10]), ...box([4.2, -17, 4.25], [4.6, -15.4, 5.75]), ...box([-1, 17.5, 4], [1, 22, 6])];
    const m = centred(raw);
    const motor: WiringPart = { id: "m", name: "N20", size: [12, 35], ports: [{ id: "h", name: "H", pins: [{ name: "VCC", x: 0.75, y: 0.95 }] }] };
    const [g] = guessPins(motor, m.pos, m.centre, m.size)!;
    expect(g.onTop).toBe(false);
    expect(g.normal).toEqual([0, -1, 0]);
    // On the tab's end.
    expect(g.point[1] + m.centre[1]).toBeCloseTo(-17, 3);
    expect(g.point[0]).toBeCloseTo(4.4, 3);
    expect(g.point[2] + m.centre[2]).toBeCloseTo(5, 3);
  });

  it("only for a model drawn in its picture's frame", () => {
    expect(fitsPicture([20, 10, 9.6], part)).toBe(true);
    expect(fitsPicture([10, 20, 9.6], part)).toBe(false);
    expect(fitsPicture([20, 10, 9.6], { size: undefined })).toBe(false);
    const m = centred(board.map((v, i) => (i % 3 === 0 ? v * 3 : v)));
    expect(guessPins(part, m.pos, m.centre, m.size)).toBeNull();
  });

  it("misses off the model", () => {
    expect(dropOnto(Float32Array.from(box([0, 0, 0], [1, 1, 1])), 5, 5)).toBeNull();
  });

  it("makes bare pin sockets with fresh ids", () => {
    const m = centred(board);
    const s = guessedSockets(guessPins(part, m.pos, m.centre, m.size)!, [{ id: "s1", point: [0, 0, 0], normal: [0, 0, 1], connector: "pin", pin: "X" }]);
    expect(s.map(x => x.id)).toEqual(["s1", "s2", "s3"]);
    expect(s[1]).toMatchObject({ connector: "pin", pin: "D1", port: "header-1" });
  });
});
