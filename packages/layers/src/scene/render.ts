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
//
// The see-through view (look.seeThrough) draws the printed parts as glass:
// a faint tinted fill that hides nothing, faint fold lines, and their own
// outline pass in the ghost colour, kept out of the main ID pass, so the
// electronics behind them keep their bold outlines.
//
// A section view cuts every part on one side of a plane (see setSection):
// each cut face is filled (a cap, found with the stencil buffer) and hatched.

import {
  Box3, BufferAttribute, Euler, Matrix4, BufferGeometry, Color, EdgesGeometry, Group, Mesh, MeshBasicMaterial, OrthographicCamera, PlaneGeometry, Scene,
  ShaderMaterial, Vector2, Vector3, WebGLRenderer, WebGLRenderTarget, NearestFilter, NoBlending, type Object3D,
} from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { BufferGeometry as CutGeometry, DoubleSide, Float32BufferAttribute, LessEqualDepth, Texture } from "three";
import { ARROW_FROM, ARROW_TO } from "./model";
import {
  AlwaysStencilFunc, BackSide, DecrementWrapStencilOp, FrontSide, IncrementWrapStencilOp, NotEqualStencilFunc, Plane, Quaternion, ZeroStencilOp, type Material, type Side,
} from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import type { SceneCamera, SceneData, ScenePart, SceneStyle, SectionPlane, Vec3 } from "./model";
import { explodeVector } from "./explode";
import { explodeOf, highlightedParts, lookOf, sectionKeeps, sectionOrigin, shownAs, type SceneLook } from "./model";
import { wireMesh } from "./wire";
import { seeThroughParts } from "./seeThrough";
import { coresOf, loomsOf, type Looms } from "./wireSpec";
import { readStep, isStepFile, mergeBodies, type StepBody } from "./step";
import { bounds, fromBase64, parseStl, stlFaces } from "./stl";
import { isPacked, unpackMesh } from "./mesh";
import { roundEdges } from "./rounds";
import { movePieceLines, movePieces, trackOpener, trackOpening, type TrackOpener } from "./trackOpen";

const DEG = Math.PI / 180;

/** The see-through view's glass: a cool tint, faint enough that what's behind it reads. */
export const GLASS_TINT = "#a9c3db";
export const GLASS_OPACITY = 0.22;

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

/**
 * The fold lines at a crease angle, worked out once per angle; with `rounds`,
 * the tangent lines of rounded edges too (see rounds.ts).
 */
function edgesOf(model: Model, crease: number, rounds = false): LineSegmentsGeometry | null {
  if (crease >= 180) return null;
  const angle = Math.round(crease);
  const key = rounds ? -angle : angle;
  let g = model.edges.get(key);
  if (!g) {
    g = new LineSegmentsGeometry().setPositions(foldLines(model.geometry, angle, rounds));
    model.edges.set(key, g);
  }
  return g;
}

/** The fold lines of some triangles at a crease angle (and their rounded edges' tangent lines, with `rounds`), as line ends. */
function foldLines(geometry: BufferGeometry, angle: number, rounds: boolean): Float32Array {
  const e = new EdgesGeometry(geometry, angle);
  let lines = e.attributes.position.array as Float32Array;
  e.dispose();
  if (rounds) {
    const r = roundEdges(geometry.attributes.position.array as Float32Array, angle);
    if (r.length) {
      const both = new Float32Array(lines.length + r.length);
      both.set(lines);
      both.set(r, lines.length);
      lines = both;
    }
  }
  return lines;
}

/** A track's first piece's fold lines, by crease key (see edgesOf), worked out once per model. */
const pieceLines = new WeakMap<Model, Map<number, Float32Array>>();
function firstPieceLines(model: Model, count: number, crease: number, rounds: boolean): Float32Array {
  const angle = Math.round(crease);
  const key = rounds ? -angle : angle;
  let byKey = pieceLines.get(model);
  if (!byKey) pieceLines.set(model, (byKey = new Map()));
  let lines = byKey.get(key);
  if (!lines) {
    const all = model.geometry.attributes.position.array as Float32Array;
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(all.slice(0, all.length / count), 3));
    lines = foldLines(g, angle, rounds);
    g.dispose();
    byKey.set(key, lines);
  }
  return lines;
}

type PartSource = Pick<ScenePart, "url" | "data" | "id" | "body"> & Pick<Partial<ScenePart>, "wire">;

/** A model with nothing in it: a wire's, whose tube is made from its parts' places as it's drawn. */
export function emptyModel(): Model {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(0), 3));
  return { geometry, centre: [0, 0, 0], size: [0, 0, 0], triangles: 0, edges: new Map() };
}

/** A wire's tube in the world, for parts placed by `world`. */
function wireGeometry(part: ScenePart, world: Map<string, Matrix4>, upto = 1, looms?: Looms, fromTo = false): BufferGeometry {
  const g = new BufferGeometry();
  const m = wireMesh(part, world, upto, looms, fromTo);
  g.setAttribute("position", new BufferAttribute(m.positions, 3));
  g.setAttribute("color", new BufferAttribute(m.colors, 3));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** Models already read, by where they came from, so each is read once. */
export class ModelStore {
  private models = new Map<string, Promise<Model>>();
  /** STEP files read, by URL: every solid in each, as one file gives several parts. */
  private steps = new Map<string, Promise<StepBody[]>>();
  constructor(private fetchModel: FetchModel) {}

  static key(part: PartSource): string {
    if (part.wire) return `wire:${part.id}`;
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
        if (part.wire) return emptyModel();
        if (part.data && isPacked(part.data)) {
          const { positions, faces } = await unpackMesh(part.data);
          return modelFromPositions(positions, faces);
        }
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
  /** A wire's tube, made from where its parts are (and made again when they move). */
  tube?: BufferGeometry;
  /** With a section: the part's cap on the plane, in the picture and in the ID pass. */
  caps?: { main: Mesh; id: Mesh };
  /** A track: how its pieces open as it explodes (null: it can't), and its shape and lines while open. */
  opener?: TrackOpener | null;
  open?: number;
  shape?: BufferGeometry;
  shapeLines?: LineSegmentsGeometry;
}

// A cut face's fill, hatched with lines across the picture (as on a drawing,
// they don't turn with the view): `angle` and `spacing` differ part to part,
// so neighbouring parts' cuts tell apart.
const CAP_VERT = "void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }";
const CAP_FRAG = `
  uniform vec3 fill; uniform vec3 line; uniform float angle; uniform float spacing; uniform float width; uniform float hatch;
  void main() {
    float d = mod(dot(gl_FragCoord.xy, vec2(cos(angle), sin(angle))), spacing);
    float off = min(d, spacing - d);
    float a = hatch * clamp(width * 0.5 + 0.5 - off, 0.0, 1.0);
    gl_FragColor = vec4(mix(fill, line, a), 1.0);
  }`;
/** Each part's hatching: angle (degrees) and spacing (px of the finished picture). */
const HATCHES: [number, number][] = [[45, 8], [-45, 8], [45, 5], [-45, 5], [30, 10], [-60, 10], [60, 6.5], [-30, 6.5]];

/**
 * A section's plane as three.js clips with it: three keeps what lies on the
 * plane normal's side, so it faces back, away from the side cut off.
 */
export function clipPlane(s: SectionPlane): Plane {
  const n = new Vector3(...s.normal).normalize();
  return new Plane(n.clone().negate(), n.dot(new Vector3(...sectionOrigin(s))));
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
        const n = explodeVector(p.joint, m).multiplyScalar(p.joint.distance * f);
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
  /** The see-through view's glass parts' IDs, outlined in the ghost colour against the solid parts' depth. */
  private glassScene = new Scene();
  private glassTarget: WebGLRenderTarget | null = null;
  private depthOnly: MeshBasicMaterial | null = null;
  /** The parts drawn as glass now (the see-through view's printed parts). */
  private glass = new Set<string>();
  private quadScene = new Scene();
  private quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private outline: ShaderMaterial;
  private target: WebGLRenderTarget | null = null;
  /** The parts' fills alone (no lines): what a draft line's halo paints, so it breaks lines but not the parts. */
  private fillTarget: WebGLRenderTarget | null = null;
  private objects: PartObjects[] = [];
  private lineMaterials = new Map<string, LineMaterial>();
  private style: SceneStyle | null = null;
  /** The part picked in the workspace: filled a stronger shade of the highlight, so it stands out (never in a saved picture). */
  private selected = "";
  /** Dashed draft lines: each exploded part's path back to where it fits. */
  private draft: LineSegments2 | null = null;
  private draftMaterial: LineMaterial | null = null;
  /** A band under each draft line painted with the fills alone, so the lines it crosses break round it as on a flat-pack sheet. */
  private draftHalo: LineSegments2 | null = null;
  private draftHaloMaterial: LineMaterial | null = null;
  /** The draft lines, drawn against the parts' depth after the outlines (unlike the overlay, which is drawn over everything). */
  private draftScene = new Scene();
  private haloFill = { value: null as Texture | null };
  /** Each exploded part's gap: from its leading end to where it fits, in the world (the draft lines' and the arrows' line). */
  private axes: { part: ScenePart; from: Vector3; to: Vector3 }[] = [];
  /** Solid arrows along the gaps, as in printed assembly steps, when on. */
  arrows = false;
  private arrowMesh: Mesh | null = null;
  private arrowMaterial: MeshBasicMaterial | null = null;
  /** The arrow picked in the workspace (its part's id, "" for none): drawn in the selected part's shade (never in a saved picture). */
  selectedArrow = "";
  private arrowSelMesh: Mesh | null = null;
  private arrowSelMaterial: MeshBasicMaterial | null = null;
  /** Each arrow as last drawn, in the world: its part, its ends, and half its widest (the head), for clicking on. */
  private arrowShapes: { id: string; start: Vector3; end: Vector3; half: number }[] = [];
  /** The parts' depth as drawn, for keeping each arrow's head out from behind a part. */
  private depthTarget: WebGLRenderTarget | null = null;
  private depthMaterial: ShaderMaterial | null = null;
  private depthPixel = new Uint8Array(4);
  /** Spots cut back to the fills alone (a detail circle's tail tip): the outline breaks round what the tail points at. */
  cuts: Cut[] = [];
  private cutMaterial: ShaderMaterial | null = null;
  private cutScene = new Scene();
  /** The section view's plane, when there is one: every part is cut by it. */
  private section: SectionPlane | null = null;
  /** The scene's wiring settings: the wiring view (other parts ghosted), or wiring hidden. Set before setParts. */
  look: SceneLook = {};
  private clip: Plane[] = [];
  /** The quad each cap is drawn on (sized to the parts), and the stencil counters' materials (picture, ID pass). */
  private capGeometry: PlaneGeometry | null = null;
  private stencilMaterials: Material[] = [];

  constructor(canvas?: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true, stencil: true });
    this.renderer.setPixelRatio(1);
    this.renderer.localClippingEnabled = true;
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
    const looms = loomsOf(list.map(x => x.part));
    this.glass = this.look.seeThrough ? seeThroughParts(list.map(x => x.part)) : new Set();
    list.forEach(({ part: own, model }, i) => {
      // As the wiring settings show it (ghosted in the wiring view, say); kept as it is.
      const part = shownAs(own, this.look);
      const fillColour = this.fillOf(part, lit);
      const tube = own.wire ? wireGeometry(own, world, 1, looms) : undefined;
      const geometry = tube || model.geometry;
      const glass = this.glass.has(own.id);
      const fill = new Mesh(geometry, new MeshBasicMaterial({ color: fillColour, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, clippingPlanes: this.clip, side: this.section ? DoubleSide : FrontSide, ...(glass ? { transparent: true, opacity: GLASS_OPACITY, depthWrite: false } : {}) }));
      fill.userData.partId = part.id;
      const group = new Group();
      group.add(fill);
      // A wire is round: its outline only, no fold lines.
      const edges = own.wire ? null : edgesOf(model, style.crease, style.rounds !== false);
      let lines: LineSegments2 | null = null;
      if (edges && style.lineWidth > 0) {
        lines = new LineSegments2(edges, glass ? this.glassLineMaterial(style.ghost) : this.lineMaterial(part.ghost ? style.ghost : style.line));
        lines.raycast = () => {};
        group.add(lines);
      }
      const idGroup = new Group();
      // Each part's ID colour; 0 (black) is the empty background.
      // Written as is (no blending), so a ghost part's alpha marks it for the outline pass.
      idGroup.add(new Mesh(geometry, new MeshBasicMaterial({ color: new Color().setHex(idColour(i + 1)), transparent: true, opacity: part.ghost || glass ? 0.5 : 1, blending: NoBlending, clippingPlanes: this.clip })));
      place(group, world.get(part.id)!);
      place(idGroup, world.get(part.id)!);
      group.visible = idGroup.visible = !part.hidden;
      this.scene.add(group);
      (glass ? this.glassScene : this.idScene).add(idGroup);
      const o: PartObjects = { part: own, model, group, fill, lines, idGroup, tube };
      this.objects.push(o);
      if (own.wire) this.paint(o, lit);
    });
    this.openTracks(list.map(x => x.part), explode);
    this.makeCaps();
    this.drawDraft(world, explode);
  }

  /**
   * Each track as open as its explode makes it: exploded far, a string of
   * pieces with its ends up and apart; closed round the wheels as it comes in.
   */
  private openTracks(parts: ScenePart[], explode: number): void {
    let assembled: Map<string, Matrix4> | undefined;
    for (const o of this.objects) {
      if (!o.part.track) continue;
      const f = o.part.hidden ? 0 : trackOpening(explodeOf(o.part, explode));
      if (f === (o.open || 0)) continue;
      if (o.opener === undefined) {
        assembled ||= worldMatrices(parts, 0, false);
        o.opener = trackOpener(o.part.id, o.part.track, o.model.triangles, assembled);
      }
      if (!o.opener) continue;
      this.shapeTrack(o, f);
    }
  }

  private shapeTrack(o: PartObjects, f: number): void {
    const style = this.style;
    const idMesh = o.idGroup.children[0] as Mesh;
    o.open = f;
    o.shapeLines?.dispose();
    o.shapeLines = undefined;
    if (!(f > 0) || !o.opener) {
      o.fill.geometry = idMesh.geometry = o.model.geometry;
      o.shape?.dispose();
      o.shape = undefined;
      if (o.lines && style) o.lines.geometry = edgesOf(o.model, style.crease, style.rounds !== false)!;
      return;
    }
    const moves = o.opener.moves(f);
    const src = o.model.geometry.attributes.position.array as Float32Array;
    if (!o.shape) {
      o.shape = new BufferGeometry();
      o.shape.setAttribute("position", new BufferAttribute(new Float32Array(src.length), 3));
    }
    const attr = o.shape.attributes.position as BufferAttribute;
    movePieces(src, moves, attr.array as Float32Array<ArrayBuffer>);
    attr.needsUpdate = true;
    o.shape.computeBoundingBox();
    o.shape.computeBoundingSphere();
    o.fill.geometry = idMesh.geometry = o.shape;
    if (o.lines && style && style.crease < 180) {
      const first = firstPieceLines(o.model, o.opener.count, style.crease, style.rounds !== false);
      o.shapeLines = new LineSegmentsGeometry().setPositions(movePieceLines(first, o.opener, moves));
      o.lines.geometry = o.shapeLines;
    }
  }

  // ------------------------------------------------------------ section view

  /**
   * Cuts every part with the section's plane (null: none). The parts' fills,
   * lines and IDs are clipped; each part's cut is capped: its back faces
   * count up in the stencil buffer and its front faces down, so where the
   * count isn't 0 the plane is inside the part, and the cap is drawn there
   * (clearing the count for the next part). Caps have their own IDs, so the
   * outline pass draws round each cut face.
   */
  setSection(s: SectionPlane | null | undefined): void {
    this.section = s ? structuredClone(s) : null;
    this.clip.length = 0;
    if (this.section) this.clip.push(clipPlane(this.section));
    // The same list everywhere: changing its length recompiles the materials that use it.
    for (const o of this.objects) {
      (o.fill.material as MeshBasicMaterial).side = this.section ? DoubleSide : FrontSide;
      (o.fill.material as MeshBasicMaterial).needsUpdate = true;
    }
    this.makeCaps();
  }

  /** Whether a point (world, mm) is drawn: not cut away by the section. */
  keeps(p: Vector3): boolean {
    return sectionKeeps(this.section ?? undefined, [p.x, p.y, p.z]);
  }

  private clearCaps(): void {
    for (const o of this.objects) {
      if (!o.caps) continue;
      this.scene.remove(o.caps.main);
      this.idScene.remove(o.caps.id);
      (o.caps.main.material as Material).dispose();
      (o.caps.id.material as Material).dispose();
      o.group.children.filter(c => c.userData.stencil).forEach(c => o.group.remove(c));
      o.idGroup.children.filter(c => c.userData.stencil).forEach(c => o.idGroup.remove(c));
      delete o.caps;
    }
    this.stencilMaterials.forEach(m => m.dispose());
    this.stencilMaterials = [];
    this.capGeometry?.dispose();
    this.capGeometry = null;
  }

  private makeCaps(): void {
    this.clearCaps();
    const s = this.section;
    const style = this.style;
    if (!s || !style) return;
    const counter = (side: Side, transparent: boolean) => {
      const m = new MeshBasicMaterial({
        colorWrite: false, depthWrite: false, depthTest: false, side, transparent, clippingPlanes: this.clip,
        stencilWrite: true, stencilFunc: AlwaysStencilFunc,
        stencilFail: side === BackSide ? IncrementWrapStencilOp : DecrementWrapStencilOp,
        stencilZFail: side === BackSide ? IncrementWrapStencilOp : DecrementWrapStencilOp,
        stencilZPass: side === BackSide ? IncrementWrapStencilOp : DecrementWrapStencilOp,
      });
      this.stencilMaterials.push(m);
      return m;
    };
    // The picture's counters, then the ID pass's (drawn in its transparent list, as its parts are).
    const mats = [[counter(BackSide, false), counter(FrontSide, false)], [counter(BackSide, true), counter(FrontSide, true)]];
    const stencilOff = (m: Material) => {
      m.stencilWrite = true;
      m.stencilRef = 0;
      m.stencilFunc = NotEqualStencilFunc;
      m.stencilFail = m.stencilZFail = m.stencilZPass = ZeroStencilOp;
    };
    this.capGeometry = new PlaneGeometry(1, 1);
    const lit = highlightedParts(this.objects.map(o => o.part));
    const n = this.objects.length;
    this.objects.forEach((o, i) => {
      const order = 10 + i * 2;
      for (const [k, g] of [o.group, o.idGroup].entries()) {
        for (const m of mats[k]) {
          const c = new Mesh(o.shape || o.model.geometry, m);
          c.userData.stencil = true;
          c.renderOrder = order;
          c.raycast = () => {};
          g.add(c);
        }
      }
      const [angle, spacing] = HATCHES[i % HATCHES.length];
      const part = o.part;
      const main = new ShaderMaterial({
        uniforms: {
          fill: { value: new Color(this.fillOf(part, lit)) },
          line: { value: new Color(part.ghost ? style.ghost : style.line) },
          angle: { value: angle * DEG },
          spacing: { value: spacing },
          width: { value: 1 },
          hatch: { value: s.plain ? 0 : 1 },
        },
        vertexShader: CAP_VERT,
        fragmentShader: CAP_FRAG,
        side: DoubleSide,
      });
      main.userData.spacing = spacing;
      stencilOff(main);
      const id = new MeshBasicMaterial({ color: new Color().setHex(idColour(n + i + 1)), transparent: true, opacity: part.ghost ? 0.5 : 1, blending: NoBlending, side: DoubleSide });
      stencilOff(id);
      const caps = { main: new Mesh(this.capGeometry!, main), id: new Mesh(this.capGeometry!, id) };
      for (const c of [caps.main, caps.id]) {
        c.renderOrder = order + 1;
        c.raycast = () => {};
        c.frustumCulled = false;
        c.visible = o.group.visible;
      }
      this.scene.add(caps.main);
      this.idScene.add(caps.id);
      o.caps = caps;
    });
    this.placeCaps();
  }

  /** The caps' quad on the plane, big enough to cover every part. */
  private placeCaps(): void {
    const s = this.section;
    if (!s || !this.objects.some(o => o.caps)) return;
    const box = new Box3();
    this.objects.forEach(o => {
      o.group.updateMatrixWorld(true);
      box.expandByObject(o.fill);
    });
    const plane = clipPlane(s);
    const centre = plane.projectPoint(box.isEmpty() ? new Vector3() : box.getCenter(new Vector3()), new Vector3());
    const size = Math.max(1, radiusOf(box) * 4);
    const turn = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), new Vector3(...s.normal).normalize());
    const m = new Matrix4().compose(centre, turn, new Vector3(size, size, 1));
    for (const o of this.objects) {
      if (!o.caps) continue;
      place(o.caps.main, m);
      place(o.caps.id, m);
      o.caps.main.visible = o.caps.id.visible = o.group.visible;
    }
  }

  /**
   * Draft lines, as in printed instructions: a dashed line from each
   * exploded part (from its picked face, or its middle) back along its joint
   * to where it fits on its parent.
   */
  private drawDraft(world: Map<string, Matrix4>, explode: number): void {
    if (this.draft) {
      this.draftScene.remove(this.draft);
      this.draft.geometry.dispose();
      this.draft = null;
    }
    if (this.draftHalo) {
      this.draftScene.remove(this.draftHalo);
      this.draftHalo = null;
    }
    const style = this.style;
    this.axes = [];
    if (!style) return;
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
      const slide = explodeVector(p.joint, pm).transformDirection(pm).multiplyScalar(p.joint.distance * f);
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
      this.axes.push({ part: p, from, to });
      pts.push(from.x, from.y, from.z, to.x, to.y, to.z);
    }
    if (!pts.length || style.draft === false || style.lineWidth <= 0) return;
    const dashed = !style.draftSolid;
    if (this.draftMaterial && this.draftMaterial.dashed !== dashed) {
      this.draftMaterial.dispose();
      this.draftMaterial = null;
    }
    // The lines are tested against the parts' depth: a line shows only where
    // it's in front of the parts (a part in front hides it, as it hides the
    // arrows), with its halo, so only an outline it really crosses breaks.
    // Nudged a little towards the camera, so a line along a part's face
    // counts as in front of it. Transparent only so the two sort by renderOrder.
    const depth = { depthTest: true, depthWrite: false, transparent: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 };
    this.draftMaterial ??= new LineMaterial({ color: 0, linewidth: 1, worldUnits: false, dashed, dashSize: 3, gapSize: 2, ...depth, depthFunc: LessEqualDepth });
    this.draftMaterial.color.set(style.line);
    if (!this.draftHaloMaterial) {
      // The halo paints the picture's fills (drawn without any lines) back over
      // a band round the line: the lines and outlines it crosses break, the
      // parts and the page show through unbroken, as on a flat-pack sheet.
      const m = new LineMaterial({ color: 0xffffff, linewidth: 1, worldUnits: false, ...depth, depthFunc: LessEqualDepth, blending: NoBlending });
      m.onBeforeCompile = shader => {
        shader.uniforms.tFill = this.haloFill;
        shader.fragmentShader = shader.fragmentShader
          .replace("uniform float linewidth;", "uniform float linewidth;\nuniform vec2 resolution;\nuniform sampler2D tFill;")
          .replace("gl_FragColor = vec4( diffuseColor.rgb, alpha );", "gl_FragColor = texture2D( tFill, gl_FragCoord.xy / resolution );");
      };
      this.draftHaloMaterial = m;
    }
    const geo = new LineSegmentsGeometry().setPositions(pts);
    // Drawn after the parts and their outlines, as the lines on a sheet run over the drawing.
    this.draftHalo = new LineSegments2(geo, this.draftHaloMaterial);
    this.draftHalo.raycast = () => {};
    this.draftHalo.renderOrder = 1;
    this.draftScene.add(this.draftHalo);
    this.draft = new LineSegments2(geo, this.draftMaterial);
    this.draft.computeLineDistances();
    this.draft.raycast = () => {};
    this.draft.renderOrder = 2;
    this.draftScene.add(this.draft);
  }

  /** A part's fill: the selected part's stronger shade, the highlight, or the plain fill. */
  private fillOf(own: ScenePart, lit: Set<string>): string {
    const style = this.style!;
    const part = shownAs(own, this.look);
    // A wire is filled in its own colour (red to V, black to G); a ghost one, plain, as an earlier step's.
    if (part.wire) {
      if (part.id === this.selected) return selectedFill(part.wire.color);
      return part.ghost ? style.fill : part.wire.color;
    }
    if (part.id === this.selected) return selectedFill(style.highlight);
    if (this.glass.has(part.id)) return lit.has(part.id) ? style.highlight : GLASS_TINT;
    return part.ghost ? style.fill : lit.has(part.id) ? style.highlight : style.fill;
  }

  /**
   * Fills a part: a wire (or a cable's wires) each in its own colour, by
   * corner, made stronger when it's picked; anything else, and a ghosted
   * wire, in one colour.
   */
  private paint(o: PartObjects, lit: Set<string>): void {
    const mat = o.fill.material as MeshBasicMaterial;
    const wire = o.part.wire;
    const colours = o.fill.geometry.getAttribute("color") as BufferAttribute | undefined;
    const each = !!wire && !!colours && !shownAs(o.part, this.look).ghost;
    if (mat.vertexColors !== each) {
      mat.vertexColors = each;
      mat.needsUpdate = true;
    }
    if (!each) {
      mat.color.set(this.fillOf(o.part, lit));
      return;
    }
    mat.color.set("#ffffff");
    const cores = coresOf(wire!);
    const per = Math.floor(colours!.count / cores.length);
    const c = new Color();
    const picked = o.part.id === this.selected;
    cores.forEach((core, i) => {
      c.set(picked ? selectedFill(core.color) : core.color);
      for (let v = i * per; v < (i + 1) * per; v++) colours!.setXYZ(v, c.r, c.g, c.b);
    });
    colours!.needsUpdate = true;
  }

  /** Marks the part picked in the workspace ("" for none), refilling the parts without rebuilding them. */
  setSelected(id: string): void {
    if (id === this.selected) return;
    this.selected = id;
    if (!this.style) return;
    const lit = highlightedParts(this.objects.map(o => o.part));
    for (const o of this.objects) {
      const c = this.fillOf(o.part, lit);
      this.paint(o, lit);
      const cap = o.caps?.main.material as ShaderMaterial | undefined;
      if (cap) (cap.uniforms.fill.value as Color).set(c);
    }
  }

  /**
   * Fills a part `t` (0 to 1) of the way from `from` to its own fill, without
   * rebuilding: a part highlighted in the last step fading back to white as
   * the next one comes in. At 1 it has its own fill again.
   */
  fadeFill(id: string, from: string, t: number): void {
    const o = this.objects.find(x => x.part.id === id);
    if (!o || !this.style || o.part.wire) return;
    const own = this.fillOf(o.part, highlightedParts(this.objects.map(x => x.part)));
    const c = new Color().lerpColors(new Color(from), new Color(own), Math.max(0, Math.min(1, t)));
    (o.fill.material as MeshBasicMaterial).color.copy(c);
    const cap = o.caps?.main.material as ShaderMaterial | undefined;
    if (cap) (cap.uniforms.fill.value as Color).copy(c);
  }

  /** Follows the parts' new places without rebuilding the scene. */
  move(parts: ScenePart[], explode = 0): void {
    const world = worldMatrices(parts, explode);
    const byId = new Map(parts.map(p => [p.id, p]));
    let lit: Set<string> | undefined;
    let looms: Looms | undefined;
    for (const o of this.objects) {
      const m = world.get(o.part.id);
      if (!m) continue;
      // The part as it is now, so its arrow settings are read live.
      o.part = byId.get(o.part.id) || o.part;
      place(o.group, m);
      place(o.idGroup, m);
      if (o.part.wire) {
        this.setTube(o, wireGeometry(o.part, world, 1, (looms ||= loomsOf(parts))));
        this.paint(o, (lit ||= highlightedParts(parts)));
      }
    }
    this.openTracks(parts, explode);
    this.placeCaps();
    this.drawDraft(world, explode);
  }

  /**
   * Shifts each part up (world Z) from where it is now by `lifts`' mm, or
   * hides it (null): the drop-in animation's parts, falling. A part not in
   * `lifts` stays where it is. Only for scenes drawn without draft lines or
   * arrows (they would stay behind), and parts that aren't wires.
   */
  lift(world: Map<string, Matrix4>, lifts: Map<string, number | null>): void {
    for (const o of this.objects) {
      const m = world.get(o.part.id);
      if (!m) continue;
      const dz = lifts.get(o.part.id);
      const show = !o.part.hidden && dz !== null;
      o.group.visible = o.idGroup.visible = show;
      const at = dz ? new Matrix4().makeTranslation(0, 0, dz).multiply(m) : m;
      place(o.group, at);
      place(o.idGroup, at);
    }
    this.placeCaps();
  }

  /**
   * Solid arrows along the gaps, as on a flat-pack sheet: each a flat
   * shape facing the camera, drawn in the picture against the parts'
   * depth, so an arrow passes behind a part rather than over it, and a
   * screw's arrow stops at the hole. Sized from the picture, not the parts.
   */
  /** The parts' depth, 16 bits in red and green, read back point by point to see what hides an arrow. */
  private drawDepth(camera: OrthographicCamera, pw: number, ph: number): void {
    const r = this.renderer;
    if (!this.depthTarget || this.depthTarget.width !== pw || this.depthTarget.height !== ph) {
      this.depthTarget?.dispose();
      this.depthTarget = new WebGLRenderTarget(pw, ph, { minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: true });
    }
    if (!this.depthMaterial) {
      this.depthMaterial = new ShaderMaterial({
        vertexShader: "#include <common>\n#include <clipping_planes_pars_vertex>\nvoid main() {\n#include <begin_vertex>\n#include <project_vertex>\n#include <clipping_planes_vertex>\n}",
        fragmentShader: "#include <common>\n#include <clipping_planes_pars_fragment>\nvoid main() {\n#include <clipping_planes_fragment>\nfloat z = gl_FragCoord.z; gl_FragColor = vec4(floor(z * 255.0) / 255.0, fract(z * 255.0), 0.0, 1.0);\n}",
        clipping: true,
      });
    }
    this.depthMaterial.clippingPlanes = this.clip;
    // The cut faces' caps and stencils aren't parts: left out.
    const hidden: Object3D[] = [];
    for (const o of this.objects) {
      if (o.caps?.id.visible) hidden.push(o.caps.id);
      for (const c of o.idGroup.children) if (c.userData.stencil && c.visible) hidden.push(c);
    }
    hidden.forEach(o => (o.visible = false));
    this.idScene.overrideMaterial = this.depthMaterial;
    r.setRenderTarget(this.depthTarget);
    r.setClearColor(0xffffff, 1);
    r.render(this.idScene, camera);
    this.idScene.overrideMaterial = null;
    hidden.forEach(o => (o.visible = true));
    r.setClearColor(0x000000, 0);
  }

  /** Whether `p` is in front of every part drawn (or on one's face), as seen from `camera`. */
  private visibleAt(p: Vector3, camera: OrthographicCamera): boolean {
    const t = this.depthTarget;
    if (!t) return true;
    const ndc = p.clone().project(camera);
    const x = Math.round(((ndc.x + 1) / 2) * t.width);
    const y = Math.round(((ndc.y + 1) / 2) * t.height);
    if (x < 0 || y < 0 || x >= t.width || y >= t.height) return true;
    this.renderer.readRenderTargetPixels(t, x, y, 1, 1, this.depthPixel);
    const d = this.depthPixel[0] / 255 + this.depthPixel[1] / 255 / 255;
    return ndc.z * 0.5 + 0.5 <= d + 3e-4;
  }

  private drawArrows(camera: OrthographicCamera, h: number): void {
    for (const m of [this.arrowMesh, this.arrowSelMesh]) {
      if (!m) continue;
      this.draftScene.remove(m);
      m.geometry.dispose();
    }
    this.arrowMesh = null;
    this.arrowSelMesh = null;
    this.arrowShapes = [];
    const style = this.style;
    if (!style || !this.arrows || !this.axes.length) return;
    const mmPerPx = (camera.top - camera.bottom) / camera.zoom / h;
    const shaft = Math.max(1.5, h * 0.004) * mmPerPx;
    const headLen = Math.max(8, h * 0.038) * mmPerPx;
    const headHalf = Math.max(4, h * 0.019) * mmPerPx;
    const view = new Vector3();
    camera.getWorldDirection(view);
    const plain: number[] = [];
    const picked: number[] = [];
    let verts = plain;
    const quad = (a: Vector3, b: Vector3, c: Vector3, d: Vector3) => verts.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
    for (const { part, from, to } of this.axes) {
      const a = part.arrow;
      if (a?.off) continue;
      const f0 = Math.min(a?.from ?? ARROW_FROM, a?.to ?? ARROW_TO);
      let f1 = Math.max(a?.from ?? ARROW_FROM, a?.to ?? ARROW_TO);
      const axis = to.clone().sub(from);
      const gap = axis.length();
      if (gap < 1e-3) continue;
      axis.normalize();
      // The head is never left behind a part: where the tip would be hidden
      // (a part fitted from below, say), the arrow stops where its line goes
      // out of sight, with the head pulled back clear of the edge.
      const at = (f: number) => from.clone().addScaledVector(axis, gap * f);
      f1 = arrowEnd(f0, f1, gap, headLen, f => this.visibleAt(at(f), camera));
      const len = gap * (f1 - f0);
      if (len < 1e-3) continue;
      // Flat on to the camera: across the axis and the line of sight.
      const side = new Vector3().crossVectors(axis, view);
      if (side.lengthSq() < 1e-6) continue;
      side.normalize();
      const start = at(f0);
      const end = start.clone().addScaledVector(axis, len);
      // A short arrow keeps its proportions: the head shrinks with it.
      const k = Math.min(1, len / (headLen * 1.6));
      const hl = headLen * k;
      const hw = headHalf * k;
      const sw = shaft * Math.max(0.6, k);
      const neck = end.clone().addScaledVector(axis, -hl);
      verts = part.id === this.selectedArrow ? picked : plain;
      this.arrowShapes.push({ id: part.id, start, end, half: Math.max(hw, sw) });
      quad(
        start.clone().addScaledVector(side, -sw),
        neck.clone().addScaledVector(side, -sw),
        neck.clone().addScaledVector(side, sw),
        start.clone().addScaledVector(side, sw),
      );
      const l = neck.clone().addScaledVector(side, -hw);
      const r2 = neck.clone().addScaledVector(side, hw);
      verts.push(l.x, l.y, l.z, end.x, end.y, end.z, r2.x, r2.y, r2.z);
    }
    const mesh = (v: number[], material: MeshBasicMaterial) => {
      const geo = new BufferGeometry();
      geo.setAttribute("position", new Float32BufferAttribute(v, 3));
      const m = new Mesh(geo, material);
      m.raycast = () => {};
      m.renderOrder = 3;
      this.draftScene.add(m);
      return m;
    };
    const arrowMaterial = () => new MeshBasicMaterial({ color: 0, side: DoubleSide, depthTest: true, depthWrite: false, transparent: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    if (plain.length) {
      this.arrowMaterial ??= arrowMaterial();
      this.arrowMaterial.color.set(style.line);
      this.arrowMesh = mesh(plain, this.arrowMaterial);
    }
    if (picked.length) {
      this.arrowSelMaterial ??= arrowMaterial();
      this.arrowSelMaterial.color.set(selectedFill(style.highlight));
      this.arrowSelMesh = mesh(picked, this.arrowSelMaterial);
    }
  }

  /**
   * The part whose arrow is under (x, y), in pixels from the top left of a
   * `w`×`h` view, as last drawn ("" for none). Within `slack` pixels of an
   * arrow counts, so a thin one is easy to hit; the nearest in sight wins.
   */
  arrowAt(x: number, y: number, camera: OrthographicCamera, w: number, h: number, slack = 5): string {
    const px = (v: Vector3) => {
      const n = v.clone().project(camera);
      return { x: ((n.x + 1) / 2) * w, y: ((1 - n.y) / 2) * h };
    };
    const mmPerPx = (camera.top - camera.bottom) / camera.zoom / h;
    let best = "";
    let bestD = Infinity;
    for (const s of this.arrowShapes) {
      const a = px(s.start);
      const b = px(s.end);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)));
      const d = Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t));
      // Where it passes behind a part, the click is the part's.
      if (d <= s.half / mmPerPx + slack && d < bestD && this.visibleAt(s.start.clone().lerp(s.end, t), camera)) {
        best = s.id;
        bestD = d;
      }
    }
    return best;
  }

  /** Gives a wire its tube anew (after its parts moved, or its route changed). */
  private setTube(o: PartObjects, g: BufferGeometry): void {
    o.tube?.dispose();
    o.tube = g;
    o.fill.geometry = g;
    (o.idGroup.children[0] as Mesh).geometry = g;
  }

  /** Lays a wire again, as it is now, where its parts are (after changing its route or look). */
  rewire(part: ScenePart, parts: ScenePart[], explode = 0): void {
    const o = this.objects.find(x => x.part.id === part.id);
    if (!o || !part.wire) return;
    o.part = part;
    const world = worldMatrices(parts, explode);
    const looms = loomsOf(parts);
    const lit = highlightedParts(this.objects.map(x => x.part));
    this.setTube(o, wireGeometry(part, world, 1, looms));
    this.paint(o, lit);
    // The wires that run along it follow it.
    for (const x of this.objects) {
      if (x === o || !x.part.wire?.waypoints.some(w => w.along?.wire === part.id)) continue;
      this.setTube(x, wireGeometry(x.part, world, 1, looms));
      this.paint(x, lit);
    }
  }

  /**
   * Lays a wire only `upto` (0 to 1) of the way along: growing, as it's put
   * in, from its `from` end or, `fromTo`, its `to` end. `world` saves
   * working out where the parts are again.
   */
  growWire(part: ScenePart, parts: ScenePart[], explode: number, upto: number, fromTo = false, world?: Map<string, Matrix4>): void {
    const o = this.objects.find(x => x.part.id === part.id);
    if (!o || !part.wire) return;
    this.setTube(o, wireGeometry(part, world || worldMatrices(parts, explode), upto, loomsOf(parts), fromTo));
    this.paint(o, highlightedParts(this.objects.map(x => x.part)));
  }

  /** Shows or leaves out a part as drawn now (for the wiring playback), without rebuilding. */
  setShown(id: string, shown: boolean): void {
    const o = this.objects.find(x => x.part.id === id);
    if (o) o.group.visible = o.idGroup.visible = shown;
  }

  /** Whether a part is drawn as glass now (the see-through view's printed parts). */
  isGlass(id: string): boolean {
    return this.glass.has(id);
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

  /**
   * The visible parts' meshes where they're drawn now, plus the ends of
   * their draft lines (where the arrows run), for framing them by their
   * real outlines rather than a box round them.
   */
  placed(): { meshes: Placed[]; points: Vector3[] } {
    const meshes: Placed[] = [];
    this.objects.forEach(o => {
      if (!o.group.visible) return;
      o.group.updateMatrixWorld(true);
      meshes.push({ geometry: o.fill.geometry, matrix: o.fill.matrixWorld });
    });
    const points = this.axes.filter(a => !a.part.hidden).flatMap(a => [a.from, a.to]);
    return { meshes, points };
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

  /** A glass part's fold lines: faint, hiding nothing, hidden by the solid parts in front. */
  private glassLineMaterial(colour: string): LineMaterial {
    const key = `glass:${colour}`;
    let m = this.lineMaterials.get(key);
    if (!m) {
      m = new LineMaterial({ color: new Color(colour).getHex(), linewidth: 1, worldUnits: false, transparent: true, opacity: 0.7, depthWrite: false });
      m.clippingPlanes = this.clip;
      this.lineMaterials.set(key, m);
    }
    return m;
  }

  private lineMaterial(colour: string): LineMaterial {
    let m = this.lineMaterials.get(colour);
    if (!m) {
      m = new LineMaterial({ color: new Color(colour).getHex(), linewidth: 1, worldUnits: false });
      m.clippingPlanes = this.clip;
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
      this.target = new WebGLRenderTarget(pw, ph, { minFilter: NearestFilter, magFilter: NearestFilter, stencilBuffer: true });
    }
    for (const o of this.objects) {
      const u = (o.caps?.main.material as ShaderMaterial | undefined)?.uniforms;
      if (!u) continue;
      u.spacing.value = (o.caps!.main.material as ShaderMaterial).userData.spacing * ratio;
      u.width.value = Math.max(1, style.lineWidth * 0.75 * ratio);
    }
    for (const m of this.lineMaterials.values()) {
      m.linewidth = style.lineWidth * ratio;
      m.resolution.set(pw, ph);
    }
    for (const m of [this.draftMaterial]) {
      if (!m) continue;
      // Dashes a steady size on the picture, whatever the zoom: mm per pixel.
      const mmPerPx = (camera.top - camera.bottom) / camera.zoom / h;
      m.linewidth = style.lineWidth * ratio;
      m.resolution.set(pw, ph);
      m.dashSize = 7 * mmPerPx;
      m.gapSize = 5 * mmPerPx;
    }
    if (this.draftHaloMaterial) {
      // Wide enough that a part's bold outline opens clearly either side of the line.
      this.draftHaloMaterial.linewidth = (style.lineWidth * 2 + style.outline + 3) * ratio;
      this.draftHaloMaterial.resolution.set(pw, ph);
    }
    r.autoClear = true;
    r.setRenderTarget(this.target);
    r.setClearColor(0x000000, 0);
    r.render(this.idScene, camera);
    if (this.arrows && this.axes.length) this.drawDepth(camera, pw, ph);
    if (background) r.setClearColor(new Color(background), 1);
    else r.setClearColor(0x000000, 0);
    if ((this.draftHalo && this.draftHaloMaterial) || this.cuts.length) {
      // The fills alone, for the draft lines' halos and the cuts.
      if (!this.fillTarget || this.fillTarget.width !== pw || this.fillTarget.height !== ph) {
        this.fillTarget?.dispose();
        this.fillTarget = new WebGLRenderTarget(pw, ph, { minFilter: NearestFilter, magFilter: NearestFilter, stencilBuffer: true });
      }
      for (const o of this.objects) if (o.lines) o.lines.visible = false;
      r.setRenderTarget(this.fillTarget);
      r.render(this.scene, camera);
      for (const o of this.objects) if (o.lines) o.lines.visible = true;
      this.haloFill.value = this.fillTarget.texture;
    }
    r.setRenderTarget(null);
    r.render(this.scene, camera);
    if (style.outline > 0 && this.objects.some(o => o.idGroup.parent === this.glassScene && o.idGroup.visible)) this.drawGlassOutline(camera, pw, ph, ratio);
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
    if (this.cuts.length && this.fillTarget) this.drawCuts(pw, ph);
    this.drawArrows(camera, h);
    if (this.draftScene.children.length) {
      // Against the depth the parts left, so a line behind a part is known to be.
      r.autoClear = false;
      r.render(this.draftScene, camera);
      r.autoClear = true;
    }
    if (this.overlay.children.length) {
      r.autoClear = false;
      r.clearDepth();
      r.render(this.overlay, camera);
      r.autoClear = true;
    }
  }

  /**
   * The glass parts' outlines, in the ghost colour and thinner: their IDs
   * drawn against the solid parts' depth (so a glass part behind a board
   * isn't outlined over it), then the outline shader over the picture.
   */
  private drawGlassOutline(camera: OrthographicCamera, pw: number, ph: number, ratio: number): void {
    const r = this.renderer;
    const style = this.style!;
    if (!this.glassTarget || this.glassTarget.width !== pw || this.glassTarget.height !== ph) {
      this.glassTarget?.dispose();
      this.glassTarget = new WebGLRenderTarget(pw, ph, { minFilter: NearestFilter, magFilter: NearestFilter });
    }
    this.depthOnly ??= new MeshBasicMaterial({ colorWrite: false });
    this.depthOnly.clippingPlanes = this.clip;
    r.setRenderTarget(this.glassTarget);
    r.setClearColor(0x000000, 0);
    r.autoClear = true;
    r.clear();
    r.autoClear = false;
    this.idScene.overrideMaterial = this.depthOnly;
    r.render(this.idScene, camera);
    this.idScene.overrideMaterial = null;
    r.render(this.glassScene, camera);
    r.setRenderTarget(null);
    const u = this.outline.uniforms;
    u.tId.value = this.glassTarget.texture;
    (u.px.value as Vector2).set(1 / pw, 1 / ph);
    u.width.value = Math.max(0.5, (style.outline * 0.6 * ratio) / 2);
    (u.colour.value as Color).set(style.ghost);
    (u.ghost.value as Color).set(style.ghost);
    r.render(this.quadScene, this.quadCamera);
    r.autoClear = true;
  }

  /** Paints the fills alone back over each cut: a capsule from its spot back along its tail. */
  private drawCuts(pw: number, ph: number): void {
    this.cutMaterial ??= new ShaderMaterial({
      uniforms: { tFill: this.haloFill, size: { value: new Vector2(1, 1) } },
      vertexShader: "void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }",
      fragmentShader: "uniform sampler2D tFill; uniform vec2 size; void main() { gl_FragColor = texture2D(tFill, gl_FragCoord.xy / size); }",
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: NoBlending,
      side: DoubleSide,
    });
    (this.cutMaterial.uniforms.size.value as Vector2).set(pw, ph);
    const verts: number[] = [];
    const N = 24;
    for (const c of this.cuts) {
      // In pixels: the tip, and the far end of the band back along the tail.
      const r = Math.max(1, c.r * ph);
      const tip = { x: c.x * pw, y: c.y * ph };
      const far = { x: tip.x + c.dx * c.len * ph, y: tip.y + c.dy * c.len * ph };
      const a0 = Math.atan2(c.dy, c.dx) + Math.PI / 2;
      // A capsule as a fan of triangles round its middle.
      const ring: { x: number; y: number }[] = [];
      for (let i = 0; i <= N; i++) ring.push({ x: tip.x + r * Math.cos(a0 + (Math.PI * i) / N), y: tip.y + r * Math.sin(a0 + (Math.PI * i) / N) });
      for (let i = 0; i <= N; i++) ring.push({ x: far.x + r * Math.cos(a0 + Math.PI + (Math.PI * i) / N), y: far.y + r * Math.sin(a0 + Math.PI + (Math.PI * i) / N) });
      const mid = { x: (tip.x + far.x) / 2, y: (tip.y + far.y) / 2 };
      const ndc = (p: { x: number; y: number }) => [(p.x / pw) * 2 - 1, 1 - (p.y / ph) * 2, 0];
      for (let i = 0; i < ring.length; i++) verts.push(...ndc(mid), ...ndc(ring[i]), ...ndc(ring[(i + 1) % ring.length]));
    }
    const geo = new CutGeometry();
    geo.setAttribute("position", new Float32BufferAttribute(verts, 3));
    const mesh = new Mesh(geo, this.cutMaterial);
    mesh.frustumCulled = false;
    this.cutScene.add(mesh);
    const r = this.renderer;
    r.autoClear = false;
    r.render(this.cutScene, this.quadCamera);
    r.autoClear = true;
    this.cutScene.remove(mesh);
    geo.dispose();
  }

  clear(): void {
    this.clearCaps();
    for (const o of this.objects) {
      o.tube?.dispose();
      o.shape?.dispose();
      o.shapeLines?.dispose();
      (o.fill.material as MeshBasicMaterial).dispose();
      ((o.idGroup.children[0] as Mesh).material as MeshBasicMaterial).dispose();
      this.scene.remove(o.group);
      o.idGroup.removeFromParent();
    }
    this.objects = [];
    this.glass = new Set();
  }

  dispose(): void {
    this.clear();
    this.draft?.geometry.dispose();
    this.draftMaterial?.dispose();
    this.draftHaloMaterial?.dispose();
    this.cutMaterial?.dispose();
    this.fillTarget?.dispose();
    this.depthTarget?.dispose();
    this.depthMaterial?.dispose();
    this.arrowMaterial?.dispose();
    this.arrowMesh?.geometry.dispose();
    this.arrowSelMaterial?.dispose();
    this.arrowSelMesh?.geometry.dispose();
    this.lineMaterials.forEach(m => m.dispose());
    this.glassTarget?.dispose();
    this.depthOnly?.dispose();
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
/**
 * The selected part's fill: the highlight colour made clearly darker (or,
 * for an already dark highlight, lighter), so it stands out from a
 * highlighted branch as well as from plain parts.
 */
export function selectedFill(highlight: string): string {
  const c = new Color(highlight);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  const l = hsl.l < 0.4 ? Math.min(1, hsl.l + 0.25) : hsl.l - 0.25;
  return `#${c.setHSL(hsl.h, Math.min(1, hsl.s + 0.1), l).getHexString()}`;
}

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
 * Where an assembly arrow's tip stops, as a fraction of its gap (`f0` to
 * `f1` along it, `gap` mm long): `f1` when the tip is in sight. Where the
 * tip would be hidden behind a part (one fitted from below, say) but the
 * tail is in sight, the arrow stops where its line goes out of sight, with
 * the head (`headLen` mm) pulled back clear of the edge, so a head is never
 * hidden. `visible(f)` says whether the point at `f` can be seen.
 */
export function arrowEnd(f0: number, f1: number, gap: number, headLen: number, visible: (f: number) => boolean): number {
  if (visible(f1) || !visible(f0)) return f1;
  let lo = f0;
  let hi = f1;
  for (let i = 0; i < 8; i++) {
    const mid = (lo + hi) / 2;
    if (visible(mid)) lo = mid;
    else hi = mid;
  }
  return Math.max(f0 + (headLen * 0.5) / gap, lo - (headLen * 0.4) / gap);
}

/** A mesh where it's drawn in the world. */
export interface Placed { geometry: BufferGeometry; matrix: Matrix4 }

/**
 * The camera that fills the picture with these meshes, from `cam`'s
 * direction: framed by every point of their real outlines as seen from
 * there (not the corners of a box round them, which leaves wide empty
 * margins on a turned view), with `margin` round them for the outlines and
 * arrow heads. `points` are extra points to keep in (draft lines, arrows);
 * `keep` leaves out what a section cuts away.
 */
export function frameTight(cam: SceneCamera, meshes: Placed[], aspect: number, margin = 1.05, points: Vector3[] = [], keep?: (p: Vector3) => boolean): SceneCamera {
  const c = cameraFor({ ...cam, target: [0, 0, 0], size: 1 }, 1, 1);
  c.updateMatrixWorld();
  const inv = c.matrixWorldInverse;
  const lo = new Vector3(Infinity, Infinity, Infinity);
  const hi = new Vector3(-Infinity, -Infinity, -Infinity);
  const v = new Vector3();
  const take = (p: Vector3) => {
    if (keep && !keep(p)) return;
    p.applyMatrix4(inv);
    lo.min(p);
    hi.max(p);
  };
  for (const { geometry, matrix } of meshes) {
    const pos = geometry.getAttribute("position");
    if (!pos) continue;
    for (let i = 0; i < pos.count; i++) take(v.fromBufferAttribute(pos, i).applyMatrix4(matrix));
  }
  points.forEach(p => take(v.copy(p)));
  if (!isFinite(lo.x)) return cam;
  // The middle of what's seen, at the middle of its depth: the target sits among the parts.
  const mid = new Vector3((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, (lo.z + hi.z) / 2).applyMatrix4(c.matrixWorld);
  const halfH = Math.max((hi.y - lo.y) / 2, (hi.x - lo.x) / 2 / aspect) * margin;
  return { direction: [...cam.direction] as Vec3, target: [mid.x, mid.y, mid.z], size: Math.max(1, halfH) };
}

/**
 * The finished picture: the scene drawn at `w`×`h` (times `scale`) with a
 * see-through background, drawn bigger and shrunk so its lines are smooth.
 * Parts whose models can't be read are left out.
 */
export async function renderPicture(data: SceneData, store: ModelStore, w: number, h: number, scale = 1, cuts: Cut[] = []): Promise<HTMLCanvasElement> {
  const settled = await Promise.allSettled(data.parts.map(async part => ({ part, model: await store.get(part) })));
  const list = settled.flatMap(r => (r.status === "fulfilled" ? [r.value] : []));
  const ow = Math.max(1, Math.round(w * scale));
  const oh = Math.max(1, Math.round(h * scale));
  const art = new LineArt();
  try {
    const max = Math.min(art.renderer.capabilities.maxTextureSize || 4096, 8192);
    const ss = Math.max(1, Math.min(2, max / Math.max(ow, oh)));
    art.setSection(data.section);
    art.look = lookOf(data);
    art.setParts(list, data.style, data.explode);
    art.arrows = !!data.arrows;
    art.cuts = cuts;
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

  /**
   * The model drawn at a set scale, `pxPerMm` pixels to the millimetre
   * (times `sharp` in the picture itself), in a square just big enough for
   * it, so several parts drawn this way can be compared side by side.
   */
  drawAt(model: Model, style: SceneStyle, direction: Vec3, pxPerMm: number, sharp = 2): { url: string; px: number } {
    const part: ScenePart = { id: "t", name: "", position: [0, 0, 0], rotation: [0, 0, 0] };
    this.art.setParts([{ part, model }], { ...style, outline: Math.min(style.outline, 2), lineWidth: Math.min(style.lineWidth, 1) }, 0);
    const box = this.art.bounds();
    const cam = frame({ direction, target: [0, 0, 0], size: 1 }, box, 1, 1.08);
    const px = Math.max(8, Math.round(2 * cam.size * pxPerMm));
    const camera = cameraFor(cam, 1, radiusOf(box) + Math.hypot(...cam.target));
    const n = Math.min(2048, Math.round(px * sharp));
    this.art.draw(camera, n, n, 2);
    const out = document.createElement("canvas");
    out.width = n;
    out.height = n;
    const ctx = out.getContext("2d")!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(this.art.renderer.domElement, 0, 0, n, n);
    return { url: out.toDataURL("image/png"), px };
  }

  /** How many mm across the square `drawAt` draws the model in (from `direction`). */
  spanOf(model: Model, style: SceneStyle, direction: Vec3): number {
    const part: ScenePart = { id: "t", name: "", position: [0, 0, 0], rotation: [0, 0, 0] };
    this.art.setParts([{ part, model }], style, 0);
    return 2 * frame({ direction, target: [0, 0, 0], size: 1 }, this.art.bounds(), 1, 1.08).size;
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

/**
 * A spot on a picture to cut back to the parts' fills: where a detail
 * circle's tail touches, so the outline breaks round it as on IKEA's sheets.
 * `x`,`y` are fractions of the picture; `r` and `len` fractions of its height;
 * `dx`,`dy` the way back along the tail (unit, in pixels).
 */
export interface Cut { x: number; y: number; dx: number; dy: number; len: number; r: number }

// ------------------------------------------------------------ detail circles

/** Where a part is in the scene as drawn (exploded), in mm: its middle and half its size. */
export async function partBounds(scene: SceneData, partId: string, store: ModelStore): Promise<{ centre: Vec3; radius: number } | null> {
  const part = scene.parts.find(p => p.id === partId);
  if (!part) return null;
  const model = await store.get(part);
  const m = worldMatrices(scene.parts, scene.explode).get(partId);
  const bb = model.geometry.boundingBox;
  if (!m || !bb) return null;
  const box = new Box3();
  for (let k = 0; k < 8; k++) box.expandByPoint(new Vector3(k & 1 ? bb.max.x : bb.min.x, k & 2 ? bb.max.y : bb.min.y, k & 4 ? bb.max.z : bb.min.z).applyMatrix4(m));
  const c = box.getCenter(new Vector3());
  return { centre: [c.x, c.y, c.z], radius: radiusOf(box) };
}

/**
 * The camera that frames every one of these scenes' shown parts, as drawn
 * (apart along their joints), from `cam`'s direction: one view for a whole
 * assembly guide, so the model doesn't jump between steps.
 */
export async function frameAll(cam: SceneCamera, scenes: SceneData[], store: ModelStore, aspect: number, margin = 1.06): Promise<SceneCamera> {
  const meshes: Placed[] = [];
  const made: BufferGeometry[] = [];
  for (const scene of scenes) {
    const mats = worldMatrices(scene.parts, scene.explode);
    let assembled: Map<string, Matrix4> | undefined;
    for (const part of scene.parts) {
      if (part.hidden) continue;
      const m = mats.get(part.id);
      let geometry: BufferGeometry;
      try {
        const model = await store.get(part);
        geometry = model.geometry;
        // A track as drawn: open, exploded far.
        const f = part.track ? trackOpening(explodeOf(part, scene.explode)) : 0;
        const opener = f > 0 ? trackOpener(part.id, part.track!, model.triangles, (assembled ||= worldMatrices(scene.parts, 0, false))) : null;
        if (opener) {
          geometry = new BufferGeometry();
          geometry.setAttribute("position", new BufferAttribute(movePieces(model.geometry.attributes.position.array as Float32Array, opener.moves(f)), 3));
          made.push(geometry);
        }
      } catch {
        continue;
      }
      if (m) meshes.push({ geometry, matrix: m });
    }
  }
  try {
    return frameTight(cam, meshes, aspect, margin);
  } finally {
    made.forEach(g => g.dispose());
  }
}

/**
 * The camera for a magnifier: the scene's own view, centred on `spot` (a
 * fraction across and down the source picture) and `zoom` times closer:
 * what the magnifier shows is the source picture's own scale times `zoom`,
 * whatever size the magnifier is drawn at.
 */
export function magnifiedCamera(cam: SceneCamera, spot: { x: number; y: number }, zoom: number, src: { w: number; h: number }, det: { w: number; h: number }): SceneCamera {
  const c = cameraFor(cam, src.w / src.h, 1);
  c.updateMatrixWorld();
  const e = c.matrixWorld.elements;
  const right = new Vector3(e[0], e[1], e[2]).normalize();
  const up = new Vector3(e[4], e[5], e[6]).normalize();
  const dx = (spot.x - 0.5) * 2 * cam.size * (src.w / src.h);
  const dy = (0.5 - spot.y) * 2 * cam.size;
  const t = new Vector3(...cam.target).addScaledVector(right, dx).addScaledVector(up, dy);
  const z = Math.max(0.25, zoom || 1);
  return { direction: [...cam.direction] as Vec3, target: [t.x, t.y, t.z], size: Math.max(0.5, (cam.size * (det.h / src.h)) / z) };
}

/** The shown part under `spot` on the picture (nearest middle, within its reach), or null. */
export async function partAt(scene: SceneData, spot: { x: number; y: number }, store: ModelStore, aspect: number): Promise<string | null> {
  let best: { id: string; d: number } | null = null;
  for (const part of scene.parts) {
    if (part.hidden) continue;
    const b = await partBounds(scene, part.id, store).catch(() => null);
    if (!b) continue;
    const [p] = pagePoints(scene, [b.centre], aspect);
    // Distances in fractions of the picture's height.
    const d = Math.hypot((p.x - spot.x) * aspect, p.y - spot.y);
    const reach = b.radius / (2 * scene.camera.size);
    if (d <= reach * 1.1 && (!best || d < best.d)) best = { id: part.id, d };
  }
  return best?.id ?? null;
}

export interface DetailLook {
  ring: { colour: string; width: number };
  /** The circle's diameter as a fraction of the picture's shorter side (the rest is room for a part to spill over). */
  circle: number;
  /** A part drawn whole over the ring, as a screw on a flat-pack sheet pokes out of its circle. */
  featured?: string;
  /** "2x", in a white box on the ring's top left. */
  label?: string;
}

/**
 * A detail circle, as on a flat-pack sheet: the scene drawn close up on a
 * white disc with a bold ring round it, in the middle of a `w` × `h`
 * picture (drawn `scale` times that size). The featured part is drawn
 * whole over the ring, and the label sits in a white box on the ring, so
 * both break its line.
 */
export async function renderDetail(scene: SceneData, store: ModelStore, w: number, h: number, scale = 1, look: DetailLook = { ring: { colour: "#111111", width: 4 }, circle: 0.72 }): Promise<HTMLCanvasElement> {
  const pic = await renderPicture(scene, store, w, h, scale);
  const out = document.createElement("canvas");
  out.width = pic.width;
  out.height = pic.height;
  const ctx = out.getContext("2d")!;
  const rw = look.ring.width * scale;
  const cx = out.width / 2;
  const cy = out.height / 2;
  const r = (Math.min(out.width, out.height) * look.circle) / 2 - rw / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(pic, 0, 0);
  ctx.restore();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.lineWidth = rw;
  ctx.strokeStyle = look.ring.colour;
  ctx.stroke();
  if (look.featured && scene.parts.some(p => p.id === look.featured && !p.hidden)) {
    const alone = { ...scene, parts: scene.parts.map(p => (p.id === look.featured ? p : { ...p, hidden: true })) };
    ctx.drawImage(await renderPicture(alone, store, w, h, scale), 0, 0);
  }
  if (look.label) {
    const px = Math.max(10, r * 0.26);
    const lx = cx - r * Math.SQRT1_2;
    const ly = cy - r * Math.SQRT1_2;
    ctx.font = `700 ${px}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const bw = ctx.measureText(look.label).width + px * 0.9;
    const bh = px * 1.35;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.roundRect(lx - bw / 2, ly - bh / 2, bw, bh, px * 0.3);
    ctx.fill();
    ctx.fillStyle = look.ring.colour;
    ctx.fillText(look.label, lx, ly + px * 0.04);
  }
  return out;
}
