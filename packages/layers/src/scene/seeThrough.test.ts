import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { lookOf, normalizeScene, shownAs, type ScenePart } from "./model";
import { worldMatrices } from "./render";
import { electronicName, growsFromTo, seeThroughParts } from "./seeThrough";
import { growLine, wireMesh } from "./wire";
import { grownAt, swayAt, wirePlugs, wiringPlan, WIRING_TIMING } from "./wiringAnimation";

const part = (id: string, position: [number, number, number] = [0, 0, 0], extra: Partial<ScenePart> = {}): ScenePart => ({ id, name: id, position, rotation: [0, 0, 0], ...extra });
const wire = (id: string, from: string, to: string): ScenePart =>
  part(id, [0, 0, 0], { wire: { from: { part: from, point: [0, 0, 5], normal: [0, 0, 1] }, to: { part: to, point: [0, 0, 5], normal: [0, 0, 1] }, waypoints: [], color: "#d33a2c", diameter: 2, slack: 0 } });
const plug = (id: string, on: string): ScenePart => part(id, [0, 0, 0], { parent: on, plug: { connector: "molex-5264-3", socket: "s" } as ScenePart["plug"] });

describe("see-through view", () => {
  it("keeps the electronics solid and turns the printed parts to glass", () => {
    const parts = [
      part("chassis", [0, 0, 0], { name: "Chassis" }),
      part("lid", [0, 0, 0], { name: "top.stl" }),
      part("pico", [0, 0, 0], { name: "Raspberry Pi Pico" }),
      part("mount", [0, 0, 0], { name: "Motor mount" }),
      part("servo", [0, 0, 0], { name: "thing", wiringPart: "servo1" }),
      part("board", [0, 0, 0], { name: "thing 2", sockets: [] }),
      part("socketed", [0, 0, 0], { name: "thing 3", sockets: [{ id: "s", point: [0, 0, 0], normal: [0, 0, 1], connector: "molex-5264-3" } as never] }),
      part("battery", [0, 0, 0], { name: "pack" }),
      plug("p1", "battery"),
      wire("w1", "p1", "pico"),
      part("forced", [0, 0, 0], { name: "Arduino UNO", xray: "glass" }),
      part("kept", [0, 0, 0], { name: "Bracket", xray: "solid" }),
    ];
    const glass = seeThroughParts(parts);
    expect([...glass].sort()).toEqual(["board", "chassis", "forced", "lid", "mount"]);
  });

  it("turns a part named like electronics to glass when the real one is joined under it", () => {
    const parts = [
      part("front", [0, 0, 0], { name: "Ultrasonic sensor" }),
      part("inner", [0, 0, 0], { name: "ultrasonic", parent: "front" }),
      part("hc", [0, 0, 0], { name: "HC-SR04", parent: "inner", wiringPart: "us1" }),
      part("motor", [0, 0, 0], { name: "N20 motor" }),
      part("deck", [0, 0, 0], { name: "holding board" }),
    ];
    expect([...seeThroughParts(parts)].sort()).toEqual(["deck", "front", "inner"]);
  });

  it("knows electronics by name, but not the printed parts that hold them", () => {
    expect(electronicName("STS3215 servo")).toBe(true);
    expect(electronicName("n20_motor")).toBe(true);
    expect(electronicName("Arduino UNO R4 Minima")).toBe(true);
    expect(electronicName("Servo bracket")).toBe(false);
    expect(electronicName("battery-cover")).toBe(false);
    expect(electronicName("Leg")).toBe(false);
  });

  it("is kept with the scene, and the wiring view gives way to it", () => {
    const s = normalizeScene({ parts: [part("a", [0, 0, 0], { xray: "solid" }), part("b", [0, 0, 0], { xray: "nope" as never })], seeThrough: true, wiring: true });
    expect(s.seeThrough).toBe(true);
    expect(s.parts[0].xray).toBe("solid");
    expect(s.parts[1].xray).toBeUndefined();
    const look = lookOf(s);
    expect(look.seeThrough).toBe(true);
    // Not ghosted as the wiring view would: the glass is drawn instead.
    expect(shownAs(s.parts[0], look).ghost).toBeFalsy();
  });
});

describe("growing wires", () => {
  it("grows evenly along the line's length, its tip between points", () => {
    const line = [new Vector3(0, 0, 0), new Vector3(10, 0, 0), new Vector3(100, 0, 0)];
    const half = growLine(line, 0.5);
    expect(half[0].x).toBe(0);
    expect(half[half.length - 1].x).toBeCloseTo(50);
    expect(growLine(line, 1)).toBe(line);
  });

  it("grows from either end", () => {
    const parts = [part("a"), part("b", [100, 0, 0]), wire("w", "a", "b")];
    const world = worldMatrices(parts, 0);
    const xs = (fromTo: boolean) => {
      const p = wireMesh(parts[2], world, 0.3, undefined, fromTo).positions;
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < p.length; i += 3) {
        lo = Math.min(lo, p[i]);
        hi = Math.max(hi, p[i]);
      }
      return { lo, hi };
    };
    expect(xs(false).hi).toBeLessThan(50);
    expect(xs(true).lo).toBeGreaterThan(50);
  });

  it("grows out of the component, to the part the wires run back to", () => {
    const parts = [part("board"), part("s1", [50, 0, 0]), part("s2", [-50, 0, 0]), plug("p", "s2"), wire("w1", "s1", "board"), wire("w2", "board", "p")];
    expect(growsFromTo(parts[4], parts)).toBe(false);
    expect(growsFromTo(parts[5], parts)).toBe(true);
  });

  it("with no such part, grows upwards", () => {
    const parts = [part("top", [0, 0, 80]), part("bottom", [0, 0, 0]), wire("w", "top", "bottom")];
    expect(growsFromTo(parts[2], parts, worldMatrices(parts, 0))).toBe(true);
  });

  it("shows a wire's first plug as it sets off and its last as it gets there", () => {
    const parts = [part("a"), part("b"), plug("pa", "a"), plug("pb", "b"), wire("w", "pa", "pb")];
    expect(wirePlugs(parts[4], parts, false)).toEqual({ first: ["pa"], last: ["pb"] });
    expect(wirePlugs(parts[4], parts, true)).toEqual({ first: ["pb"], last: ["pa"] });
  });
});

describe("the wiring showcase's timing", () => {
  it("sets the wires off one after another, then holds and draws them back", () => {
    const { turns, total } = wiringPlan([{ id: "a", length: 90 }, { id: "b", length: 900 }, { id: "c", length: 1 }]);
    turns.forEach((t, i) => expect(t.start).toBeCloseTo([0.6, 0.95, 1.3][i]));
    expect(turns[0].grow).toBeCloseTo(1);
    expect(turns[1].grow).toBe(WIRING_TIMING.maxGrow);
    expect(turns[2].grow).toBe(WIRING_TIMING.minGrow);
    expect(total).toBeCloseTo(0.95 + 2.4 + WIRING_TIMING.hold + WIRING_TIMING.back);
    expect(grownAt(turns, total, 0)).toEqual([0, 0, 0]);
    expect(grownAt(turns, total, 1.2)[0]).toBeGreaterThan(0.5);
    expect(grownAt(turns, total, 1.2)[2]).toBe(0);
    expect(grownAt(turns, total, total - WIRING_TIMING.back - 0.1)).toEqual([1, 1, 1]);
    expect(grownAt(turns, total, total)).toEqual([0, 0, 0]);
  });

  it("sets many wires off closer together", () => {
    const { turns } = wiringPlan(Array.from({ length: 61 }, (_, i) => ({ id: `w${i}`, length: 100 })));
    expect(turns[60].start - turns[0].start).toBeCloseTo(WIRING_TIMING.maxGaps);
  });

  it("sways to and fro, ending where it started", () => {
    expect(swayAt(0, 10)).toBe(0);
    expect(swayAt(2.5, 10)).toBeCloseTo(WIRING_TIMING.sway / 360);
    expect(Math.abs(swayAt(10, 10))).toBeLessThan(1e-9);
  });
});
