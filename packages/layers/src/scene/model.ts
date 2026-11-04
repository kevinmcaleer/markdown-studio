// A 3D scene: the parts (STL models) placed in it, the camera and the
// drawing style. It is plain data, stored on the scene layer, so a graphic
// can be opened again and its scene changed. No three.js here, so this
// loads with the editor; the 3D code loads only when a scene is opened.
//
// Units are millimetres and degrees. Z points up, as in CAD. A part turns
// about its own middle: roll about X, pitch about Y, yaw about Z, applied
// roll first, then pitch, then yaw (the same as URDF's rpy).

export type Vec3 = [number, number, number];

export interface ScenePart {
  id: string;
  name: string;
  /** Where the model comes from: the host's URL for it, or the model itself (base64 STL) for an upload. */
  url?: string;
  data?: string;
  /** The STL's file name, for a URDF's mesh paths. */
  file?: string;
  /** The middle of the part, in mm. */
  position: Vec3;
  /** Roll, pitch, yaw in degrees. */
  rotation: Vec3;
  hidden?: boolean;
  /** Drawn in the style's highlight colour. */
  highlight?: boolean;
  /**
   * The part this one is joined to. Its position and rotation are then in
   * that part's frame, so it moves with it (joints, phase 2).
   */
  parent?: string;
  /**
   * How it is joined: the faces picked on each part (see joint.ts), and how
   * it comes apart in an exploded view, along `normal` (the parent's face,
   * in the parent's frame) by `distance` mm.
   */
  joint?: PartJoint;
  /** Drawn faint: a part fitted in an earlier step. */
  ghost?: boolean;
}

export interface PartJoint {
  normal: Vec3;
  distance: number;
  point?: Vec3;
  childPoint?: Vec3;
  childNormal?: Vec3;
  /** Degrees about the normal. */
  spin?: number;
  /** Millimetres standing off the face. */
  gap?: number;
  /**
   * How the part moves on its joint: fixed, turning about the normal
   * (revolute: spin is its angle) or sliding along it (prismatic: gap is
   * how far). Fixed unless set.
   */
  type?: JointType;
  /** A moving joint's limits: degrees for turning, mm for sliding. */
  lower?: number;
  upper?: number;
}

export type JointType = "fixed" | "revolute" | "prismatic";
export const JOINT_TYPES: { id: JointType; label: string; detail: string }[] = [
  { id: "fixed", label: "Fixed", detail: "Held in place" },
  { id: "revolute", label: "Turns", detail: "Turns about the joined faces, like a servo horn" },
  { id: "prismatic", label: "Slides", detail: "Slides along the joined faces' normal, like a drawer" },
];
/** Limits a new moving joint starts with. */
export const DEFAULT_LIMITS: Record<Exclude<JointType, "fixed">, [number, number]> = { revolute: [-90, 90], prismatic: [0, 20] };

export interface SceneCamera {
  /** Where the camera looks from, as a direction from the target. */
  direction: Vec3;
  target: Vec3;
  /** Half the height of the view, in mm. */
  size: number;
}

export interface SceneStyle {
  preset: string;
  fill: string;
  line: string;
  /** Thin fold lines, in pixels of the finished picture. */
  lineWidth: number;
  /** The thick line round each part, in pixels; 0 for none. */
  outline: number;
  /** How sharp a fold must be, in degrees, to get a line. 180: no fold lines. */
  crease: number;
  highlight: string;
  /** Lines of ghost parts (fitted in an earlier step); their fill is a pale mix of fill and this. */
  ghost: string;
  /** Dashed draft lines in an exploded view, from each part back to where it fits. On unless false. */
  draft?: boolean;
}

export interface SceneData {
  version: 1;
  parts: ScenePart[];
  camera: SceneCamera;
  style: SceneStyle;
  /** How far apart joined parts are drawn: 0 assembled, 1 fully exploded. */
  explode: number;
  /**
   * Set when the scene's parts come from the project's model: the model's
   * version (stamp) they were last taken from. Its parts are then a copy of
   * the model's, each with this scene's own hidden / ghost / highlight.
   */
  model?: { stamp: number };
  /** Named views, when the host keeps no project model (otherwise they're the model's). */
  views?: NamedView[];
}

/** A camera saved under a name, so pictures can share it (like Fusion 360's named views). */
export interface NamedView {
  id: string;
  name: string;
  camera: SceneCamera;
}

/**
 * A project's model: the parts and joints every scene in the project picks
 * from (the host stores it). `stamp` changes whenever the parts or joints
 * do, so pictures drawn from an older one can say they're out of date.
 */
export interface ProjectModel {
  version: 1;
  stamp: number;
  parts: ScenePart[];
  /** The project's named views (they don't change its stamp). */
  views?: NamedView[];
}

export interface StylePreset {
  id: string;
  label: string;
  detail: string;
  style: Omit<SceneStyle, "preset">;
}

export const HIGHLIGHT = "#9db8f5";
export const GHOST = "#a6a6a6";

export const STYLE_PRESETS: StylePreset[] = [
  { id: "line-art", label: "Line art", detail: "White parts, fine fold lines, a bold outline", style: { fill: "#ffffff", line: "#111111", lineWidth: 1, outline: 3, crease: 30, highlight: HIGHLIGHT, ghost: GHOST } },
  { id: "technical", label: "Technical", detail: "Fine lines only", style: { fill: "#ffffff", line: "#111111", lineWidth: 1, outline: 1, crease: 30, highlight: HIGHLIGHT, ghost: GHOST } },
  { id: "bold", label: "Bold", detail: "Thicker lines for small pictures", style: { fill: "#ffffff", line: "#111111", lineWidth: 2, outline: 5, crease: 35, highlight: HIGHLIGHT, ghost: GHOST } },
  { id: "silhouette", label: "Silhouette", detail: "Outlines only, no fold lines", style: { fill: "#ffffff", line: "#111111", lineWidth: 1, outline: 3, crease: 180, highlight: HIGHLIGHT, ghost: GHOST } },
];

export interface ViewPreset {
  id: string;
  label: string;
  direction: Vec3;
}

/** Camera directions. Iso looks down at the front-right corner. */
export const VIEWS: ViewPreset[] = [
  { id: "iso", label: "Iso", direction: [1, -1, 0.82] },
  { id: "front", label: "Front", direction: [0, -1, 0] },
  { id: "side", label: "Side", direction: [1, 0, 0] },
  { id: "top", label: "Top", direction: [0, -0.0001, 1] },
];

export const LIMITS = { position: 100_000, size: [1, 100_000], lineWidth: [0, 10], outline: [0, 20], crease: [1, 180] } as const;

export function defaultStyle(): SceneStyle {
  return { preset: STYLE_PRESETS[0].id, ...STYLE_PRESETS[0].style };
}

export function blankScene(): SceneData {
  return { version: 1, parts: [], camera: { direction: [...VIEWS[0].direction], target: [0, 0, 0], size: 60 }, style: defaultStyle(), explode: 0 };
}

const num = (v: unknown, fallback: number, min = -Infinity, max = Infinity) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};
const vec = (v: unknown, fallback: Vec3, limit: number = LIMITS.position): Vec3 =>
  Array.isArray(v) && v.length === 3 ? [num(v[0], fallback[0], -limit, limit), num(v[1], fallback[1], -limit, limit), num(v[2], fallback[2], -limit, limit)] : [...fallback];
const colour = (v: unknown, fallback: string) => (typeof v === "string" && /^#[0-9a-f]{3,8}$/i.test(v) ? v : fallback);
const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

/** Rotation angles kept between -180 and 180. */
export function wrapAngle(a: number): number {
  const r = ((((a + 180) % 360) + 360) % 360) - 180;
  return Object.is(r, -0) ? 0 : r;
}

/** `value` as a scene, with anything missing or out of range put right. */
export function normalizeScene(value: unknown): SceneData {
  const base = blankScene();
  if (!value || typeof value !== "object") return base;
  const v = value as Partial<SceneData>;
  const parts: ScenePart[] = Array.isArray(v.parts)
    ? v.parts.filter(p => p && typeof p === "object").map((p, i) => {
        const part: ScenePart = {
          id: text(p.id, 40) || `p${i + 1}`,
          name: text(p.name, 120) || `Part ${i + 1}`,
          position: vec(p.position, [0, 0, 0]),
          rotation: vec(p.rotation, [0, 0, 0], 100_000).map(wrapAngle) as Vec3,
        };
        if (typeof p.url === "string" && p.url) part.url = p.url;
        if (typeof p.file === "string" && p.file) part.file = p.file.slice(0, 200);
        if (typeof p.data === "string" && p.data) part.data = p.data;
        if (p.hidden) part.hidden = true;
        if (p.highlight) part.highlight = true;
        if (typeof p.parent === "string" && p.parent) part.parent = p.parent;
        if (p.ghost) part.ghost = true;
        if (p.joint && typeof p.joint === "object") {
          const j = p.joint;
          const unit = (v: unknown) => {
            const n = vec(v, [0, 0, 1], 1);
            return Math.hypot(...n) > 1e-9 ? n : ([0, 0, 1] as Vec3);
          };
          part.joint = { normal: unit(j.normal), distance: num(j.distance, 0, 0, LIMITS.position) };
          if (Array.isArray(j.point) && Array.isArray(j.childPoint) && Array.isArray(j.childNormal)) {
            part.joint.point = vec(j.point, [0, 0, 0]);
            part.joint.childPoint = vec(j.childPoint, [0, 0, 0]);
            part.joint.childNormal = unit(j.childNormal);
            part.joint.spin = wrapAngle(num(j.spin, 0));
            part.joint.gap = num(j.gap, 0, -LIMITS.position, LIMITS.position);
          }
          if (j.type === "revolute" || j.type === "prismatic") {
            const [lo, hi] = DEFAULT_LIMITS[j.type];
            const max = j.type === "revolute" ? 180 : LIMITS.position;
            let lower = num(j.lower, lo, -max, max);
            let upper = num(j.upper, hi, -max, max);
            if (lower > upper) [lower, upper] = [upper, lower];
            part.joint.type = j.type;
            part.joint.lower = lower;
            part.joint.upper = upper;
          }
        }
        return part;
      })
    : [];
  // A part joined to one that isn't there, or to itself through others, stands on its own.
  const ids = new Set(parts.map(p => p.id));
  const byId = new Map(parts.map(p => [p.id, p]));
  for (const p of parts) {
    if (p.parent && !ids.has(p.parent)) delete p.parent;
    const seen = new Set([p.id]);
    for (let q = p.parent ? byId.get(p.parent) : undefined; q; q = q.parent ? byId.get(q.parent) : undefined) {
      if (seen.has(q.id)) {
        delete p.parent;
        break;
      }
      seen.add(q.id);
    }
  }
  const c = (v.camera || {}) as Partial<SceneCamera>;
  const dir = vec(c.direction, base.camera.direction);
  const camera: SceneCamera = {
    direction: Math.hypot(...dir) > 1e-9 ? dir : base.camera.direction,
    target: vec(c.target, base.camera.target),
    size: num(c.size, base.camera.size, LIMITS.size[0], LIMITS.size[1]),
  };
  const s = (v.style || {}) as Partial<SceneStyle>;
  const d = base.style;
  const style: SceneStyle = {
    preset: text(s.preset, 40) || d.preset,
    fill: colour(s.fill, d.fill),
    line: colour(s.line, d.line),
    lineWidth: num(s.lineWidth, d.lineWidth, ...LIMITS.lineWidth),
    outline: num(s.outline, d.outline, ...LIMITS.outline),
    crease: num(s.crease, d.crease, ...LIMITS.crease),
    highlight: colour(s.highlight, d.highlight),
    ghost: colour(s.ghost, d.ghost),
  };
  if (s.draft === false) style.draft = false;
  const out: SceneData = { version: 1, parts, camera, style, explode: num(v.explode, 0, 0, 1) };
  if (v.model && typeof v.model === "object") out.model = { stamp: num((v.model as { stamp?: unknown }).stamp, 0, 0) };
  const views = normalizeViews(v.views);
  if (views.length) out.views = views;
  return out;
}

/** `value` as a list of named views (at most 50), anything broken left out. */
export function normalizeViews(value: unknown): NamedView[] {
  if (!Array.isArray(value)) return [];
  const base = blankScene().camera;
  const seen = new Set<string>();
  const out: NamedView[] = [];
  for (const v of value.slice(0, 50)) {
    if (!v || typeof v !== "object") continue;
    const id = text(v.id, 40);
    const name = text(v.name, 60).trim();
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    const c = (v.camera || {}) as Partial<SceneCamera>;
    const dir = vec(c.direction, base.direction);
    out.push({
      id,
      name,
      camera: {
        direction: Math.hypot(...dir) > 1e-9 ? dir : base.direction,
        target: vec(c.target, base.target),
        size: num(c.size, base.size, LIMITS.size[0], LIMITS.size[1]),
      },
    });
  }
  return out;
}

// ------------------------------------------------------------ the project model

/** What a scene shows of a part, as opposed to what the part is. */
const SHOWING = ["hidden", "ghost", "highlight"] as const;

/** A part as the model has it: without one scene's hidden / ghost / highlight. */
export function modelPart(p: ScenePart): ScenePart {
  const out = { ...p };
  for (const k of SHOWING) delete out[k];
  return out;
}

/** `value` as a project model, or null when it isn't one. */
export function normalizeModel(value: unknown): ProjectModel | null {
  if (!value || typeof value !== "object" || !Array.isArray((value as ProjectModel).parts)) return null;
  const v = value as ProjectModel;
  const out: ProjectModel = { version: 1, stamp: num(v.stamp, 0, 0), parts: normalizeScene({ parts: v.parts }).parts.map(modelPart) };
  const views = normalizeViews(v.views);
  if (views.length) out.views = views;
  return out;
}

/** The model a scene's parts make, at `stamp`. */
export function modelOf(scene: SceneData, stamp: number): ProjectModel {
  return { version: 1, stamp, parts: scene.parts.map(modelPart) };
}

/** Whether two lists of parts differ in what they are (not in what a scene shows of them). */
export function partsDiffer(a: ScenePart[], b: ScenePart[]): boolean {
  return JSON.stringify(a.map(modelPart)) !== JSON.stringify(b.map(modelPart));
}

/**
 * The scene with its parts taken from `model`: each keeps what this scene
 * showed of it, and parts new to the model start hidden (tick them to show
 * them). Camera, explode and style stay the scene's own.
 */
export function followModel(scene: SceneData, model: ProjectModel): SceneData {
  const had = new Map(scene.parts.map(p => [p.id, p]));
  const fresh = !scene.model;
  const parts = model.parts.map(m => {
    const p: ScenePart = { ...structuredClone(m) };
    const was = had.get(m.id);
    if (was) for (const k of SHOWING) if (was[k]) p[k] = true;
    if (!was && !fresh) p.hidden = true;
    return p;
  });
  return { ...scene, parts, model: { stamp: model.stamp } };
}

/** Whether the scene was drawn from an older version of `model`. */
export function behindModel(scene: SceneData | undefined, model: ProjectModel | { stamp: number } | null | undefined): boolean {
  return !!(scene?.model && model && scene.model.stamp < model.stamp);
}

/** The style a preset gives, keeping the highlight colour already chosen. */
export function applyPreset(style: SceneStyle, id: string): SceneStyle {
  const p = STYLE_PRESETS.find(x => x.id === id);
  return p ? { ...p.style, highlight: style.highlight, ghost: style.ghost, ...(style.draft === false ? { draft: false } : {}), preset: p.id } : style;
}

export function newPartId(parts: ScenePart[]): string {
  const used = new Set(parts.map(p => p.id));
  let n = parts.length + 1;
  while (used.has(`p${n}`)) n++;
  return `p${n}`;
}

/** A part's name from its file name: "left_wheel-2.stl" → "left wheel 2". */
export function partName(file: string): string {
  const base = file.split(/[\\/]/).pop()!.replace(/\?.*$/, "").replace(/\.(stl)$/i, "");
  return base.replace(/[_-]+/g, " ").trim() || "Part";
}

export interface Box3 {
  min: Vec3;
  max: Vec3;
}

/**
 * Where a new part goes, given the boxes of the parts already there and the
 * new part's own size: where its file put it, unless that overlaps another
 * part; then beside the others along X, with a gap.
 */
export function placeBeside(existing: Box3[], at: Vec3, size: Vec3, gap = 10): Vec3 {
  const half = size.map(s => s / 2) as Vec3;
  const box: Box3 = { min: at.map((a, i) => a - half[i]) as Vec3, max: at.map((a, i) => a + half[i]) as Vec3 };
  const overlaps = (a: Box3, b: Box3) => a.min.every((m, i) => m < b.max[i] && a.max[i] > b.min[i]);
  if (!existing.some(b => overlaps(box, b))) return [...at];
  const maxX = Math.max(...existing.map(b => b.max[0]));
  const ys = existing.map(b => (b.min[1] + b.max[1]) / 2);
  const zMin = Math.min(...existing.map(b => b.min[2]));
  return [maxX + gap + half[0], ys.reduce((a, b) => a + b, 0) / ys.length, zMin + half[2]];
}
