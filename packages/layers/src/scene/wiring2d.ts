// The project's 2D wiring diagram, as 3D scenes see it (no three.js here).
//
// The host (kevsrobots' project editor) draws the wiring in Snakie's
// electronics workspace: placed parts with pins, and connections from pin
// to pin ("servo1.D1" to "servo2.D2"), each with a net and a colour, the
// wires of one cable sharing a `cable` id. A 3D wire links to them by id
// (its cores' `connection`), so its colours come from the diagram; a model
// part links to a placed part (`wiringPart`), and a socket on it to one of
// that part's ports (a header group: an STS3215's "bus-1", D1 V1 G1), the
// port's pins in the plug's order.
//
// Either can come first: "Add missing wires" makes a 3D cable for each of
// the diagram's that has sockets at both ends, and a 3D wire made first can
// add its connections to the diagram.

import type { ScenePart, Vec3 } from "./model";
import { connectionsOf, coresOf, isBarePin, type PartSocket, type WireCore } from "./wireSpec";

export interface WiringPin {
  /** The pin's name on its part ("D1"): what connections name. */
  name: string;
  /** What's printed by it ("D"). */
  label?: string;
}

/** A group of a part's pins a plug goes on: a header group, or a connector. */
export interface WiringPort {
  id: string;
  name: string;
  /** In order along the header: pin 1 first. */
  pins: WiringPin[];
}

/** A part placed in the wiring diagram. */
export interface WiringPart {
  /** Its id in the diagram ("servo1"). */
  id: string;
  name: string;
  /** Its catalog part, when it's one. */
  slug?: string;
  ports: WiringPort[];
  /** Sockets the catalog part keeps for its model (see {@link CatalogSockets}). */
  sockets?: CatalogSockets | null;
  /**
   * The catalog part's 3D model, when it has one a scene can show: where to
   * fetch it, and a file name saying what it is ("9v-battery.stl").
   */
  model?: { url: string; file: string; thumbnail?: string | (() => Promise<Blob | string | null | undefined>) } | null;
}

export interface WiringConnection {
  id: string;
  /** "<part id>.<pin name>". */
  from: string;
  to: string;
  net?: "vcc" | "gnd" | "signal" | string;
  color?: string;
  cable?: string;
}

export interface WiringInfo {
  parts: WiringPart[];
  connections: WiringConnection[];
}

/**
 * A catalog part's sockets, as a model of it has them: the model's size
 * (mm, as it's centred) says which model they're for, as another file of the
 * same part may be drawn another way round.
 */
export interface CatalogSockets {
  size: Vec3;
  sockets: PartSocket[];
}

/** What the host offers a 3D scene of its 2D wiring. */
export interface WiringHost {
  /** The diagram as it's saved (null: there isn't one). */
  load(): Promise<WiringInfo | null>;
  /** Adds these connections to the diagram (and saves it); resolves with them as saved, ids and all. */
  addConnections?(connections: Omit<WiringConnection, "id">[]): Promise<WiringConnection[]>;
  /** Opens the diagram, at this connection when there's one. */
  open?(connection?: string): void;
  /** Keeps a model's sockets on its catalog part, for every project that uses it. */
  saveSockets?(slug: string, sockets: CatalogSockets): Promise<void>;
}

/** "servo1.D1" as its part and pin. */
export function splitPin(ref: string): { part: string; pin: string } {
  const at = ref.indexOf(".");
  return at < 0 ? { part: ref, pin: "" } : { part: ref.slice(0, at), pin: ref.slice(at + 1) };
}

/** A connection's colour in 3D: its own, else its net's (red power, black ground). */
export function connectionColour(c: Pick<WiringConnection, "color" | "net">): string {
  if (c.color && /^#[0-9a-f]{3,8}$/i.test(c.color)) return c.color.toLowerCase();
  if (c.net === "vcc") return "#d33a2c";
  if (c.net === "gnd") return "#222222";
  return "#f2c400";
}

/** The port a pin is on, and where along it. */
export function portOfPin(part: WiringPart | undefined, pin: string): { port: WiringPort; index: number } | null {
  for (const port of part?.ports || []) {
    const index = port.pins.findIndex(p => p.name === pin);
    if (index >= 0) return { port, index };
  }
  return null;
}

/**
 * A part's port by id; "pin:<name>" is one pin on its own (a lone pin, or a
 * bare pin of a port wired by itself), as a port of that one pin.
 */
export function portById(part: WiringPart | undefined, id: string): WiringPort | null {
  if (!part) return null;
  if (id.startsWith("pin:")) {
    const name = id.slice(4);
    const pin = part.ports.flatMap(p => p.pins).find(p => p.name === name);
    return { id, name: pin?.label && pin.label !== name ? `${name} (${pin.label})` : name, pins: [pin || { name }] };
  }
  return part.ports.find(p => p.id === id) || null;
}

/** Whether a pin is on this diagram end (its port, or the lone pin it is). */
function endHasPin(part: WiringPart | undefined, end: DiagramEnd, ref: { part: string; pin: string }): boolean {
  if (ref.part !== end.part) return false;
  if (end.port === `pin:${ref.pin}`) return true;
  return portOfPin(part, ref.pin)?.port.id === end.port;
}

/** One end of a cable in the diagram: a placed part's port (or a lone pin's). */
export interface DiagramEnd {
  part: string;
  port: string;
}

/** A cable in the diagram: its connections between two ports, in the from port's pin order. */
export interface DiagramCable {
  from: DiagramEnd;
  to: DiagramEnd;
  connections: WiringConnection[];
}

/**
 * The diagram's connections as cables: the wires sharing a `cable` id, and
 * the wires between the same two ports, run together; each on its own
 * otherwise. Each cable's ends are its first connection's, and its wires
 * are in the order of their pins on the from end.
 */
export function diagramCables(info: WiringInfo): DiagramCable[] {
  const parts = new Map(info.parts.map(p => [p.id, p]));
  const endOf = (ref: string): DiagramEnd & { index: number } => {
    const { part, pin } = splitPin(ref);
    const on = portOfPin(parts.get(part), pin);
    return on ? { part, port: on.port.id, index: on.index } : { part, port: `pin:${pin}`, index: 0 };
  };
  const key = (e: DiagramEnd) => `${e.part}\u0000${e.port}`;
  const groups = new Map<string, { from: DiagramEnd; to: DiagramEnd; items: { c: WiringConnection; index: number }[] }>();
  for (const c of info.connections) {
    let a = endOf(c.from);
    let b = endOf(c.to);
    const pair = [key(a), key(b)].sort().join("\u0001");
    const id = c.cable ? `cable:${c.cable}` : `ports:${pair}`;
    let g = groups.get(id);
    if (!g) {
      g = { from: { part: a.part, port: a.port }, to: { part: b.part, port: b.port }, items: [] };
      groups.set(id, g);
    }
    // Each wire the cable's way round.
    if (key(a) !== key(g.from) && key(b) === key(g.from)) [a, b] = [b, a];
    g.items.push({ c, index: a.index });
  }
  return [...groups.values()].map(g => ({
    from: g.from,
    to: g.to,
    connections: g.items.sort((x, y) => x.index - y.index).map(x => x.c),
  }));
}

/** The diagram's connections the 3D wires are (routed), and how many it has. */
export function routedCount(info: WiringInfo, parts: ScenePart[]): { routed: number; total: number } {
  const have = new Set(parts.flatMap(p => (p.wire ? connectionsOf(p.wire) : [])));
  return { routed: info.connections.filter(c => have.has(c.id)).length, total: info.connections.length };
}

/** A socket in the model a diagram end can go in. */
export interface ModelEnd {
  part: string;
  socket: PartSocket;
}

/** The socket for a diagram end: on the model part linked to its placed part, a plug's for its port. */
export function socketFor(parts: ScenePart[], end: DiagramEnd): ModelEnd | null {
  if (end.port.startsWith("pin:")) return pinSocketFor(parts, end.part, end.port.slice(4));
  for (const p of parts) {
    if (p.wiringPart !== end.part || !p.sockets) continue;
    const s = p.sockets.find(x => x.port === end.port && !isBarePin(x));
    if (s) return { part: p.id, socket: s };
  }
  return null;
}

/** The bare pin a diagram pin is on the model, if it's been placed: on the model part linked to its placed part. */
export function pinSocketFor(parts: ScenePart[], part: string, pin: string): ModelEnd | null {
  for (const p of parts) {
    if (p.wiringPart !== part || !p.sockets) continue;
    const s = p.sockets.find(x => isBarePin(x) && x.pin === pin);
    if (s) return { part: p.id, socket: s };
  }
  return null;
}

/** How far each of a port's pins is placed on a model part: by a plug's socket, or pin by pin. */
export interface PortPlacement {
  port: WiringPort;
  /** The plug's socket for the port, when it has one. */
  plug?: PartSocket;
  /** Its pins placed as bare pins, by pin name. */
  pins: Map<string, PartSocket>;
}

/** Each of a placed part's ports as a model part has them placed. */
export function portPlacements(part: WiringPart | undefined, sockets: PartSocket[] | undefined): PortPlacement[] {
  return (part?.ports || []).map(port => {
    const pins = new Map<string, PartSocket>();
    for (const s of sockets || []) if (isBarePin(s) && s.pin && port.pins.some(q => q.name === s.pin)) pins.set(s.pin, s);
    const plug = (sockets || []).find(s => s.port === port.id && !isBarePin(s));
    return plug ? { port, plug, pins } : { port, pins };
  });
}

/**
 * A 3D cable "Add missing wires" would make. A wire of one of the diagram's
 * connections, when an end is a bare pin, ends on that pin; at a plug, on
 * its pin `fromIndex`/`toIndex` along the plug (pin 1 is 0).
 */
export interface MissingWire {
  cable: DiagramCable;
  from: ModelEnd;
  to: ModelEnd;
  cores: WireCore[];
  fromIndex?: number;
  toIndex?: number;
}

/**
 * What "Add missing wires" makes: a 3D cable for each of the diagram's not
 * routed yet with a plug's socket for its port at both ends; where either
 * end's pins are placed one by one (bare pins: a motor's tabs, a screw
 * terminal), a wire for each of its connections instead, pin to pin (or to
 * its pin's place on a plug). `skipped` counts the cables it can't, for
 * want of a linked part, a socket for the port or a placed pin.
 */
export function missingWires(info: WiringInfo, parts: ScenePart[]): { wires: MissingWire[]; skipped: number } {
  const routed = new Set(parts.flatMap(p => (p.wire ? connectionsOf(p.wire) : [])));
  const placed = new Map(info.parts.map(p => [p.id, p]));
  const wires: MissingWire[] = [];
  let skipped = 0;
  for (const cable of diagramCables(info)) {
    if (cable.connections.some(c => routed.has(c.id))) continue;
    const from = socketFor(parts, cable.from);
    const to = socketFor(parts, cable.to);
    if (from && to && !isBarePin(from.socket) && !isBarePin(to.socket)) {
      if (from.part === to.part && from.socket.id === to.socket.id) {
        skipped++;
        continue;
      }
      wires.push({ cable, from, to, cores: cable.connections.map(c => ({ color: connectionColour(c), connection: c.id })) });
      continue;
    }
    // Pin by pin: each connection's ends, each on its bare pin or its place on the port's plug.
    const one: MissingWire[] = [];
    const endOf = (end: DiagramEnd, plug: ModelEnd | null, ref: { part: string; pin: string }): { at: ModelEnd; index?: number } | null => {
      const bare = pinSocketFor(parts, ref.part, ref.pin);
      if (bare) return { at: bare };
      if (!plug || isBarePin(plug.socket)) return null;
      const on = portOfPin(placed.get(ref.part), ref.pin);
      return on && on.port.id === end.port ? { at: plug, index: on.index } : null;
    };
    for (const c of cable.connections) {
      let a = splitPin(c.from);
      let b = splitPin(c.to);
      if (!endHasPin(placed.get(cable.from.part), cable.from, a)) [a, b] = [b, a];
      const x = endOf(cable.from, from, a);
      const y = endOf(cable.to, to, b);
      if (!x || !y || (x.at.part === y.at.part && x.at.socket.id === y.at.socket.id && x.index === y.index)) break;
      const w: MissingWire = { cable: { ...cable, connections: [c] }, from: x.at, to: y.at, cores: [{ color: connectionColour(c), connection: c.id }] };
      if (x.index !== undefined) w.fromIndex = x.index;
      if (y.index !== undefined) w.toIndex = y.index;
      one.push(w);
    }
    if (one.length === cable.connections.length) wires.push(...one);
    else skipped++;
  }
  return { wires, skipped };
}

/** The diagram's cable between these two ports (either way round), if it has one. */
export function cableBetween(info: WiringInfo, a: DiagramEnd, b: DiagramEnd): DiagramCable | null {
  if (a.port.startsWith("pin:") || b.port.startsWith("pin:")) {
    // A bare pin's end: the connections between exactly these pins.
    const placed = new Map(info.parts.map(p => [p.id, p]));
    const connections = info.connections.flatMap(c => {
      const x = splitPin(c.from);
      const y = splitPin(c.to);
      const fwd = endHasPin(placed.get(a.part), a, x) && endHasPin(placed.get(b.part), b, y);
      const back = endHasPin(placed.get(a.part), a, y) && endHasPin(placed.get(b.part), b, x);
      return fwd || back ? [c] : [];
    });
    return connections.length ? { from: a, to: b, connections } : null;
  }
  const same = (x: DiagramEnd, y: DiagramEnd) => x.part === y.part && x.port === y.port;
  for (const c of diagramCables(info)) {
    if (same(c.from, a) && same(c.to, b)) return c;
    if (same(c.from, b) && same(c.to, a)) return { from: c.to, to: c.from, connections: c.connections };
  }
  return null;
}

/** The net a pin's label suggests: power, ground or signal. */
export function netOfPin(pin: WiringPin): "vcc" | "gnd" | "signal" {
  const t = `${pin.label || ""} ${pin.name}`.toUpperCase();
  if (/\b(G|GND|GROUND|VSS|0V|-)\b/.test(t) || /^G\d*$/.test(pin.name.toUpperCase())) return "gnd";
  if (/\b(V|VCC|VIN|VDD|VBAT|VBUS|5V|3V3|3\.3V|12V|\+)\b/.test(t) || /^V\d*$/.test(pin.name.toUpperCase())) return "vcc";
  return "signal";
}

/**
 * The connections a cable between two ports would add to the diagram:
 * pin to pin by label where the labels match (D to D, V to V, G to G, as a
 * bus servo's daisy chain), else in order. Null when the ports don't fit
 * (a different number of pins).
 */
export function connectionsFor(info: WiringInfo, a: DiagramEnd, b: DiagramEnd, colours?: string[]): Omit<WiringConnection, "id">[] | null {
  const pa = portById(info.parts.find(p => p.id === a.part), a.port);
  const pb = portById(info.parts.find(p => p.id === b.part), b.port);
  if (!pa || !pb || !pa.pins.length || pa.pins.length !== pb.pins.length) return null;
  const label = (p: WiringPin) => (p.label || p.name).toUpperCase();
  const byLabel = pa.pins.every(p => pb.pins.filter(q => label(q) === label(p)).length === 1);
  const cable = pa.pins.length > 1 ? `${a.part}-${a.port}-${b.part}-${b.port}`.slice(0, 40) : undefined;
  return pa.pins.map((p, i) => {
    const q = byLabel ? pb.pins.find(x => label(x) === label(p))! : pb.pins[i];
    const net = netOfPin(p);
    const c: Omit<WiringConnection, "id"> = { from: `${a.part}.${p.name}`, to: `${b.part}.${q.name}`, net };
    const colour = colours?.[i];
    if (colour) c.color = colour;
    if (cable) c.cable = cable;
    return c;
  });
}

/** A wire's cores coloured as the diagram has them now (null: none of it is in the diagram). */
export function coloursFromDiagram(info: WiringInfo, cores: WireCore[]): WireCore[] | null {
  const byId = new Map(info.connections.map(c => [c.id, c]));
  if (!cores.some(c => c.connection && byId.has(c.connection))) return null;
  return cores.map(c => {
    const d = c.connection ? byId.get(c.connection) : undefined;
    return d ? { ...c, color: connectionColour(d) } : c;
  });
}

/** What a wire is in the diagram, for its settings: "servo1 D1 → servo2 D2", per core. */
export function diagramLabels(info: WiringInfo, wireCores: WireCore[]): string[] {
  const byId = new Map(info.connections.map(c => [c.id, c]));
  const name = (ref: string) => {
    const { part, pin } = splitPin(ref);
    return `${info.parts.find(p => p.id === part)?.name || part} ${pin}`.trim();
  };
  return wireCores.map(c => {
    const d = c.connection ? byId.get(c.connection) : undefined;
    return d ? `${name(d.from)} → ${name(d.to)}` : "";
  });
}

/** Model parts a placed part's name matches (case and spacing aside), for "Link by name". */
export function linkByName(info: WiringInfo, parts: ScenePart[]): { part: string; wiringPart: string }[] {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const taken = new Set(parts.flatMap(p => (p.wiringPart ? [p.wiringPart] : [])));
  const out: { part: string; wiringPart: string }[] = [];
  for (const w of info.parts) {
    if (taken.has(w.id)) continue;
    const hits = parts.filter(p => !p.wiringPart && !p.wire && !p.plug && (norm(p.name) === norm(w.name) || norm(p.name) === norm(w.id)));
    if (hits.length === 1 && !out.some(o => o.part === hits[0].id)) out.push({ part: hits[0].id, wiringPart: w.id });
  }
  return out;
}

/**
 * The diagram's parts that no part in the scene stands for yet (none linked
 * to it, and none named as it): those with a 3D model the scene can add,
 * and those without.
 */
export function partsNotInScene(info: WiringInfo, parts: ScenePart[]): { withModel: WiringPart[]; noModel: WiringPart[] } {
  const linked = new Set(parts.flatMap(p => (p.wiringPart ? [p.wiringPart] : [])));
  for (const l of linkByName(info, parts)) linked.add(l.wiringPart);
  const out = { withModel: [] as WiringPart[], noModel: [] as WiringPart[] };
  for (const w of info.parts) {
    if (linked.has(w.id)) continue;
    (w.model?.url && /\.(stl|step|stp)$/i.test(w.model.file || "") ? out.withModel : out.noModel).push(w);
  }
  return out;
}

/** The first of a placed part's ports with this many pins no socket has yet (for a new socket). */
export function freePort(part: WiringPart | undefined, ways: number, sockets: PartSocket[] | undefined): string | undefined {
  const used = new Set((sockets || []).filter(s => !isBarePin(s)).map(s => s.port));
  return (part?.ports.find(p => p.pins.length === ways && !used.has(p.id)) || part?.ports.find(p => !used.has(p.id) && p.pins.length >= ways))?.id;
}

/** Catalog sockets that fit a model `size` (within half a mm each way), or null. */
export function catalogSocketsFor(saved: CatalogSockets | null | undefined, size: Vec3): PartSocket[] | null {
  if (!saved?.sockets?.length || !Array.isArray(saved.size)) return null;
  return saved.size.every((v, i) => Math.abs(v - size[i]) <= 0.5) ? saved.sockets.map(s => ({ ...s })) : null;
}

/** Whether a wire is in the diagram at all. */
export const inDiagram = (p: ScenePart) => !!p.wire && coresOf(p.wire).some(c => !!c.connection);
