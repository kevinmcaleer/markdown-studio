import { describe, expect, it } from "vitest";
import { boxSides, distToSegment, facingSide, polygonSides, snapAngle } from "./geometry";

const close = (a: { x: number; y: number }, x: number, y: number) => {
  expect(a.x).toBeCloseTo(x, 6);
  expect(a.y).toBeCloseTo(y, 6);
};

describe("snap points", () => {
  it("sit in the middle of a box's sides", () => {
    const s = boxSides(200, 100);
    close(s.top, 0, -50);
    close(s.right, 100, 0);
    close(s.bottom, 0, 50);
    close(s.left, -100, 0);
  });

  it("sit on a triangle's sloping sides", () => {
    // Apex at the top, base at the bottom; centred on its box.
    const s = polygonSides([{ x: 0, y: -100 }, { x: 100, y: 100 }, { x: -100, y: 100 }]);
    close(s.top, 0, -100);
    close(s.bottom, 0, 100);
    close(s.right, 50, 0);
    close(s.left, -50, 0);
  });

  it("sit on a diamond's points", () => {
    const s = polygonSides([{ x: 0, y: -60 }, { x: 80, y: 0 }, { x: 0, y: 60 }, { x: -80, y: 0 }]);
    close(s.top, 0, -60);
    close(s.right, 80, 0);
    close(s.bottom, 0, 60);
    close(s.left, -80, 0);
  });

  it("pick the side facing the other end", () => {
    const s = boxSides(100, 100);
    expect(facingSide(s, { x: 500, y: 10 })).toBe("right");
    expect(facingSide(s, { x: -20, y: 400 })).toBe("bottom");
    expect(facingSide(s, { x: -300, y: -20 })).toBe("left");
  });
});

describe("lines", () => {
  it("measure the distance to a segment", () => {
    expect(distToSegment({ x: 50, y: 10 }, { x: 0, y: 0 }, { x: 100, y: 0 })).toBeCloseTo(10);
    expect(distToSegment({ x: 130, y: 40 }, { x: 0, y: 0 }, { x: 100, y: 0 })).toBeCloseTo(50);
  });

  it("snap to 45° steps", () => {
    close(snapAngle({ x: 0, y: 0 }, { x: 100, y: 8 }), 100.31948963187562, 0);
    const p = snapAngle({ x: 0, y: 0 }, { x: 100, y: 90 });
    expect(p.x).toBeCloseTo(p.y, 6);
  });
});
