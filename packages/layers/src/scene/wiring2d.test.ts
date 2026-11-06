import { describe, expect, it } from "vitest";
import type { ScenePart } from "./model";
import { normalizeScene } from "./model";
import {
  cableBetween,
  catalogSocketsFor,
  coloursFromDiagram,
  connectionColour,
  connectionsFor,
  diagramCables,
  diagramLabels,
  freePort,
  linkByName,
  missingWires,
  netOfPin,
  partsNotInScene,
  routedCount,
  type WiringInfo,
  type WiringPart,
} from "./wiring2d";

const servo = (id: string, name: string): WiringPart => ({
  id,
  name,
  slug: "sts3215-bus-servo",
  ports: ["1", "2"].map(n => ({ id: `bus-${n}`, name: `Bus port ${n}`, pins: ["D", "V", "G"].map(l => ({ name: `${l}${n}`, label: l })) })),
});

// Servo 1's second port to servo 2's first, as a 3-wire cable, its wires drawn any way round.
const info: WiringInfo = {
  parts: [servo("s1", "Servo 1"), servo("s2", "Servo 2"), { id: "pico", name: "Pico", ports: [] }],
  connections: [
    { id: "c1", from: "s2.G1", to: "s1.G2", net: "gnd", cable: "lead" },
    { id: "c2", from: "s1.D2", to: "s2.D1", color: "#F2C400", cable: "lead" },
    { id: "c3", from: "s1.V2", to: "s2.V1", net: "vcc", cable: "lead" },
    { id: "c4", from: "pico.GP0", to: "s1.D1", net: "signal", color: "#2f6fd6" },
  ],
};

const model = (over: Partial<ScenePart>[] = []): ScenePart[] =>
  normalizeScene({
    parts: [
      { id: "a", name: "Servo 1", position: [0, 0, 0], rotation: [0, 0, 0], wiringPart: "s1", sockets: [{ id: "x", point: [0, 0, 1], normal: [0, 0, 1], connector: "molex-5264-3", port: "bus-2" }] },
      { id: "b", name: "Servo 2", position: [50, 0, 0], rotation: [0, 0, 0], wiringPart: "s2", sockets: [{ id: "y", point: [0, 0, 1], normal: [0, 0, 1], connector: "molex-5264-3", port: "bus-1" }] },
      ...over,
    ],
  }).parts;

describe("the 2D wiring, in 3D", () => {
  it("runs a cable's wires together, in its from port's pin order", () => {
    const cables = diagramCables(info);
    expect(cables).toHaveLength(2);
    const lead = cables[0];
    expect(lead.from).toEqual({ part: "s2", port: "bus-1" });
    expect(lead.to).toEqual({ part: "s1", port: "bus-2" });
    // D V G along s2's bus-1, though c1 (G) was drawn first.
    expect(lead.connections.map(c => c.id)).toEqual(["c2", "c3", "c1"]);
    // A pin with no port is its own end.
    expect(cables[1].from).toEqual({ part: "pico", port: "pin:GP0" });
  });

  it("colours a wire as the diagram does, else by its net", () => {
    expect(connectionColour({ color: "#F2C400" })).toBe("#f2c400");
    expect(connectionColour({ net: "vcc" })).toBe("#d33a2c");
    expect(connectionColour({ net: "gnd" })).toBe("#222222");
    expect(connectionColour({ color: "red" })).toBe("#f2c400");
  });

  it("finds the cables it can add, with sockets at both ends", () => {
    const { wires, skipped } = missingWires(info, model());
    expect(skipped).toBe(1);
    expect(wires).toHaveLength(1);
    expect(wires[0].from.part).toBe("b");
    expect(wires[0].to.part).toBe("a");
    expect(wires[0].cores).toEqual([
      { color: "#f2c400", connection: "c2" },
      { color: "#d33a2c", connection: "c3" },
      { color: "#222222", connection: "c1" },
    ]);
    // Once a 3D wire is one of the cable's, it's routed.
    const routed = model([{ id: "w", name: "Lead", position: [0, 0, 0], rotation: [0, 0, 0], wire: { from: { part: "a", point: [0, 0, 0], normal: [0, 0, 1] }, to: { part: "b", point: [0, 0, 0], normal: [0, 0, 1] }, waypoints: [], color: "#f2c400", diameter: 1, slack: 0, cores: wires[0].cores } }]);
    expect(missingWires(info, routed).wires).toHaveLength(0);
    expect(routedCount(info, routed)).toEqual({ routed: 3, total: 4 });
  });

  it("finds the diagram's cable between two ports either way round", () => {
    const c = cableBetween(info, { part: "s1", port: "bus-2" }, { part: "s2", port: "bus-1" })!;
    expect(c.from.part).toBe("s1");
    expect(c.connections).toHaveLength(3);
    expect(cableBetween(info, { part: "s1", port: "bus-1" }, { part: "s2", port: "bus-2" })).toBeNull();
  });

  it("proposes a daisy chain's connections pin to pin by label", () => {
    const c = connectionsFor(info, { part: "s2", port: "bus-2" }, { part: "s1", port: "bus-1" }, ["#f2c400", "#d33a2c", "#222222"])!;
    expect(c.map(x => `${x.from}>${x.to}:${x.net}`)).toEqual(["s2.D2>s1.D1:signal", "s2.V2>s1.V1:vcc", "s2.G2>s1.G1:gnd"]);
    expect(new Set(c.map(x => x.cable)).size).toBe(1);
    expect(c[1].color).toBe("#d33a2c");
    expect(connectionsFor(info, { part: "s2", port: "bus-2" }, { part: "pico", port: "x" })).toBeNull();
    expect(netOfPin({ name: "GND" })).toBe("gnd");
    expect(netOfPin({ name: "VBUS" })).toBe("vcc");
    expect(netOfPin({ name: "GP4" })).toBe("signal");
  });

  it("follows the diagram's colours, and names each wire's pins", () => {
    const cores = coloursFromDiagram(info, [{ color: "#000000", connection: "c3" }, { color: "#8f8f8f" }])!;
    expect(cores.map(c => c.color)).toEqual(["#d33a2c", "#8f8f8f"]);
    expect(coloursFromDiagram(info, [{ color: "#000000" }])).toBeNull();
    expect(diagramLabels(info, [{ color: "#000", connection: "c2" }, { color: "#000" }])).toEqual(["Servo 1 D2 → Servo 2 D1", ""]);
  });

  it("links parts by name, picks a free port, and fits catalog sockets by size", () => {
    const parts = normalizeScene({ parts: [{ id: "a", name: "servo 1", position: [0, 0, 0], rotation: [0, 0, 0] }, { id: "b", name: "PICO", position: [0, 0, 0], rotation: [0, 0, 0] }, { id: "c", name: "Servo 2", position: [0, 0, 0], rotation: [0, 0, 0], wiringPart: "s2" }] }).parts;
    expect(linkByName(info, parts)).toEqual([{ part: "a", wiringPart: "s1" }, { part: "b", wiringPart: "pico" }]);
    expect(freePort(info.parts[0], 3, [{ id: "x", point: [0, 0, 0], normal: [0, 0, 1], connector: "molex-5264-3", port: "bus-1" }])).toBe("bus-2");
    expect(freePort(info.parts[2], 3, [])).toBeUndefined();
    const saved = { size: [24.7, 45.2, 35] as [number, number, number], sockets: [{ id: "s1", point: [0, 1, 2] as [number, number, number], normal: [0, 0, 1] as [number, number, number], connector: "molex-5264-3", port: "bus-1" }] };
    expect(catalogSocketsFor(saved, [24.9, 45, 35.2])).toHaveLength(1);
    expect(catalogSocketsFor(saved, [45.2, 24.7, 35])).toBeNull();
  });

  it("keeps a part's link to the diagram, but not a wire's", () => {
    expect(model()[0].wiringPart).toBe("s1");
    const w = normalizeScene({ parts: [{ id: "w", name: "W", position: [0, 0, 0], rotation: [0, 0, 0], wiringPart: "s1", wire: { from: { part: "a", point: [0, 0, 0], normal: [0, 0, 1] }, to: { part: "b", point: [0, 0, 0], normal: [0, 0, 1] } } }] }).parts[0];
    expect(w.wiringPart).toBeUndefined();
    expect(model()[0].sockets![0].port).toBe("bus-2");
  });

  it("lists the diagram's parts not in the scene, those with a catalog model apart", () => {
    const withBattery: WiringInfo = {
      ...info,
      parts: [...info.parts, { id: "bat", name: "9V battery", slug: "9v-battery", ports: [], model: { url: "/api/parts/9v-battery/mesh", file: "9v-battery.stl" } }, { id: "glb", name: "Odd", ports: [], model: { url: "/m", file: "odd.glb" } }],
    };
    // s1 and s2 are linked; "PICO" is the Pico by name.
    const parts = [...model(), ...normalizeScene({ parts: [{ id: "c", name: "PICO", position: [0, 0, 0], rotation: [0, 0, 0] }] }).parts];
    const got = partsNotInScene(withBattery, parts);
    expect(got.withModel.map(w => w.id)).toEqual(["bat"]);
    expect(got.noModel.map(w => w.id)).toEqual(["glb"]);
    expect(partsNotInScene(withBattery, model()).noModel.map(w => w.id)).toEqual(["pico", "glb"]);
  });
});
