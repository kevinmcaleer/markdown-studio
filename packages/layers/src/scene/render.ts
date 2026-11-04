// Draws a scene in the assembly-instructions style with three.js:
//
// 1. Part-ID pass: every part in its own flat colour, to an off-screen image.
// 2. Main pass: parts filled flat (white, or the highlight colour), with fine
//    lines where the surface folds more than the crease angle. The fill is
//    pushed back a little so its own lines aren't hidden; nearer parts hide
//    the lines of parts behind them.
// 3. Outline pass: a full-screen shader draws the line colour wherever a
//    pixel nearby belongs to another part (or to nothing), which gives each
//    part its bold outline, even where it overlaps another part.
//
// The finished picture is drawn at twice the size and shrunk, so lines are smooth.

import {
  Box3, BufferAttribute, Euler, Matrix4, BufferGeometry, Color, EdgesGeometry, Group, Mesh, MeshBasicMaterial, OrthographicCamera, PlaneGeometry, Scene,
  ShaderMaterial, Vector2, Vector3, WebGLRenderer, WebGLRenderTarget, NearestFilter, NoBlending, type Object3D,
} from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import type { SceneCamera, SceneData, ScenePart, SceneStyle, Vec3 } from "./model";
import { explodeOf, highlightedParts } from "./model";
import { readStep, isStepFile, mergeBodies, type StepBody } from "./step";
import { bounds, fromBase64, parseStl, stlFaces } from "./stl";

const DEG = Math.PI / 180;

// ------------------------------------------------------------ models

export interface Model {
  /** The triangles, moved so the model's middle is at 0, 0, 0. */
  geometry: BufferGeometry;
  /** Where the model's middle was in its file, in mm. */
  centre: Vec3;
  size: Vec3;
  triangles: number;
  edges: Map<number, LineSegmentsGeometry>;
  /** Each triangle's CAD face, for a model from a STEP file (0xffff: not known). */
  faces?: Uint16Array;
}

export type FetchModel = (url: string) => Promise<ArrayBuffer>;

export function modelFromStl(buffer: ArrayBuffer): Model {
  return modelFromPositions(parseStl(buffer), stlFaces(buffer));
}

/** A model from its triangles' corners (moved to its middle, in place). */
export function modelFromPositions(pos: Float32Array, faces?: Uint16Array | null): Model {
  const b = bounds(pos);
  const centre = b.min.map((m, i) => (m + b.max[i]) / 2) as Vec3;
  for (let i = 0; i < pos.length; i += 3) {
    pos[i] -= centre[0];
    pos[i + 1] -= centre[1];
    pos[i + 2] -= centre[2];
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(pos, 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const model: Model = { geometry, centre, size: b.max.map((m, i) => m - b.min[i]) as Vec3, triangles: pos.length / 9, edges: new Map() };
  if (faces && faces.length === model.triangles) model.faces = faces;
  return model;
}

/** The fold lines at a crease angle, worked out once per angle. */
function edgesOf(model: Model, crease: number): LineSegmentsGeometry | null {
  if (crease >= 180) return null;
  const key = Math.round(crease);
  let g = model.edges.get(key);
  if (!g) {
    const e = new EdgesGeometry(model.geometry, key);
    g = new LineSegmentsGeometry().setPositions(e.attributes.position.array as Float32Array);
    e.dispose();
    model.edges.set(key, g);
  }
  return g;
}

type PartSource = Pick<ScenePart, "url" | "data" | "id" | "body">;

/** Models already read, by where they came from, so each is read once. */
export class ModelStore {
  private models = new Map<string, Promise<Model>>();
  /** STEP files read, by URL: every solid in each, as one file gives several parts. */
  private steps = new Map<string, Promise<StepBody[]>>();
  constructor(private fetchModel: FetchModel) {}

  static key(part: PartSource): string {
    return part.url ? `url:${part.url}${part.body !== undefined ? `#${part.body}` : ""}` : `data:${part.id}:${part.data?.length || 0}:${part.data?.slice(0, 64) || ""}`;
  }

  /** The solids in a STEP file in the project, read once. */
  stepBodies(url: string): Promise<StepBody[]> {
    let s = this.steps.get(url);
    if (!s) {
      s = this.fetchModel(url).then(readStep);
      this.steps.set(url, s);
      s.catch(() => this.steps.delete(url));
    }
    return s;
  }

  get(part: PartSource): Promise<Model> {
    const key = ModelStore.key(part);
    let m = this.models.get(key);
    if (!m) {
      m = (async () => {
        if (part.data) return modelFromStl(fromBase64(part.data));
        if (part.url && isStepFile(part.url)) {
          const bodies = await this.stepBodies(part.url);
          // The whole file as one part; `body` is one solid of it (scenes made before files came in whole).
          const b = part.body === undefined ? mergeBodies(bodies) : bodies[part.body];
          if (!b) throw new Error("That part isn't in its STEP file any more.");
          // A copy: the solid is kept for the file's other parts, and a model is moved to its middle.
          return modelFromPositions(b.positions.slice(), b.faces);
        }
        if (part.url) return modelFromStl(await this.fetchModel(part.url));
        throw new Error("This part has no model.");
      })();
      this.models.set(key, m);
      m.catch(() => this.models.delete(key));
    }
    return m;
  }

  /** A model read here already, under the part that will use it. */
  put(part: PartSource, model: Model): void {
    this.models.set(ModelStore.key(part), Promise.resolve(model));
  }

  dispose(): void {
    for (const m of this.models.values()) {
      m.then(model => {
        model.geometry.dispose();
        model.edges.forEach(e => e.dispose());
      }, () => {});
    }
    this.models.clear();
  }
}

// ------------------------------------------------------------ the camera

export function cameraFor(cam: SceneCamera, aspect: number, radius: number): OrthographicCamera {
  const s = cam.size;
  const dist = Math.max(1000, radius * 4);
  const c = new OrthographicCamera(-s * aspect, s * aspect, s, -s, 0.1, dist * 2 + radius * 4);
  c.up.set(0, 0, 1);
  placeCamera(c, cam, dist);
  return c;
}

export function placeCamera(c: OrthographicCamera, cam: SceneCamera, dist: number): void {
  const dir = new Vector3(...cam.direction).normalize();
  const target = new Vector3(...cam.target);
  c.position.copy(target).addScaledVector(dir, dist);
  c.lookAt(target);
  c.updateProjectionMatrix();
}

// ------------------------------------------------------------ the renderer

const OUTLINE_VERT = "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }";
const OUTLINE_FRAG = `
  uniform sampler2D tId; uniform vec2 px; uniform float width; uniform vec3 colour; uniform vec3 ghost; varying vec2 vUv;
  // A part's ID is its colour; alpha is 1 for a part, 0.5 for a ghost part, 0 for nothing.
  // An edge touching a part gets the line colour; one only between ghosts and nothing, the ghost colour.
  void main() {
    vec4 here = texture2D(tId, vUv);
    float hitPart = 0.0;
    float hitGhost = 0.0;
    for (int r = 1; r <= 48; r++) {
      float fr = float(r);
      if (fr > width) break;
      for (int k = 0; k < 16; k++) {
        float a = float(k) * 0.39269908;
        vec4 there = texture2D(tId, vUv + vec2(cos(a), sin(a)) * fr * px);
        if (distance(there, here) > 0.001) {
          if (here.a > 0.75 || there.a > 0.75) { hitPart = 1.0; break; }
          hitGhost = 1.0;
        }
      }
      if (hitPart > 0.5) break;
    }
    if (hitPart > 0.5) gl_FragColor = vec4(colour, 1.0);
    else if (hitGhost > 0.5) gl_FragColor = vec4(ghost, 1.0);
    else discard;
  }`;

interface PartObjects {
  part: ScenePart;
  model: Model;
  group: Group;
  fill: Mesh;
  lines: LineSegments2 | null;
  idGroup: Group;
}

/** A part's place in its parent's frame (or the world's): move, then turn about its middle. */
export function localMatrix(part: Pick<ScenePart, "position" | "rotation">): Matrix4 {
  const m = new Matrix4().makeRotationFromEuler(new Euler(part.rotation[0] * DEG, part.rotation[1] * DEG, part.rotation[2] * DEG, "ZYX"));
  return m.setPosition(...part.position);
}

/**
 * Every part's place in the world. A joined part sits in its parent's frame,
 * pushed out along its joint by `explode` of its distance, so exploding
 * moves a whole branch together. A part's own explode wins over `explode`,
 * unless `own` is false (where everything goes when assembled).
 */
export function worldMatrices(parts: ScenePart[], explode = 0, own = true): Map<string, Matrix4> {
  const byId = new Map(parts.map(p => [p.id, p]));
  const out = new Map<string, Matrix4>();
  const visit = (p: ScenePart, depth: number): Matrix4 => {
    const done = out.get(p.id);
    if (done) return done;
    const local = localMatrix(p);
    const parent = p.parent ? byId.get(p.parent) : undefined;
    let m = local;
    if (parent && depth < 64) {
      m = visit(parent, depth + 1).clone();
      const f = own ? explodeOf(p, explode) : explode;
      if (p.joint && f > 0) {
        const n = new Vector3(...p.joint.normal).normalize().multiplyScalar(p.joint.distance * f);
        m.multiply(new Matrix4().makeTranslation(n.x, n.y, n.z));
      }
      m.multiply(local);
    }
    out.set(p.id, m);
    return m;
  };
  parts.forEach(p => visit(p, 0));
  return out;
}

function place(o: Object3D, m: Matrix4): void {
  o.matrixAutoUpdate = false;
  o.matrix.copy(m);
  o.matrixWorldNeedsUpdate = true;
}

/**
 * One WebGL drawing surface that draws scenes in the line-art style. The
 * workspace keeps one for its live view; a finished picture uses a short-lived one.
 */
export class LineArt {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  /** Drawn last, over the picture and without its style: the workspace's handles. */
  readonly overlay = new Scene();
  private idScene = new Scene();
  private quadScene = new Scene();
  private quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private outline: ShaderMaterial;
  private target: WebGLRenderTarget | null = null;
  private objects: PartObjects[] = [];
  private lineMaterials = new Map<string, LineMaterial>();
  private style: SceneStyle | null = null;
  /** Dashed draft lines: each exploded part's path back to where it fits. */
  private draft: LineSegments2 | null = null;
  private draftMaterial: LineMaterial | null = null;

  constructor(canvas?: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(1);
    this.outline = new ShaderMaterial({
      uniforms: { tId: { value: null }, px: { value: new Vector2() }, width: { value: 3 }, colour: { value: new Color() }, ghost: { value: new Color() } },
      vertexShader: OUTLINE_VERT,
      fragmentShader: OUTLINE_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.quadScene.add(new Mesh(new PlaneGeometry(2, 2), this.outline));
  }

  /** Puts these parts (with their models) in the scene, in this style. */
  setParts(list: { part: ScenePart; model: Model }[], style: SceneStyle, explode = 0): void {
    this.clear();
    this.style = style;
    const world = worldMatrices(list.map(x => x.part), explode);
    const lit = highlightedParts(list.map(x => x.part));
    list.forEach(({ part, model }, i) => {
      const fillColour = part.ghost ? style.fill : lit.has(part.id) ? style.highlight : style.fill;
      const fill = new Mesh(model.geometry, new MeshBasicMaterial({ color: fillColour, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
      fill.userData.partId = part.id;
      const group = new Group();
      group.add(fill);
      const edges = edgesOf(model, style.crease);
      let lines: LineSegments2 | null = null;
      if (edges && style.lineWidth > 0) {
        lines = new LineSegments2(edges, this.lineMaterial(part.ghost ? style.ghost : style.line));
        lines.raycast = () => {};
        group.add(lines);
      }
      const idGroup = new Group();
      // Each part's ID colour; 0 (black) is the empty background.
      // Written as is (no blending), so a ghost part's alpha marks it for the outline pass.
      idGroup.add(new Mesh(model.geometry, new MeshBasicMaterial({ color: new Color().setHex(idColour(i + 1)), transparent: true, opacity: part.ghost ? 0.5 : 1, blending: NoBlending })));
      place(group, world.get(part.id)!);
      place(idGroup, world.get(part.id)!);
      group.visible = idGroup.visible = !part.hidden;
      this.scene.add(group);
      this.idScene.add(idGroup);
      this.objects.push({ part, model, group, fill, lines, idGroup });
    });
    this.drawDraft(world, explode);
  }

  /**
   * Draft lines, as in printed instructions: a dashed line from each
   * exploded part (from its picked face, or its middle) back along its joint
   * to where it fits on its parent.
   */
  private drawDraft(world: Map<string, Matrix4>, explode: number): void {
    if (this.draft) {
      this.scene.remove(this.draft);
      this.draft.geometry.dispose();
      this.draft = null;
    }
    const style = this.style;
    if (!style || style.draft === false || style.lineWidth <= 0) return;
    const pts: number[] = [];
    const byId = new Map(this.objects.map(o => [o.part.id, o]));
    for (const o of this.objects) {
      const p = o.part;
      const f = explodeOf(p, explode);
      if (!p.parent || !p.joint || p.hidden || p.ghost || p.joint.distance <= 0 || f <= 0) continue;
      const parent = byId.get(p.parent);
      const m = world.get(p.id);
      const pm = world.get(p.parent);
      if (!parent || parent.part.hidden || !m || !pm) continue;
      const from = new Vector3(...(p.joint.childPoint || [0, 0, 0])).applyMatrix4(m);
      // The slide, turned into the world by the parent's frame.
      const slide = new Vector3(...p.joint.normal).transformDirection(pm).multiplyScalar(p.joint.distance * f);
      if (slide.lengthSq() < 1e-6) continue;
      // Start at the part's leading end (a screw's tip, not its neck), so
      // the line isn't hidden inside the part.
      const back = slide.clone().normalize().negate();
      const bb = o.model.geometry.boundingBox;
      let lead = 0;
      if (bb) for (let k = 0; k < 8; k++) {
        const c = new Vector3(k & 1 ? bb.max.x : bb.min.x, k & 2 ? bb.max.y : bb.min.y, k & 4 ? bb.max.z : bb.min.z).applyMatrix4(m);
        lead = Math.max(lead, c.sub(from).dot(back));
      }
      // Still overlapping where it fits: no gap for a line to show.
      if (lead >= slide.length() - 1e-3) continue;
      const to = from.clone().sub(slide);
      from.addScaledVector(back, lead);
      pts.push(from.x, from.y, from.z, to.x, to.y, to.z);
    }
    if (!pts.length) return;
    const dashed = !style.draftSolid;
    if (this.draftMaterial && this.draftMaterial.dashed !== dashed) {
      this.draftMaterial.dispose();
      this.draftMaterial = null;
    }
    this.draftMaterial ??= new LineMaterial({ color: 0, linewidth: 1, worldUnits: false, dashed, dashSize: 3, gapSize: 2 });
    this.draftMaterial.color.set(style.line);
    const geo = new LineSegmentsGeometry().setPositions(pts);
    this.draft = new LineSegments2(geo, this.draftMaterial);
    this.draft.computeLineDistances();
    this.draft.raycast = () => {};
    this.scene.add(this.draft);
  }

  /** Follows the parts' new places without rebuilding the scene. */
  move(parts: ScenePart[], explode = 0): void {
    const world = worldMatrices(parts, explode);
    for (const o of this.objects) {
      const m = world.get(o.part.id);
      if (!m) continue;
      place(o.group, m);
      place(o.idGroup, m);
    }
    this.drawDraft(world, explode);
  }

  /** A part's place in the world as drawn now. */
  matrixOf(id: string): Matrix4 | undefined {
    return this.objects.find(x => x.part.id === id)?.group.matrix;
  }

  groupOf(id: string): Group | undefined {
    return this.objects.find(x => x.part.id === id)?.group;
  }

  /** The parts' fill meshes, for finding what was clicked. */
  meshes(): Mesh[] {
    return this.objects.filter(o => o.group.visible).map(o => o.fill);
  }

  /** The box round the visible parts, in mm. */
  bounds(): Box3 {
    const box = new Box3();
    this.objects.forEach(o => {
      if (!o.group.visible) return;
      o.group.updateMatrixWorld(true);
      box.expandByObject(o.fill);
    });
    return box;
  }

  private lineMaterial(colour: string): LineMaterial {
    let m = this.lineMaterials.get(colour);
    if (!m) {
      m = new LineMaterial({ color: new Color(colour).getHex(), linewidth: 1, worldUnits: false });
      this.lineMaterials.set(colour, m);
    }
    return m;
  }

  /**
   * Draws to the renderer's canvas, `w`×`h` CSS pixels at `ratio` device
   * pixels each. `background` "" leaves it see-through.
   */
  draw(camera: OrthographicCamera, w: number, h: number, ratio: number, background = ""): void {
    const style = this.style;
    if (!style) return;
    const r = this.renderer;
    const pw = Math.max(1, Math.round(w * ratio));
    const ph = Math.max(1, Math.round(h * ratio));
    r.setPixelRatio(1);
    r.setSize(pw, ph, false);
    if (!this.target || this.target.width !== pw || this.target.height !== ph) {
      this.target?.dispose();
      this.target = new WebGLRenderTarget(pw, ph, { minFilter: NearestFilter, magFilter: NearestFilter });
    }
    for (const m of this.lineMaterials.values()) {
      m.linewidth = style.lineWidth * ratio;
      m.resolution.set(pw, ph);
    }
    if (this.draftMaterial) {
      // Dashes a steady size on the picture, whatever the zoom: mm per pixel.
      const mmPerPx = (camera.top - camera.bottom) / camera.zoom / h;
      this.draftMaterial.linewidth = style.lineWidth * ratio;
      this.draftMaterial.resolution.set(pw, ph);
      this.draftMaterial.dashSize = 7 * mmPerPx;
      this.draftMaterial.gapSize = 5 * mmPerPx;
    }
    r.autoClear = true;
    r.setRenderTarget(this.target);
    r.setClearColor(0x000000, 0);
    r.render(this.idScene, camera);
    r.setRenderTarget(null);
    if (background) r.setClearColor(new Color(background), 1);
    else r.setClearColor(0x000000, 0);
    r.render(this.scene, camera);
    if (style.outline > 0) {
      const u = this.outline.uniforms;
      u.tId.value = this.target.texture;
      (u.px.value as Vector2).set(1 / pw, 1 / ph);
      // Half the outline falls on each side of a part's edge.
      u.width.value = Math.max(0.5, (style.outline * ratio) / 2);
      (u.colour.value as Color).set(style.line);
      (u.ghost.value as Color).set(style.ghost);
      r.autoClear = false;
      r.render(this.quadScene, this.quadCamera);
      r.autoClear = true;
    }
    if (this.overlay.children.length) {
      r.autoClear = false;
      r.clearDepth();
      r.render(this.overlay, camera);
      r.autoClear = true;
    }
  }

  clear(): void {
    for (const o of this.objects) {
      (o.fill.material as MeshBasicMaterial).dispose();
      ((o.idGroup.children[0] as Mesh).material as MeshBasicMaterial).dispose();
      this.scene.remove(o.group);
      this.idScene.remove(o.idGroup);
    }
    this.objects = [];
  }

  dispose(): void {
    this.clear();
    this.draft?.geometry.dispose();
    this.draftMaterial?.dispose();
    this.lineMaterials.forEach(m => m.dispose());
    this.outline.dispose();
    this.target?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

/** Part IDs spread over the colours so neighbours differ well above rounding. */
function idColour(n: number): number {
  const r = (n * 53) % 256;
  const g = (n * 97 + 40) % 256;
  const b = Math.floor(n / 256) * 37 + 20;
  return (r << 16) | (g << 8) | (b & 255);
}

/** Half the size of a sphere round the visible parts, for framing. */
export function radiusOf(box: Box3): number {
  return box.isEmpty() ? 50 : box.getSize(new Vector3()).length() / 2;
}

/** The camera that frames these parts from the camera's direction, with a margin. */
export function frame(cam: SceneCamera, box: Box3, aspect: number, margin = 1.12): SceneCamera {
  if (box.isEmpty()) return cam;
  const c = cameraFor({ ...cam, target: [0, 0, 0], size: 1 }, 1, radiusOf(box));
  c.updateMatrixWorld();
  // The parts' corners as seen by the camera: their spread across and up.
  const inv = c.matrixWorldInverse;
  const lo = new Vector3(Infinity, Infinity, Infinity);
  const hi = new Vector3(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < 8; i++) {
    const p = new Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(inv);
    lo.min(p);
    hi.max(p);
  }
  const mid = new Vector3((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, (lo.z + hi.z) / 2).applyMatrix4(c.matrixWorld);
  // Back along the view to the box middle's depth, so the target sits among the parts.
  const centre = box.getCenter(new Vector3());
  const dir = new Vector3(...cam.direction).normalize();
  mid.addScaledVector(dir, centre.clone().sub(mid).dot(dir));
  const halfH = Math.max((hi.y - lo.y) / 2, (hi.x - lo.x) / 2 / aspect) * margin;
  return { direction: [...cam.direction] as Vec3, target: [mid.x, mid.y, mid.z], size: Math.max(1, halfH) };
}

/**
 * The finished picture: the scene drawn at `w`×`h` (times `scale`) with a
 * see-through background, drawn bigger and shrunk so its lines are smooth.
 * Parts whose models can't be read are left out.
 */
export async function renderPicture(data: SceneData, store: ModelStore, w: number, h: number, scale = 1): Promise<HTMLCanvasElement> {
  const settled = await Promise.allSettled(data.parts.map(async part => ({ part, model: await store.get(part) })));
  const list = settled.flatMap(r => (r.status === "fulfilled" ? [r.value] : []));
  const ow = Math.max(1, Math.round(w * scale));
  const oh = Math.max(1, Math.round(h * scale));
  const art = new LineArt();
  try {
    const max = Math.min(art.renderer.capabilities.maxTextureSize || 4096, 8192);
    const ss = Math.max(1, Math.min(2, max / Math.max(ow, oh)));
    art.setParts(list, data.style, data.explode);
    const camera = cameraFor(data.camera, w / h, radiusOf(art.bounds()) + Math.hypot(...data.camera.target));
    art.draw(camera, w, h, scale * ss);
    const out = document.createElement("canvas");
    out.width = ow;
    out.height = oh;
    const ctx = out.getContext("2d")!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(art.renderer.domElement, 0, 0, ow, oh);
    return out;
  } finally {
    art.dispose();
  }
}

/**
 * Small pictures of single models, for the Add a part menu: each drawn alone
 * from the iso view in the scene's style, framed to fill the square. One
 * renderer draws them all, so a long list doesn't use up the browser's
 * WebGL contexts.
 */
export class Thumbnailer {
  private art = new LineArt();

  /** The model drawn `px` pixels square, as a data URL. */
  draw(model: Model, style: SceneStyle, direction: Vec3, px: number): string {
    const part: ScenePart = { id: "t", name: "", position: [0, 0, 0], rotation: [0, 0, 0] };
    // Lines a touch finer than the scene's, so a small picture isn't all line.
    this.art.setParts([{ part, model }], { ...style, outline: Math.min(style.outline, 2), lineWidth: Math.min(style.lineWidth, 1) }, 0);
    const box = this.art.bounds();
    const cam = frame({ direction, target: [0, 0, 0], size: 1 }, box, 1, 1.08);
    const camera = cameraFor(cam, 1, radiusOf(box) + Math.hypot(...cam.target));
    this.art.draw(camera, px, px, 2);
    const out = document.createElement("canvas");
    out.width = px;
    out.height = px;
    const ctx = out.getContext("2d")!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(this.art.renderer.domElement, 0, 0, px, px);
    return out.toDataURL("image/png");
  }

  dispose(): void {
    this.art.dispose();
  }
}

// ------------------------------------------------------------ page geometry

/** Where points in the scene (mm) land on its picture, as fractions of its width and height (0–1; outside when off the picture). */
export function pagePoints(scene: SceneData, points: Vec3[], aspect: number): { x: number; y: number }[] {
  const camera = cameraFor(scene.camera, aspect, 1);
  camera.updateMatrixWorld();
  return points.map(p => {
    const v = new Vector3(...p).project(camera);
    return { x: (v.x + 1) / 2, y: (1 - v.y) / 2 };
  });
}

export interface StepArrow {
  /** The part the arrow belongs to. */
  id: string;
  name: string;
  /** From the exploded part towards where it fits, as fractions of the picture. */
  from: { x: number; y: number };
  to: { x: number; y: number };
  /** A Turns joint: the part turns about its joint as well. */
  turns: boolean;
}

/**
 * An arrow for each part drawn apart from its parent in this scene: along
 * its joint, from where it is drawn to where it fits, as fractions of the
 * picture. Parts that aren't exploded, are hidden or ghosts, or whose move
 * is too small to see get none.
 */
export function stepArrows(scene: SceneData, aspect: number): StepArrow[] {
  const world = worldMatrices(scene.parts, scene.explode);
  const out: StepArrow[] = [];
  const byId = new Map(scene.parts.map(p => [p.id, p]));
  for (const p of scene.parts) {
    const f = explodeOf(p, scene.explode);
    if (!p.parent || !p.joint || p.hidden || p.ghost || p.joint.distance <= 0 || f <= 0) continue;
    const parent = byId.get(p.parent);
    const m = world.get(p.id);
    const pm = world.get(p.parent);
    if (!parent || parent.hidden || !m || !pm) continue;
    const from = new Vector3(...(p.joint.childPoint || [0, 0, 0])).applyMatrix4(m);
    const slide = new Vector3(...p.joint.normal).transformDirection(pm).multiplyScalar(p.joint.distance * f);
    if (slide.lengthSq() < 1e-6) continue;
    const to = from.clone().sub(slide);
    const [a, b] = pagePoints(scene, [[from.x, from.y, from.z], [to.x, to.y, to.z]], aspect);
    if (Math.hypot((b.x - a.x) * aspect, b.y - a.y) < 0.04) continue;
    out.push({ id: p.id, name: p.name, from: a, to: b, turns: p.joint.type === "revolute" });
  }
  return out;
}
