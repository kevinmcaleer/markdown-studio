// The tools an assembly guide can ask for: a catalogue grouped by kind, each
// with a filled symbol in the style of the other instruction symbols
// (symbols.ts) and, for tools that come in sizes, the usual sizes. The
// guide's Before you start page draws the ones picked in the 3D scene's
// Steps mode (model.guide.tools); Elements offers them all as tiles.
//
// A pick is saved as its id ("pliers"), its id and a size
// ("allen-key:2.5 mm"), or any other tool's name, drawn as words.

import {
  ALLEN_KEY, arcBand, bar, circle, GLUE_GUN, HAMMER, pathOf, PLIERS, PRINTER_3D, rect, regular, rrect, SCREWDRIVER, SOLDERING_IRON, type XY,
} from "./symbols";

export interface ToolKind {
  id: string;
  label: string;
  /** Its group in the catalogue (TOOL_GROUPS). */
  group: string;
  /** The sizes it comes in, if it's picked by size. */
  sizes?: string[];
  /** Its symbol: an SVG path filled non-zero, in a box `w` × `h`. */
  path: string;
  w: number;
  h: number;
  /** Other names it's found by. */
  also?: string[];
}

export const TOOL_GROUPS = ["Screwdrivers and keys", "Cutting and shaping", "Holding", "Electronics", "Measuring", "Glue and tape", "Machines", "Safety"];

/** A screwdriver whose handle carries `mark` (cut out) to say which kind it is. */
function driver(mark: XY[][], tip: XY[] = [{ x: 170, y: 13 }, { x: 200, y: 19 }, { x: 200, y: 25 }, { x: 170, y: 31 }]): string {
  return pathOf([rrect(0, 0, 84, 44, 16), rect(80, 16, 92, 12), tip], mark);
}
const plus = (cx: number, cy: number, s: number, t: number): XY[] => [
  { x: cx - t, y: cy - s }, { x: cx + t, y: cy - s }, { x: cx + t, y: cy - t }, { x: cx + s, y: cy - t }, { x: cx + s, y: cy + t }, { x: cx + t, y: cy + t },
  { x: cx + t, y: cy + s }, { x: cx - t, y: cy + s }, { x: cx - t, y: cy + t }, { x: cx - s, y: cy + t }, { x: cx - s, y: cy - t }, { x: cx - t, y: cy - t },
];
const star = (cx: number, cy: number, r: number, inner: number, n: number): XY[] =>
  Array.from({ length: n * 2 }, (_, i) => {
    const a = ((-90 + (180 * i) / n) * Math.PI) / 180;
    const rr = i % 2 ? inner : r;
    return { x: cx + rr * Math.cos(a), y: cy + rr * Math.sin(a) };
  });

/** Pliers-like tools: a pivot, two jaws and two handles, jaws up. */
function plierLike(pivot: XY, jaws: [XY, XY], jawW: number, extra: XY[][] = [], holes: XY[][] = []): string {
  return pathOf([
    bar(pivot, jaws[0], jawW),
    bar(pivot, jaws[1], jawW),
    bar(pivot, { x: pivot.x - 36, y: pivot.y + 112 }, 16),
    bar(pivot, { x: pivot.x + 36, y: pivot.y + 112 }, 16),
    bar({ x: pivot.x - 16, y: pivot.y + 50 }, { x: pivot.x - 36, y: pivot.y + 112 }, 26),
    bar({ x: pivot.x + 16, y: pivot.y + 50 }, { x: pivot.x + 36, y: pivot.y + 112 }, 26),
    circle(pivot.x, pivot.y, 14),
    ...extra,
  ], [circle(pivot.x, pivot.y, 5), ...holes]);
}

const ticks = (x0: number, x1: number, step: number, y: number, h: (i: number) => number, w = 3): XY[][] => {
  const out: XY[][] = [];
  for (let x = x0, i = 0; x <= x1; x += step, i++) out.push(rect(x, y, w, h(i)));
  return out;
};

export const TOOL_CATALOGUE: ToolKind[] = [
  // Screwdrivers and keys
  { id: "screwdriver", label: "Screwdriver", group: "Screwdrivers and keys", path: SCREWDRIVER, w: 200, h: 44 },
  { id: "phillips", label: "Phillips screwdriver", group: "Screwdrivers and keys", sizes: ["PH000", "PH00", "PH0", "PH1", "PH2"], path: driver([plus(42, 22, 13, 4)]), w: 200, h: 44, also: ["cross head", "crosshead", "pozi"] },
  { id: "flat-screwdriver", label: "Flat screwdriver", group: "Screwdrivers and keys", sizes: ["1.5 mm", "2 mm", "3 mm", "4 mm", "5 mm"], path: driver([rect(28, 18, 28, 8)], [{ x: 170, y: 13 }, { x: 200, y: 15 }, { x: 200, y: 29 }, { x: 170, y: 31 }]), w: 200, h: 44, also: ["slotted", "flathead"] },
  { id: "torx", label: "Torx screwdriver", group: "Screwdrivers and keys", sizes: ["T5", "T6", "T8", "T10", "T15", "T20"], path: driver([star(42, 22, 14, 7, 6)]), w: 200, h: 44, also: ["star"] },
  { id: "allen-key", label: "Allen key", group: "Screwdrivers and keys", sizes: ["1.5 mm", "2 mm", "2.5 mm", "3 mm", "4 mm", "5 mm"], path: ALLEN_KEY, w: 70, h: 130, also: ["hex key", "hex"] },
  { id: "spanner", label: "Spanner", group: "Screwdrivers and keys", sizes: ["5.5 mm", "7 mm", "8 mm", "10 mm", "13 mm"], path: pathOf([bar({ x: 44, y: 156 }, { x: 156, y: 44 }, 30), circle(166, 34, 34), circle(34, 166, 30)], [regular(166, 34, 17, 6), regular(34, 166, 14, 6)]), w: 200, h: 200, also: ["wrench"] },
  { id: "nut-driver", label: "Nut driver", group: "Screwdrivers and keys", sizes: ["5.5 mm", "7 mm", "8 mm"], path: pathOf([rrect(0, 0, 84, 44, 16), rect(80, 15, 80, 14), rrect(156, 8, 44, 28, 4)], [regular(42, 22, 12, 6), rect(184, 14, 12, 16)]), w: 200, h: 44, also: ["socket"] },

  // Cutting and shaping
  { id: "flush-cutters", label: "Flush cutters", group: "Cutting and shaping", path: plierLike({ x: 100, y: 64 }, [{ x: 86, y: 18 }, { x: 114, y: 18 }], 30), w: 200, h: 190, also: ["side cutters", "snips", "wire cutters", "nippers"] },
  { id: "craft-knife", label: "Craft knife", group: "Cutting and shaping", path: pathOf([rrect(0, 10, 124, 26, 11), rect(118, 14, 14, 18), [{ x: 130, y: 14 }, { x: 166, y: 14 }, { x: 200, y: 34 }, { x: 130, y: 32 }]], [rect(20, 19, 70, 8)]), w: 200, h: 44, also: ["scalpel", "hobby knife", "x-acto", "stanley"] },
  { id: "scissors", label: "Scissors", group: "Cutting and shaping", path: pathOf([bar({ x: 96, y: 60 }, { x: 200, y: 34 }, 16), bar({ x: 96, y: 60 }, { x: 200, y: 86 }, 16), bar({ x: 96, y: 60 }, { x: 58, y: 36 }, 14), bar({ x: 96, y: 60 }, { x: 58, y: 84 }, 14), arcBand(34, 28, 22, 0, 360, 12), arcBand(34, 92, 22, 0, 360, 12)], [circle(96, 60, 4)]), w: 200, h: 120 },
  { id: "sandpaper", label: "Sandpaper", group: "Cutting and shaping", sizes: ["120 grit", "240 grit", "400 grit", "800 grit"], path: pathOf([rrect(0, 0, 160, 110, 6)], Array.from({ length: 24 }, (_, i) => circle(18 + (i % 6) * 25 + (Math.floor(i / 6) % 2) * 12, 18 + Math.floor(i / 6) * 25, 4))), w: 160, h: 110, also: ["sanding", "abrasive"] },
  { id: "needle-files", label: "Needle files", group: "Cutting and shaping", path: pathOf([rrect(0, 8, 70, 28, 12), [{ x: 66, y: 12 }, { x: 200, y: 19 }, { x: 200, y: 25 }, { x: 66, y: 32 }]], Array.from({ length: 9 }, (_, i) => [{ x: 84 + i * 12, y: 17 }, { x: 88 + i * 12, y: 17 }, { x: 85 + i * 12, y: 27 }, { x: 81 + i * 12, y: 27 }])), w: 200, h: 44, also: ["file", "rasp"] },
  { id: "deburring-tool", label: "Deburring tool", group: "Cutting and shaping", path: pathOf([rrect(0, 8, 96, 28, 12), rect(92, 18, 60, 8), arcBand(166, 22, 14, 200, 470, 7)]), w: 190, h: 44, also: ["deburr", "support removal"] },

  // Holding
  { id: "pliers", label: "Pliers", group: "Holding", path: PLIERS, w: 200, h: 200 },
  { id: "needle-nose-pliers", label: "Needle-nose pliers", group: "Holding", path: plierLike({ x: 100, y: 90 }, [{ x: 97, y: 4 }, { x: 103, y: 4 }], 12), w: 200, h: 216, also: ["long nose", "pinchers"] },
  { id: "tweezers", label: "Tweezers", group: "Holding", path: pathOf([bar({ x: 6, y: 30 }, { x: 196, y: 8 }, 12), bar({ x: 6, y: 30 }, { x: 196, y: 52 }, 12), circle(8, 30, 9)]), w: 204, h: 60, also: ["pinchers", "pincers"] },
  { id: "clamp", label: "Clamps", group: "Holding", path: pathOf([rect(0, 0, 110, 20), rect(0, 0, 22, 130), rect(0, 110, 110, 20), rect(76, 44, 12, 110), rrect(64, 36, 36, 12, 3), rrect(52, 150, 60, 12, 5)]), w: 112, h: 162, also: ["c-clamp", "g-clamp", "vice"] },
  { id: "helping-hands", label: "Helping hands", group: "Holding", path: pathOf([rrect(0, 150, 200, 20, 6), bar({ x: 100, y: 152 }, { x: 100, y: 70 }, 10), bar({ x: 100, y: 70 }, { x: 40, y: 30 }, 8), bar({ x: 100, y: 70 }, { x: 160, y: 30 }, 8), rrect(22, 14, 30, 22, 4), rrect(148, 14, 30, 22, 4), circle(100, 70, 9)]), w: 200, h: 170, also: ["third hand", "pcb holder"] },

  // Electronics
  { id: "soldering-iron", label: "Soldering iron", group: "Electronics", path: SOLDERING_IRON, w: 240, h: 70, also: ["solder"] },
  { id: "solder", label: "Solder", group: "Electronics", path: pathOf([circle(60, 60, 60), bar({ x: 112, y: 76 }, { x: 196, y: 104 }, 8)], [circle(60, 60, 20), arcBand(60, 60, 42, 0, 360, 4)]), w: 200, h: 120 },
  { id: "heat-set-insert-tip", label: "Heat-set insert tip", group: "Electronics", path: pathOf([rrect(40, 14, 90, 36, 14), rect(126, 18, 18, 28), rect(142, 25, 56, 14), [{ x: 196, y: 24 }, { x: 222, y: 28 }, { x: 222, y: 36 }, { x: 196, y: 40 }], rrect(222, 20, 24, 24, 3), arcBand(40, 46, 20, 90, 270, 6), rrect(28, 52, 28, 14, 5)], [rect(227, 24, 3, 16), rect(233, 24, 3, 16), rect(239, 24, 3, 16)]), w: 246, h: 70, also: ["heat set", "threaded insert", "insert tool"] },
  { id: "wire-strippers", label: "Wire strippers", group: "Electronics", path: plierLike({ x: 100, y: 88 }, [{ x: 90, y: 10 }, { x: 110, y: 10 }], 24, [], [circle(100, 30, 3.5), circle(100, 48, 3)]), w: 200, h: 216, also: ["strippers", "stripping"] },
  { id: "crimping-tool", label: "Crimping tool", group: "Electronics", path: plierLike({ x: 100, y: 84 }, [{ x: 100, y: 70 }, { x: 100, y: 70 }], 4, [rrect(66, 4, 68, 66, 10)], [rect(76, 20, 10, 10), rect(95, 20, 10, 10), rect(114, 20, 10, 10)]), w: 200, h: 212, also: ["crimper", "dupont", "jst"] },
  { id: "multimeter", label: "Multimeter", group: "Electronics", path: pathOf([rrect(0, 0, 120, 180, 16), bar({ x: 40, y: 176 }, { x: 18, y: 232 }, 8), bar({ x: 80, y: 176 }, { x: 102, y: 232 }, 8), bar({ x: 60, y: 112 }, { x: 74, y: 96 }, 6)], [rrect(16, 16, 88, 48, 6), circle(60, 112, 24)]), w: 120, h: 236, also: ["meter", "voltmeter", "dmm"] },
  { id: "heat-gun", label: "Heat gun", group: "Electronics", path: pathOf([rrect(0, 10, 160, 52, 22), [{ x: 156, y: 18 }, { x: 200, y: 24 }, { x: 200, y: 48 }, { x: 156, y: 54 }], bar({ x: 66, y: 58 }, { x: 52, y: 146 }, 36)], [rect(18, 24, 6, 24), rect(32, 24, 6, 24), rect(46, 24, 6, 24)]), w: 200, h: 166, also: ["heat shrink", "hot air"] },
  { id: "usb-cable", label: "USB cable", group: "Electronics", path: pathOf([rrect(0, 20, 50, 30, 6), rect(48, 27, 22, 16), arcBand(120, 35, 40, 180, 360, 8), arcBand(196, 35, 36, 180, 0, 8)], [rect(10, 29, 30, 12)]), w: 236, h: 80, also: ["cable", "lead"] },

  // Measuring
  { id: "calipers", label: "Calipers", group: "Measuring", path: pathOf([rect(0, 24, 220, 18), [{ x: 0, y: 24 }, { x: 24, y: 24 }, { x: 24, y: 96 }, { x: 8, y: 116 }, { x: 0, y: 116 }], [{ x: 60, y: 24 }, { x: 84, y: 24 }, { x: 84, y: 116 }, { x: 76, y: 116 }, { x: 60, y: 96 }], rect(6, 0, 10, 26), rect(68, 0, 10, 26), rrect(52, 18, 64, 32, 4)], ticks(124, 210, 8, 27, i => (i % 5 ? 6 : 10), 2)), w: 220, h: 116, also: ["vernier", "callipers", "measure"] },
  { id: "ruler", label: "Ruler", group: "Measuring", path: pathOf([rect(0, 0, 220, 40)], ticks(10, 210, 10, 4, i => (i % 5 ? 10 : 18))), w: 220, h: 40, also: ["rule", "measure"] },
  { id: "square", label: "Set square", group: "Measuring", path: pathOf([[{ x: 0, y: 0 }, { x: 0, y: 160 }, { x: 160, y: 160 }]], [[{ x: 22, y: 60 }, { x: 22, y: 140 }, { x: 102, y: 140 }]]), w: 160, h: 160, also: ["try square", "triangle"] },

  // Glue and tape
  { id: "glue-gun", label: "Hot glue gun", group: "Glue and tape", path: GLUE_GUN, w: 210, h: 160, also: ["hot glue", "glue"] },
  { id: "superglue", label: "Superglue", group: "Glue and tape", path: pathOf([rrect(8, 30, 112, 40, 10), rect(0, 26, 14, 48), [{ x: 116, y: 36 }, { x: 172, y: 46 }, { x: 172, y: 54 }, { x: 116, y: 64 }], rrect(170, 44, 26, 12, 4)], [rect(30, 42, 60, 16)]), w: 196, h: 100, also: ["glue", "ca glue", "cyanoacrylate"] },
  { id: "tape", label: "Tape", group: "Glue and tape", path: pathOf([circle(70, 70, 70), rect(70, 118, 110, 22)], [circle(70, 70, 32)]), w: 180, h: 140, also: ["masking tape", "double-sided tape", "insulating tape", "electrical tape"] },
  { id: "hammer", label: "Hammer", group: "Glue and tape", path: HAMMER, w: 100, h: 180, also: ["mallet"] },

  // Machines
  { id: "printer", label: "3D printer", group: "Machines", path: PRINTER_3D, w: 200, h: 180, also: ["printing", "fdm"] },
  { id: "laser-cutter", label: "Laser cutter", group: "Machines", path: pathOf([rrect(0, 0, 220, 150, 10), rect(16, 40, 188, 8), rrect(96, 44, 28, 22, 3), rect(108, 64, 4, 26), rect(16, 90, 188, 6), circle(196, 126, 7), circle(174, 126, 7)], [rrect(16, 16, 188, 84, 4)]), w: 220, h: 150, also: ["laser", "cnc"] },
  { id: "drill", label: "Drill", group: "Machines", sizes: ["2 mm bit", "3 mm bit", "4 mm bit", "5 mm bit"], path: pathOf([rrect(30, 0, 150, 56, 22), [{ x: 178, y: 10 }, { x: 208, y: 16 }, { x: 208, y: 40 }, { x: 178, y: 46 }], rect(206, 24, 44, 8), bar({ x: 90, y: 52 }, { x: 78, y: 148 }, 40), rrect(36, 140, 92, 30, 6), bar({ x: 116, y: 60 }, { x: 120, y: 86 }, 10)], [rect(48, 14, 6, 28), rect(62, 14, 6, 28)]), w: 250, h: 170, also: ["drill bit", "driver"] },
  { id: "computer", label: "Computer", group: "Machines", path: pathOf([rrect(20, 0, 160, 110, 8), [{ x: 0, y: 116 }, { x: 200, y: 116 }, { x: 188, y: 134 }, { x: 12, y: 134 }]], [rrect(32, 12, 136, 86, 3)]), w: 200, h: 134, also: ["laptop", "pc", "programming", "code"] },

  // Safety
  { id: "safety-glasses", label: "Safety glasses", group: "Safety", path: pathOf([rrect(10, 30, 80, 54, 22), rrect(110, 30, 80, 54, 22), bar({ x: 86, y: 46 }, { x: 114, y: 46 }, 10), bar({ x: 16, y: 42 }, { x: 0, y: 8 }, 8), bar({ x: 184, y: 42 }, { x: 200, y: 8 }, 8)], [rrect(22, 40, 18, 10, 4), rrect(122, 40, 18, 10, 4)]), w: 200, h: 84, also: ["goggles", "eye protection"] },
  { id: "gloves", label: "Gloves", group: "Safety", path: pathOf([rrect(30, 60, 90, 110, 30), bar({ x: 44, y: 80 }, { x: 44, y: 14 }, 20), bar({ x: 66, y: 76 }, { x: 66, y: 4 }, 20), bar({ x: 88, y: 76 }, { x: 88, y: 8 }, 20), bar({ x: 108, y: 84 }, { x: 108, y: 26 }, 18), bar({ x: 40, y: 120 }, { x: 4, y: 82 }, 22), rect(36, 160, 78, 30)]), w: 128, h: 190, also: ["heat resistant gloves"] },
];

const BY_ID = new Map(TOOL_CATALOGUE.map(t => [t.id, t]));
export const toolKind = (id: string): ToolKind | undefined => BY_ID.get(id);

/** What the guide lists under You will need when none were picked. */
export const DEFAULT_GUIDE_TOOLS = ["screwdriver", "allen-key", "pliers"];

/** A pick (as saved) as the tool it names: its kind and size, or just a name. */
export function readTool(pick: string): { kind?: ToolKind; size?: string; label: string } {
  const at = pick.indexOf(":");
  const id = at < 0 ? pick : pick.slice(0, at);
  const size = at < 0 ? undefined : pick.slice(at + 1).trim() || undefined;
  const kind = BY_ID.get(id) || (at < 0 ? TOOL_CATALOGUE.find(t => t.label.toLowerCase() === pick.trim().toLowerCase()) : undefined);
  if (!kind) return { label: pick };
  return { kind, ...(size ? { size } : {}), label: size ? `${kind.label} ${size}` : kind.label };
}

/** The tools the guide lists, in order: each with its symbol when it has one. */
export function guideTools(guide?: { tools?: string[] }): { kind?: string; path?: string; label: string }[] {
  return (guide?.tools ?? DEFAULT_GUIDE_TOOLS).map(t => {
    const r = readTool(t);
    return r.kind ? { kind: r.kind.id, path: r.kind.path, label: r.label } : { label: r.label };
  });
}

/** Catalogue tools whose name (or another name for them) has `q` in it. */
export function findTools(q: string): ToolKind[] {
  const s = q.trim().toLowerCase();
  if (!s) return TOOL_CATALOGUE;
  return TOOL_CATALOGUE.filter(t => [t.label, ...(t.also || []), t.group].some(n => n.toLowerCase().includes(s)));
}

/** The tool `q` most likely means (for Enter in the search): its own name before another name for it, before its group's. */
export function bestTool(q: string): ToolKind | undefined {
  const s = q.trim().toLowerCase();
  if (!s) return undefined;
  const score = (t: ToolKind): number => {
    const l = t.label.toLowerCase();
    const also = (t.also || []).map(a => a.toLowerCase());
    if (l === s || also.includes(s)) return 0;
    if (l.startsWith(s)) return 1;
    if (l.includes(s)) return 2;
    if (also.some(a => a.includes(s))) return 3;
    return 9;
  };
  let best: ToolKind | undefined;
  let at = 9;
  for (const t of TOOL_CATALOGUE) {
    const v = score(t);
    if (v < at) [best, at] = [t, v];
  }
  return best;
}

/** The symbol as an inline SVG, `size` px high (for buttons and tiles). */
export function toolSvg(t: ToolKind, size = 18): string {
  const pad = Math.max(t.w, t.h) * 0.04;
  return `<svg class="lyr-tool-svg" width="${Math.round((size * (t.w + pad * 2)) / (t.h + pad * 2))}" height="${size}" viewBox="${-pad} ${-pad} ${t.w + pad * 2} ${t.h + pad * 2}" aria-hidden="true"><path d="${t.path}" fill="currentColor"/></svg>`;
}
