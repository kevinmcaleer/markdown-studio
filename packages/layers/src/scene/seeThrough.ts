// The see-through view (as tnkr.ai shows a robot's wiring): the printed
// parts go glassy, so the electronics inside them and the wires between
// them show. This file works out which parts stay solid and which way each
// wire grows when it's put in; render.ts draws the glass.

import type { Matrix4 } from "three";
import type { ScenePart } from "./model";

/**
 * Names that mark a part as electronics, for a part that isn't on the
 * wiring diagram (a board or motor dropped in from a file, say).
 */
const ELECTRONIC_NAME = /\b(servos?|motors?|steppers?|pcb|boards?|arduino|pico|esp32|esp8266|raspberry|rpi|teensy|microbit|micro:bit|batter(y|ies)|lipo|18650|sensors?|cameras?|leds?|neopixels?|displays?|oled|lcd|speakers?|buzzer|switch(es)?|buttons?|drivers?|modules?|shield|breadboard|buck|regulator|n20|sts3215|sg90|mg90s?|mg996r?|ultrasonic|hc-sr04|lidar|imu|mpu6050|bno055|encoder|relay|potentiometer|antenna|wires?|cables?|plugs?|connectors?|headers?|jst|dupont|molex)\b/i;

/** Names of the printed parts that hold electronics ("Motor mount", "Battery cover"): those stay see-through. */
const HOLDER_NAME = /\b(mounts?|mounting|brackets?|holders?|covers?|case|casing|housing|lids?|plates?|horns?|clips?|trays?|box|frame|enclosure|stand|arms?|shell|bumper|spacers?|standoffs?|risers?|supports?|holding|holds|decks?|platforms?|cradle|clamps?|caps?|guards?|chassis|body|base|shroud|sleeve|adapter|pulley|wheels?|gears?|legs?|feet|foot|head)\b/i;

/** Whether a part's name says it's electronics (and not something printed to hold them). */
export function electronicName(name: string): boolean {
  const n = name.replace(/[_-]+/g, " ");
  return ELECTRONIC_NAME.test(n) && !HOLDER_NAME.test(n);
}

/**
 * The parts drawn see-through in the see-through view: every part but the
 * electronics. Electronics are the wiring (wires and plugs), a part on the
 * wiring diagram, a part with sockets, a part a wire ends on, and a part
 * whose name says so, unless one of those is joined under it (then it's the
 * printed part holding it). A part's own `xray` setting wins.
 */
export function seeThroughParts(parts: ScenePart[]): Set<string> {
  const byId = new Map(parts.map(p => [p.id, p]));
  const solid = new Set<string>();
  const ownerOf = (id: string) => {
    const p = byId.get(id);
    // A plug's part is the one it's plugged into.
    return p?.plug && p.parent ? p.parent : id;
  };
  for (const p of parts) {
    if (p.wire) {
      solid.add(ownerOf(p.wire.from.part));
      solid.add(ownerOf(p.wire.to.part));
    }
  }
  // Known for sure: on the wiring diagram, with sockets, or wired to.
  const sure = (p: ScenePart) => !!(p.wiringPart || p.sockets?.length || solid.has(p.id));
  // A part named like electronics that has the real thing joined under it
  // ("Ultrasonic sensor" holding the HC-SR04) is what holds it: printed.
  const holdsSure = new Set<string>();
  for (const p of parts) {
    if (!sure(p)) continue;
    const seen = new Set<string>();
    for (let up = p.parent; up && !seen.has(up); up = byId.get(up)?.parent) {
      seen.add(up);
      holdsSure.add(up);
    }
  }
  const out = new Set<string>();
  for (const p of parts) {
    if (p.xray === "solid" || p.wire || p.plug) continue;
    if (p.xray === "glass") {
      out.add(p.id);
      continue;
    }
    if (sure(p) || (electronicName(p.name || "") && !holdsSure.has(p.id))) continue;
    out.add(p.id);
  }
  return out;
}

/**
 * Which end a wire grows from as it's put in: out of the component, up to
 * where it ends. The end on the part more wires end on (the board they all
 * run back to) is where it ends; with no such part, it grows upwards, from
 * the lower end. True: it grows from its `to` end.
 */
export function growsFromTo(wire: ScenePart, parts: ScenePart[], world?: Map<string, Matrix4>): boolean {
  if (!wire.wire) return false;
  const byId = new Map(parts.map(p => [p.id, p]));
  const ownerOf = (id: string) => {
    const p = byId.get(id);
    return p?.plug && p.parent ? p.parent : id;
  };
  const ends = new Map<string, number>();
  for (const p of parts) {
    if (!p.wire || p.hidden) continue;
    for (const id of new Set([ownerOf(p.wire.from.part), ownerOf(p.wire.to.part)])) ends.set(id, (ends.get(id) || 0) + 1);
  }
  const from = ownerOf(wire.wire.from.part);
  const to = ownerOf(wire.wire.to.part);
  const a = ends.get(from) || 0;
  const b = ends.get(to) || 0;
  if (a !== b) return a > b;
  const z = (end: { part: string; point: [number, number, number] }) => {
    const m = world?.get(end.part);
    if (!m) return 0;
    const e = m.elements;
    const [x, y, zz] = end.point;
    return e[2] * x + e[6] * y + e[10] * zz + e[14];
  };
  return z(wire.wire.to) < z(wire.wire.from) - 1e-6;
}
