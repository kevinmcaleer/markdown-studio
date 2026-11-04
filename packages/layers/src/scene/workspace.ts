// The 3D scene workspace: opened from a scene layer, full screen, over the
// editor. Parts (STL models) are added from the host's models or by
// uploading or dropping them; each is placed with handles on the view or
// with exact numbers (X, Y, Z in mm; roll, pitch, yaw in degrees). The view
// is drawn in the scene's own style, the shape of the layer, on the page's
// colour, so what you see is the picture you get. Done draws the picture.
//
// This module and three.js load only when a scene is opened.

import { Box3 as Bounds, BufferAttribute, BufferGeometry, DoubleSide, Euler, Line, LineBasicMaterial, Matrix4, Mesh, MeshBasicMaterial, Object3D, OrthographicCamera, Quaternion, Raycaster, Vector2, Vector3 } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { icon } from "../icons";
import {
  applyPreset, DEFAULT_LIMITS, JOINT_TYPES, normalizeScene, newPartId, partName, placeBeside, STYLE_PRESETS, VIEWS, wrapAngle,
  followModel, modelOf, partsDiffer,
  normalizeViews,
  type JointType, type NamedView, type PartJoint, type ProjectModel,
  type Box3 as PlainBox, type SceneCamera, type SceneData, type ScenePart, type SceneStyle, type Vec3,
  explodeOf,
  highlightedParts,
} from "./model";
import { applyJoint } from "./joint";
import { frame, LineArt, modelFromPositions, modelFromStl, Thumbnailer, ModelStore, placeCamera, radiusOf, renderPicture, worldMatrices, type FetchModel, type Model } from "./render";
import { MAX_EMBED, parseStl, toBase64, toBinaryStl } from "./stl";
import { isStepFile, readStep, type StepBody } from "./step";
import { toUrdf, zip } from "./urdf";
import { createViewCube } from "./viewcube";
import { MAX_SNAP_TRIANGLES, nearestSnap, Topology, type Face, type Snap } from "./snaps";

export interface SceneModel {
  url: string;
  title?: string;
  /**
   * A picture of the model for the Add a part menu: an image URL, or a
   * function giving one (or an image Blob). Without one, or if it fails,
   * the model is drawn here instead.
   */
  thumbnail?: string | (() => Promise<Blob | string | null | undefined>);
}

export interface WorkspaceOptions {
  scene: SceneData;
  /** The finished picture's size on the page; the view takes its shape. */
  width: number;
  height: number;
  /** Times the page size the picture is drawn at, for sharpness. */
  scale: number;
  /** The page colour, shown behind the view ("" for see-through). */
  background: string;
  store: ModelStore;
  /** The host's models, offered under Add a part. */
  listModels?(): Promise<SceneModel[]>;
  /**
   * The project's model, when the host keeps one (null: none yet). With
   * `saveModel`, scenes share their parts and joints through it: Done saves
   * any change to them, and each scene keeps only what it shows.
   */
  model?: ProjectModel | null;
  saveModel?(model: ProjectModel): Promise<void>;
}

export interface WorkspaceResult {
  scene: SceneData;
  picture: HTMLCanvasElement;
}

const DEG = Math.PI / 180;
const round = (n: number, places = 2) => {
  const f = 10 ** places;
  const r = Math.round(n * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const clone = (s: SceneData): SceneData => ({
  ...s,
  // Models carried inside stay shared: they never change.
  parts: s.parts.map(p => ({ ...p, position: [...p.position] as Vec3, rotation: [...p.rotation] as Vec3, ...(p.joint ? { joint: { ...p.joint, normal: [...p.joint.normal] as Vec3 } } : {}) })),
  camera: { ...s.camera, direction: [...s.camera.direction] as Vec3, target: [...s.camera.target] as Vec3 },
  style: { ...s.style },
});

/** Opens the workspace; resolves with the scene and its picture, or null on Cancel. */
export function openWorkspace(opts: WorkspaceOptions): Promise<WorkspaceResult | null> {
  return new Promise(resolve => {
    let scene = clone(normalizeScene(opts.scene));
    // The project's model: a scene drawn from it follows it; a new one starts
    // with all of it; a scene before there was one becomes it. A scene with
    // its own parts, in a project that has a model, keeps them until asked.
    const shared = !!opts.saveModel;
    const projectModel = opts.model?.parts.length ? opts.model : null;
    if (shared) {
      if (projectModel && (scene.model || !scene.parts.length)) scene = followModel(scene, projectModel);
      else if (!projectModel) scene.model = { stamp: opts.model?.stamp || 0 };
    }
    const start = JSON.stringify(scene);
    const aspect = opts.width / opts.height;
    const models = new Map<string, Model | Error>();
    let selectedId = "";
    let tool: "translate" | "rotate" = "translate";
    let busy = false;
    let closed = false;

    const overlay = document.createElement("div");
    overlay.className = "lyr-overlay lyr-scene-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "3D scene");
    overlay.innerHTML = `
      <div class="lyr lyr-scene" tabindex="-1">
        <div class="lyr-top">
          <strong class="lyr-scene-title">${icon("cube", 18)}<span>3D scene</span></strong>
          <span class="lyr-sep"></span>
          <button type="button" class="lyr-btn" data-act="undo" title="Undo (Ctrl+Z)" aria-label="Undo">${icon("undo")}</button>
          <button type="button" class="lyr-btn" data-act="redo" title="Redo (Ctrl+Shift+Z)" aria-label="Redo">${icon("redo")}</button>
          <span class="lyr-status" role="status"></span>
          <span class="lyr-grow"></span>
          <button type="button" class="lyr-btn lyr-cancel" data-act="cancel">Cancel</button>
          <button type="button" class="lyr-btn lyr-done" data-act="done">${icon("check", 16)}<span>Done</span></button>
        </div>
        <div class="lyr-scene-body">
          <aside class="lyr-scene-side lyr-scene-parts" aria-label="Parts">
            <div class="lyr-scene-add">
              <button type="button" class="lyr-wide-btn lyr-primary" data-act="add" aria-haspopup="menu">${icon("plus", 16)} Add a part</button>
              <div class="lyr-scene-menu" role="menu" hidden></div>
            </div>
            <div class="lyr-scene-parts-head">
              <div class="lyr-panel-title lyr-scene-parts-title">Parts</div>
              <button type="button" class="lyr-btn" data-act="urdf" title="Download the parts and their joints as a robot (URDF and meshes in a .zip) that opens in Snakie's Build workspace">${icon("download", 16)}<span>URDF</span></button>
            </div>
            <div class="lyr-scene-model"></div>
            <ul class="lyr-scene-list"></ul>
            <p class="lyr-note">Add STL or STEP files, or drop them on the view. A STEP assembly comes in as one part per solid. Click a part to place it.</p>
          </aside>
          <div class="lyr-scene-stage">
            <div class="lyr-scene-tools" role="toolbar" aria-label="View">
              <button type="button" class="lyr-btn" data-tool="translate" title="Move parts with the handles (M)">${icon("move", 16)}<span>Move</span></button>
              <button type="button" class="lyr-btn" data-tool="rotate" title="Turn parts with the handles (R)">${icon("rotate", 16)}<span>Turn</span></button>
              <span class="lyr-sep"></span>
              ${VIEWS.map(v => `<button type="button" class="lyr-btn" data-view="${v.id}" title="Look from the ${esc(v.label.toLowerCase())}">${esc(v.label)}</button>`).join("")}
              <span class="lyr-sep"></span>
              <span class="lyr-scene-views">
                <button type="button" class="lyr-btn" data-act="views" aria-haspopup="menu" title="Named views: save this camera under a name, to give other pictures the same view">${icon("camera", 16)}<span>Views</span></button>
                <div class="lyr-scene-views-menu" role="menu" hidden></div>
              </span>
              <button type="button" class="lyr-btn" data-act="fit" title="Fit the parts in the picture (F)">${icon("frame", 16)}<span>Fit</span></button>
              <span class="lyr-sep"></span>
              <label class="lyr-scene-explode" title="Slide joined parts apart along their joints, to show how they fit">${icon("expand", 16)}<span>Explode</span><input type="range" min="0" max="100" step="1" data-explode value="0" aria-label="Explode"><input type="number" class="lyr-scene-explode-num" min="0" max="100" step="1" data-explode-num value="0" aria-label="Explode, per cent"><span class="lyr-scene-explode-unit">%</span></label>
            </div>
            <div class="lyr-scene-frame"><canvas class="lyr-scene-canvas"></canvas></div>
            <div class="lyr-scene-help">Drag to look around, right-drag to pan, scroll to zoom. Hold Shift on a handle for 5 mm or 15° steps.</div>
            <div class="lyr-drop" hidden>Drop STL or STEP files to add them</div>
          </div>
          <aside class="lyr-scene-side lyr-scene-props" aria-label="Part and style"></aside>
        </div>
        <input type="file" class="lyr-file" accept=".stl,.step,.stp,model/stl,application/sla,model/step" multiple hidden>
      </div>`;
    document.body.appendChild(overlay);
    document.documentElement.classList.add("lyr-open");

    const root = overlay.querySelector(".lyr-scene") as HTMLElement;
    const $ = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector(s) as T;
    const stage = $(".lyr-scene-stage");
    const frameEl = $(".lyr-scene-frame");
    const canvasEl = $<HTMLCanvasElement>(".lyr-scene-canvas");
    const list = $(".lyr-scene-list");
    const props = $(".lyr-scene-props");
    const menu = $(".lyr-scene-menu");
    const fileInput = $<HTMLInputElement>(".lyr-file");
    frameEl.classList.toggle("lyr-clear", !opts.background);
    frameEl.style.background = opts.background || "";

    let statusTimer = 0;
    function status(text: string, bad = false, sticky = false): void {
      const el = $(".lyr-status");
      el.textContent = text;
      el.classList.toggle("lyr-bad", bad);
      clearTimeout(statusTimer);
      if (text && !sticky) statusTimer = window.setTimeout(() => (el.textContent = ""), 5000);
    }

    // ------------------------------------------------------------ three.js

    const art = new LineArt(canvasEl);
    const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10000);
    camera.up.set(0, 0, 1);
    const orbit = new OrbitControls(camera, canvasEl);
    orbit.enableDamping = false;
    orbit.screenSpacePanning = true;
    const proxy = new Object3D();
    art.overlay.add(proxy);
    const gizmo = new TransformControls(camera, canvasEl);
    gizmo.setSize(0.85);
    art.overlay.add(gizmo.getHelper());
    let dist = 1000;
    let viewW = 1;
    let viewH = 1;

    function radius(): number {
      return radiusOf(art.bounds()) + Math.hypot(...scene.camera.target);
    }

    /** The view's camera from the scene's. */
    function applyCamera(): void {
      const s = scene.camera.size;
      camera.left = -s * aspect;
      camera.right = s * aspect;
      camera.top = s;
      camera.bottom = -s;
      camera.zoom = 1;
      const r = radius();
      dist = Math.max(1000, r * 4);
      camera.near = 0.1;
      camera.far = dist * 2 + r * 4;
      placeCamera(camera, scene.camera, dist);
      orbit.target.set(...scene.camera.target);
      orbit.update();
    }

    /** The scene's camera from the view's, after looking around. */
    function readCamera(): void {
      const dir = camera.position.clone().sub(orbit.target);
      if (dir.lengthSq() < 1e-12) return;
      dir.normalize();
      scene.camera.direction = [round(dir.x, 5), round(dir.y, 5), round(dir.z, 5)];
      scene.camera.target = [round(orbit.target.x, 3), round(orbit.target.y, 3), round(orbit.target.z, 3)];
      scene.camera.size = Math.max(1, round(camera.top / camera.zoom, 3));
    }

    let drawQueued = 0;
    function draw(): void {
      if (drawQueued || closed) return;
      drawQueued = requestAnimationFrame(() => {
        drawQueued = 0;
        if (closed) return;
        art.draw(camera, viewW, viewH, Math.min(2, window.devicePixelRatio || 1));
        placeSnaps();
        viewCube.sync(camera.quaternion);
        viewCube.render();
      });
    }

    // The view cube (as in Snakie's build workspace): click a face, edge or
    // corner to glide round to it, or drag it to look around.
    const viewCube = createViewCube({
      size: 104,
      onPick: d => {
        // Straight down or up, a hair off so "up" stays Z (as the Top view does).
        const dir: Vec3 = Math.abs(d.z) > 0.999 ? [0, -0.0001, Math.sign(d.z)] : [d.x, d.y, d.z];
        glideTo({ ...scene.camera, direction: dir }, commit);
      },
      onOrbit: (dx, dy) => {
        stopGlide();
        const [x, y, z] = scene.camera.direction;
        const len = Math.hypot(x, y, z) || 1;
        const theta = Math.atan2(y, x) - dx * 0.01;
        const phi = Math.max(0.01, Math.min(Math.PI - 0.01, Math.acos(Math.max(-1, Math.min(1, z / len))) - dy * 0.01));
        scene.camera.direction = [round(Math.sin(phi) * Math.cos(theta), 5), round(Math.sin(phi) * Math.sin(theta), 5), round(Math.cos(phi), 5)];
        applyCamera();
        draw();
      },
      onOrbitEnd: () => commit(),
    });
    frameEl.appendChild(viewCube.dom);

    function layout(): void {
      const box = stage.getBoundingClientRect();
      const availW = Math.max(100, box.width - 32);
      const availH = Math.max(100, box.height - 96);
      viewW = Math.floor(Math.min(availW, availH * aspect));
      viewH = Math.floor(viewW / aspect);
      frameEl.style.width = `${viewW}px`;
      frameEl.style.height = `${viewH}px`;
      canvasEl.style.width = `${viewW}px`;
      canvasEl.style.height = `${viewH}px`;
      draw();
    }
    const ro = new ResizeObserver(layout);
    ro.observe(stage);

    // ------------------------------------------------------------ camera moves

    // The camera glides to a new view instead of jumping: it turns round the
    // parts, slides across and zooms together, easing in and out.
    const GLIDE_MS = 450;
    let glide = 0;
    const stillPlease = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    function stopGlide(): void {
      if (glide) cancelAnimationFrame(glide);
      glide = 0;
    }
    /** Moves the camera to `to` over a moment, then calls `done`. */
    function glideTo(to: SceneCamera, done?: () => void): void {
      stopGlide();
      const from = structuredClone(scene.camera);
      const a = new Vector3(...from.direction).normalize();
      const b = new Vector3(...to.direction).normalize();
      // Straight through the parts when turning right round: go round the up axis instead.
      const turn = a.dot(b) < -0.9999 ? new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI) : new Quaternion().setFromUnitVectors(a, b);
      const t0 = new Vector3(...from.target);
      const t1 = new Vector3(...to.target);
      const finish = () => {
        glide = 0;
        scene.camera = structuredClone(to);
        applyCamera();
        draw();
        done?.();
      };
      const still = a.distanceTo(b) < 1e-6 && t0.distanceTo(t1) < 1e-6 && Math.abs(from.size - to.size) < 1e-6;
      if (still || stillPlease() || closed) return finish();
      const start = performance.now();
      const step = (now: number) => {
        if (closed) return;
        const k = Math.min(1, (now - start) / GLIDE_MS);
        if (k >= 1) return finish();
        const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        const d = a.clone().applyQuaternion(new Quaternion().slerp(turn, e));
        const t = t0.clone().lerp(t1, e);
        scene.camera = {
          direction: [d.x, d.y, d.z],
          target: [t.x, t.y, t.z],
          size: Math.exp(Math.log(from.size) + (Math.log(to.size) - Math.log(from.size)) * e),
        };
        applyCamera();
        draw();
        glide = requestAnimationFrame(step);
      };
      glide = requestAnimationFrame(step);
    }

    orbit.addEventListener("start", stopGlide);
    orbit.addEventListener("change", () => {
      if (glide) return;
      readCamera();
      draw();
    });
    orbit.addEventListener("end", () => commit());

    // ------------------------------------------------------------ parts

    const partById = (id: string) => scene.parts.find(p => p.id === id);
    const loaded = () => scene.parts.flatMap(part => {
      const m = models.get(part.id);
      return m && !(m instanceof Error) ? [{ part, model: m }] : [];
    });

    /** Puts the parts in the view again (after adding, removing or restyling). */
    function rebuild(): void {
      art.setParts(loaded(), scene.style, scene.explode);
      attachGizmo();
      renderList();
      draw();
    }

    /** Moves the parts in the view to where the scene says. */
    function follow(): void {
      art.move(scene.parts, scene.explode);
      placeProxy();
      draw();
    }

    async function loadModels(): Promise<void> {
      const missing: string[] = [];
      await Promise.all(scene.parts.map(async part => {
        if (models.has(part.id)) return;
        try {
          models.set(part.id, await opts.store.get(part));
        } catch (e) {
          models.set(part.id, e instanceof Error ? e : new Error(String(e)));
          missing.push(part.name);
        }
      }));
      if (missing.length) status(`${missing.length === 1 ? `“${missing[0]}”'s model` : `${missing.length} models`} couldn't be loaded, so ${missing.length === 1 ? "it isn't" : "they aren't"} drawn.`, true, true);
    }

    /** The world box of each visible part. */
    function partBoxes(): PlainBox[] {
      const out: PlainBox[] = [];
      for (const { part, model } of loaded()) {
        if (part.hidden) continue;
        const m = art.matrixOf(part.id);
        if (!m) continue;
        model.geometry.computeBoundingBox();
        const bb = model.geometry.boundingBox!.clone().applyMatrix4(m);
        out.push({ min: [bb.min.x, bb.min.y, bb.min.z], max: [bb.max.x, bb.max.y, bb.max.z] });
      }
      return out;
    }

    /** Downloads the parts as a URDF robot: robot.urdf and meshes/*.stl in a .zip. */
    function exportUrdf(): void {
      const parts = scene.parts.filter(p => {
        const m = models.get(p.id);
        return m && !(m instanceof Error);
      });
      if (!parts.length) {
        status(scene.parts.length ? "The parts' models haven't loaded yet." : "Add a part first.", true);
        return;
      }
      const { urdf, meshes } = toUrdf("robot", parts);
      const files = [{ name: "robot.urdf", data: new TextEncoder().encode(urdf) }];
      for (const m of meshes) {
        const model = models.get(m.partId) as Model;
        files.push({ name: m.path, data: new Uint8Array(toBinaryStl(model.geometry.getAttribute("position").array as Float32Array)) });
      }
      const blob = new Blob([zip(files) as BlobPart], { type: "application/zip" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "robot-urdf.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      const skipped = scene.parts.length - parts.length;
      status(`Downloaded robot-urdf.zip: ${parts.length} part${parts.length === 1 ? "" : "s"}${skipped ? ` (${skipped} not loaded, left out)` : ""}. Unzip it and open robot.urdf in Snakie.`);
    }

    async function addModel(source: { url?: string; buffer?: ArrayBuffer; name: string; file?: string }): Promise<void> {
      if (isStepFile(source.file || "") || isStepFile(source.url || "")) return addStep(source);
      status(`Adding ${source.name}…`, false, true);
      try {
        let model: Model;
        let data: string | undefined;
        if (source.buffer) {
          const pos = parseStl(source.buffer);
          // Uploads are carried inside the graphic, as binary STL (a text STL is about five times bigger).
          const bin = new Uint8Array(source.buffer, 0, 5).every((c, i) => c === "solid".charCodeAt(i)) && 84 + pos.length / 9 * 50 !== source.buffer.byteLength ? toBinaryStl(pos) : source.buffer;
          if (bin.byteLength > MAX_EMBED) throw new Error(`${source.name} is ${(bin.byteLength / 1e6).toFixed(1)} MB. Models carried in a graphic can be up to ${MAX_EMBED / 1e6} MB: add it to your project's files and pick it from there, or simplify it.`);
          data = toBase64(bin);
          model = modelFromStl(bin);
        } else {
          model = await opts.store.get({ id: "", url: source.url });
        }
        const boxes = partBoxes();
        const first = !scene.parts.length;
        const part: ScenePart = {
          id: newPartId(scene.parts),
          name: source.name.slice(0, 120),
          position: placeBeside(boxes, model.centre, model.size).map(n => round(n)) as Vec3,
          rotation: [0, 0, 0],
          ...(source.file ? { file: source.file.slice(0, 200) } : {}),
          ...(source.url ? { url: source.url } : { data }),
        };
        opts.store.put(part, model);
        models.set(part.id, model);
        scene.parts.push(part);
        selectedId = part.id;
        rebuild();
        if (first || boxes.length === 0) fitView();
        commit();
        renderProps();
        status(model.triangles > 1_500_000 ? `${part.name} added. It's a big model (${Math.round(model.triangles / 1000)}k triangles), so it may be slow.` : `${part.name} added.`);
      } catch (e) {
        status(e instanceof Error && e.message ? e.message : "That model couldn't be added.", true, true);
      }
    }

    /**
     * A STEP file's solids, each as its own part, named from the CAD's tree
     * and placed as the CAD has them (the lot moved over together if that
     * spot is taken). An upload's solids are carried in the graphic as
     * binary STL, with their CAD faces; a project file's are read from it.
     */
    async function addStep(source: { url?: string; buffer?: ArrayBuffer; name: string; file?: string }): Promise<void> {
      status(`Reading ${source.name}… (the first STEP file takes a moment to set up)`, false, true);
      try {
        const bodies: StepBody[] = source.buffer ? await readStep(source.buffer) : await opts.store.stepBodies(source.url!);
        if (closed) return;
        if (!bodies.length) throw new Error(`${source.name} has no solids in it. If it is an assembly that links to other STEP files, export it from your CAD as one file.`);
        const one = bodies.length === 1;
        const items = bodies.map((b, i) => {
          const data = source.buffer ? toBase64(toBinaryStl(b.positions, b.faces)) : undefined;
          return { b, i, data, model: modelFromPositions(b.positions.slice(), b.faces), name: one ? source.name : b.name };
        });
        const embedded = items.reduce((n, it) => n + (it.data ? it.data.length * 0.75 : 0), 0);
        if (embedded > MAX_EMBED) throw new Error(`${source.name} is ${(embedded / 1e6).toFixed(1)} MB as triangles. Models carried in a graphic can be up to ${MAX_EMBED / 1e6} MB: add it to your project's files and pick it from there, or simplify it.`);
        // The box round the whole file, to keep its parts together.
        const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
        for (const { model } of items) {
          for (let k = 0; k < 3; k++) {
            lo[k] = Math.min(lo[k], model.centre[k] - model.size[k] / 2);
            hi[k] = Math.max(hi[k], model.centre[k] + model.size[k] / 2);
          }
        }
        const mid = lo.map((v, k) => (v + hi[k]) / 2) as Vec3;
        const boxes = partBoxes();
        const first = !scene.parts.length;
        const at = placeBeside(boxes, mid, hi.map((v, k) => v - lo[k]) as Vec3);
        const added: ScenePart[] = [];
        let triangles = 0;
        for (const it of items) {
          const part: ScenePart = {
            id: newPartId(scene.parts),
            name: it.name.slice(0, 120),
            position: it.model.centre.map((c, k) => round(c + at[k] - mid[k])) as Vec3,
            rotation: [0, 0, 0],
            file: `${it.name}.stl`.slice(0, 200),
            ...(source.url ? { url: source.url, body: it.i } : { data: it.data }),
          };
          opts.store.put(part, it.model);
          models.set(part.id, it.model);
          scene.parts.push(part);
          added.push(part);
          triangles += it.model.triangles;
        }
        selectedId = added[0].id;
        rebuild();
        if (first || boxes.length === 0) fitView();
        commit();
        renderProps();
        const what = one ? `${added[0].name} added` : `${added.length} parts added from ${source.name}`;
        status(triangles > 1_500_000 ? `${what}. It's a big model (${Math.round(triangles / 1000)}k triangles), so it may be slow.` : `${what}.`);
      } catch (e) {
        status(e instanceof Error && e.message ? e.message : "That STEP file couldn't be added.", true, true);
      }
    }

    async function addFiles(files: Iterable<File>): Promise<void> {
      for (const f of files) {
        if (!/\.(stl|step|stp)$/i.test(f.name)) {
          status(`${f.name} isn't an STL or STEP file.`, true);
          continue;
        }
        await addModel({ buffer: await f.arrayBuffer(), name: partName(f.name), file: f.name });
      }
    }

    function removePart(id: string): void {
      const p = partById(id);
      if (!p) return;
      // Parts joined to it stay where they are, standing on their own.
      const world = worldMatrices(scene.parts, 0, false);
      for (const c of scene.parts) {
        if (c.parent !== id) continue;
        setLocalFromWorld(c, world.get(c.id)!, null);
        delete c.parent;
        delete c.joint;
        delete c.explode;
      }
      scene.parts = scene.parts.filter(x => x.id !== id);
      models.delete(id);
      if (selectedId === id) selectedId = "";
      rebuild();
      commit();
      renderProps();
    }

    // ------------------------------------------------------------ the handles

    /** The frame a part's numbers are in: its parent's (exploded as drawn), or the world's. */
    function parentFrame(part: ScenePart): Matrix4 {
      if (!part.parent) return new Matrix4();
      const world = worldMatrices(scene.parts, scene.explode);
      const m = world.get(part.parent)?.clone() || new Matrix4();
      const f = explodeOf(part, scene.explode);
      if (part.joint && f > 0) {
        const n = new Vector3(...part.joint.normal).normalize().multiplyScalar(part.joint.distance * f);
        m.multiply(new Matrix4().makeTranslation(n.x, n.y, n.z));
      }
      return m;
    }

    function setLocalFromWorld(part: ScenePart, world: Matrix4, frameM: Matrix4 | null): void {
      const local = frameM ? frameM.clone().invert().multiply(world) : world.clone();
      const pos = new Vector3();
      const q = new Quaternion();
      local.decompose(pos, q, new Vector3());
      const e = new Euler().setFromQuaternion(q, "ZYX");
      part.position = [round(pos.x), round(pos.y), round(pos.z)];
      part.rotation = [round(wrapAngle(e.x / DEG)), round(wrapAngle(e.y / DEG)), round(wrapAngle(e.z / DEG))];
    }

    function placeProxy(): void {
      const m = selectedId ? art.matrixOf(selectedId) : undefined;
      if (!m) return;
      m.decompose(proxy.position, proxy.quaternion, proxy.scale);
      proxy.updateMatrixWorld(true);
    }

    function attachGizmo(): void {
      const p = selectedId ? partById(selectedId) : undefined;
      if (p && !p.hidden && art.matrixOf(p.id)) {
        placeProxy();
        gizmo.attach(proxy);
        gizmo.setMode(tool);
      } else {
        gizmo.detach();
      }
      root.querySelectorAll<HTMLElement>("[data-tool]").forEach(b => b.classList.toggle("lyr-on", b.dataset.tool === tool));
    }

    gizmo.addEventListener("dragging-changed", e => {
      orbit.enabled = !(e as unknown as { value: boolean }).value;
      if (!(e as unknown as { value: boolean }).value) commit();
    });
    gizmo.addEventListener("objectChange", () => {
      const p = selectedId ? partById(selectedId) : undefined;
      if (!p) return;
      proxy.updateMatrix();
      setLocalFromWorld(p, proxy.matrix, parentFrame(p));
      looseJoint(p);
      art.move(scene.parts, scene.explode);
      syncFields();
      draw();
    });
    gizmo.addEventListener("change", draw);

    // ------------------------------------------------------------ clicking parts

    const raycaster = new Raycaster();
    let downAt: { x: number; y: number } | null = null;
    canvasEl.addEventListener("pointerdown", e => {
      downAt = { x: e.clientX, y: e.clientY };
    });
    canvasEl.addEventListener("pointerup", e => {
      const d = downAt;
      downAt = null;
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
      // A handle under the pointer is the gizmo's click, unless faces are being picked (the gizmo is put away then).
      if (!joining && (gizmo.dragging || (gizmo as unknown as { axis: string | null }).axis)) return;
      const r = canvasEl.getBoundingClientRect();
      const ndc = new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      // A right-click (not a right-drag, which pans): the part's menu, or the view's.
      if ((e.button === 2 || (e.button === 0 && e.ctrlKey && mac)) && !joining) {
        art.scene.updateMatrixWorld(true);
        raycaster.setFromCamera(ndc, camera);
        const hit = raycaster.intersectObjects(art.meshes(), false)[0];
        const id = hit ? String(hit.object.userData.partId || "") : "";
        if (id && partById(id)) {
          if (selectedId !== id || shownJoint) select(id);
          partMenu(id, e.clientX, e.clientY);
        } else viewMenu(e.clientX, e.clientY);
        return;
      }
      if (e.button !== 0) return;
      if (joining) {
        hoverAt(e);
        pickFace(hoverPick());
        return;
      }
      art.scene.updateMatrixWorld(true);
      raycaster.setFromCamera(ndc, camera);
      const hit = raycaster.intersectObjects(art.meshes(), false)[0];
      select(hit ? String(hit.object.userData.partId || "") : "");
    });

    function select(id: string, keepJoint = false): void {
      selectedId = id;
      if (!keepJoint && shownJoint) {
        shownJoint = "";
        status("");
      }
      attachGizmo();
      renderList();
      renderProps();
      draw();
    }

    // ------------------------------------------------------------ views

    /** Frames all the parts; `smooth` glides there and saves the step for undo. */
    function fitView(smooth = false): void {
      art.scene.updateMatrixWorld(true);
      const to = frame(scene.camera, art.bounds(), aspect);
      if (smooth) return glideTo(to, commit);
      stopGlide();
      scene.camera = to;
      applyCamera();
      draw();
    }

    /** Turns the camera to show `box` (zooming in or out), keeping the direction it looks from. */
    function frameOn(box: Bounds): void {
      if (box.isEmpty()) return;
      glideTo(frame(scene.camera, box, aspect, 1.35), commit);
    }
    /** Where a part is drawn now, as a box. */
    function partBounds(id: string): Bounds {
      const g = art.groupOf(id);
      const box = new Bounds();
      if (!g) return box;
      art.scene.updateMatrixWorld(true);
      const m = models.get(id);
      if (m && !(m instanceof Error)) {
        m.geometry.computeBoundingBox();
        if (m.geometry.boundingBox) box.copy(m.geometry.boundingBox).applyMatrix4(g.matrixWorld);
      }
      return box;
    }
    /** Zooms to a part, or to a joint's two faces with a little of each part round them. */
    function zoomTo(id: string, joint: boolean): void {
      if (!joint) return frameOn(partBounds(id));
      const box = new Bounds();
      art.scene.updateMatrixWorld(true);
      let reach = 0;
      for (const jf of jointFaces) {
        const g = art.groupOf(jf.id);
        const m = models.get(jf.id);
        if (!g || !m || m instanceof Error) continue;
        reach = Math.max(reach, ...m.size);
        if (jf.face) {
          const fg = faceGeometry(m, jf.face);
          fg.computeBoundingBox();
          if (fg.boundingBox) box.union(fg.boundingBox.clone().applyMatrix4(g.matrixWorld));
        }
        box.expandByPoint(new Vector3(...jf.point).applyMatrix4(g.matrixWorld));
      }
      if (box.isEmpty()) return frameOn(partBounds(id).union(partBounds(partById(id)?.parent || "")));
      // Some room round the faces, so the joint reads in its parts.
      box.expandByScalar(Math.max(4, reach * 0.15));
      frameOn(box);
    }

    function setView(id: string): void {
      const v = VIEWS.find(x => x.id === id);
      if (!v) return;
      art.scene.updateMatrixWorld(true);
      glideTo(frame({ ...scene.camera, direction: [...v.direction] }, art.bounds(), aspect), commit);
    }

    // ------------------------------------------------------------ history

    const past: string[] = [];
    const future: string[] = [];
    // Snapshots without the models carried inside, which never change: they're put back by id.
    const embedded = new Map<string, string>();
    const snap = () => JSON.stringify({ ...scene, parts: scene.parts.map(p => (p.data ? (embedded.set(p.id + p.data.length, p.data), { ...p, data: `#${p.id + p.data.length}` }) : p)) });
    let current = snap();
    function commit(): void {
      const next = snap();
      if (next === current) return;
      past.push(current);
      if (past.length > 80) past.shift();
      future.length = 0;
      current = next;
      syncHistory();
    }
    function restore(text: string): void {
      stopGlide();
      const s = JSON.parse(text) as SceneData;
      s.parts.forEach(p => {
        if (p.data?.startsWith("#")) p.data = embedded.get(p.data.slice(1));
      });
      scene = clone(s);
      if (selectedId && !partById(selectedId)) selectedId = "";
      shownJoint = "";
      void loadModels().then(() => {
        rebuild();
        applyCamera();
        renderProps();
        syncExplode();
      });
    }
    function undo(): void {
      commit();
      if (!past.length) return;
      future.push(current);
      current = past.pop()!;
      restore(current);
      syncHistory();
    }
    function redo(): void {
      if (!future.length) return;
      past.push(current);
      current = future.pop()!;
      restore(current);
      syncHistory();
    }
    function syncHistory(): void {
      $<HTMLButtonElement>("[data-act=undo]").disabled = !past.length;
      $<HTMLButtonElement>("[data-act=redo]").disabled = !future.length;
    }

    // ------------------------------------------------------------ the parts list

    function renderList(): void {
      // A tree: each part joined to another sits under it, with its joint
      // as a row between them that can be shown, changed or undone.
      const byParent = new Map<string, ScenePart[]>();
      const ids = new Set(scene.parts.map(p => p.id));
      for (const p of scene.parts) {
        const key = p.parent && ids.has(p.parent) ? p.parent : "";
        let l = byParent.get(key);
        if (!l) byParent.set(key, (l = []));
        l.push(p);
      }
      const lit = highlightedParts(scene.parts);
      const row = (p: ScenePart, depth: number): string => {
        const m = models.get(p.id);
        const on = lit.has(p.id);
        // Lit by a part above it, not by its own setting.
        const inherited = on && p.highlight === undefined;
        const ownExplode = p.explode !== undefined;
        const f = Math.round(explodeOf(p, scene.explode) * 100);
        const broken = m instanceof Error;
        const parent = p.parent ? partById(p.parent) : undefined;
        const joint = parent ? `<li class="lyr-scene-row lyr-scene-joint-row${shownJoint === p.id ? " lyr-on" : ""}" style="--depth:${depth}">
              <button type="button" class="lyr-scene-name" data-joint="${esc(p.id)}" title="Show where they join">${icon("link", 14)}<span>${esc(p.joint?.point && p.joint.type === "revolute" ? "Turns on" : p.joint?.point && p.joint.type === "prismatic" ? "Slides on" : "Joint to")} ${esc(parent.name)}</span></button>
              <button type="button" class="lyr-btn lyr-icon-btn${ownExplode ? " lyr-on" : ""}" data-joint-explode="${esc(p.id)}" title="${ownExplode ? `Explodes ${f}% on its own` : "Explode just this joint"}" aria-label="Explode the joint of ${esc(p.name)}" aria-expanded="${explodeOpen === p.id}">${icon("expand", 16)}</button>
              <button type="button" class="lyr-btn lyr-icon-btn" data-rejoin="${esc(p.id)}" title="Change the joint: pick the two faces again" aria-label="Change the joint of ${esc(p.name)}">${icon("pencil", 16)}</button>
              <button type="button" class="lyr-btn lyr-icon-btn" data-unjoin="${esc(p.id)}" title="Remove the joint (the part stays where it is)" aria-label="Remove the joint of ${esc(p.name)}">${icon("unlink", 16)}</button>
            </li>${explodeOpen === p.id ? `<li class="lyr-scene-row lyr-scene-joint-explode" style="--depth:${depth}" data-explode-for="${esc(p.id)}">
              <input type="range" min="0" max="100" step="1" value="${f}" data-joint-explode-range aria-label="How far this joint comes apart, per cent">
              <input type="number" class="lyr-scene-explode-num" min="0" max="100" step="1" value="${f}" data-joint-explode-num aria-label="How far this joint comes apart, per cent"><span class="lyr-scene-explode-unit">%</span>
              <button type="button" class="lyr-btn lyr-icon-btn" data-joint-explode-reset="${esc(p.id)}" title="Follow the main Explode slider again" aria-label="Follow the main Explode slider"${ownExplode ? "" : " disabled"}>${icon("rotate", 16)}</button>
            </li>` : ""}` : "";
        return `${joint}<li class="lyr-scene-row${p.id === selectedId && !shownJoint ? " lyr-on" : ""}${p.hidden ? " lyr-off" : ""}" data-id="${esc(p.id)}" style="--depth:${depth}">
              <button type="button" class="lyr-scene-name" data-pick="${esc(p.id)}" title="${broken ? "Its model couldn't be loaded" : "Select"}">${icon("cube", 14)}<span>${esc(p.name)}</span>${broken ? `<em>missing</em>` : ""}</button>
              <button type="button" class="lyr-btn lyr-icon-btn${on ? " lyr-on" : ""}${inherited ? " lyr-inherited" : ""}" data-highlight="${esc(p.id)}" title="${inherited ? "Highlighted with the part above it: click to leave this one out" : on ? "Stop highlighting (and the parts under it)" : "Highlight (and the parts under it)"}" aria-label="Highlight ${esc(p.name)}" aria-pressed="${on}">${icon("highlight", 16)}</button>
              <button type="button" class="lyr-btn lyr-icon-btn${p.ghost ? " lyr-on" : ""}" data-ghost-part="${esc(p.id)}" title="${p.ghost ? "Draw it normally" : "Ghost: draw it faint, as fitted in an earlier step"}" aria-label="Ghost ${esc(p.name)}" aria-pressed="${!!p.ghost}">${icon("opacity", 16)}</button>
              <button type="button" class="lyr-btn lyr-icon-btn" data-hide="${esc(p.id)}" title="${linked() ? (p.hidden ? "Show it in this scene" : "Leave it out of this scene (it stays in the model)") : p.hidden ? "Show" : "Hide"}" aria-label="${p.hidden ? "Show" : "Hide"} ${esc(p.name)}">${icon(p.hidden ? "eyeOff" : "eye", 16)}</button>
              <button type="button" class="lyr-btn lyr-icon-btn" data-remove="${esc(p.id)}" title="${linked() ? "Remove it from the project's model (every scene)" : "Remove"}" aria-label="Remove ${esc(p.name)}">${icon("trash", 16)}</button>
            </li>${(byParent.get(p.id) || []).map(c => row(c, depth + 1)).join("")}`;
      };
      renderModelNote();
      const had = list.contains(document.activeElement);
      list.innerHTML = scene.parts.length ? (byParent.get("") || []).map(p => row(p, 0)).join("") : `<li class="lyr-note">No parts yet.</li>`;
      // The button clicked has gone: keep the keys working in the scene.
      if (had) root.focus({ preventScroll: true });
    }

    /** Whether this scene's parts are the project's model. */
    function linked(): boolean {
      return shared && !!scene.model;
    }

    const modelNote = $(".lyr-scene-model");
    function renderModelNote(): void {
      const title = $(".lyr-scene-parts-title");
      if (!shared) {
        modelNote.hidden = true;
        return;
      }
      modelNote.hidden = false;
      if (linked()) {
        const shown = scene.parts.filter(p => !p.hidden).length;
        title.textContent = "Project model";
        modelNote.innerHTML = `<p class="lyr-note">${scene.parts.length ? `Parts and joints are shared by every scene in this project. This scene shows ${shown} of ${scene.parts.length}: the eye picks which.` : "The parts you add here are the project's model: every scene can show them."}</p>`;
      } else {
        title.textContent = "Parts";
        modelNote.innerHTML = `<div class="lyr-scene-banner"><p>This scene has its own parts. The project has a model of ${projectModel?.parts.length || 0} part${projectModel?.parts.length === 1 ? "" : "s"}.</p>
          <button type="button" class="lyr-wide-btn" data-act="use-model" title="Show the project's model here instead of these parts (camera and style stay)">${icon("cube", 16)} Use the project model</button></div>`;
      }
    }
    modelNote.addEventListener("click", e => {
      if (!(e.target as HTMLElement).closest("[data-act=use-model]") || !projectModel) return;
      scene = followModel({ ...scene, parts: [] }, projectModel);
      selectedId = "";
      shownJoint = "";
      void loadModels().then(() => {
        rebuild();
        fitView();
        commit();
      });
      renderList();
      renderProps();
      syncExplode();
      status("This scene now shows the project's model.");
    });

    list.addEventListener("click", e => {
      const b = (e.target as HTMLElement).closest("button");
      if (!b) return;
      const d = b.dataset;
      // Picked in the list: the view zooms to it (Fit shows everything again).
      if (d.pick) {
        const off = d.pick === selectedId && !shownJoint;
        select(off ? "" : d.pick);
        if (!off) zoomTo(d.pick, false);
      } else if (d.joint) {
        const off = shownJoint === d.joint;
        showJoint(off ? "" : d.joint);
        if (!off) zoomTo(d.joint, true);
      }
      else if (d.rejoin) {
        select(d.rejoin);
        openJointDialog(d.rejoin);
      } else if (d.unjoin) {
        const p = partById(d.unjoin);
        if (p) unjoin(p);
      } else if (d.jointExplode) {
        explodeOpen = explodeOpen === d.jointExplode ? "" : d.jointExplode;
        renderList();
        if (explodeOpen) list.querySelector<HTMLInputElement>("[data-joint-explode-num]")?.focus();
      } else if (d.jointExplodeReset) {
        const p = partById(d.jointExplodeReset);
        if (p && p.explode !== undefined) {
          delete p.explode;
          follow();
          commit();
          renderList();
          list.querySelector<HTMLInputElement>("[data-joint-explode-num]")?.focus();
        }
      } else if (d.highlight) toggleHighlight(d.highlight);
      else if (d.ghostPart) toggle(d.ghostPart, "ghost");
      else if (d.hide) toggle(d.hide, "hidden");
      else if (d.remove) removePart(d.remove);
    });

    // A joint's own explode, from its row's slider or number.
    list.addEventListener("input", e => {
      const t = e.target as HTMLInputElement;
      const rowEl = t.closest<HTMLElement>("[data-explode-for]");
      const p = rowEl ? partById(rowEl.dataset.explodeFor || "") : undefined;
      if (!p || !rowEl) return;
      const v = Number(t.value);
      if (t.value === "" || !Number.isFinite(v)) return;
      const pc = Math.max(0, Math.min(100, Math.round(v)));
      p.explode = pc / 100;
      const other = rowEl.querySelector<HTMLInputElement>(t.matches("[data-joint-explode-range]") ? "[data-joint-explode-num]" : "[data-joint-explode-range]");
      if (other) other.value = String(pc);
      rowEl.querySelector<HTMLButtonElement>("[data-joint-explode-reset]")!.disabled = false;
      const btn = list.querySelector<HTMLElement>(`[data-joint-explode="${CSS.escape(p.id)}"]`);
      btn?.classList.add("lyr-on");
      if (btn) btn.title = `Explodes ${pc}% on its own`;
      follow();
    });
    list.addEventListener("change", e => {
      const t = e.target as HTMLInputElement;
      if (!t.closest("[data-explode-for]")) return;
      const p = partById(t.closest<HTMLElement>("[data-explode-for]")!.dataset.explodeFor || "");
      if (p) t.value = String(Math.round(explodeOf(p, scene.explode) * 100));
      commit();
    });

    /**
     * Turns a part's highlight on or off, for its whole branch: the parts
     * under it follow it again, and it keeps a setting of its own only
     * where it differs from the part above it.
     */
    function toggleHighlight(id: string): void {
      const p = partById(id);
      if (!p) return;
      const lit = highlightedParts(scene.parts);
      const want = !lit.has(id);
      const above = p.parent ? lit.has(p.parent) : false;
      if (want === above) delete p.highlight;
      else p.highlight = want;
      const under = new Set([id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const c of scene.parts) if (c.parent && under.has(c.parent) && !under.has(c.id)) {
          under.add(c.id);
          grew = true;
          delete c.highlight;
        }
      }
      rebuild();
      commit();
      renderList();
      renderProps();
    }

    /** Turns a part's highlight, ghost or hidden on or off. */
    function toggle(id: string, key: "highlight" | "ghost" | "hidden"): void {
      const p = partById(id);
      if (!p) return;
      if (p[key]) delete p[key];
      else p[key] = true;
      rebuild();
      commit();
      renderList();
      renderProps();
    }

    /** A copy of a part, standing on its own beside it (its joint isn't copied: join the copy where it goes). */
    function duplicatePart(id: string): void {
      const p = partById(id);
      const model = models.get(id);
      if (!p || !model || model instanceof Error) return;
      const world = worldMatrices(scene.parts, 0, false).get(id) || new Matrix4();
      const names = new Set(scene.parts.map(x => x.name));
      const base = p.name.replace(/ \d+$/, "");
      let n = 2;
      while (names.has(`${base} ${n}`)) n++;
      const copy: ScenePart = { ...structuredClone(p), id: newPartId(scene.parts), name: `${base} ${n}`.slice(0, 120) };
      delete copy.parent;
      delete copy.joint;
      delete copy.hidden;
      // Beside it, one part's width plus a gap along X.
      const shift = new Matrix4().makeTranslation(model.size[0] + 10, 0, 0);
      setLocalFromWorld(copy, shift.multiply(world), null);
      opts.store.put(copy, model);
      models.set(copy.id, model);
      scene.parts.push(copy);
      selectedId = copy.id;
      shownJoint = "";
      rebuild();
      commit();
      renderList();
      renderProps();
      status(`${copy.name} added beside ${p.name}. Join it where it goes with Join.`);
    }

    /** Shows only this part (or all of them again). */
    function showOnly(id: string): void {
      for (const x of scene.parts) {
        if (!id || x.id === id) delete x.hidden;
        else x.hidden = true;
      }
      rebuild();
      commit();
      renderList();
      renderProps();
    }

    /** Puts the caret in the part's Name box. */
    function renameAt(id: string): void {
      select(id);
      const input = props.querySelector<HTMLInputElement>("[data-name]");
      input?.focus();
      input?.select();
    }

    // ------------------------------------------------------------ right-click menus

    interface MenuItem { label: string; icon?: string; keys?: string; on?: boolean; danger?: boolean; run: () => void }
    const ctx = document.createElement("div");
    ctx.className = "lyr-scene-ctx";
    ctx.setAttribute("role", "menu");
    ctx.hidden = true;
    overlay.appendChild(ctx);
    let ctxItems: (MenuItem | null)[] = [];
    function openCtx(x: number, y: number, title: string, items: (MenuItem | null)[]): void {
      ctxItems = items;
      ctx.innerHTML = `<div class="lyr-scene-ctx-title">${esc(title)}</div>` + items.map((it, i) => it
        ? `<button type="button" class="lyr-scene-ctx-item${it.danger ? " lyr-danger" : ""}" role="${it.on === undefined ? "menuitem" : "menuitemcheckbox"}"${it.on === undefined ? "" : ` aria-checked="${it.on}"`} data-ctx="${i}">
             <span class="lyr-scene-ctx-icon">${it.on ? icon("check", 16) : it.icon ? icon(it.icon, 16) : ""}</span><span>${esc(it.label)}</span>${it.keys ? `<span class="lyr-scene-ctx-keys">${esc(it.keys)}</span>` : ""}</button>`
        : `<hr>`).join("");
      ctx.hidden = false;
      const r = ctx.getBoundingClientRect();
      ctx.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
      ctx.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
      ctx.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    }
    function closeCtx(): void {
      if (ctx.hidden) return;
      const had = ctx.contains(document.activeElement);
      ctx.hidden = true;
      ctxItems = [];
      // Keys go on working in the scene (Delete, ⌘D, Esc…).
      if (had) root.focus({ preventScroll: true });
    }
    ctx.addEventListener("click", e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-ctx]");
      if (!b) return;
      const it = ctxItems[Number(b.dataset.ctx)];
      closeCtx();
      it?.run();
    });
    ctx.addEventListener("keydown", e => {
      const items = [...ctx.querySelectorAll<HTMLButtonElement>("button")];
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        items[(at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeCtx();
      }
    });
    ctx.addEventListener("contextmenu", e => e.preventDefault());
    overlay.addEventListener("pointerdown", e => {
      if (!ctx.contains(e.target as Node)) closeCtx();
    }, true);
    overlay.addEventListener("wheel", () => closeCtx(), { passive: true, capture: true });

    const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    const keyName = (k: string) => (mac ? `⌘${k}` : `Ctrl+${k}`);

    function partMenu(id: string, x: number, y: number): void {
      const p = partById(id);
      if (!p) return;
      const parent = p.parent ? partById(p.parent) : undefined;
      const broken = models.get(id) instanceof Error;
      const others = scene.parts.some(o => o.id !== id && !o.hidden);
      openCtx(x, y, p.name, [
        { label: "Zoom to it", icon: "frame", run: () => { select(id); zoomTo(id, false); } },
        { label: "Rename", icon: "pencil", run: () => renameAt(id) },
        ...(broken ? [] : [{ label: "Duplicate", icon: "copy", keys: keyName("D"), run: () => duplicatePart(id) }]),
        null,
        parent
          ? { label: `Edit joint to ${parent.name}`, icon: "link", run: () => { select(id); openJointDialog(id); } }
          : { label: "Join to another part…", icon: "link", run: () => { select(id); openJointDialog(id); } },
        ...(parent ? [{ label: "Remove joint", icon: "unlink", run: () => unjoin(p) }] : []),
        null,
        { label: "Highlight", on: highlightedParts(scene.parts).has(id), run: () => toggleHighlight(id) },
        { label: "Ghost", on: !!p.ghost, run: () => toggle(id, "ghost") },
        { label: linked() ? "Show in this scene" : "Show", on: !p.hidden, run: () => toggle(id, "hidden") },
        ...(others ? [{ label: "Show only this", icon: "eye", run: () => showOnly(id) }] : []),
        ...(scene.parts.some(o => o.hidden) ? [{ label: "Show all parts", icon: "eye", run: () => showOnly("") }] : []),
        null,
        { label: linked() ? "Remove from the model" : "Remove", icon: "trash", keys: "Del", danger: true, run: () => removePart(id) },
      ]);
    }

    function jointMenu(id: string, x: number, y: number): void {
      const p = partById(id);
      const parent = p?.parent ? partById(p.parent) : undefined;
      if (!p || !parent) return;
      openCtx(x, y, `${p.name} → ${parent.name}`, [
        { label: "Show and zoom to it", icon: "frame", run: () => { showJoint(id); zoomTo(id, true); } },
        { label: "Edit joint", icon: "pencil", run: () => { select(id); openJointDialog(id); } },
        null,
        { label: `Select ${p.name}`, icon: "cube", run: () => select(id) },
        { label: `Select ${parent.name}`, icon: "cube", run: () => select(parent.id) },
        null,
        { label: "Remove joint", icon: "unlink", danger: true, run: () => unjoin(p) },
      ]);
    }

    function viewMenu(x: number, y: number): void {
      openCtx(x, y, "View", [
        { label: "Fit everything", icon: "frame", keys: "F", run: () => fitView(true) },
        ...(VIEWS.map(v => ({ label: v.label, run: () => setView(v.id) }))),
        null,
        ...(scene.parts.some(o => o.hidden) ? [{ label: "Show all parts", icon: "eye", run: () => showOnly("") }] : []),
        { label: "Add a part…", icon: "plus", run: () => void openMenu() },
      ]);
    }

    list.addEventListener("contextmenu", e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("li");
      const id = b?.dataset.id || b?.querySelector<HTMLElement>("[data-joint]")?.dataset.joint;
      if (!b || !id) return;
      e.preventDefault();
      if (b.dataset.id) {
        if (selectedId !== id || shownJoint) select(id);
        partMenu(id, e.clientX, e.clientY);
      } else jointMenu(id, e.clientX, e.clientY);
    });

    // ------------------------------------------------------------ the part and style panel

    const field = (key: string, label: string, unit: string, value: number, step: number, title: string) => `
      <label class="lyr-scene-field" title="${esc(title)}">
        <span class="lyr-scene-scrub" data-scrub="${key}" data-step="${step}">${esc(label)}</span>
        <input class="lyr-num" type="number" step="${step}" data-field="${key}" value="${value}">
        <em>${esc(unit)}</em>
      </label>`;

    function fieldValue(key: string, p: ScenePart | undefined): number {
      const s = scene.style;
      switch (key) {
        case "x": return p ? p.position[0] : 0;
        case "y": return p ? p.position[1] : 0;
        case "z": return p ? p.position[2] : 0;
        case "roll": return p ? p.rotation[0] : 0;
        case "pitch": return p ? p.rotation[1] : 0;
        case "yaw": return p ? p.rotation[2] : 0;
        case "lineWidth": return s.lineWidth;
        case "outline": return s.outline;
        case "crease": return s.crease;
        case "spin": return p?.joint?.spin || 0;
        case "gap": return p?.joint?.gap || 0;
        case "distance": return p?.joint?.distance || 0;
        case "lower": return p?.joint?.lower ?? 0;
        case "upper": return p?.joint?.upper ?? 0;
      }
      return 0;
    }

    function setField(key: string, value: number): void {
      if (!Number.isFinite(value)) return;
      const p = partById(selectedId);
      const s = scene.style;
      const pos = ["x", "y", "z"].indexOf(key);
      const rot = ["roll", "pitch", "yaw"].indexOf(key);
      if (pos >= 0 && p) {
        p.position[pos] = round(Math.max(-100_000, Math.min(100_000, value)));
        if (looseJoint(p)) renderProps();
        follow();
      } else if (rot >= 0 && p) {
        p.rotation[rot] = round(wrapAngle(value));
        if (looseJoint(p)) renderProps();
        follow();
      } else if ((key === "spin" || key === "gap") && p?.joint?.point) {
        if (key === "spin") p.joint.spin = round(wrapAngle(value));
        else p.joint.gap = round(Math.max(-100_000, Math.min(100_000, value)));
        keepInLimits(p.joint);
        applyJoint(p);
        follow();
        syncFields();
      } else if ((key === "lower" || key === "upper") && p?.joint?.type && p.joint.type !== "fixed") {
        const j = p.joint;
        const max = j.type === "revolute" ? 180 : 100_000;
        const v = round(Math.max(-max, Math.min(max, value)));
        // The other end moves along rather than letting the range turn inside out.
        if (key === "lower") {
          j.lower = v;
          if ((j.upper ?? v) < v) j.upper = v;
        } else {
          j.upper = v;
          if ((j.lower ?? v) > v) j.lower = v;
        }
        if (j.point && keepInLimits(j)) {
          applyJoint(p);
          follow();
        }
        syncFields();
      } else if (key === "distance" && p?.joint) {
        p.joint.distance = round(Math.max(0, Math.min(100_000, value)));
        follow();
      } else if (key === "lineWidth" || key === "outline" || key === "crease") {
        const lim = { lineWidth: [0, 10], outline: [0, 20], crease: [1, 180] }[key];
        (s as unknown as Record<string, number>)[key] = round(Math.max(lim[0], Math.min(lim[1], value)), 1);
        s.preset = "custom";
        rebuild();
        syncPresets();
      }
    }

    function syncFields(): void {
      const p = partById(selectedId);
      props.querySelectorAll<HTMLInputElement>("[data-field]").forEach(inp => {
        if (document.activeElement === inp) return;
        inp.value = String(fieldValue(inp.dataset.field!, p));
      });
    }

    function syncPresets(): void {
      props.querySelectorAll<HTMLElement>("[data-preset]").forEach(b => b.classList.toggle("lyr-on", b.dataset.preset === scene.style.preset));
    }

    const colourInput = (key: keyof SceneStyle, label: string) =>
      `<label class="lyr-scene-colour">${esc(label)} <input type="color" data-colour="${key}" value="${esc(String(scene.style[key]).slice(0, 7))}"></label>`;

    // ------------------------------------------------------------ joints

    /** Joining: the part being joined, and (after the first click) the face picked on it. */
    let joining: { childId: string; childPoint?: Vec3; childNormal?: Vec3; half?: "child" | "parent" } | null = null;

    /** The parts joined (directly or further down) to `id`, and itself. */
    function branch(id: string): Set<string> {
      const out = new Set([id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const p of scene.parts) if (p.parent && out.has(p.parent) && !out.has(p.id)) {
          out.add(p.id);
          grew = true;
        }
      }
      return out;
    }

    /** Picks one half's face for the joint dialog: this part's, or the other part's. */
    function pickHalf(half: "child" | "parent"): void {
      if (!draft) return;
      joining = { childId: draft.childId, half, ...(half === "parent" ? { childPoint: draft.childPoint, childNormal: draft.childNormal } : {}) };
      canvasEl.classList.add("lyr-scene-picking");
      gizmo.detach();
      renderJointDialog();
      status(half === "child"
        ? `Click the face on “${esc(partById(draft.childId)?.name)}” that meets the other part. Esc to stop.`
        : `Click where it goes on another part: a face, a corner, an edge, a hole or a round rim. Hold ${isMacKeys ? "⌘" : "Ctrl"} to stay on a face while you choose its point. Esc to stop.`, false, true);
      draw();
    }

    function stopJoin(message = ""): void {
      joining = null;
      faceHeld = false;
      clearHover();
      canvasEl.classList.remove("lyr-scene-picking");
      attachGizmo();
      status(message);
      draw();
    }

    /** A point picked on a part, in its own frame, with the way its face looks there. */
    interface Pick {
      id: string;
      point: Vec3;
      normal: Vec3;
    }

    function pickFace(f: Pick | null): void {
      if (!joining) return;
      // Picking for one half of the joint dialog.
      if (joining.half && draft) {
        const half = joining.half;
        if (half === "child") {
          if (!f || f.id !== draft.childId) {
            status(`Click a face on “${esc(partById(draft.childId)?.name)}” itself. Esc to stop.`, true, true);
            return;
          }
          draft.childPoint = f.point;
          draft.childNormal = f.normal;
        } else {
          if (!f || f.id === draft.childId || branch(draft.childId).has(f.id)) {
            status("Click a face on another part (not this one, or one joined to it). Esc to stop.", true, true);
            return;
          }
          draft.parentId = f.id;
          draft.point = f.point;
          draft.normal = f.normal;
        }
        stopJoin();
        // The other half next, if it's still to pick.
        if (half === "child" && !draft.point) pickHalf("parent");
        else {
          applyDraft();
          renderJointDialog();
          status(draft.point && draft.childPoint ? "" : "Pick the other face to finish the joint.");
        }
        return;
      }
      if (!joining.childPoint) {
        if (!f || f.id !== joining.childId) {
          status(`Click a face on “${partById(joining.childId)?.name}” itself. Esc to stop.`, true, true);
          return;
        }
        joining.childPoint = f.point;
        joining.childNormal = f.normal;
        clearHover();
        status(`Now click where it goes on another part: a face, a corner, an edge or a hole. Esc to stop.`, false, true);
        return;
      }
      if (!f || branch(joining.childId).has(f.id)) {
        status("Click a face on another part (not one joined to this one). Esc to stop.", true, true);
        return;
      }
      const child = partById(joining.childId);
      const parent = partById(f.id);
      const model = child ? models.get(child.id) : undefined;
      if (!child || !parent) return stopJoin();
      const size = model && !(model instanceof Error) ? Math.max(...model.size) : 20;
      // How far the part reaches past its picked face into the other (a
      // screw's shank), so exploding pulls it clear with room to spare.
      let reach = 0;
      if (model && !(model instanceof Error)) {
        const cp = joining.childPoint, cn = joining.childNormal!;
        for (let k = 0; k < 8; k++) {
          const c = [k & 1 ? 1 : -1, k & 2 ? 1 : -1, k & 4 ? 1 : -1].map((sgn, i) => (sgn * model.size[i]) / 2);
          reach = Math.max(reach, (c[0] - cp[0]) * cn[0] + (c[1] - cp[1]) * cn[1] + (c[2] - cp[2]) * cn[2]);
        }
      }
      child.parent = parent.id;
      // Picking the faces again keeps how it moves.
      const was = child.joint?.type ? { type: child.joint.type, lower: child.joint.lower, upper: child.joint.upper } : {};
      child.joint = {
        ...was,
        normal: f.normal,
        distance: Math.max(10, Math.round(reach + Math.max(size * 0.6, 8))),
        point: f.point,
        childPoint: joining.childPoint,
        childNormal: joining.childNormal!,
        spin: 0,
        gap: 0,
      };
      applyJoint(child);
      selectedId = child.id;
      stopJoin(`“${child.name}” is joined to “${parent.name}”.`);
      follow();
      renderList();
      renderProps();
      syncExplode();
      commit();
    }

    // ------------------------------------------------------------ join snaps

    /** The part whose joint is shown: both faces tinted, and the points joined. */
    let shownJoint = "";
    /** The joint whose own explode slider is open in the list. */
    let explodeOpen = "";

    // While joining, the face under the pointer is tinted and its snap
    // points shown: its middle, corners and edge middles, the centres of
    // round holes in it, or the round rims at the ends of a curved face (a
    // screw's neck, a peg's end, the inside of a hole). A click takes the
    // snap nearest the pointer, or the point itself when none is near.
    const topologies = new WeakMap<Model, Topology | null>();
    function topologyOf(m: Model): Topology | null {
      if (topologies.has(m)) return topologies.get(m)!;
      const pos = m.geometry.getAttribute("position");
      const t = m.triangles <= MAX_SNAP_TRIANGLES && pos ? new Topology(pos.array as ArrayLike<number>, m.faces) : null;
      topologies.set(m, t);
      return t;
    }
    const faceGeometries = new WeakMap<Face, BufferGeometry>();
    function faceGeometry(m: Model, face: Face): BufferGeometry {
      let g = faceGeometries.get(face);
      if (!g) {
        const src = m.geometry.getAttribute("position").array as ArrayLike<number>;
        const out = new Float32Array(face.tris.length * 9);
        face.tris.forEach((t, i) => {
          for (let k = 0; k < 9; k++) out[i * 9 + k] = src[t * 9 + k];
        });
        g = new BufferGeometry();
        g.setAttribute("position", new BufferAttribute(out, 3));
        faceGeometries.set(face, g);
      }
      return g;
    }

    const faceTint = new Mesh(new BufferGeometry(), new MeshBasicMaterial({ color: 0x4ea1ff, transparent: true, opacity: 0.32, depthTest: false, depthWrite: false, side: DoubleSide }));
    faceTint.matrixAutoUpdate = false;
    faceTint.visible = false;
    faceTint.raycast = () => {};
    // A shown joint: the parent's face blue, the joined part's orange.
    const jointTints = [0x4ea1ff, 0xff922b].map(c => {
      const m = new Mesh(new BufferGeometry(), new MeshBasicMaterial({ color: c, transparent: true, opacity: 0.38, depthTest: false, depthWrite: false, side: DoubleSide }));
      m.matrixAutoUpdate = false;
      m.visible = false;
      m.raycast = () => {};
      art.overlay.add(m);
      return m;
    });
    /** The two faces of the shown joint, found again from its picked points. */
    let jointFaces: { id: string; face: Face | null; point: Vec3 }[] = [];

    function showJoint(id: string): void {
      shownJoint = "";
      jointFaces = [];
      const p = id ? partById(id) : undefined;
      if (p?.joint && p.parent) {
        shownJoint = id;
        selectedId = id;
        const j = p.joint;
        const findFace = (partId: string, point?: Vec3, normal?: Vec3) => {
          const m = models.get(partId);
          if (!point || !normal || !m || m instanceof Error) return null;
          try {
            return topologyOf(m)?.faceNear(point, normal) ?? null;
          } catch (e) {
            console.warn("Layers: the joint's face couldn't be found", e);
            return null;
          }
        };
        // A joint from before faces were picked has only its direction: its parts' middles stand in.
        jointFaces = [
          { id: p.parent, face: findFace(p.parent, j.point, j.normal), point: j.point || [0, 0, 0] },
          { id: p.id, face: findFace(p.id, j.childPoint, j.childNormal), point: j.childPoint || [0, 0, 0] },
        ];
        const pn = partById(p.parent)?.name || "";
        status(`“${p.name}” is joined to “${pn}” here: its orange face to the blue one. Change it with the pencil, or remove it.`, false, true);
      } else status("");
      attachGizmo();
      if (shownJoint) gizmo.detach();
      renderList();
      renderProps();
      placeSnaps();
      draw();
    }

    const ringGeometry = new BufferGeometry();
    const ring = new Line(ringGeometry, new LineBasicMaterial({ color: 0x1f6fe0, depthTest: false }));
    ring.matrixAutoUpdate = false;
    ring.visible = false;
    ring.raycast = () => {};
    art.overlay.add(faceTint, ring);
    const snapLayer = document.createElement("div");
    snapLayer.className = "lyr-scene-snaps";
    frameEl.appendChild(snapLayer);

    interface Hover {
      id: string;
      mesh: Mesh;
      face: Face | null;
      /** The point under the pointer and its triangle's normal, in the part's frame. */
      point: Vec3;
      normal: Vec3;
      snap: number;
    }
    let hover: Hover | null = null;
    let pointer = { x: 0, y: 0 };
    // ⌘ (Ctrl elsewhere) held while picking: stay on the face under the
    // pointer and move between its points, wherever the pointer goes.
    let faceHeld = false;
    const isMacKeys = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    const holdKey = (e: { metaKey: boolean; ctrlKey: boolean }) => (isMacKeys ? e.metaKey : e.ctrlKey);
    function setFaceHeld(on: boolean): void {
      if (on === faceHeld) return;
      faceHeld = on;
      if (joining && hover) placeSnaps();
      draw();
    }
    /** How far (px) each of the face's round snaps reaches: its circle as drawn. */
    function snapReach(snaps: Snap[], m: Matrix4, project: (p: Vec3, m: Matrix4) => { x: number; y: number }): number[] {
      return snaps.map(sn => {
        if (!sn.radius || !(sn.role === "hole" || sn.role === "rim" || sn.role === "centre" || sn.role === "pocket")) return 0;
        const n = new Vector3(...sn.n).normalize();
        const u = new Vector3(1, 0, 0).cross(n);
        if (u.lengthSq() < 1e-6) u.set(0, 1, 0).cross(n);
        u.normalize();
        const w = n.clone().cross(u);
        const c = project(sn.p, m);
        let r = 0;
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          const q = new Vector3(...sn.p).addScaledVector(u, Math.cos(a) * sn.radius).addScaledVector(w, Math.sin(a) * sn.radius);
          const at = project([q.x, q.y, q.z], m);
          r = Math.max(r, Math.hypot(at.x - c.x, at.y - c.y));
        }
        // Inside the circle, a little short of its edge (the edge's own points stay catchable).
        return r * 0.85;
      });
    }
    /** Whether the pointer is inside one of the hovered face's round snaps, as drawn. */
    function insideRound(): boolean {
      if (!hover?.face) return false;
      const m = hover.mesh.matrixWorld;
      const project = (p: Vec3, mm: Matrix4) => {
        const v = new Vector3(...p).applyMatrix4(mm).project(camera);
        return { x: ((v.x + 1) / 2) * viewW, y: ((1 - v.y) / 2) * viewH };
      };
      const reach = snapReach(hover.face.snaps, m, project);
      return hover.face.snaps.some((sn, i) => {
        if (!reach[i]) return false;
        const c = project(sn.p, m);
        return Math.hypot(c.x - pointer.x, c.y - pointer.y) < reach[i];
      });
    }

    const ROLE_LABEL: Record<Snap["role"], string> = { centre: "middle of the face", corner: "corner", edge: "middle of the edge", hole: "centre of the hole", rim: "centre of the rim", pocket: "middle of the recess" };

    /** The meshes a join may pick now: the part being joined, then any part not on its branch. */
    function pickable(): Mesh[] {
      if (!joining) return [];
      const branchIds = joining.childPoint ? branch(joining.childId) : null;
      return art.meshes().filter(m => {
        const id = String(m.userData.partId || "");
        return branchIds ? !branchIds.has(id) : id === joining!.childId;
      });
    }

    function hoverAt(e: { clientX: number; clientY: number }): void {
      const r = canvasEl.getBoundingClientRect();
      pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
      // The face is held: only its points move.
      if (faceHeld && hover) {
        placeSnaps();
        draw();
        return;
      }
      art.scene.updateMatrixWorld(true);
      raycaster.setFromCamera(new Vector2((pointer.x / r.width) * 2 - 1, -(pointer.y / r.height) * 2 + 1), camera);
      const hit = raycaster.intersectObjects(pickable(), false).find(h => h.face && h.faceIndex !== undefined);
      // Over a hole in the face (seeing its wall, another part, or nothing),
      // the face stays, so the hole's centre can be had. A face parallel to
      // it on the same part (a counterbore's floor) takes over as usual.
      if (hover && insideRound()) {
        const sameSide = hit && hit.object === hover.mesh && Math.abs(hit.face!.normal.clone().normalize().dot(new Vector3(...hover.normal))) > 0.9;
        const model = hit ? models.get(String(hit.object.userData.partId || "")) : undefined;
        const other = sameSide && model && !(model instanceof Error) ? topologyOf(model)?.faceAt(hit!.faceIndex!) : null;
        if (!sameSide || !other || other === hover.face) {
          placeSnaps();
          draw();
          return;
        }
      }
      if (!hit) {
        // Off the part, a snap still near the pointer (a hole's centre is
        // over empty space) stays catchable.
        if (hover) placeSnaps();
        if (hover && hover.snap < 0) clearHover();
        else draw();
        return;
      }
      const mesh = hit.object as Mesh;
      const id = String(mesh.userData.partId || "");
      const model = models.get(id);
      const face = model && !(model instanceof Error) ? topologyOf(model)?.faceAt(hit.faceIndex!) ?? null : null;
      const local = mesh.worldToLocal(hit.point.clone());
      const n = hit.face!.normal.clone().normalize();
      const same = hover && hover.mesh === mesh && hover.face && hover.face === face;
      hover = { id, mesh, face, point: [local.x, local.y, local.z], normal: [n.x, n.y, n.z], snap: -1 };
      if (!same) {
        if (face && model && !(model instanceof Error)) {
          faceTint.geometry = faceGeometry(model, face);
          faceTint.visible = true;
        } else faceTint.visible = false;
      }
      faceTint.matrix.copy(mesh.matrixWorld);
      faceTint.matrixWorldNeedsUpdate = true;
      placeSnaps();
      draw();
    }

    function clearHover(): void {
      hover = null;
      faceTint.visible = false;
      ring.visible = false;
      snapLayer.innerHTML = "";
      draw();
    }

    /** Puts the snap dots over the view, and marks the one a click would take. */
    function placeSnaps(): void {
      const marks: string[] = [];
      const project = (p: Vec3, m: Matrix4) => {
        const v = new Vector3(...p).applyMatrix4(m).project(camera);
        return { x: ((v.x + 1) / 2) * viewW, y: ((1 - v.y) / 2) * viewH };
      };
      jointTints.forEach(t => (t.visible = false));
      if (shownJoint && !joining) {
        jointFaces.forEach((jf, i) => {
          const g = art.groupOf(jf.id);
          const m = models.get(jf.id);
          if (!g) return;
          try {
          g.updateMatrixWorld(true);
          const tint = jointTints[i];
          if (jf.face && m && !(m instanceof Error)) {
            tint.geometry = faceGeometry(m, jf.face);
            tint.matrix.copy(g.matrixWorld);
            tint.matrixWorldNeedsUpdate = true;
            tint.visible = true;
            for (const sn of jf.face.snaps) {
              const at = project(sn.p, g.matrixWorld);
              marks.push(`<span class="lyr-snap lyr-snap-${sn.role} lyr-snap-faint" style="left:${at.x}px;top:${at.y}px"></span>`);
            }
          }
          const at = project(jf.point, g.matrixWorld);
          marks.push(`<span class="lyr-snap ${i ? "lyr-snap-picked" : "lyr-snap-joined"}" style="left:${at.x}px;top:${at.y}px"></span>`);
          } catch (e) {
            console.warn("Layers: the joint couldn't be shown", e);
          }
        });
      }
      if (joining?.childPoint) {
        const g = art.groupOf(joining.childId);
        if (g) {
          const at = project(joining.childPoint, g.matrix);
          marks.push(`<span class="lyr-snap lyr-snap-picked" style="left:${at.x}px;top:${at.y}px"></span>`);
        }
      }
      if (hover) {
        const snaps = hover.face?.snaps || [];
        const m = hover.mesh.matrixWorld;
        const screen = snaps.map(s => project(s.p, m));
        hover.snap = nearestSnap(screen, snaps, pointer, 22, 40, snapReach(snaps, m, project), faceHeld);
        screen.forEach((p, i) => {
          marks.push(`<span class="lyr-snap lyr-snap-${snaps[i].role}${i === hover!.snap ? " lyr-on" : ""}" style="left:${p.x}px;top:${p.y}px"></span>`);
        });
        const on = hover.snap >= 0 ? snaps[hover.snap] : null;
        if (on) {
          const p = screen[hover.snap];
          marks.push(`<span class="lyr-snap-label" style="left:${p.x}px;top:${p.y}px">${esc(ROLE_LABEL[on.role])}${faceHeld ? " · face held" : ""}</span>`);
        }
        if (on?.radius && (on.role === "hole" || on.role === "rim" || on.role === "centre")) {
          const n = new Vector3(...on.n).normalize();
          const u = new Vector3(1, 0, 0).cross(n);
          if (u.lengthSq() < 1e-6) u.set(0, 1, 0).cross(n);
          u.normalize();
          const w = n.clone().cross(u);
          const pts: number[] = [];
          for (let k = 0; k <= 48; k++) {
            const a = (k / 48) * Math.PI * 2;
            const q = new Vector3(...on.p).addScaledVector(u, Math.cos(a) * on.radius).addScaledVector(w, Math.sin(a) * on.radius);
            pts.push(q.x, q.y, q.z);
          }
          ringGeometry.setAttribute("position", new BufferAttribute(new Float32Array(pts), 3));
          ring.matrix.copy(m);
          ring.matrixWorldNeedsUpdate = true;
          ring.visible = true;
        } else ring.visible = false;
      } else ring.visible = false;
      snapLayer.innerHTML = marks.join("");
    }

    /** What a click picks now: the snap marked, or the point under the pointer. */
    function hoverPick(): Pick | null {
      if (!hover) return null;
      const s = hover.snap >= 0 ? hover.face?.snaps[hover.snap] : undefined;
      const p = s ? s.p : hover.point;
      const n = s ? s.n : hover.normal;
      return { id: hover.id, point: [round(p[0], 3), round(p[1], 3), round(p[2], 3)], normal: [round(n[0], 5), round(n[1], 5), round(n[2], 5)] };
    }

    let hoverQueued = 0;
    canvasEl.addEventListener("pointermove", e => {
      if (!joining || e.buttons) return;
      faceHeld = holdKey(e) && !!hover;
      const at = { clientX: e.clientX, clientY: e.clientY };
      cancelAnimationFrame(hoverQueued);
      hoverQueued = requestAnimationFrame(() => joining && hoverAt(at));
    });
    canvasEl.addEventListener("pointerleave", () => {
      cancelAnimationFrame(hoverQueued);
      if (joining) clearHover();
    });

    /**
     * Keeps a moving joint's angle (turning) or slide (sliding) inside its
     * limits. Says whether it moved it.
     */
    function keepInLimits(j: PartJoint): boolean {
      if (j.type !== "revolute" && j.type !== "prismatic") return false;
      const key = j.type === "revolute" ? "spin" : "gap";
      const v = j[key] || 0;
      const to = Math.max(j.lower ?? -Infinity, Math.min(j.upper ?? Infinity, v));
      if (to === v) return false;
      j[key] = to;
      return true;
    }

    function setJointType(p: ScenePart, type: JointType): void {
      const j = p.joint;
      if (!j) return;
      if (type === "fixed") {
        delete j.type;
        delete j.lower;
        delete j.upper;
      } else {
        j.type = type;
        [j.lower, j.upper] = DEFAULT_LIMITS[type];
        // The range starts round where it is now, so nothing jumps.
        const now = type === "revolute" ? j.spin || 0 : j.gap || 0;
        if (now < j.lower) j.lower = round(now);
        if (now > j.upper) j.upper = round(now);
      }
      renderList();
      renderProps();
      commit();
    }

    /** Stops a part following its picked faces once it's placed by hand. Says whether it did. */
    function looseJoint(p: ScenePart): boolean {
      const j = p.joint;
      if (!j?.point) return false;
      delete j.point;
      delete j.childPoint;
      delete j.childNormal;
      delete j.spin;
      delete j.gap;
      return true;
    }

    function unjoin(p: ScenePart): void {
      const world = worldMatrices(scene.parts, 0, false).get(p.id);
      if (world) setLocalFromWorld(p, world, null);
      delete p.parent;
      delete p.joint;
      delete p.explode;
      if (shownJoint === p.id) shownJoint = "";
      follow();
      renderList();
      renderProps();
      syncExplode();
      commit();
    }

    // ------------------------------------------------------------ the joint dialog

    /** The joint being made or changed in the floating dialog. */
    interface JointDraft {
      childId: string;
      parentId: string;
      childPoint?: Vec3;
      childNormal?: Vec3;
      point?: Vec3;
      normal?: Vec3;
      /** The scene before it was opened, for Cancel. */
      before: string;
    }
    let draft: JointDraft | null = null;

    const jointDialog = document.createElement("div");
    jointDialog.className = "lyr-joint-dialog";
    jointDialog.setAttribute("role", "dialog");
    jointDialog.setAttribute("aria-label", "Edit joint");
    jointDialog.hidden = true;
    stage.appendChild(jointDialog);

    const mm = (v?: Vec3) => (v ? v.map(n => round(n, 1)).join(", ") + " mm" : "");

    function openJointDialog(childId: string): void {
      const p = partById(childId);
      if (!p) return;
      const j = p.joint;
      draft = {
        childId,
        parentId: (p.parent && partById(p.parent) ? p.parent : "") || "",
        childPoint: j?.childPoint,
        childNormal: j?.childNormal,
        point: j?.point,
        normal: j?.normal,
        before: snap(),
      };
      selectedId = childId;
      shownJoint = p.parent ? childId : "";
      renderList();
      renderProps();
      renderJointDialog();
      if (!draft.childPoint) pickHalf("child");
      else {
        placeSnaps();
        draw();
      }
    }

    function closeJointDialog(): void {
      draft = null;
      jointDialog.hidden = true;
      if (joining?.half) stopJoin();
      renderList();
      renderProps();
      draw();
    }

    /** Puts the draft on the part, once both faces are picked. */
    function applyDraft(): void {
      const p = draft && partById(draft.childId);
      if (!draft || !p || !draft.parentId || !draft.point || !draft.normal || !draft.childPoint || !draft.childNormal) return;
      const model = models.get(p.id);
      const size = model && !(model instanceof Error) ? Math.max(...model.size) : 20;
      let reach = 0;
      if (model && !(model instanceof Error)) {
        const cp = draft.childPoint, cn = draft.childNormal;
        for (let k = 0; k < 8; k++) {
          const c = [k & 1 ? 1 : -1, k & 2 ? 1 : -1, k & 4 ? 1 : -1].map((sgn, i) => (sgn * model.size[i]) / 2);
          reach = Math.max(reach, (c[0] - cp[0]) * cn[0] + (c[1] - cp[1]) * cn[1] + (c[2] - cp[2]) * cn[2]);
        }
      }
      const was = p.joint;
      p.parent = draft.parentId;
      p.joint = {
        ...(was?.type ? { type: was.type, lower: was.lower, upper: was.upper } : {}),
        normal: draft.normal,
        distance: was?.distance || Math.max(10, Math.round(reach + Math.max(size * 0.6, 8))),
        point: draft.point,
        childPoint: draft.childPoint,
        childNormal: draft.childNormal,
        spin: was?.spin || 0,
        gap: was?.gap || 0,
      };
      keepInLimits(p.joint);
      applyJoint(p);
      shownJoint = p.id;
      showJoint(p.id);
      follow();
      renderList();
      renderProps();
      syncExplode();
    }

    /** The field rows in the dialog (its own, so the side panel's keep working). */
    const jf = (key: string, label: string, unit: string, value: number, step: number, title: string) => `
      <label class="lyr-scene-field" title="${esc(title)}">
        <span>${esc(label)}</span>
        <input class="lyr-num" type="number" step="${step}" data-joint-field="${key}" value="${value}">
        <em>${esc(unit)}</em>
      </label>`;

    function renderJointDialog(): void {
      if (!draft) {
        jointDialog.hidden = true;
        return;
      }
      const p = partById(draft.childId);
      if (!p) return closeJointDialog();
      const j = p.joint;
      const ready = !!(draft.parentId && draft.point && draft.childPoint);
      const type: JointType = (ready && j?.type) || "fixed";
      const turns = type === "revolute";
      const slides = type === "prismatic";
      const others = scene.parts.filter(x => x.id !== draft!.childId && !branch(draft!.childId).has(x.id));
      const half = (which: "child" | "parent") => {
        const picked = which === "child" ? draft!.childPoint : draft!.point;
        const picking = joining?.half === which;
        return `
          <div class="lyr-joint-half">
            <select data-joint-part="${which}" aria-label="${which === "child" ? "This part" : "The part it joins"}">
              ${which === "child"
                ? `<option value="${esc(p.id)}">${esc(p.name)}</option>`
                : `<option value=""${draft!.parentId ? "" : " selected"}>Choose a part…</option>${others.map(o => `<option value="${esc(o.id)}"${o.id === draft!.parentId ? " selected" : ""}>${esc(o.name)}</option>`).join("")}`}
            </select>
            <div class="lyr-joint-face">
              <button type="button" class="lyr-wide-btn${picking ? " lyr-on" : ""}" data-pick-half="${which}" title="Click a face, corner, edge, hole or rim in the view">
                ${icon(picked ? "check" : "plus", 14)} ${picking ? "Click the face in the view…" : picked ? `Face at ${esc(mm(picked))}` : "Pick a face…"}
              </button>
              ${picked ? `<button type="button" class="lyr-btn lyr-icon-btn" data-clear-half="${which}" title="Forget this face" aria-label="Forget this face">${icon("close", 14)}</button>` : ""}
            </div>
          </div>`;
      };
      jointDialog.innerHTML = `
        <div class="lyr-joint-head">
          ${icon("link", 16)}<strong title="Drag here to move the dialog">${j?.point ? "Edit joint" : "New joint"}</strong>
          <span class="lyr-grow"></span>
          <button type="button" class="lyr-btn lyr-icon-btn" data-act="joint-cancel" title="Close without keeping the changes" aria-label="Close">${icon("close", 16)}</button>
        </div>
        <div class="lyr-joint-body">
          <div class="lyr-panel-title">This part</div>
          ${half("child")}
          <div class="lyr-panel-title">Fits against</div>
          ${half("parent")}
          ${ready ? `
            <div class="lyr-panel-title">How it moves</div>
            <div class="lyr-scene-jtypes" role="radiogroup" aria-label="How it moves">
              ${JOINT_TYPES.map(t => `<button type="button" class="lyr-scene-preset${t.id === type ? " lyr-on" : ""}" role="radio" aria-checked="${t.id === type}" data-jtype="${t.id}" title="${esc(t.detail)}">${esc(t.label)}</button>`).join("")}
            </div>
            ${turns || slides ? `<div class="lyr-scene-fields">
              ${jf("lower", "From", turns ? "°" : "mm", j?.lower ?? 0, turns ? 1 : 0.5, turns ? "How far it can turn one way" : "The nearest it slides in")}
              ${jf("upper", "To", turns ? "°" : "mm", j?.upper ?? 0, turns ? 1 : 0.5, turns ? "How far it can turn the other way" : "The furthest it slides out")}
            </div>` : ""}
            <div class="lyr-panel-title">Line-up</div>
            <div class="lyr-scene-fields">
              ${jf("spin", turns ? "Angle" : "Spin", "°", j?.spin || 0, 1, "Turn it about the joint, keeping the faces together")}
              ${jf("gap", slides ? "Slide" : "Gap", "mm", j?.gap || 0, 0.1, "How far it stands off the face")}
              ${jf("distance", "Explode", "mm", j?.distance || 0, 1, "How far it slides out in the exploded view")}
            </div>
            <div class="lyr-scene-quick">
              <button type="button" class="lyr-btn" data-act="joint-flip" title="Turn the part over, so it sits on the other side of the face">${icon("flipV", 16)}<span>Flip</span></button>
              <button type="button" class="lyr-btn" data-act="joint-unjoin" title="Stand on its own again, where it is now">Remove joint</button>
            </div>`
          : `<p class="lyr-note">Pick a face on each part. They meet face to face, and you can then set how the joint moves.</p>`}
        </div>
        <div class="lyr-joint-foot">
          <button type="button" class="lyr-btn" data-act="joint-cancel">Cancel</button>
          <button type="button" class="lyr-btn lyr-done" data-act="joint-ok"${ready ? "" : " disabled"}>${icon("check", 16)}<span>OK</span></button>
        </div>`;
      jointDialog.hidden = false;
    }

    /**
     * Puts the part back where it stood when the dialog opened (as Cancel
     * would) and clears the old joint's marks, so it doesn't hide the face
     * about to be picked.
     */
    function putBack(): void {
      if (!draft) return;
      const id = draft.childId;
      const p = partById(id);
      const was = (JSON.parse(draft.before) as SceneData).parts.find(x => x.id === id);
      if (!p || !was) return;
      p.position = [...was.position];
      p.rotation = [...was.rotation];
      if (was.parent && was.joint && partById(was.parent)) {
        p.parent = was.parent;
        p.joint = structuredClone(was.joint);
      } else {
        delete p.parent;
        delete p.joint;
      }
      shownJoint = "";
      jointFaces = [];
      follow();
      renderList();
      renderProps();
      placeSnaps();
    }

    // The dialog moves by its title bar, so it needn't cover the parts.
    jointDialog.addEventListener("pointerdown", e => {
      const head = (e.target as HTMLElement).closest<HTMLElement>(".lyr-joint-head");
      if (!head || (e.target as HTMLElement).closest("button") || e.button !== 0) return;
      e.preventDefault();
      const box = jointDialog.getBoundingClientRect();
      const area = stage.getBoundingClientRect();
      const dx = e.clientX - box.left, dy = e.clientY - box.top;
      head.setPointerCapture(e.pointerId);
      head.classList.add("lyr-dragging");
      const move = (m: PointerEvent) => {
        const x = Math.max(0, Math.min(m.clientX - dx - area.left, area.width - box.width));
        const y = Math.max(0, Math.min(m.clientY - dy - area.top, area.height - 40));
        jointDialog.style.left = `${Math.round(x)}px`;
        jointDialog.style.top = `${Math.round(y)}px`;
        jointDialog.style.right = "auto";
        jointDialog.style.bottom = "auto";
      };
      const up = () => {
        head.classList.remove("lyr-dragging");
        head.removeEventListener("pointermove", move);
        head.removeEventListener("pointerup", up);
        head.removeEventListener("pointercancel", up);
      };
      head.addEventListener("pointermove", move);
      head.addEventListener("pointerup", up);
      head.addEventListener("pointercancel", up);
    });

    jointDialog.addEventListener("change", e => {
      const t = e.target as HTMLSelectElement;
      if (!draft || !t.dataset.jointPart) return;
      if (t.dataset.jointPart === "parent") {
        draft.parentId = t.value;
        delete draft.point;
        delete draft.normal;
        // Pick the face next: on that part, or on any part when none is chosen.
        putBack();
        pickHalf("parent");
      }
    });
    jointDialog.addEventListener("input", e => {
      const t = e.target as HTMLInputElement;
      const p = draft && partById(draft.childId);
      if (!t.dataset.jointField || !p?.joint) return;
      setField(t.dataset.jointField, Number(t.value));
      syncJointFields();
    });
    function syncJointFields(): void {
      const p = draft && partById(draft.childId);
      if (!p) return;
      jointDialog.querySelectorAll<HTMLInputElement>("[data-joint-field]").forEach(inp => {
        if (document.activeElement !== inp) inp.value = String(fieldValue(inp.dataset.jointField!, p));
      });
    }
    jointDialog.addEventListener("click", e => {
      const b = (e.target as HTMLElement).closest("button");
      if (!b || !draft) return;
      const p = partById(draft.childId);
      const d = b.dataset;
      if (d.pickHalf) pickHalf(d.pickHalf as "child" | "parent");
      else if (d.clearHalf === "child") {
        // Forgetting a face goes straight on to picking another.
        delete draft.childPoint;
        delete draft.childNormal;
        putBack();
        pickHalf("child");
      } else if (d.clearHalf === "parent") {
        delete draft.point;
        delete draft.normal;
        putBack();
        pickHalf("parent");
      } else if (d.jtype && p) {
        setJointType(p, d.jtype as JointType);
        renderJointDialog();
      } else if (d.act === "joint-flip" && p?.joint?.childNormal) {
        // Turn the part over, so it sits on the other side of the face. A
        // half turn about the joint is the Angle instead, which a turning
        // joint keeps within its limits.
        const n = p.joint.childNormal.map(v => round(-v, 4)) as Vec3;
        p.joint.childNormal = n;
        draft.childNormal = n;
        applyJoint(p);
        follow();
        showJoint(p.id);
        renderProps();
        renderJointDialog();
      } else if (d.act === "joint-unjoin" && p) {
        unjoin(p);
        closeJointDialog();
      } else if (d.act === "joint-ok") {
        const name = p?.name || "The part";
        const to = partById(draft.parentId)?.name || "";
        closeJointDialog();
        commit();
        status(to ? `“${name}” is joined to “${to}”.` : "");
      } else if (d.act === "joint-cancel") {
        const before = draft.before;
        closeJointDialog();
        restore(before);
        syncHistory();
        status("");
      }
    });

    function jointSection(p: ScenePart, parent: ScenePart | undefined): string {
      const others = scene.parts.length > 1;
      if (!parent) {
        return others
          ? `<div class="lyr-scene-join"><button type="button" class="lyr-wide-btn" data-act="join" title="Pick a face on this part, then the face on another part it fits against">${icon("layers", 16)} Join to another part…</button></div>`
          : "";
      }
      const picked = !!p.joint?.point;
      const type: JointType = (picked && p.joint?.type) || "fixed";
      const turns = type === "revolute";
      const slides = type === "prismatic";
      return `<div class="lyr-scene-join">
        <p class="lyr-note">Joined to <strong>${esc(parent.name)}</strong>. Its place is from that part, and it moves with it.</p>
        ${picked ? `<div class="lyr-scene-sub">Joint</div>
        <div class="lyr-scene-jtypes" role="radiogroup" aria-label="How it moves">
          ${JOINT_TYPES.map(t => `<button type="button" class="lyr-scene-preset${t.id === type ? " lyr-on" : ""}" role="radio" aria-checked="${t.id === type}" data-jtype="${t.id}" title="${esc(t.detail)}">${esc(t.label)}</button>`).join("")}
        </div>
        ${turns || slides ? `<div class="lyr-scene-fields">
          ${field("lower", "From", turns ? "°" : "mm", p.joint?.lower ?? 0, turns ? 1 : 0.5, turns ? "How far it can turn one way" : "The nearest it slides in")}
          ${field("upper", "To", turns ? "°" : "mm", p.joint?.upper ?? 0, turns ? 1 : 0.5, turns ? "How far it can turn the other way" : "The furthest it slides out")}
        </div>` : ""}
        <div class="lyr-scene-fields">
          ${field("spin", turns ? "Angle" : "Spin", "°", p.joint?.spin || 0, 1, turns ? "Where it's turned to in this picture, between From and To" : "Turn it about the joint, keeping the faces together")}
          ${field("gap", slides ? "Slide" : "Gap", "mm", p.joint?.gap || 0, 0.1, slides ? "How far it's slid out in this picture, between From and To" : "How far it stands off the face")}
          ${field("distance", "Explode", "mm", p.joint?.distance || 0, 1, "How far it slides out in the exploded view")}
        </div>` : `<div class="lyr-scene-fields">${field("distance", "Explode", "mm", p.joint?.distance || 0, 1, "How far it slides out in the exploded view")}</div>`}
        <div class="lyr-scene-quick">
          <button type="button" class="lyr-btn" data-act="join" title="Pick the two faces again">Re-join</button>
          <button type="button" class="lyr-btn" data-act="unjoin" title="Stand on its own again, where it is now">Unjoin</button>
        </div>
      </div>`;
    }

    const explodeInput = $<HTMLInputElement>("[data-explode]");
    function syncExplode(): void {
      const any = scene.parts.some(p => p.parent && p.joint);
      explodeInput.disabled = !any;
      explodeInput.value = explodeNum.value = String(Math.round(scene.explode * 100));
      explodeNum.disabled = !any;
      explodeInput.closest("label")!.title = any ? "Slide joined parts apart along their joints, to show how they fit" : "Join parts first: then this slides them apart";
    }
    const explodeNum = $<HTMLInputElement>("[data-explode-num]");
    explodeInput.addEventListener("input", () => {
      scene.explode = Math.max(0, Math.min(1, Number(explodeInput.value) / 100));
      explodeNum.value = explodeInput.value;
      follow();
      syncJointExplode();
    });
    explodeInput.addEventListener("change", () => commit());
    explodeNum.addEventListener("input", () => {
      const v = Number(explodeNum.value);
      if (explodeNum.value === "" || !Number.isFinite(v)) return;
      scene.explode = Math.max(0, Math.min(100, Math.round(v))) / 100;
      explodeInput.value = String(Math.round(scene.explode * 100));
      follow();
      syncJointExplode();
    });
    explodeNum.addEventListener("change", () => {
      explodeNum.value = String(Math.round(scene.explode * 100));
      commit();
    });
    /** An open joint explode row that follows the main slider shows its value. */
    function syncJointExplode(): void {
      const rowEl = list.querySelector<HTMLElement>("[data-explode-for]");
      const p = rowEl ? partById(rowEl.dataset.explodeFor || "") : undefined;
      if (!p || !rowEl || p.explode !== undefined) return;
      rowEl.querySelectorAll<HTMLInputElement>("input").forEach(i => (i.value = String(Math.round(scene.explode * 100))));
    }

    function renderProps(): void {
      const p = partById(selectedId);
      const parent = p?.parent ? partById(p.parent) : undefined;
      props.innerHTML = `
        <section class="lyr-scene-section">
          <div class="lyr-panel-title">Part</div>
          ${p ? `
            <label class="lyr-scene-namebox">Name <input type="text" maxlength="120" data-name value="${esc(p.name)}"></label>
            ${jointSection(p, parent)}
            <div class="lyr-scene-sub">Position</div>
            <div class="lyr-scene-fields">
              ${field("x", "X", "mm", p.position[0], 0.1, "Left and right")}
              ${field("y", "Y", "mm", p.position[1], 0.1, "Back and forth")}
              ${field("z", "Z", "mm", p.position[2], 0.1, "Up and down")}
            </div>
            <div class="lyr-scene-sub">Turn</div>
            <div class="lyr-scene-fields">
              ${field("roll", "Roll", "°", p.rotation[0], 0.5, "Turn about X")}
              ${field("pitch", "Pitch", "°", p.rotation[1], 0.5, "Turn about Y")}
              ${field("yaw", "Yaw", "°", p.rotation[2], 0.5, "Turn about Z (up)")}
            </div>
            <div class="lyr-scene-quick">
              <span class="lyr-label">Turn 90°</span>
              <button type="button" class="lyr-btn" data-turn="0" title="A quarter turn about X">X</button>
              <button type="button" class="lyr-btn" data-turn="1" title="A quarter turn about Y">Y</button>
              <button type="button" class="lyr-btn" data-turn="2" title="A quarter turn about Z">Z</button>
              <button type="button" class="lyr-btn" data-act="reset-turn" title="Turn it back to how its file has it">Reset</button>
            </div>
            <label class="lyr-scene-check" title="Draw it faint, for a part fitted in an earlier step"><input type="checkbox" data-ghost${p.ghost ? " checked" : ""}> Ghost (fitted earlier)</label>
            <p class="lyr-note">Arrow keys in a box: ±1 step, Shift ×10, Alt ×0.1. Or drag a label sideways.</p>`
          : `<p class="lyr-note">${scene.parts.length ? "Click a part, in the view or the list, to place it." : "Add a part to start."}</p>`}
        </section>
        <section class="lyr-scene-section">
          <div class="lyr-panel-title">Style</div>
          <div class="lyr-scene-presets">
            ${STYLE_PRESETS.map(s => `<button type="button" class="lyr-scene-preset" data-preset="${s.id}" title="${esc(s.detail)}">${esc(s.label)}</button>`).join("")}
          </div>
          <div class="lyr-scene-colours">
            ${colourInput("fill", "Parts")}
            ${colourInput("line", "Lines")}
            ${colourInput("highlight", "Highlight")}
            ${colourInput("ghost", "Ghost lines")}
          </div>
          <div class="lyr-scene-fields">
            ${field("lineWidth", "Lines", "px", scene.style.lineWidth, 0.5, "Fine fold lines")}
            ${field("outline", "Outline", "px", scene.style.outline, 0.5, "The bold line round each part")}
            ${field("crease", "Folds", "°", scene.style.crease, 1, "How sharp a fold must be to get a line (180: none)")}
          </div>
          <label class="lyr-scene-check" title="In an exploded view, a dashed line from each part back to where it fits"><input type="checkbox" data-draft${scene.style.draft === false ? "" : " checked"}> Draft lines when exploded</label>
          <p class="lyr-note">The background is the page's colour: change it in Layers.</p>
        </section>`;
      syncPresets();
    }

    props.addEventListener("input", e => {
      const t = e.target as HTMLInputElement;
      if (t.dataset.field) setField(t.dataset.field, Number(t.value));
      else if (t.dataset.draft !== undefined) {
        if (t.checked) delete scene.style.draft;
        else scene.style.draft = false;
        rebuild();
        commit();
      } else if (t.dataset.ghost !== undefined) {
        const p = partById(selectedId);
        if (!p) return;
        if (t.checked) p.ghost = true;
        else delete p.ghost;
        rebuild();
        commit();
      } else if (t.dataset.colour) {
        (scene.style as unknown as Record<string, string>)[t.dataset.colour] = t.value;
        if (t.dataset.colour !== "highlight") scene.style.preset = "custom";
        rebuild();
        syncPresets();
      } else if (t.dataset.name !== undefined) {
        const p = partById(selectedId);
        if (p) {
          p.name = t.value.slice(0, 120) || "Part";
          renderList();
        }
      }
    });
    props.addEventListener("change", e => {
      const t = e.target as HTMLInputElement;
      if (t.dataset.field) t.value = String(fieldValue(t.dataset.field, partById(selectedId)));
      commit();
    });
    props.addEventListener("keydown", e => {
      const t = e.target as HTMLInputElement;
      if (!t.dataset.field || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
      e.preventDefault();
      const step = Number(t.step) || 1;
      const by = step * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1) * (e.key === "ArrowUp" ? 1 : -1);
      setField(t.dataset.field, fieldValue(t.dataset.field, partById(selectedId)) + by);
      t.value = String(fieldValue(t.dataset.field, partById(selectedId)));
    });
    props.addEventListener("keyup", e => {
      if (e.key === "ArrowUp" || e.key === "ArrowDown") commit();
    });
    props.addEventListener("click", e => {
      const b = (e.target as HTMLElement).closest("button");
      if (!b) return;
      if (b.dataset.preset) {
        scene.style = applyPreset(scene.style, b.dataset.preset);
        rebuild();
        commit();
        renderProps();
      } else if (b.dataset.turn) {
        const p = partById(selectedId);
        if (!p) return;
        const axis = new Vector3(...([[1, 0, 0], [0, 1, 0], [0, 0, 1]][Number(b.dataset.turn)] as Vec3));
        const q = new Quaternion().setFromEuler(new Euler(p.rotation[0] * DEG, p.rotation[1] * DEG, p.rotation[2] * DEG, "ZYX"));
        q.premultiply(new Quaternion().setFromAxisAngle(axis, 90 * DEG));
        const eul = new Euler().setFromQuaternion(q, "ZYX");
        p.rotation = [round(wrapAngle(eul.x / DEG)), round(wrapAngle(eul.y / DEG)), round(wrapAngle(eul.z / DEG))];
        follow();
        syncFields();
        commit();
      } else if (b.dataset.jtype) {
        const p = partById(selectedId);
        if (p) setJointType(p, b.dataset.jtype as JointType);
      } else if (b.dataset.act === "join") {
        if (selectedId) openJointDialog(selectedId);
      } else if (b.dataset.act === "unjoin") {
        const p = partById(selectedId);
        if (p) unjoin(p);
      } else if (b.dataset.act === "reset-turn") {
        const p = partById(selectedId);
        if (!p) return;
        p.rotation = [0, 0, 0];
        follow();
        syncFields();
        commit();
      }
    });
    // Drag a field's label sideways to change it.
    props.addEventListener("pointerdown", e => {
      const label = (e.target as HTMLElement).closest<HTMLElement>("[data-scrub]");
      if (!label) return;
      e.preventDefault();
      const key = label.dataset.scrub!;
      const step = Number(label.dataset.step) || 1;
      const from = fieldValue(key, partById(selectedId));
      const x0 = e.clientX;
      label.setPointerCapture(e.pointerId);
      const inp = label.parentElement!.querySelector("input") as HTMLInputElement;
      const onMove = (m: PointerEvent) => {
        const k = m.shiftKey ? 10 : m.altKey ? 0.1 : 1;
        setField(key, from + Math.round((m.clientX - x0) / 3) * step * k);
        inp.value = String(fieldValue(key, partById(selectedId)));
      };
      const onUp = () => {
        label.removeEventListener("pointermove", onMove);
        label.removeEventListener("pointerup", onUp);
        label.removeEventListener("pointercancel", onUp);
        commit();
      };
      label.addEventListener("pointermove", onMove);
      label.addEventListener("pointerup", onUp);
      label.addEventListener("pointercancel", onUp);
    });

    // ------------------------------------------------------------ adding parts

    async function openMenu(): Promise<void> {
      menu.hidden = false;
      menu.innerHTML = `
        <button type="button" class="lyr-scene-menu-item" role="menuitem" data-act="upload">${icon("upload", 16)}<span>Upload an STL or STEP file…</span></button>
        ${opts.listModels ? `<div class="lyr-panel-title">Your project's models</div><div class="lyr-scene-models"><span class="lyr-note">Loading…</span></div>` : ""}`;
      if (!opts.listModels) return;
      try {
        const found = (await opts.listModels()).filter(m => /\.(stl|step|stp)(\?|#|$)/i.test(m.url) || /\.(stl|step|stp)$/i.test(m.title || ""));
        const box = menu.querySelector(".lyr-scene-models");
        if (!box || menu.hidden) return;
        box.classList.toggle("lyr-scene-tiles", found.length > 0);
        box.innerHTML = found.length
          ? found.map((m, i) => {
              const name = esc(m.title || partName(m.url));
              return `<button type="button" class="lyr-scene-tile" role="menuitem" data-model="${i}" title="${name}"><span class="lyr-scene-thumb">${icon("cube", 24)}</span><span class="lyr-scene-tile-name">${name}</span></button>`;
            }).join("")
          : `<span class="lyr-note">No STL or STEP files in this project yet.</span>`;
        box.querySelectorAll<HTMLElement>("[data-model]").forEach(b => {
          const m = found[Number(b.dataset.model)];
          b.addEventListener("click", () => {
            closeMenu();
            void addModel({ url: m.url, name: partName(m.title || m.url), file: m.title || decodeURIComponent(m.url.split(/[?#]/)[0].split("/").pop() || "") });
          });
          showThumb(b.querySelector<HTMLElement>(".lyr-scene-thumb")!, m);
        });
      } catch {
        const box = menu.querySelector(".lyr-scene-models");
        if (box) box.innerHTML = `<span class="lyr-note">Your models couldn't be loaded.</span>`;
      }
    }
    function closeMenu(): void {
      menu.hidden = true;
      menu.innerHTML = "";
      thumbWatch?.disconnect();
      thumbWatch = null;
    }

    // Thumbnails: the host's picture if it has one, else the model drawn
    // here, one at a time and only once its tile scrolls into view. Kept
    // for the menu's next opening; a model read here is kept by the store,
    // so adding it afterwards is quick.
    const thumbs = new Map<string, Promise<string | null>>();
    let thumbnailer: Thumbnailer | null = null;
    let thumbQueue: Promise<unknown> = Promise.resolve();
    let thumbWatch: IntersectionObserver | null = null;
    const blobUrls: string[] = [];
    const THUMB_PX = 112;

    function hostThumb(m: SceneModel): Promise<string | null> {
      const t = m.thumbnail;
      if (!t) return Promise.resolve(null);
      return (async () => {
        const v = typeof t === "string" ? t : await t();
        if (!v) return null;
        const src = typeof v === "string" ? v : URL.createObjectURL(v);
        if (typeof v !== "string") blobUrls.push(src);
        // Only a picture that actually loads counts.
        await new Promise<void>((ok, fail) => {
          const img = new Image();
          img.onload = () => (img.naturalWidth ? ok() : fail(new Error("empty")));
          img.onerror = () => fail(new Error("no picture"));
          img.src = src;
        });
        return src;
      })().catch(() => null);
    }

    function drawnThumb(m: SceneModel): Promise<string | null> {
      // A STEP file is drawn only once it is added: reading one sets up OpenCascade, too much for a menu.
      if (isStepFile(m.url) || isStepFile(m.title || "")) return Promise.resolve(null);
      const job = thumbQueue.then(async () => {
        const model = await opts.store.get({ id: "", url: m.url });
        if (closed) return null;
        thumbnailer ??= new Thumbnailer();
        return thumbnailer.draw(model, scene.style, VIEWS[0].direction, THUMB_PX * 2);
      });
      thumbQueue = job.catch(() => null);
      return job.catch(() => null);
    }

    function thumbOf(m: SceneModel): Promise<string | null> {
      let t = thumbs.get(m.url);
      if (!t) {
        t = hostThumb(m).then(src => src ?? drawnThumb(m));
        thumbs.set(m.url, t);
      }
      return t;
    }

    function showThumb(slot: HTMLElement, m: SceneModel): void {
      const fill = (src: string | null) => {
        if (src && slot.isConnected) slot.innerHTML = `<img src="${esc(src)}" alt="" draggable="false">`;
      };
      if (thumbs.has(m.url)) {
        void thumbs.get(m.url)!.then(fill);
        return;
      }
      slot.classList.add("lyr-loading");
      if (!thumbWatch) {
        thumbWatch = new IntersectionObserver(entries => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            thumbWatch?.unobserve(e.target);
            const go = (e.target as HTMLElement & { lyrThumb?: () => void }).lyrThumb;
            go?.();
          }
        }, { root: menu, rootMargin: "120px" });
      }
      (slot as HTMLElement & { lyrThumb?: () => void }).lyrThumb = () =>
        void thumbOf(m).then(src => {
          slot.classList.remove("lyr-loading");
          fill(src);
        });
      thumbWatch.observe(slot);
    }

    fileInput.addEventListener("change", () => {
      const files = [...(fileInput.files || [])];
      fileInput.value = "";
      void addFiles(files);
    });

    let dragDepth = 0;
    const dropHint = $(".lyr-drop");
    const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types || [])].includes("Files");
    stage.addEventListener("dragenter", e => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth++;
      dropHint.hidden = false;
    });
    stage.addEventListener("dragover", e => {
      if (hasFiles(e)) e.preventDefault();
    });
    stage.addEventListener("dragleave", () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) dropHint.hidden = true;
    });
    stage.addEventListener("drop", e => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      dropHint.hidden = true;
      void addFiles([...(e.dataTransfer?.files || [])]);
    });

    // ------------------------------------------------------------ named views

    // A camera saved under a name, so other pictures can use the same view.
    // With the host's project model they're the project's (saved with it on
    // Done, without making pictures out of date); otherwise the scene's own.
    let views: NamedView[] = structuredClone(shared ? opts.model?.views || [] : scene.views || []);
    const startViews = JSON.stringify(views);
    const viewsMenu = $(".lyr-scene-views-menu");
    const sameCamera = (a: NamedView["camera"], b: NamedView["camera"]) =>
      a.direction.every((x, i) => Math.abs(x - b.direction[i]) < 1e-6) && a.target.every((x, i) => Math.abs(x - b.target[i]) < 1e-3) && Math.abs(a.size - b.size) < 1e-3;
    function storeViews(): void {
      if (!shared) {
        if (views.length) scene.views = structuredClone(views);
        else delete scene.views;
        commit();
      }
    }
    function openViews(): void {
      viewsMenu.innerHTML = `
        <div class="lyr-panel-title">Named views</div>
        ${views.length
          ? views.map(v => `<div class="lyr-scene-view-row${sameCamera(v.camera, scene.camera) ? " lyr-on" : ""}">
              <button type="button" class="lyr-scene-menu-item" role="menuitem" data-named-view="${esc(v.id)}" title="Look from this view"><span>${esc(v.name)}</span></button>
              <button type="button" class="lyr-btn lyr-icon-btn" data-update-view="${esc(v.id)}" title="Save the camera as it is now under this name" aria-label="Update ${esc(v.name)}">${icon("pencil", 16)}</button>
              <button type="button" class="lyr-btn lyr-icon-btn" data-delete-view="${esc(v.id)}" title="Delete this view" aria-label="Delete ${esc(v.name)}">${icon("trash", 16)}</button>
            </div>`).join("")
          : `<p class="lyr-note">None yet. Set up the camera, then save it here: every picture ${shared ? "in this project " : ""}can use it, so they match.</p>`}
        <form class="lyr-scene-view-save">
          <input type="text" maxlength="60" placeholder="Name this view, e.g. Front left" aria-label="View name" data-view-name>
          <button type="submit" class="lyr-btn lyr-primary-btn">Save view</button>
        </form>`;
      viewsMenu.hidden = false;
      viewsMenu.querySelector<HTMLInputElement>("[data-view-name]")!.focus();
    }
    viewsMenu.addEventListener("submit", e => {
      e.preventDefault();
      const input = viewsMenu.querySelector<HTMLInputElement>("[data-view-name]")!;
      const name = input.value.trim().slice(0, 60);
      if (!name) return input.focus();
      const same = views.find(v => v.name.toLowerCase() === name.toLowerCase());
      if (same) same.camera = structuredClone(scene.camera);
      else {
        let n = views.length + 1;
        while (views.some(v => v.id === `v${n}`)) n++;
        views.push({ id: `v${n}`, name, camera: structuredClone(scene.camera) });
      }
      views = normalizeViews(views);
      storeViews();
      openViews();
      status(`${same ? "Updated" : "Saved"} the view “${name}”.${shared ? " It's kept with the project's model when you click Done." : ""}`);
    });
    viewsMenu.addEventListener("click", e => {
      const b = (e.target as HTMLElement).closest("button");
      if (!b) return;
      const d = b.dataset;
      const v = views.find(x => x.id === (d.namedView || d.updateView || d.deleteView));
      if (!v) return;
      if (d.namedView) {
        glideTo(structuredClone(v.camera), commit);
        viewsMenu.hidden = true;
        status(`Looking from “${v.name}”.`);
      } else if (d.updateView) {
        v.camera = structuredClone(scene.camera);
        storeViews();
        openViews();
        status(`Updated the view “${v.name}”.`);
      } else if (d.deleteView) {
        views = views.filter(x => x !== v);
        storeViews();
        openViews();
        status(`Deleted the view “${v.name}”.`);
      }
    });
    viewsMenu.addEventListener("keydown", e => {
      if (e.key === "Escape") {
        e.stopPropagation();
        viewsMenu.hidden = true;
      }
    });

    // ------------------------------------------------------------ actions

    root.addEventListener("click", e => {
      const b = (e.target as HTMLElement).closest("button");
      if (!menu.hidden && !menu.contains(e.target as Node) && b?.dataset.act !== "add") closeMenu();
      if (!viewsMenu.hidden && !viewsMenu.contains(e.target as Node) && b?.dataset.act !== "views") viewsMenu.hidden = true;
      if (!b) return;
      if (b.dataset.tool) {
        tool = b.dataset.tool as typeof tool;
        attachGizmo();
        draw();
      } else if (b.dataset.view) setView(b.dataset.view);
      switch (b.dataset.act) {
        case "add": if (menu.hidden) void openMenu(); else closeMenu(); break;
        case "upload": closeMenu(); fileInput.click(); break;
        case "fit": fitView(true); break;
        case "views": if (viewsMenu.hidden) openViews(); else viewsMenu.hidden = true; break;
        case "urdf": exportUrdf(); break;
        case "undo": undo(); break;
        case "redo": redo(); break;
        case "cancel": cancel(); break;
        case "done": void finish(); break;
      }
    });

    const isTyping = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !["color", "checkbox", "button", "range"].includes((el as HTMLInputElement).type)));
    };
    const onKey = (e: KeyboardEvent) => {
      // Keys pressed here are the workspace's, not the editor's or the page's.
      e.stopPropagation();
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (joining && (e.key === "Meta" || e.key === "Control")) setFaceHeld(holdKey(e) && !!hover);
      if (e.key === "Shift") {
        gizmo.setTranslationSnap(5);
        gizmo.setRotationSnap(15 * DEG);
      }
      if (mod && (key === "s" || key === "enter")) {
        e.preventDefault();
        void finish();
        return;
      }
      if (isTyping(e.target)) {
        if (e.key === "Escape") (e.target as HTMLElement).blur();
        return;
      }
      if (mod && key === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && key === "y") {
        e.preventDefault();
        redo();
      } else if (mod && key === "d" && selectedId) {
        e.preventDefault();
        duplicatePart(selectedId);
      } else if (e.key === "Escape") {
        if (!ctx.hidden) closeCtx();
        else if (joining) stopJoin("Join stopped.");
        else if (!menu.hidden) closeMenu();
        else if (selectedId) select("");
        else cancel();
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        e.preventDefault();
        removePart(selectedId);
      } else if (!mod && key === "m") {
        tool = "translate";
        attachGizmo();
        draw();
      } else if (!mod && key === "r") {
        tool = "rotate";
        attachGizmo();
        draw();
      } else if (!mod && key === "f") {
        fitView();
        commit();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Meta" || e.key === "Control") setFaceHeld(false);
      if (e.key === "Shift") {
        gizmo.setTranslationSnap(null);
        gizmo.setRotationSnap(null);
      }
    };
    overlay.addEventListener("keydown", onKey);
    overlay.addEventListener("keyup", onKeyUp);

    function close(result: WorkspaceResult | null): void {
      if (closed) return;
      closed = true;
      cancelAnimationFrame(drawQueued);
      ro.disconnect();
      gizmo.detach();
      gizmo.dispose();
      orbit.dispose();
      art.dispose();
      viewCube.dispose();
      thumbWatch?.disconnect();
      thumbnailer?.dispose();
      blobUrls.forEach(u => URL.revokeObjectURL(u));
      overlay.remove();
      // The editor underneath may be full screen too.
      if (!document.querySelector(".lyr-overlay")) document.documentElement.classList.remove("lyr-open");
      resolve(result);
    }

    function cancel(): void {
      commit();
      if (JSON.stringify(scene) !== start && !window.confirm("Leave the 3D scene without keeping your changes?")) return;
      close(null);
    }

    async function finish(): Promise<void> {
      if (busy) return;
      busy = true;
      commit();
      const btn = $<HTMLButtonElement>("[data-act=done]");
      btn.disabled = true;
      status("Drawing the picture…", false, true);
      try {
        const out = clone(scene);
        const viewsChanged = shared && JSON.stringify(views) !== startViews;
        if (linked() && opts.saveModel && (scene.parts.length || projectModel) && (!projectModel || partsDiffer(projectModel.parts, scene.parts))) {
          // The parts or joints changed: a new version of the model, which
          // pictures drawn from the old one will say they're behind.
          status("Saving the project's model…", false, true);
          const stamp = Math.max(Date.now(), (opts.model?.stamp || 0) + 1);
          await opts.saveModel({ ...modelOf(out, stamp), ...(views.length ? { views } : {}) });
          out.model = { stamp };
        } else if (viewsChanged && opts.saveModel) {
          // Only the named views changed: the same version, so no picture is out of date.
          status("Saving the project's views…", false, true);
          const base = opts.model || modelOf(linked() ? out : { ...out, parts: [] }, 0);
          await opts.saveModel({ ...base, ...(views.length ? { views } : { views: [] }) });
        }
        status("Drawing the picture…", false, true);
        const picture = await renderPicture(out, opts.store, opts.width, opts.height, opts.scale);
        close({ scene: out, picture });
      } catch (e) {
        status(e instanceof Error && e.message ? `That didn't work: ${e.message}` : "The picture couldn't be drawn.", true, true);
        btn.disabled = false;
        busy = false;
      }
    }

    // ------------------------------------------------------------ start

    syncHistory();
    renderList();
    renderProps();
    syncExplode();
    layout();
    applyCamera();
    root.focus({ preventScroll: true });
    if (scene.parts.length) {
      status("Loading the models…", false, true);
      void loadModels().then(() => {
        if (closed) return;
        if ($(".lyr-status").textContent === "Loading the models…") status("");
        rebuild();
        applyCamera();
      });
    } else {
      void openMenu();
    }
  });
}

export type { FetchModel };
