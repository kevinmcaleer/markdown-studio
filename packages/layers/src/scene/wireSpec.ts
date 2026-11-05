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
}

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
export const WIRE_LIMITS = { diameter: [0.3, 20], slack: [0, 500], lift: [-500, 500] } as const;

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
  return part && point && normal ? { part, point, normal } : null;
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
    return out;
  }
  if (typeof w.lift === "number" && Number.isFinite(w.lift)) return { lift: num(w.lift, 0, ...WIRE_LIMITS.lift) };
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
  return out;
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
