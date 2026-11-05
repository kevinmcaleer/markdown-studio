import { describe, expect, it } from "vitest";
import { Matrix4, Vector3 } from "three";
import { allConnectors, connectorMesh, connectorOf, DEFAULT_CONNECTOR } from "./connectors";
import { normalizeScene, shownAs, type ScenePart } from "./model";
import { worldMatrices } from "./render";
import { leadLength, tubeTriangles, wireRoute } from "./wire";
import { nextWireColour, normalizeWire, type WireSpec } from "./wireSpec";

const part = (id: string, position: [number, number, number] = [0, 0, 0], extra: Partial<ScenePart> = {}): ScenePart => ({ id, name: id, position, rotation: [0, 0, 0], ...extra });
const spec = (over: Partial<WireSpec> = {}): WireSpec => ({
  from: { part: "a", point: [0, 0, 5], normal: [0, 0, 1] },
  to: { part: "b", point: [0, 0, 5], normal: [0, 0, 1] },
  waypoints: [],
  color: "#d33a2c",
  diameter: 2,
  slack: 0,
  ...over,
});

describe("connectors", () => {
  it("knows the STS3215 lead's housing", () => {
    const c = connectorOf(DEFAULT_CONNECTOR)!;
    expect(c.ways).toBe(3);
    expect(c.family.pitch).toBe(2.5);
    expect(connectorOf("jst-xh-99")).toBeNull();
  });

  it("makes every connector's model at its size, centred, with its mating face and wire exit", () => {
    for (const c of allConnectors()) {
      const m = connectorMesh(c.id);
      expect(m.positions.length % 9).toBe(0);
      const [w, h, l] = c.family.size(c.ways);
      expect(m.size[0]).toBeGreaterThanOrEqual(w - 1e-3);
      expect(m.size[1]).toBeGreaterThanOrEqual(h - 1e-3);
      expect(m.size[2]).toBeCloseTo(l, 3);
      // The mating face and the back are the two ends along Z.
      expect(m.contact[2]).toBeCloseTo(-l / 2, 3);
      expect(m.exit[2]).toBeCloseTo(l / 2, 3);
    }
  });
});

describe("wire route", () => {
  const mats = worldMatrices([part("a", [0, 0, 0]), part("b", [60, 0, 0])]);

  it("leaves each end straight out along its normal", () => {
    const r = wireRoute(spec({ slack: 10 }), mats)!;
    const lead = leadLength({ diameter: 2 });
    const first = r.centre[1].clone().sub(r.centre[0]).normalize();
    expect(first.z).toBeGreaterThan(0.95);
    const last = r.centre[r.centre.length - 2].clone().sub(r.centre[r.centre.length - 1]).normalize();
    expect(last.z).toBeGreaterThan(0.95);
    expect(r.controls[1].z).toBeCloseTo(5 + lead, 5);
  });

  it("bows the free span by its slack, up when both ends face up", () => {
    const tight = wireRoute(spec(), mats)!;
    const slack = wireRoute(spec({ slack: 20 }), mats)!;
    expect(slack.length - tight.length).toBeGreaterThan(12);
    expect(slack.length - tight.length).toBeLessThan(28);
    const top = Math.max(...slack.centre.map(p => p.z));
    expect(top).toBeGreaterThan(Math.max(...tight.centre.map(p => p.z)) + 5);
  });

  it("passes through a waypoint, lifted off its face by the radius", () => {
    const r = wireRoute(spec({ waypoints: [{ part: "a", point: [30, 20, 0], normal: [0, 0, 1] }] }), mats)!;
    const want = new Vector3(30, 20, 1);
    expect(Math.min(...r.centre.map(p => p.distanceTo(want)))).toBeLessThan(0.3);
  });

  it("follows its parts when a joint explodes", () => {
    const parts = [part("a"), part("b", [60, 0, 0], { parent: "a", joint: { normal: [1, 0, 0], distance: 40 } })];
    const shut = wireRoute(spec(), worldMatrices(parts, 0))!;
    const open = wireRoute(spec(), worldMatrices(parts, 1))!;
    expect(open.centre[open.centre.length - 1].x).toBeCloseTo(100, 3);
    expect(shut.centre[shut.centre.length - 1].x).toBeCloseTo(60, 3);
  });

  it("can't be laid without its end's part", () => {
    expect(wireRoute(spec(), new Map([["a", new Matrix4()]]))).toBeNull();
  });

  it("makes a closed tube", () => {
    const r = wireRoute(spec({ slack: 5 }), mats)!;
    const tris = tubeTriangles(r.centre, 1);
    expect(tris.length % 9).toBe(0);
    expect(tris.length).toBeGreaterThan(9 * 16 * 2 * 10);
  });
});

describe("wires saved", () => {
  it("normalises a wire and drops a broken one", () => {
    const w = normalizeWire({ ...spec(), diameter: 999, color: "nope", waypoints: [{ lift: 4 }, { junk: 1 }] })!;
    expect(w.diameter).toBe(20);
    expect(w.color).toBe("#d33a2c");
    expect(w.waypoints).toEqual([{ lift: 4 }]);
    expect(normalizeWire({ from: { part: "a" } })).toBeNull();
  });

  it("keeps a wire part at the origin and unjoined, and its sockets and plugs", () => {
    const s = normalizeScene({
      parts: [
        { id: "a", name: "Servo", position: [0, 0, 0], rotation: [0, 0, 0], sockets: [{ id: "s1", point: [1, 2, 3], normal: [0, 0, 2], connector: "molex-5264-3" }] },
        { id: "p", name: "Plug", position: [1, 1, 1], rotation: [0, 0, 0], parent: "a", plug: { connector: "molex-5264-3", socket: "s1" } },
        { id: "w", name: "Lead", position: [5, 5, 5], rotation: [10, 0, 0], parent: "a", url: "x.stl", wire: spec({ waypoints: [{ part: "gone", point: [0, 0, 0] }] }) },
      ],
      wiring: true,
    });
    expect(s.parts[0].sockets![0].normal).toEqual([0, 0, 1]);
    expect(s.parts[1].plug).toEqual({ connector: "molex-5264-3", socket: "s1" });
    const w = s.parts[2];
    expect(w.position).toEqual([0, 0, 0]);
    expect(w.parent).toBeUndefined();
    expect(w.url).toBeUndefined();
    expect(w.wire!.waypoints).toEqual([]);
    expect(s.wiring).toBe(true);
  });

  it("ghosts the other parts in the wiring view, and hides wiring when asked", () => {
    const servo = part("a");
    const lead = part("w", [0, 0, 0], { wire: spec() });
    expect(shownAs(servo, { wiring: true }).ghost).toBe(true);
    expect(shownAs(lead, { wiring: true }).ghost).toBeUndefined();
    expect(shownAs(lead, { hideWiring: true }).hidden).toBe(true);
    expect(shownAs(servo, { hideWiring: true }).hidden).toBeUndefined();
  });

  it("gives a new wire the next colour not used", () => {
    expect(nextWireColour([])).toBe("#d33a2c");
    expect(nextWireColour(["#D33A2C"])).toBe("#222222");
  });
});
