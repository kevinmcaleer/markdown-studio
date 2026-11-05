// The wire list: every wire in the model, with what it runs between and
// how long to cut it, for the bill of materials.

import type { ScenePart } from "./model";
import { worldMatrices } from "./render";
import { cableRadius, MIN_BEND, tightestBend, wireRoute } from "./wire";
import { coresOf, loomsOf, WIRE_COLOURS } from "./wireSpec";

/** Mm added at each end when a wire is cut: enough to strip it and crimp a pin on. */
export const CUT_ALLOWANCE = 5;

export interface WireRow {
  id: string;
  name: string;
  /** The parts at its ends (a plug's, the part it plugs into). */
  from: string;
  to: string;
  /** Its wires' colours (one for a single wire). */
  colours: string[];
  /** Each wire's diameter, mm. */
  diameter: number;
  /** Along its route, mm (0 when it can't be laid). */
  length: number;
  /** To cut it: the length plus an allowance at each end, up to the next whole mm. */
  cut: number;
  /** Its tightest bend's radius, mm, when that is under the minimum (MIN_BEND × its outer diameter). */
  tightBend?: number;
}

/** The wire list of `parts` (a scene's or the project model's), in the order the wires go in. */
export function wireListOf(parts: ScenePart[]): WireRow[] {
  const mats = worldMatrices(parts, 0);
  const byId = new Map(parts.map(p => [p.id, p]));
  const looms = loomsOf(parts);
  const endName = (id: string) => {
    const p = byId.get(id);
    if (!p) return "";
    const into = p.plug && p.parent ? byId.get(p.parent) : undefined;
    return into ? into.name : p.name;
  };
  return parts.filter(p => p.wire).map(p => {
    const w = p.wire!;
    const route = wireRoute(w, mats, looms);
    const length = route?.length || 0;
    const outer = cableRadius(w) * 2;
    const bend = route ? tightestBend(route, outer) : null;
    return {
      id: p.id,
      name: p.name,
      from: endName(w.from.part),
      to: endName(w.to.part),
      colours: coresOf(w).map(c => c.color),
      diameter: w.diameter,
      length,
      cut: length > 0 ? Math.ceil(length + 2 * CUT_ALLOWANCE) : 0,
      ...(bend && bend.radius < MIN_BEND * outer ? { tightBend: bend.radius } : {}),
    };
  });
}

const colourName = (hex: string) => WIRE_COLOURS.find(c => c.id === hex.toLowerCase())?.label || hex;
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const mm = (n: number) => `${Math.round(n * 10) / 10}`;

/** The wire list as a Markdown table, a row a wire ("" when there are none). */
export function wireListMarkdown(rows: WireRow[]): string {
  if (!rows.length) return "";
  const lines = [
    "| Wire | From | To | Colour | Size (mm) | Length (mm) | Cut to (mm) |",
    "| - | - | - | - | -: | -: | -: |",
    ...rows.map(r => {
      const colours = r.colours.length > 1 ? `${r.colours.length} wires: ${r.colours.map(colourName).join(", ")}` : colourName(r.colours[0] || "");
      return `| ${cell(r.name)} | ${cell(r.from)} | ${cell(r.to)} | ${cell(colours)} | ${mm(r.diameter)} | ${r.length ? Math.round(r.length) : "–"} | ${r.cut || "–"} |`;
    }),
  ];
  const total = rows.reduce((s, r) => s + r.cut, 0);
  return `${lines.join("\n")}\n\nCut lengths allow ${CUT_ALLOWANCE} mm at each end for stripping and crimping${rows.length > 1 ? `, ${total} mm in all` : ""}.`;
}
