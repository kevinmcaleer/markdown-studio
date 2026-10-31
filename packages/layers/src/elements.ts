// What the side panel adds: shapes, lines and arrows, text styles, step
// badges, and the starting templates. Each is made at a point on the page.

import { Circle, Ellipse, FabricObject, FabricText, Group, Path, Polygon, Rect, Textbox } from "fabric";
import { Connector } from "./connector";

export const INK = "#1f2328";
export const ACCENT = "#e8590c";

export const PALETTE = [
  "#1f2328", "#495057", "#868e96", "#ced4da", "#f1f3f5", "#ffffff",
  "#e03131", "#e8590c", "#f59f00", "#ffd43b", "#2f9e44", "#69db7c",
  "#0c8599", "#1971c2", "#74c0fc", "#5f3dc4", "#c2255c", "#f783ac",
];

export const FONTS: [string, string][] = [
  ["Sans", "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"],
  ["Rounded", "ui-rounded, 'SF Pro Rounded', 'Nunito', 'Varela Round', 'Arial Rounded MT Bold', sans-serif"],
  ["Serif", "ui-serif, 'Iowan Old Style', Georgia, Cambria, 'Times New Roman', serif"],
  ["Mono", "ui-monospace, 'IBM Plex Mono', 'SF Mono', Menlo, Consolas, monospace"],
  ["Hand", "'Segoe Print', 'Bradley Hand', 'Comic Sans MS', 'Chalkboard SE', cursive"],
  ["Impact", "Impact, 'Haettenschweiler', 'Arial Narrow Bold', sans-serif"],
];

export interface Point {
  x: number;
  y: number;
}

let counter = 0;
export function newId(): string {
  counter += 1;
  return `l${Date.now().toString(36)}${counter.toString(36)}`;
}

const poly = (n: number, r: number, inner = 0): Point[] => {
  const pts: Point[] = [];
  const steps = inner ? n * 2 : n;
  for (let i = 0; i < steps; i++) {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / steps;
    const rr = inner && i % 2 ? inner : r;
    pts.push({ x: r + rr * Math.cos(a), y: r + rr * Math.sin(a) });
  }
  return pts;
};

export interface ShapeKind {
  id: string;
  label: string;
  /** Inline SVG drawing for the tile (viewBox 0 0 48 48). */
  svg: string;
}

export const SHAPES: ShapeKind[] = [
  { id: "rect", label: "Square", svg: '<rect x="8" y="8" width="32" height="32" fill="currentColor"/>' },
  { id: "rounded", label: "Rounded square", svg: '<rect x="8" y="8" width="32" height="32" rx="8" fill="currentColor"/>' },
  { id: "circle", label: "Circle", svg: '<circle cx="24" cy="24" r="16" fill="currentColor"/>' },
  { id: "triangle", label: "Triangle", svg: '<path d="M24 8 41 38H7z" fill="currentColor"/>' },
  { id: "diamond", label: "Diamond", svg: '<path d="M24 6 42 24 24 42 6 24z" fill="currentColor"/>' },
  { id: "hexagon", label: "Hexagon", svg: '<path d="M24 6l15.6 9v18L24 42 8.4 33V15z" fill="currentColor"/>' },
  { id: "star", label: "Star", svg: '<path d="m24 6 5.3 11.6 12.6 1.4-9.4 8.6 2.6 12.4L24 33.8 12.9 40l2.6-12.4L6.1 19l12.6-1.4z" fill="currentColor"/>' },
  { id: "outline", label: "Outline box", svg: '<rect x="9" y="9" width="30" height="30" rx="4" fill="none" stroke="currentColor" stroke-width="3"/>' },
  { id: "ring", label: "Outline circle", svg: '<circle cx="24" cy="24" r="15" fill="none" stroke="currentColor" stroke-width="3"/>' },
  { id: "bubble", label: "Speech bubble", svg: '<path d="M8 10h32v22H22l-9 8v-8H8z" fill="currentColor"/>' },
];

export const LINES: ShapeKind[] = [
  { id: "line", label: "Line", svg: '<path d="M6 24h36" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>' },
  { id: "dashed", label: "Dashed line", svg: '<path d="M6 24h36" stroke="currentColor" stroke-width="3" stroke-dasharray="6 5" stroke-linecap="round"/>' },
  { id: "arrow", label: "Arrow", svg: '<path d="M6 24h34M30 14l10 10-10 10" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>' },
  { id: "double", label: "Double arrow", svg: '<path d="M8 24h32M30 14l10 10-10 10M18 14 8 24l10 10" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>' },
  { id: "curved", label: "Curved arrow", svg: '<path d="M8 36C12 18 24 12 38 14M30 7l8 7-7 8" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>' },
  { id: "badge", label: "Step number", svg: `<circle cx="24" cy="24" r="16" fill="${ACCENT}"/><text x="24" y="30.5" text-anchor="middle" font-size="18" font-weight="700" fill="#fff" font-family="sans-serif">1</text>` },
];

const ARROW = "M 0 40 L 200 40 M 170 10 L 200 40 L 170 70";
const CURVED = "M 0 160 C 30 60 100 20 200 30 M 165 0 L 200 30 L 168 64";
const BUBBLE = "M 0 0 L 240 0 L 240 150 L 110 150 L 60 200 L 60 150 L 0 150 Z";

const lineStyle = (color: string) => ({
  fill: "",
  stroke: color,
  strokeWidth: 8,
  strokeLineCap: "round" as const,
  strokeLineJoin: "round" as const,
  strokeUniform: true,
  objectCaching: false,
});

function named<T extends FabricObject>(o: T, name: string): T {
  Object.assign(o, { name, layerId: newId() });
  return o;
}

/** A step badge: a numbered circle. */
export function badge(n: number, at: Point, color = ACCENT): Group {
  const circle = new Circle({ radius: 40, fill: color, originX: "center", originY: "center", left: 0, top: 0 });
  const label = new FabricText(String(n), {
    fontFamily: FONTS[0][1],
    fontSize: 44,
    fontWeight: "700",
    fill: "#ffffff",
    originX: "center",
    originY: "center",
    left: 0,
    top: 2,
  });
  const g = new Group([circle, label], { left: at.x, top: at.y });
  Object.assign(g, { badge: n });
  return named(g, `Step ${n}`);
}

export function makeShape(kind: string, at: Point, color: string): FabricObject | null {
  const base = { left: at.x, top: at.y };
  const fill = { fill: color, stroke: "", strokeWidth: 0, strokeUniform: true };
  switch (kind) {
    case "rect": return named(new Rect({ ...base, ...fill, width: 240, height: 240 }), "Square");
    case "rounded": return named(new Rect({ ...base, ...fill, width: 240, height: 240, rx: 40, ry: 40 }), "Rounded square");
    case "circle": return named(new Circle({ ...base, ...fill, radius: 120 }), "Circle");
    case "triangle": return named(new Polygon([{ x: 120, y: 0 }, { x: 240, y: 210 }, { x: 0, y: 210 }], { ...base, ...fill }), "Triangle");
    case "diamond": return named(new Polygon([{ x: 120, y: 0 }, { x: 240, y: 120 }, { x: 120, y: 240 }, { x: 0, y: 120 }], { ...base, ...fill }), "Diamond");
    case "hexagon": return named(new Polygon(poly(6, 120), { ...base, ...fill }), "Hexagon");
    case "star": return named(new Polygon(poly(5, 125, 52), { ...base, ...fill }), "Star");
    case "outline": return named(new Rect({ ...base, width: 260, height: 180, rx: 12, ry: 12, fill: "", stroke: color, strokeWidth: 8, strokeUniform: true }), "Outline box");
    case "ring": return named(new Ellipse({ ...base, rx: 120, ry: 120, fill: "", stroke: color, strokeWidth: 8, strokeUniform: true }), "Outline circle");
    case "bubble": return named(new Path(BUBBLE, { ...base, ...fill, strokeLineJoin: "round" }), "Speech bubble");
    case "line": return named(new Connector([0, 0, 300, 0], { ...base, ...lineStyle(color) }), "Line");
    case "dashed": return named(new Connector([0, 0, 300, 0], { ...base, ...lineStyle(color), strokeDashArray: [24, 20] }), "Dashed line");
    case "arrow": return named(new Connector([0, 0, 300, 0], { ...base, ...lineStyle(color), arrowEnd: true }), "Arrow");
    case "double": return named(new Connector([0, 0, 300, 0], { ...base, ...lineStyle(color), arrowStart: true, arrowEnd: true }), "Double arrow");
    case "curved": return named(new Path(CURVED, { ...base, ...lineStyle(color) }), "Curved arrow");
    default: return null;
  }
}

export interface TextStyle {
  id: string;
  label: string;
  text: string;
  /** How the button shows it. */
  css: string;
  props: Record<string, unknown>;
}

export const TEXT_STYLES: TextStyle[] = [
  { id: "heading", label: "Add a heading", text: "Heading", css: "font-size:22px;font-weight:800", props: { fontSize: 96, fontWeight: "800", width: 800 } },
  { id: "subheading", label: "Add a subheading", text: "Subheading", css: "font-size:17px;font-weight:600", props: { fontSize: 56, fontWeight: "600", width: 640 } },
  { id: "body", label: "Add a little bit of body text", text: "Body text", css: "font-size:13px", props: { fontSize: 36, width: 560 } },
  { id: "label", label: "Label", text: "Label", css: `font-size:13px;font-weight:700;background:${INK};color:#fff;padding:2px 8px;border-radius:4px`, props: { fontSize: 40, fontWeight: "700", width: 220, fill: "#ffffff", backgroundColor: INK, textAlign: "center" } },
  { id: "highlight", label: "Highlighted", text: "Note", css: "font-size:13px;font-weight:600;background:#ffd43b;padding:2px 8px", props: { fontSize: 40, fontWeight: "600", width: 220, backgroundColor: "#ffd43b", textAlign: "center" } },
  { id: "outlined", label: "Outlined", text: "BIG", css: "font-size:20px;font-weight:900;color:#fff;-webkit-text-stroke:1.5px #1f2328", props: { fontSize: 120, fontWeight: "900", width: 420, fill: "#ffffff", stroke: INK, strokeWidth: 4, paintFirst: "stroke", fontFamily: FONTS[5][1] } },
];

export function makeText(style: TextStyle, at: Point): Textbox {
  const t = new Textbox(style.text, {
    left: at.x,
    top: at.y,
    fontFamily: FONTS[0][1],
    fill: INK,
    lineHeight: 1.15,
    splitByGrapheme: false,
    ...style.props,
  });
  return named(t, style.text);
}

export interface Template {
  id: string;
  label: string;
  detail: string;
  /** The objects, laid out on a `w`×`h` page. */
  build(w: number, h: number): FabricObject[];
}

const tb = (text: string, o: Record<string, unknown>) => named(new Textbox(text, { fontFamily: FONTS[0][1], fill: INK, ...o }), text);

export const TEMPLATES: Template[] = [
  {
    id: "title",
    label: "Title card",
    detail: "A bold title and a subtitle",
    build: (w, h) => [
      named(new Rect({ left: 0, top: h * 0.62, width: w, height: h * 0.38, fill: "#1971c2" }), "Band"),
      tb("Project title", { left: w * 0.08, top: h * 0.2, width: w * 0.84, fontSize: Math.round(h * 0.16), fontWeight: "800" }),
      tb("A short line about what it does", { left: w * 0.08, top: h * 0.72, width: w * 0.84, fontSize: Math.round(h * 0.065), fill: "#ffffff" }),
    ],
  },
  {
    id: "steps",
    label: "Three steps",
    detail: "Numbered steps side by side",
    build: (w, h) => {
      const out: FabricObject[] = [];
      for (let i = 0; i < 3; i++) {
        const x = w * (0.08 + i * 0.3);
        out.push(badge(i + 1, { x, y: h * 0.2 }, [ACCENT, "#1971c2", "#2f9e44"][i]));
        out.push(tb(`Step ${i + 1}`, { left: x, top: h * 0.2 + 110, width: w * 0.25, fontSize: 52, fontWeight: "700" }));
        out.push(tb("What to do in this step", { left: x, top: h * 0.2 + 180, width: w * 0.25, fontSize: 32, fill: "#495057" }));
      }
      return out;
    },
  },
  {
    id: "annotated",
    label: "Labelled picture",
    detail: "Labels with arrows around a picture",
    build: (w, h) => [
      named(new Rect({ left: w * 0.25, top: h * 0.12, width: w * 0.5, height: h * 0.76, rx: 16, ry: 16, fill: "#f1f3f5", stroke: "#adb5bd", strokeWidth: 4, strokeDashArray: [18, 14], strokeUniform: true }), "Picture goes here"),
      tb("Drop a picture here", { left: w * 0.25, top: h * 0.46, width: w * 0.5, fontSize: 36, fill: "#868e96", textAlign: "center" }),
      tb("Label", { left: w * 0.03, top: h * 0.2, width: w * 0.17, fontSize: 40, fontWeight: "700", backgroundColor: INK, fill: "#fff", textAlign: "center" }),
      named(new Path(ARROW, { left: w * 0.225, top: h * 0.235, originX: "center", originY: "center", scaleX: 0.4, scaleY: 0.4, ...lineStyle(ACCENT) }), "Arrow"),
      tb("Label", { left: w * 0.8, top: h * 0.62, width: w * 0.17, fontSize: 40, fontWeight: "700", backgroundColor: INK, fill: "#fff", textAlign: "center" }),
      named(new Path(ARROW, { left: w * 0.775, top: h * 0.655, originX: "center", originY: "center", angle: 180, scaleX: 0.4, scaleY: 0.4, ...lineStyle(ACCENT) }), "Arrow"),
    ],
  },
  {
    id: "compare",
    label: "Before and after",
    detail: "Two frames side by side",
    build: (w, h) => [
      tb("Before", { left: w * 0.05, top: h * 0.06, width: w * 0.42, fontSize: Math.round(h * 0.08), fontWeight: "800" }),
      named(new Rect({ left: w * 0.05, top: h * 0.2, width: w * 0.42, height: h * 0.72, rx: 16, ry: 16, fill: "#f1f3f5" }), "Before picture"),
      tb("After", { left: w * 0.53, top: h * 0.06, width: w * 0.42, fontSize: Math.round(h * 0.08), fontWeight: "800" }),
      named(new Rect({ left: w * 0.53, top: h * 0.2, width: w * 0.42, height: h * 0.72, rx: 16, ry: 16, fill: "#f1f3f5" }), "After picture"),
    ],
  },
];

/** Plain-language name for a layer's kind. */
export function kindOf(o: FabricObject): { icon: string; label: string } {
  const t = String(o.type || "").toLowerCase();
  if (t === "image") return { icon: "image", label: "Picture" };
  if (t === "textbox" || t === "i-text" || t === "text") return { icon: "text", label: "Text" };
  if (t === "group" || t === "activeselection") return { icon: "group", label: (o as Group & { badge?: number }).badge ? "Step number" : "Group" };
  if (o instanceof Connector) return { icon: "dash", label: o.arrowStart || o.arrowEnd ? "Arrow" : "Line" };
  if (t === "line" || t === "path") return { icon: "dash", label: "Line" };
  return { icon: "shapes", label: "Shape" };
}

export function isText(o: FabricObject | undefined | null): o is Textbox {
  const t = String(o?.type || "").toLowerCase();
  return t === "textbox" || t === "i-text" || t === "text";
}

export function isLine(o: FabricObject | undefined | null): boolean {
  if (!o) return false;
  const t = String(o.type || "").toLowerCase();
  return o instanceof Connector || t === "line" || (t === "path" && !o.fill);
}

/** Text that belongs to a shape: it sits in the middle of the shape and moves with it. */
export function boundTo(o: FabricObject | undefined | null): string {
  return String((o as (FabricObject & { boundTo?: string }) | undefined)?.boundTo || "");
}

/** Whether `o` can hold text of its own (a filled or outlined shape, not a line, text, picture or group). */
export function canHoldText(o: FabricObject | undefined | null): boolean {
  if (!o || isLine(o) || isText(o)) return false;
  const t = String(o.type || "").toLowerCase();
  return ["rect", "circle", "ellipse", "polygon", "path", "triangle"].includes(t);
}

/** The text style a shape's own text starts with. */
export function shapeText(text: string, color: string): Textbox {
  const t = new Textbox(text, {
    fontFamily: FONTS[0][1],
    fontSize: 40,
    fontWeight: "600",
    fill: color,
    textAlign: "center",
    originX: "center",
    originY: "center",
    lineHeight: 1.15,
    width: 200,
  });
  return named(t, "Shape text");
}
