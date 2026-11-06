// Wires in 3D scenes, as saved (see wire.ts for how one is drawn). No
// three.js here, so this loads with the editor.
//
// A wire is a part of the model whose shape is worked out from other parts:
// it runs from one end to the other through waypoints, and each end and
// waypoint belongs to a part (a point and its face's outward normal, in that
// part's frame), so the wire follows its parts when they move, turn on a
// joint or explode. Its ends are usually plugs: connector parts (see
// connectors.ts) joined to a socket on a part.
//
// Sockets are kept on the part they're on: a point and an outward normal
// (the way a plug goes in, backwards), and the connector that fits.

import type { Vec3 } from "./model";

/** Where one end of a wire is: on a part, in its frame. */
export interface WireEnd {
  part: string;
  point: Vec3;
  /** The way the wire leaves, in the part's frame. */
  normal: Vec3;
  /**
   * For a cable's cores: the way along the plug's row of pins, in the
   * part's frame, and the pins' spacing (mm). The cores leave the plug side
   * by side there and gather into the cable over the first few mm.
   */
  row?: Vec3;
  pitch?: number;
}

/**
 * A point a wire passes through. On a part's face (`part`, `point`,
 * `normal`): the wire runs over the face, its radius off it. Free (`lift`
 * only): it bows `lift` mm up from the straight line between its neighbours,
 * for bridging a gap.
 */
export interface WireWaypoint {
  part?: string;
  point?: Vec3;
  normal?: Vec3;
  lift?: number;
  /** Put there by "Route round parts" (so routing again replaces it), not by hand. */
  auto?: true;
  /**
   * Alongside another wire (a loom): it runs beside wire `wire`, touching
   * it, from `from` to `to` of the way along it (0 to 1; `from` past `to`
   * runs it the other way), then leaves it.
   */
  along?: WireAlong;
}

export interface WireAlong {
  wire: string;
  from: number;
  to: number;
}

/** The wires a wire can run alongside, by id (a scene's wires). */
export type Looms = Map<string, WireSpec>;

/** The wires among `parts`, for wires that run along them. */
export function loomsOf(parts: { id: string; wire?: WireSpec }[]): Looms {
  return new Map(parts.filter(p => p.wire).map(p => [p.id, p.wire!]));
}

/** One of a cable's wires: its colour, and the 2D wiring connection it is (when it is one). */
export interface WireCore {
  color: string;
  connection?: string;
}

export interface WireSpec {
  from: WireEnd;
  to: WireEnd;
  waypoints: WireWaypoint[];
  /** The fill colour, as on the real wire. */
  color: string;
  /** Mm across. */
  diameter: number;
  /** Mm of extra length over the shortest smooth run: bows the free spans. */
  slack: number;
  /** The 2D wiring connection this is, when there is one (it then shares its colour and pins). */
  connection?: string;
  /**
   * A cable: several wires along the one route, each `diameter` across,
   * pin 1's first. Without, it's one wire in `color`.
   */
  cores?: WireCore[];
  /** How a cable's wires lie: side by side as a servo lead's do, or round in a bundle (the default). */
  lay?: "flat";
  /** Degrees a cable's wires turn round each other every 100 mm. */
  twist?: number;
}

/** A place on a part a plug goes in. */
export interface PartSocket {
  id: string;
  /** On the part's face, in its frame. */
  point: Vec3;
  /** Out of the face: the plug goes in against it, and its wire leaves along it. */
  normal: Vec3;
  /** The connector that fits (connectors.ts), e.g. "molex-5264-3". */
  connector: string;
  /** Degrees the plug is turned about the normal. */
  spin?: number;
  name?: string;
  /** The port of the part's 2D wiring this is (a header group's id, "bus-1" say), its pins in the plug's order. */
  port?: string;
  /**
   * A bare pin (connector {@link BARE_PIN}): which of the 2D wiring's pins
   * it is ("M1"). A wire ends right on it, soldered or screwed down, with no
   * plug: a motor's tab, a battery snap, a screw terminal.
   */
  pin?: string;
}

/** The "connector" of a bare pin: no plug, the wire ends on the point. */
export const BARE_PIN = "pin";
/** Whether a socket is a bare pin (no plug goes in it). */
export const isBarePin = (s: Pick<PartSocket, "connector">) => s.connector === BARE_PIN;

/** A plug: a connector part sitting in a socket of the part it's joined to. */
export interface PlugSpec {
  connector: string;
  /** The socket's id on the parent part. */
  socket: string;
}

/** Wire colours, as hookup wire comes (the first few are a servo lead's). */
export const WIRE_COLOURS: { id: string; label: string }[] = [
  { id: "#d33a2c", label: "Red" },
  { id: "#222222", label: "Black" },
  { id: "#f2c400", label: "Yellow" },
  { id: "#2f6fd6", label: "Blue" },
  { id: "#2e9e4f", label: "Green" },
  { id: "#f08a1c", label: "Orange" },
  { id: "#8a4fc9", label: "Purple" },
  { id: "#f4f4f4", label: "White" },
  { id: "#8c5a32", label: "Brown" },
  { id: "#8f8f8f", label: "Grey" },
];

export const WIRE_DEFAULTS = { diameter: 2, slack: 8 } as const;
export const WIRE_LIMITS = { diameter: [0.3, 20], slack: [0, 500], lift: [-500, 500], cores: 16, twist: [-3600, 3600], pitch: [0.3, 20] } as const;
/** How far round a bundle's wires turn every 100 mm, unless set: enough that the colours interleave. */
export const BUNDLE_TWIST = 120;

const LIMIT = 100_000;
const num = (v: unknown, f: number, lo = -LIMIT, hi = LIMIT) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : f;
};
const v3 = (v: unknown, lim = LIMIT): Vec3 | null =>
  Array.isArray(v) && v.length === 3 && v.every(n => Number.isFinite(Number(n))) ? (v.map(n => num(n, 0, -lim, lim)) as Vec3) : null;
const unit = (v: unknown): Vec3 | null => {
  const n = v3(v, 1e6);
  const l = n ? Math.hypot(...n) : 0;
  return n && l > 1e-9 ? (n.map(x => x / l) as Vec3) : null;
};
const id = (v: unknown) => (typeof v === "string" && v ? v.slice(0, 40) : "");
const colour = (v: unknown, f: string) => (typeof v === "string" && /^#[0-9a-f]{3,8}$/i.test(v) ? v : f);

function end(v: unknown): WireEnd | null {
  if (!v || typeof v !== "object") return null;
  const e = v as Partial<WireEnd>;
  const part = id(e.part);
  const point = v3(e.point);
  const normal = unit(e.normal);
  if (!part || !point || !normal) return null;
  const out: WireEnd = { part, point, normal };
  const row = unit(e.row);
  if (row) out.row = row;
  if (typeof e.pitch === "number" && Number.isFinite(e.pitch) && e.pitch > 0) out.pitch = num(e.pitch, 1, ...WIRE_LIMITS.pitch);
  return out;
}

function core(v: unknown, fallback: string): WireCore | null {
  if (!v || typeof v !== "object") return null;
  const c = v as Partial<WireCore>;
  const out: WireCore = { color: colour(c.color, fallback) };
  const conn = id(c.connection);
  if (conn) out.connection = conn;
  return out;
}

function waypoint(v: unknown): WireWaypoint | null {
  if (!v || typeof v !== "object") return null;
  const w = v as WireWaypoint;
  const part = id(w.part);
  const point = v3(w.point);
  if (part && point) {
    const out: WireWaypoint = { part, point };
    const n = unit(w.normal);
    if (n) out.normal = n;
    if (w.auto === true) out.auto = true;
    return out;
  }
  if (typeof w.lift === "number" && Number.isFinite(w.lift)) return { lift: num(w.lift, 0, ...WIRE_LIMITS.lift) };
  const along = w.along && typeof w.along === "object" ? w.along : null;
  const wire = along ? id(along.wire) : "";
  if (along && wire) {
    const from = num(along.from, 0, 0, 1);
    const to = num(along.to, 1, 0, 1);
    if (Math.abs(to - from) >= 0.01) return { along: { wire, from, to } };
  }
  return null;
}

/** `value` as a wire, or null when it isn't one. */
export function normalizeWire(value: unknown): WireSpec | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<WireSpec>;
  const from = end(v.from);
  const to = end(v.to);
  if (!from || !to) return null;
  const out: WireSpec = {
    from,
    to,
    waypoints: Array.isArray(v.waypoints) ? v.waypoints.slice(0, 200).map(waypoint).filter((w): w is WireWaypoint => !!w) : [],
    color: colour(v.color, WIRE_COLOURS[0].id),
    diameter: num(v.diameter, WIRE_DEFAULTS.diameter, ...WIRE_LIMITS.diameter),
    slack: num(v.slack, WIRE_DEFAULTS.slack, ...WIRE_LIMITS.slack),
  };
  const c = id(v.connection);
  if (c) out.connection = c;
  if (Array.isArray(v.cores)) {
    const cores = v.cores.slice(0, WIRE_LIMITS.cores).map((x, i) => core(x, WIRE_COLOURS[i % WIRE_COLOURS.length].id)).filter((x): x is WireCore => !!x);
    // One core is just a wire.
    if (cores.length > 1) {
      out.cores = cores;
      out.color = cores[0].color;
      delete out.connection;
    } else if (cores.length === 1) {
      out.color = cores[0].color;
      if (cores[0].connection) out.connection = cores[0].connection;
    }
  }
  if (out.cores) {
    if (v.lay === "flat") out.lay = "flat";
    if (typeof v.twist === "number" && Number.isFinite(v.twist)) out.twist = num(v.twist, 0, ...WIRE_LIMITS.twist);
  }
  return out;
}

/** A wire's wires: its cores, or itself as one. */
export function coresOf(w: Pick<WireSpec, "cores" | "color" | "connection">): WireCore[] {
  if (w.cores && w.cores.length > 1) return w.cores;
  return [w.connection ? { color: w.color, connection: w.connection } : { color: w.color }];
}

/** The 2D wiring connections a wire is. */
export function connectionsOf(w: Pick<WireSpec, "cores" | "color" | "connection">): string[] {
  return coresOf(w).flatMap(c => (c.connection ? [c.connection] : []));
}

/** `value` as a part's sockets (at most 64), anything broken left out. */
export function normalizeSockets(value: unknown): PartSocket[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: PartSocket[] = [];
  for (const v of value.slice(0, 64)) {
    if (!v || typeof v !== "object") continue;
    const s = v as Partial<PartSocket>;
    const sid = id(s.id);
    const point = v3(s.point);
    const normal = unit(s.normal);
    const connector = id(s.connector);
    if (!sid || seen.has(sid) || !point || !normal || !connector) continue;
    seen.add(sid);
    const sock: PartSocket = { id: sid, point, normal, connector };
    if (typeof s.spin === "number" && Number.isFinite(s.spin) && s.spin % 360) sock.spin = ((((s.spin + 180) % 360) + 360) % 360) - 180;
    if (typeof s.name === "string" && s.name.trim()) sock.name = s.name.slice(0, 60);
    const port = id(s.port);
    if (port) sock.port = port;
    if (typeof s.pin === "string" && s.pin.trim()) sock.pin = s.pin.trim().slice(0, 60);
    out.push(sock);
  }
  return out;
}

/** `value` as a plug, or null when it isn't one. */
export function normalizePlug(value: unknown): PlugSpec | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<PlugSpec>;
  const connector = id(v.connector);
  const socket = id(v.socket);
  return connector && socket ? { connector, socket } : null;
}

/** An id for a new socket on a part with these. */
export function newSocketId(sockets: PartSocket[] | undefined): string {
  const used = new Set((sockets || []).map(s => s.id));
  let n = (sockets?.length || 0) + 1;
  while (used.has(`s${n}`)) n++;
  return `s${n}`;
}

/** The colour a new wire takes: the first not used yet, in the usual order. */
export function nextWireColour(used: string[]): string {
  const have = new Set(used.map(c => c.toLowerCase()));
  return (WIRE_COLOURS.find(c => !have.has(c.id)) || WIRE_COLOURS[used.length % WIRE_COLOURS.length]).id;
}

/** "Red", or the colour itself when it isn't one of ours. */
export function wireColourName(c: string): string {
  return WIRE_COLOURS.find(x => x.id.toLowerCase() === c.toLowerCase())?.label || c;
}

/**
 * A new cable's wires' colours, pin 1's first: a servo lead's for three
 * (yellow signal, red power, black ground: an STS3215's D V G), red and
 * black for two, else the usual order.
 */
export function cableColours(n: number): string[] {
  if (n === 3) return ["#f2c400", "#d33a2c", "#222222"];
  if (n === 2) return ["#d33a2c", "#222222"];
  return Array.from({ length: n }, (_, i) => WIRE_COLOURS[i % WIRE_COLOURS.length].id);
}
