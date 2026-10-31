import { describe, expect, it } from "vitest";
import { snap } from "./snap";

const page = { left: 0, top: 0, width: 1000, height: 500 };

describe("snap", () => {
  it("centres on the page within the threshold", () => {
    const r = snap({ left: 447, top: 10, width: 100, height: 50 }, page, [], 6);
    expect(r.dx).toBe(3);
    expect(r.dy).toBe(0); // the top edge is 10 away, past the threshold
    expect(r.guides.some(g => g.axis === "x" && g.at === 500)).toBe(true);
  });

  it("snaps edges to another layer and picks the nearest", () => {
    const other = { left: 200, top: 300, width: 100, height: 100 };
    const r = snap({ left: 302, top: 196, width: 50, height: 50 }, page, [other], 6);
    expect(r.dx).toBe(-2); // left edge to other's right edge
    expect(r.dy).toBe(4); // bottom edge to other's top
    expect(r.guides.map(g => g.axis).sort()).toEqual(["x", "y"]);
  });

  it("leaves a far-away layer alone", () => {
    const r = snap({ left: 120, top: 120, width: 30, height: 30 }, page, [], 6);
    expect(r).toEqual({ dx: 0, dy: 0, guides: [] });
  });
});
