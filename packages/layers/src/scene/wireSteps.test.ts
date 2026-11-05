import { describe, expect, it } from "vitest";
import { Line3, Vector3 } from "three";
import { blankDoc, nextStepDoc } from "../doc";
import { lookOf, normalizeScene, shownAs, type ScenePart } from "./model";
import { worldMatrices } from "./render";
import { MIN_BEND, tightestBend, wireLength, wireMesh, wireRoute } from "./wire";
import { CUT_ALLOWANCE, wireListMarkdown, wireListOf } from "./wireList";
import { loomsOf, normalizeWire, type WireSpec } from "./wireSpec";

const part = (id: string, position: [number, number, number] = [0, 0, 0], extra: Partial<ScenePart> = {}): ScenePart => ({ id, name: id, position, rotation: [0, 0, 0], ...extra });
const wire = (id: string, from: string, to: string, over: Partial<WireSpec> = {}): ScenePart =>
  part(id, [0, 0, 0], {
    wire: { from: { part: from, point: [0, 0, 5], normal: [0, 0, 1] }, to: { part: to, point: [0, 0, 5], normal: [0, 0, 1] }, waypoints: [], color: "#d33a2c", diameter: 2, slack: 0, ...over },
  });
const plug = (id: string, on: string): ScenePart => part(id, [0, 0, 0], { parent: on, plug: { connector: "molex-5264-3", socket: "s" } as ScenePart["plug"] });

/** How far `q` is from the line through `pts`. */
const offLine = (pts: Vector3[], q: Vector3) => {
  let best = Infinity;
  const seg = new Line3();
  const at = new Vector3();
  for (let i = 1; i < pts.length; i++) {
    seg.set(pts[i - 1], pts[i]).closestPointToPoint(q, true, at);
    best = Math.min(best, at.distanceTo(q));
  }
  return best;
};

describe("wiring steps", () => {
  const parts = () => [part("base"), part("arm", [100, 0, 0]), plug("p1", "base"), plug("p2", "arm"), plug("p3", "arm"), wire("w1", "p1", "p2"), wire("w2", "p1", "p3"), wire("w3", "base", "arm")];

  it("shows the step's wire and its plugs, earlier wires grey, later ones out", () => {
    const look = lookOf({ parts: parts(), wireStep: "w2" });
    const ps = parts();
    const as = (id: string) => shownAs(ps.find(p => p.id === id)!, look);
    expect(as("w1").ghost).toBe(true);
    expect(as("w2").ghost).toBeFalsy();
    expect(as("w2").hidden).toBeFalsy();
    expect(as("w3").hidden).toBe(true);
    // p1 is on the earlier wire and this one: drawn as this one's.
    expect(as("p1").ghost).toBeFalsy();
    expect(as("p3").hidden).toBeFalsy();
    expect(as("p2").ghost).toBe(true);
    expect(as("base").ghost).toBe(true);
    // No step: as the parts say.
    expect(lookOf({ parts: parts() }).step).toBeUndefined();
  });

  it("keeps a wiring step only when it names a wire", () => {
    expect(normalizeScene({ parts: parts(), wireStep: "w2" }).wireStep).toBe("w2");
    expect(normalizeScene({ parts: parts(), wireStep: "base" }).wireStep).toBeUndefined();
  });

  it("goes on to the next wire for the next step, and a plain step after the last", () => {
    const doc = (step: string) => ({ ...blankDoc(), objects: [{ type: "SceneLayer", scene: { parts: parts(), wireStep: step } }] });
    const scene = (d: ReturnType<typeof nextStepDoc>) => (d.objects[0] as { scene: { parts: ScenePart[]; wireStep?: string } }).scene;
    expect(scene(nextStepDoc(doc("w1"))).wireStep).toBe("w2");
    const last = scene(nextStepDoc(doc("w3")));
    expect(last.wireStep).toBeUndefined();
    expect(last.parts.find(p => p.id === "base")!.ghost).toBe(true);
  });
});

describe("wire lengths and bends", () => {
  it("lists each wire with its ends (a plug by its part) and a cut length", () => {
    const ps = [part("base"), part("arm", [100, 0, 0]), plug("p1", "base"), wire("w1", "p1", "arm", { cores: [{ color: "#f2c400" }, { color: "#d33a2c" }, { color: "#222222" }] })];
    const [row] = wireListOf(ps);
    expect(row.from).toBe("base");
    expect(row.to).toBe("arm");
    expect(row.length).toBeGreaterThan(100);
    expect(row.cut).toBe(Math.ceil(row.length + 2 * CUT_ALLOWANCE));
    const md = wireListMarkdown([row]);
    expect(md).toContain("| w1 | base | arm | 3 wires: Yellow, Red, Black | 2 |");
    expect(md).toContain(`| ${row.cut} |`);
    expect(wireListMarkdown([])).toBe("");
  });

  it("finds a wire's tightest bend, and none on a straight run", () => {
    const straight = { centre: Array.from({ length: 50 }, (_, i) => new Vector3(i, 0, 0)), length: 49 };
    expect(tightestBend(straight, 2)).toBeNull();
    // A quarter circle of radius 10.
    const centre = Array.from({ length: 60 }, (_, i) => {
      const a = (i / 59) * (Math.PI / 2);
      return new Vector3(10 * Math.cos(a), 10 * Math.sin(a), 0);
    });
    const bend = tightestBend({ centre, length: (Math.PI / 2) * 10 }, 2)!;
    expect(bend.radius).toBeCloseTo(10, 0);
    expect(MIN_BEND).toBe(3);
  });

  it("warns of a hairpin in the wire list", () => {
    // Out of a face and straight back into the one beside it.
    const ps = [part("a"), part("b", [6, 0, 0]), wire("w", "a", "b", { diameter: 3 })];
    expect(wireListOf(ps)[0].tightBend).toBeGreaterThan(0);
    const easy = [part("a"), part("b", [200, 0, 0]), wire("w", "a", "b", { diameter: 1 })];
    expect(wireListOf(easy)[0].tightBend).toBeUndefined();
  });
});

describe("wires in a loom", () => {
  const ps = () => [
    part("a"),
    part("b", [200, 0, 0]),
    part("c", [0, 30, 0]),
    part("d", [200, 30, 0]),
    wire("trunk", "a", "b"),
    wire("branch", "c", "d", { waypoints: [{ along: { wire: "trunk", from: 0.2, to: 0.8 } }] }),
  ];

  it("keeps a waypoint along another wire, and drops one along a wire that isn't there", () => {
    expect(normalizeWire({ ...ps()[5].wire, waypoints: [{ along: { wire: "trunk", from: 0.2, to: 2 } }, { along: { wire: "x", from: 0.5, to: 0.5 } }] })!.waypoints).toEqual([{ along: { wire: "trunk", from: 0.2, to: 1 } }]);
    const n = normalizeScene({ parts: [...ps().slice(0, 4), wire("branch", "c", "d", { waypoints: [{ along: { wire: "gone", from: 0, to: 1 } }] })] }).parts;
    expect(n.find(p => p.id === "branch")!.wire!.waypoints).toEqual([]);
  });

  it("runs beside the other wire for its stretch, touching it", () => {
    const parts = ps();
    const mats = worldMatrices(parts, 0);
    const looms = loomsOf(parts);
    const trunk = wireRoute(parts[4].wire!, mats)!;
    const branch = wireRoute(parts[5].wire!, mats, looms)!;
    // Its middle stretch is a wire's width (both radii) off the trunk's middle.
    const mid = branch.centre[Math.floor(branch.centre.length / 2)];
    const near = offLine(trunk.centre, mid);
    expect(near).toBeGreaterThan(1.8);
    expect(near).toBeLessThan(2.2);
    // On its own it runs 30 mm away.
    const alone = wireRoute(parts[5].wire!, mats)!;
    const far = alone.centre[Math.floor(alone.centre.length / 2)];
    expect(offLine(trunk.centre, far)).toBeGreaterThan(20);
    expect(wireLength(parts[5], mats, looms)).toBeGreaterThan(wireLength(parts[5], mats));
    expect(wireMesh(parts[5], mats, 1, looms).positions.length).toBeGreaterThan(0);
  });

  it("doesn't bow the stretch in the loom, though the wire has slack", () => {
    const parts = ps();
    parts[5].wire!.slack = 40;
    const mats = worldMatrices(parts, 0);
    const trunk = wireRoute(parts[4].wire!, mats)!;
    const branch = wireRoute(parts[5].wire!, mats, loomsOf(parts))!;
    const mid = branch.centre[Math.floor(branch.centre.length / 2)];
    expect(offLine(trunk.centre, mid)).toBeLessThan(2.2);
  });
});
