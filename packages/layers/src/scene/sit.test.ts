import { describe, expect, it } from "vitest";
import { Matrix4 } from "three";
import { sitDelta } from "./sit";

/** A box's triangles, from corner a to corner b. */
function box(a: number[], b: number[]): number[] {
  const c = (i: number) => [i & 1 ? b[0] : a[0], i & 2 ? b[1] : a[1], i & 4 ? b[2] : a[2]];
  const quads = [[0, 1, 3, 2], [4, 5, 7, 6], [0, 1, 5, 4], [2, 3, 7, 6], [0, 2, 6, 4], [1, 3, 7, 5]];
  const out: number[] = [];
  for (const [p, q, r, s] of quads) out.push(...c(p), ...c(q), ...c(r), ...c(p), ...c(r), ...c(s));
  return out;
}

// A tray: a floor whose top is at z = 2, with walls up to z = 20 round it.
const tray = [
  ...box([-50, -50, 0], [50, 50, 2]),
  ...box([-50, -50, 2], [-46, 50, 20]),
  ...box([46, -50, 2], [50, 50, 20]),
  ...box([-46, -50, 2], [46, -46, 20]),
  ...box([-46, 46, 2], [46, 50, 20]),
];
// A battery, 10 mm tall, its middle at 0, 0, 0.
const battery = box([-12, -8, -5], [12, 8, 5]);
const at = (x: number, y: number, z: number) => new Matrix4().makeTranslation(x, y, z);

describe("sit on the part beneath", () => {
  it("lifts a part sunk into the floor until it rests on it", () => {
    // Its bottom at z = 0: 2 mm into the floor.
    expect(sitDelta(tray, battery, at(0, 0, 5), [0, 0, 1])).toBeCloseTo(2, 1);
  });

  it("drops a floating part onto the floor of a well, not the walls' tops", () => {
    expect(sitDelta(tray, battery, at(0, 0, 15), [0, 0, 1])).toBeCloseTo(-8, 1);
  });

  it("rests on whatever is highest beneath it", () => {
    // Half over a wall: it sits on the wall's top.
    expect(sitDelta(tray, battery, at(46, 0, 30), [0, 0, 1])).toBeCloseTo(20 - 25, 1);
  });

  it("works along any normal", () => {
    // The same tray stood on its side: the floor faces +x.
    const turn = new Matrix4().makeRotationY(Math.PI / 2);
    const side = (pts: number[]) => {
      const out: number[] = [];
      for (let i = 0; i < pts.length; i += 3) out.push(pts[i + 2], pts[i + 1], -pts[i]);
      return out;
    };
    const m = at(5, 0, 0).multiply(turn);
    expect(sitDelta(side(tray), battery, m, [1, 0, 0])).toBeCloseTo(2, 1);
  });

  it("says when nothing is beneath", () => {
    expect(sitDelta(tray, battery, at(200, 0, 5), [0, 0, 1])).toBeNull();
  });
});
