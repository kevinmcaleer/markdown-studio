import { type BufferGeometry, ExtrudeGeometry, LatheGeometry, Path, Shape, Vector2 } from "three";
import { describe, expect, it } from "vitest";
import { Topology } from "./snaps";
import { fitDiameter, fitLength, holeDepth, isHoleSnap, matchingHoles, normalizeScrew, screwLabel, screwMesh, screwName } from "./screw";

const soup = (g: BufferGeometry) => (g.index ? g.toNonIndexed() : g).getAttribute("position").array as ArrayLike<number>;

/** A 40 × 20 plate, `depth` thick, with round holes through it at these points. */
function plate(depth: number, holes: [number, number, number][]): Topology {
  const s = new Shape().moveTo(-20, -10).lineTo(20, -10).lineTo(20, 10).lineTo(-20, 10).lineTo(-20, -10);
  for (const [x, y, r] of holes) s.holes.push(new Path().absarc(x, y, r, 0, Math.PI * 2, true));
  return new Topology(soup(new ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: 32 })));
}

/** Signed volume of a closed mesh (positive when its triangles face out). */
function volume(pos: Float32Array): number {
  let v = 0;
  for (let i = 0; i < pos.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = pos.slice(i, i + 9);
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

describe("screws", () => {
  it("names them as they're sold", () => {
    expect(screwLabel({ d: 3, length: 8, head: "socket" })).toBe("M3 × 8");
    expect(screwName({ d: 2.5, length: 6, head: "button" })).toBe("M2.5 × 6 button screw");
  });

  it("keeps only real sizes", () => {
    expect(normalizeScrew({ d: 3, length: 8 })).toEqual({ d: 3, length: 8, head: "socket" });
    expect(normalizeScrew({ d: 3.5, length: 8 })).toBeNull();
    expect(normalizeScrew({ d: 3, length: 0 })).toBeNull();
    expect(normalizeScrew("M3")).toBeNull();
  });

  it("picks the biggest screw that goes through a hole", () => {
    expect(fitDiameter(1.6)).toBe(3); // a 3.2 mm clearance hole
    expect(fitDiameter(1.5)).toBe(3); // drawn at 3 mm
    expect(fitDiameter(1.25)).toBe(2.5);
    expect(fitDiameter(2.2)).toBe(4);
    expect(fitDiameter(0.5)).toBe(2);
    // A countersink as wide as an M3 head.
    expect(fitDiameter(3.4, "countersunk")).toBe(3);
  });

  it("fills a blind hole and goes through a plate with some to spare", () => {
    expect(fitLength(3, { depth: 9, through: false })).toBe(8);
    expect(fitLength(3, { depth: 3, through: true })).toBe(8);
    expect(fitLength(2, { depth: 2, through: true })).toBe(5);
  });

  it("measures a hole right through a plate", () => {
    const t = plate(3, [[8, 2, 1.6]]);
    const hole = holeDepth(t, [8, 2, 3], [0, 0, 1], 1.6);
    expect(hole.through).toBe(true);
    expect(hole.depth).toBeCloseTo(3, 2);
  });

  it("measures a blind hole", () => {
    // A round block 10 high (Y up) with a hole 6 deep in its top.
    const profile = [[0, -4], [10, -4], [10, 6], [1.5, 6], [1.5, 0], [0, 0]].map(([x, y]) => new Vector2(x, y));
    const t = new Topology(soup(new LatheGeometry(profile, 48)));
    const hole = holeDepth(t, [0, 6, 0], [0, 1, 0], 1.5);
    expect(hole.through).toBe(false);
    expect(hole.depth).toBeCloseTo(6, 2);
  });

  it("finds the other holes like one, facing the same way", () => {
    const t = plate(3, [[-15, -5, 1.6], [15, -5, 1.6], [-15, 5, 1.6], [15, 5, 1.6], [0, 0, 2.5]]);
    const top = t.faceAt([...Array(t.triangles).keys()].find(i => t.normalOf(i)[2] > 0.99)!)!;
    const ref = top.snaps.find(s => s.role === "hole" && Math.abs(s.radius! - 1.6) < 0.1)!;
    expect(isHoleSnap(ref)).toBe(true);
    const all = matchingHoles(t, ref);
    expect(all.length).toBe(4);
    all.forEach(s => expect(s.n[2]).toBeCloseTo(1, 3));
  });

  for (const head of ["socket", "button", "countersunk"] as const) {
    it(`makes a closed ${head} screw, centred, meeting the part at the head`, () => {
      const m = screwMesh({ d: 3, length: 8, head });
      expect(m.positions.length % 9).toBe(0);
      expect(volume(m.positions)).toBeGreaterThan(0);
      let lo = Infinity, hi = -Infinity, wide = 0;
      for (let i = 0; i < m.positions.length; i += 3) {
        lo = Math.min(lo, m.positions[i + 2]);
        hi = Math.max(hi, m.positions[i + 2]);
        wide = Math.max(wide, Math.hypot(m.positions[i], m.positions[i + 1]));
      }
      expect(lo + hi).toBeCloseTo(0, 5);
      // Overall: 8 under a socket or button head; 8 overall for countersunk.
      const overall = hi - lo;
      if (head === "countersunk") expect(overall).toBeCloseTo(8, 1);
      else expect(overall - 8).toBeGreaterThan(1);
      // The thread under the head is no wider than the screw.
      expect(wide).toBeGreaterThan(2.7);
      // The contact is 8 above the tip.
      expect(m.contact[2] - lo).toBeCloseTo(head === "countersunk" ? 8 : 8, 1);
      expect(m.normal).toEqual([0, 0, -1]);
    });
  }
});
