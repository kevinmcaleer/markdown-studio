import { describe, expect, it } from "vitest";
import { Matrix3, Matrix4, Vector3 } from "three";
import { allConnectors, connectorMesh, connectorOf, DEFAULT_CONNECTOR } from "./connectors";
import { normalizeScene, shownAs, type ScenePart } from "./model";
import { worldMatrices } from "./render";
import { cableRadius, coreLines, leadLength, ringRadius, tubeTriangles, wireMesh, wireRoute } from "./wire";
import { mirrorPartner, mirrorPlane, mirrorPoint } from "./wireMirror";
import { cableColours, connectionsOf, coresOf, nextWireColour, normalizeWire, type WireSpec } from "./wireSpec";

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

describe("cables", () => {
  const mats = worldMatrices([part("a", [0, 0, 0]), part("b", [80, 0, 0])]);
  const ends = {
    from: { part: "a", point: [0, 0, 5] as [number, number, number], normal: [0, 0, 1] as [number, number, number], row: [1, 0, 0] as [number, number, number], pitch: 2.5 },
    to: { part: "b", point: [0, 0, 5] as [number, number, number], normal: [0, 0, 1] as [number, number, number], row: [1, 0, 0] as [number, number, number], pitch: 2.5 },
  };
  const cable = (over: Partial<WireSpec> = {}) => spec({ ...ends, diameter: 1.2, slack: 10, cores: cableColours(3).map(color => ({ color })), ...over });

  it("keeps a cable's wires, the first one's colour its own", () => {
    const w = normalizeWire({ ...cable({ lay: "flat", twist: 99999 }), connection: "c1", cores: [{ color: "#f2c400", connection: "c1" }, { color: "bad" }, { color: "#222222" }] })!;
    expect(w.cores!.map(c => c.color)).toEqual(["#f2c400", "#222222", "#222222"]);
    expect(w.color).toBe("#f2c400");
    expect(w.connection).toBeUndefined();
    expect(w.lay).toBe("flat");
    expect(w.twist).toBe(3600);
    expect(w.from.pitch).toBe(2.5);
    expect(connectionsOf(w)).toEqual(["c1"]);
    // One core is a wire.
    const one = normalizeWire({ ...spec(), cores: [{ color: "#2f6fd6", connection: "c9" }] })!;
    expect(one.cores).toBeUndefined();
    expect(one.color).toBe("#2f6fd6");
    expect(connectionsOf(one)).toEqual(["c9"]);
  });

  it("sits a bundle's wires touching round the middle", () => {
    expect(ringRadius(1, 1)).toBe(0);
    expect(ringRadius(2, 1)).toBe(1);
    expect(ringRadius(3, 1)).toBeCloseTo(2 / Math.sqrt(3), 6);
    expect(cableRadius(cable())).toBeCloseTo(0.6 + ringRadius(3, 0.6), 6);
    expect(cableRadius(cable({ lay: "flat" }))).toBeCloseTo(0.6, 6);
  });

  it("leaves each plug side by side at its pins, and bundles in the middle", () => {
    const w = cable();
    const r = wireRoute(w, mats)!;
    const lines = coreLines(w, r);
    expect(lines).toHaveLength(3);
    // At the plug: one pin's spacing apart, along the row.
    expect(lines[1][0].distanceTo(r.centre[0])).toBeLessThan(1e-6);
    expect(lines[2][0].clone().sub(lines[0][0]).x).toBeCloseTo(5, 2);
    // In the middle: round it, touching.
    const mid = Math.floor(r.centre.length / 2);
    for (const l of lines) expect(l[mid].distanceTo(r.centre[mid])).toBeCloseTo(ringRadius(3, 0.6), 3);
  });

  it("lays a flat cable side by side, its wires touching", () => {
    const w = cable({ lay: "flat" });
    const r = wireRoute(w, mats)!;
    const lines = coreLines(w, r);
    const mid = Math.floor(r.centre.length / 2);
    expect(lines[0][mid].distanceTo(lines[1][mid])).toBeCloseTo(1.2, 3);
    expect(lines[1][mid].distanceTo(r.centre[mid])).toBeLessThan(1e-6);
    const last = r.centre.length - 1;
    expect(Math.abs(lines[2][last].clone().sub(lines[0][last]).x)).toBeCloseTo(5, 2);
  });

  it("colours each wire of a cable", () => {
    const m = wireMesh(part("w", [0, 0, 0], { wire: cable() }), mats);
    expect(m.colors.length).toBe(m.positions.length);
    const per = m.colors.length / 3;
    // Black's last: the third wire's corners are dark.
    expect(m.colors[per * 2 + 3]).toBeLessThan(0.05);
    // Yellow's first: red and green, little blue.
    expect(m.colors[0]).toBeGreaterThan(0.8);
    expect(coresOf(cable()).length).toBe(3);
  });
});

describe("mirroring a wire", () => {
  // A body in the middle, a leg either side; the right leg turned round.
  const parts = [
    part("body", [0, 0, 0]),
    part("left", [-40, 0, -20], { parent: "body" }),
    part("right", [40, 0, -20], { parent: "body", rotation: [0, 0, 180] }),
  ];
  const world = worldMatrices(parts, 0, false);

  it("finds the mirror across the middle, and each part's partner", () => {
    const plane = mirrorPlane(parts, world);
    expect(plane).toBeCloseTo(0, 6);
    expect(mirrorPartner(parts, world, "left", plane, 5)).toBe("right");
    expect(mirrorPartner(parts, world, "right", plane, 5)).toBe("left");
    expect(mirrorPartner(parts, world, "body", plane, 5)).toBe("body");
    expect(mirrorPartner([parts[0], parts[1]], world, "left", plane, 5)).toBeNull();
  });

  it("puts a point on the partner where the mirror does, in its frame", () => {
    const m = mirrorPoint([5, 2, 3], [1, 0, 0], world.get("left")!, world.get("right")!, 0);
    const at = new Vector3(...m.point).applyMatrix4(world.get("right")!);
    // The left leg's point at x -35 is the right leg's at x 35.
    expect(at.x).toBeCloseTo(35, 3);
    expect(at.y).toBeCloseTo(2, 3);
    expect(at.z).toBeCloseTo(-17, 3);
    // Its outward way, mirrored: +x on the left is -x on the right, in the world.
    const n = new Vector3(...m.normal!).applyMatrix3(new Matrix3().setFromMatrix4(world.get("right")!));
    expect(n.x).toBeCloseTo(-1, 4);
  });
});
