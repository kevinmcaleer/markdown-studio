// The 3D scene workspace: opened from a scene layer, full screen, over the
// editor. Parts (STL models) are added from the host's models or by
// uploading or dropping them; each is placed with handles on the view or
// with exact numbers (X, Y, Z in mm; roll, pitch, yaw in degrees). The view
// is drawn in the scene's own style, the shape of the layer, on the page's
// colour, so what you see is the picture you get. Done draws the picture.
//
// This module and three.js load only when a scene is opened.

import { Box3 as Bounds, BufferAttribute, BufferGeometry, DoubleSide, Euler, Line, LineBasicMaterial, Matrix3, Matrix4, Mesh, MeshBasicMaterial, Object3D, OrthographicCamera, Plane, Quaternion, Raycaster, Vector2, Vector3 } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { icon } from "../icons";
import {
  applyPreset, DEFAULT_LIMITS, JOINT_TYPES, normalizeScene, newPartId, partName, placeBeside, STYLE_PRESETS, VIEWS, wrapAngle,
  followModel, modelOf, partsDiffer,
  normalizeViews,
  type ExplodeDir, type JointType, type NamedView, type PartJoint, type ProjectModel,
  type Box3 as PlainBox, type SceneCamera, type SceneData, type ScenePart, type SceneStyle, type Vec3,
  explodeOf,
  highlightedParts, ARROW_FROM, ARROW_TO, isWiring, lookOf, wiresInOrder } from "./model";
import { connectorFile, connectorMesh, connectorOf, CONNECTOR_FAMILIES, DEFAULT_CONNECTOR, plugLift } from "./connectors";
import { cableRadius, MIN_BEND, tightestBend, wireLength, wireRoute, wireTriangles } from "./wire";
import { solidGrid, type Solid, type SolidGrid } from "./wireAvoid";
import { followRoom, othersFor, routeOrder, routeWire, wireHitsParts, type LaidWire } from "./wireRouting";
import { mirrorPartner, mirrorPlane, mirrorPoint } from "./wireMirror";
import { guessedSockets, guessPins, fitsPicture } from "./pinGuess";
import { cableBetween, catalogSocketsFor, coloursFromDiagram, connectionsFor, diagramLabels, freePort, linkByName, missingWires, movedConnections, partsNotInScene, portById, portPlacements, routedCount, type DiagramEnd, type PortPlacement, type WiringPart, type WiringHost, type WiringInfo } from "./wiring2d";
import { BARE_PIN, BUNDLE_TWIST, cableColours, connectionsOf, coresOf, isBarePin, loomsOf, newSocketId, nextWireColour, WIRE_COLOURS, WIRE_DEFAULTS, WIRE_LIMITS, wireColourName, type PartSocket, type WireCore, type WireEnd, type WireSpec, type WireWaypoint } from "./wireSpec";
import { applyJoint } from "./joint";
import { EXPLODE_DIRS, explodeChooser, explodeDirLabel, explodeVector, type ExplodeChoice, type ExplodeShape } from "./explode";
import { partJoints } from "./jointList";
import { sitDelta } from "./sit";
import { renderStepsMovie } from "./stepsAnimation";
import { renderWiringAnimation } from "./wiringAnimation";
import { growsFromTo, seeThroughParts } from "./seeThrough";
import { emptyModel, frame, frameAll, frameTight, LineArt, modelFromPositions, Thumbnailer, ModelStore, placeCamera, radiusOf, renderPicture, worldMatrices, type FetchModel, type Model } from "./render";
import { MAX_EMBED, parseStl, stlFaces, toBinaryStl, tooBigToCarry } from "./stl";
import { isPacked, packMesh, packParts } from "./mesh";
import { isStepFile, mergeBodies, readStep, type StepBody } from "./step";
import { toUrdf, zip } from "./urdf";
import { createViewCube } from "./viewcube";
import { MAX_SNAP_TRIANGLES, nearestSnap, Topology, type Face, type Snap } from "./snaps";
import { createSectionTool } from "./sectionTool";
import { insideReach, layTrack, MAX_TRACK_PIECES, trackPitch, trackTriangles, type TrackSpec, type TrackWheel, type WorldCircle } from "./track";
import { hideTrackPieces, trackPieces } from "./trackSpec";
import { MAX_GUIDE_TOOLS, MAX_TOOL_LENGTH, fixingOwners, newStepId, readyToFit, stepIndex, stepOfParts, steppable, stepWarnings, suggestSteps, tidySteps, type BuildStep } from "./buildSteps";
import { isFastener } from "../stepFrame";
import { bestTool, DEFAULT_GUIDE_TOOLS, findTools, readTool, TOOL_CATALOGUE, TOOL_GROUPS, toolSvg } from "../tools";
import { fitDiameter, fitLength, holeDepth, isHoleSnap, matchingHoles, SCREW_HEADS, SCREW_LENGTHS, SCREW_SIZES, screwFile, screwLabel, screwLift, screwMesh, screwName, screwNoun, type ScrewHead, type ScrewSpec } from "./screw";

export interface SceneModel {
  url: string;
  title?: string;
  /**
   * A picture of the model for the Add a part menu: an image URL, or a
   * function giving one (or an image Blob). Without one, or if it fails,
   * the model is drawn here instead.
   */
  thumbnail?: string | (() => Promise<Blob | string | null | undefined>);
  /** Its file name, when the URL doesn't end in one ("uno-r3.stl"): says whether it's STL or STEP. */
  file?: string;
  /**
   * "parts": a catalog part in the project's parts list (its BOM), offered
   * under From the parts list rather than with the project's files.
   */
  group?: "parts";
  /** Its catalog part, so it links to the wiring diagram's part of that slug. */
  slug?: string;
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
  /** The project's 2D wiring diagram, which wires link to (see wiring2d.ts). */
  wiring?: WiringHost;
  /**
   * Just the project's model ("/Model"), not a picture: titled Model, Done
   * saves the model and draws no picture (the result's picture is empty).
   */
  modelOnly?: boolean;
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
    const modelOnly = shared && !!opts.modelOnly;
    const heading = modelOnly ? "Model" : "3D scene";
    const projectModel = opts.model?.parts.length ? opts.model : null;
    if (shared) {
      if (projectModel && (scene.model || !scene.parts.length)) scene = followModel(scene, projectModel);
      else if (!projectModel) scene.model = { stamp: opts.model?.stamp || 0 };
    }
    // A new step starts from the project's chosen view.
    if (shared && projectModel?.defaultView && !opts.scene.parts.length) {
      const v = projectModel.views?.find(x => x.id === projectModel.defaultView);
      if (v) scene.camera = structuredClone(v.camera);
    }
    const start = JSON.stringify(scene);
    const aspect = opts.width / opts.height;
    const models = new Map<string, Model | Error>();
    let selectedId = "";
    /** The part whose pins are being mapped: the rest are faded. */
    let pinFocus = "";
    let tool: "translate" | "rotate" = "translate";
    let busy = false;
    let closed = false;
    // Steps mode (see "steps" below): the build steps, the one shown, and what the scene showed before.
    type Showing = { hidden?: boolean; ghost?: boolean; highlight?: boolean; explode?: number };
    let steps: BuildStep[] = structuredClone(shared ? opts.model?.steps || [] : []);
    const startSteps = JSON.stringify(steps);
    /** The tools the assembly guide lists (Steps mode's Tools for the guide); none set, its default three. */
    let guideToolList: string[] | undefined = shared && opts.model?.guide?.tools ? [...opts.model.guide.tools] : undefined;
    const startTools = JSON.stringify(guideToolList ?? null);
    const stepsState = () => JSON.stringify([steps, guideToolList ?? null]);
    const stepsChanged = () => JSON.stringify(steps) !== startSteps || JSON.stringify(guideToolList ?? null) !== startTools;
    let stepsOn = false;
    let stepAt = 0;
    /** What the scene showed before Steps mode, put back when it ends. */
    let kept: { parts: Map<string, Showing>; explode: number; arrows?: boolean; historyAt: number } | null = null;
    let recording: { steps: string[][] } | null = null;
    let stepPlay: { frame: number; at: number; t0: number } | null = null;
    /** The steps movie being made (Save as movie): how far it's got, and whether it's been stopped. */
    let movie: { pct: number; stopped: boolean } | null = null;
    /** The wiring animation being made to watch here (Play the wiring animation): how far it's got, and whether it's been stopped. */
    let wiringMovie: { pct: number; stopped: boolean } | null = null;

    const overlay = document.createElement("div");
    overlay.className = "lyr-overlay lyr-scene-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", heading);
    overlay.innerHTML = `
      <div class="lyr lyr-scene" tabindex="-1">
        <div class="lyr-top">
          <strong class="lyr-scene-title">${icon("cube", 18)}<span>${heading}</span></strong>
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
            <div class="lyr-scene-modes" role="group" aria-label="Mode"${shared ? "" : " hidden"}>
              <button type="button" class="lyr-scene-mode lyr-on" data-mode="model" aria-pressed="true" title="Build the model: parts, joints and how they come apart">${icon("cube", 14)}<span>Model</span></button>
              <button type="button" class="lyr-scene-mode" data-mode="steps" aria-pressed="false" title="Put the model's parts in the order they go together, a step at a time, for the assembly guide">${icon("list", 14)}<span>Steps</span></button>
            </div>
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
            <p class="lyr-note">Add STL or STEP files, or drop them on the view. Click a part to place it.</p>
          </aside>
          <div class="lyr-scene-stage">
            <div class="lyr-scene-tools" role="toolbar" aria-label="View">
              <button type="button" class="lyr-btn" data-tool="translate" title="Move parts with the handles (M)">${icon("move", 16)}<span>Move</span></button>
              <button type="button" class="lyr-btn" data-tool="rotate" title="Turn parts with the handles (R)">${icon("rotate", 16)}<span>Turn</span></button>
              <button type="button" class="lyr-btn" data-act="screw" title="Screws: click a hole to put a screw in it (S)">${icon("screw", 16)}<span>Screw</span></button>
              <button type="button" class="lyr-btn" data-act="wire" title="Wires: click where a plug goes, then the faces it runs over, then the other plug (W)">${icon("wire", 16)}<span>Wire</span></button>
              <span class="lyr-sep"></span>
              ${VIEWS.map(v => `<button type="button" class="lyr-btn" data-view="${v.id}" title="Look from the ${esc(v.label.toLowerCase())}">${esc(v.label)}</button>`).join("")}
              <span class="lyr-sep"></span>
              <span class="lyr-scene-views">
                <button type="button" class="lyr-btn" data-act="views" aria-haspopup="menu" title="Named views: save this camera under a name, to give other pictures the same view">${icon("camera", 16)}<span>Views</span></button>
                <div class="lyr-scene-views-menu" role="menu" hidden></div>
              </span>
              <button type="button" class="lyr-btn" data-act="fit" title="Fit the parts in the picture (F)">${icon("frame", 16)}<span>Fit</span></button>
              <button type="button" class="lyr-btn" data-act="section" title="Section view: click a face, then drag its arrow to slide a cut through the parts">${icon("section", 16)}<span>Section</span></button>
              <span class="lyr-sep"></span>
              <label class="lyr-scene-explode" title="Slide joined parts apart along their joints, to show how they fit">${icon("expand", 16)}<span>Explode</span><input type="range" min="0" max="100" step="1" data-explode value="0" aria-label="Explode"><input type="number" class="lyr-scene-explode-num" min="0" max="100" step="1" data-explode-num value="0" aria-label="Explode, per cent"><span class="lyr-scene-explode-unit">%</span></label>
              <button type="button" class="lyr-btn lyr-icon-btn lyr-scene-smart" data-act="explode-smart" title="Smart explode: point each joint the way it comes off clear of the other parts (leaves the ways you picked by hand)" aria-label="Smart explode">${icon("wand", 16)}</button>
              <button type="button" class="lyr-btn lyr-scene-explode-follow" data-act="explode-follow" hidden>${icon("rotate", 16)}<span></span></button>
            </div>
            <div class="lyr-screw-bar" role="toolbar" aria-label="Screw" hidden></div>
            <div class="lyr-screw-bar lyr-wire-bar" role="toolbar" aria-label="Wire" hidden></div>
            <div class="lyr-screw-bar lyr-play-bar" role="toolbar" aria-label="Assemble the wires" hidden></div>
            <div class="lyr-scene-frame"><canvas class="lyr-scene-canvas"></canvas></div>
            <div class="lyr-steps-strip" role="region" aria-label="Steps" hidden></div>
            <div class="lyr-scene-help">Drag to look around, right-drag to pan, scroll to zoom. Hold Shift on a handle for 5 mm or 15° steps.</div>
            <div class="lyr-drop" hidden>Drop STL or STEP files to add them</div>
            <div class="lyr-wiring-player" role="dialog" aria-label="Wiring animation" hidden></div>
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
        art.arrows = !!scene.arrows;
        art.setSelected(shownJoint ? "" : selectedId);
        art.selectedArrow = shownJoint;
        art.draw(camera, viewW, viewH, Math.min(2, window.devicePixelRatio || 1));
        placeSnaps();
        placeWireHandles();
        placeDial();
        section.place();
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
      const barH = [...root.querySelectorAll<HTMLElement>(".lyr-screw-bar")].reduce((h, bar) => h + (bar.hidden ? 0 : bar.offsetHeight + 10), 0);
      const stripEl = root.querySelector<HTMLElement>(".lyr-steps-strip");
      const stripH = stripEl && !stripEl.hidden ? stripEl.offsetHeight + 10 : 0;
      const availH = Math.max(100, box.height - 96 - barH - stripH);
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
      const was = structuredClone(scene.camera);
      readCamera();
      // Zoomed or slid across by hand: the view stays put while exploding, till Fit.
      if (Math.abs(scene.camera.size - was.size) > 1e-3 || scene.camera.target.some((v, i) => Math.abs(v - was.target[i]) > 1e-3)) keepFitted = false;
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
      // A track's piece stays out of the picture (Show all, a branch's eye...), but while its track is being made.
      hideTrackPieces(scene.parts, trackDraft?.linkId);
      art.setSection(scene.section);
      art.look = pinFocus && partById(pinFocus) ? { ...lookOf(scene), focus: pinFocus } : lookOf(scene);
      syncSectionButton();
      art.setParts(loaded(), scene.style, scene.explode);
      attachGizmo();
      renderList();
      draw();
    }

    /** Moves the parts in the view to where the scene says. */
    function follow(): void {
      art.move(scene.parts, scene.explode);
      // Its handles too: a part just joined is held by its joint, one unjoined is free.
      attachGizmo();
      draw();
    }

    /** Smart explode's chooser for the scene as it stands (see explode.ts). */
    function chooser(): (id: string) => ExplodeChoice | null {
      const shapes = new Map<string, ExplodeShape>();
      for (const q of scene.parts) {
        const m = models.get(q.id);
        if (!m || m instanceof Error) continue;
        const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry;
        shapes.set(q.id, { size: m.size, triangles: g.getAttribute("position")?.array as ArrayLike<number> | undefined });
      }
      return explodeChooser(scene.parts, worldMatrices(scene.parts, 0, false), shapes);
    }

    /**
     * Works out which way a joint comes off clear of the other parts and
     * keeps it as Smart's choice. False when it can't (not joined, or the
     * models aren't loaded).
     */
    function smartOne(p: ScenePart, choose = chooser()): boolean {
      if (!p.joint) return false;
      const choice = choose(p.id);
      if (!choice) return false;
      if (choice.dir === "joint") delete p.joint.explodeDir;
      else p.joint.explodeDir = choice.dir;
      p.joint.explodeAuto = true;
      return true;
    }

    /** Smart explode for every joint whose way wasn't picked by hand. */
    function smartAll(): void {
      let changed = 0, looked = 0, kept = 0;
      const choose = chooser();
      for (const p of scene.parts) {
        if (!p.parent || !p.joint) continue;
        if (p.joint.explodeDir && !p.joint.explodeAuto) {
          kept++;
          continue;
        }
        const was = p.joint.explodeDir || "joint";
        if (!smartOne(p, choose)) continue;
        looked++;
        if ((p.joint.explodeDir || "joint") !== was) changed++;
      }
      if (!looked && !kept) return status("Join parts first: then Smart explode points each one the clear way.", true);
      follow();
      refit();
      commit();
      renderList();
      renderProps();
      if (draft) renderJointDialog();
      const hand = kept ? ` ${kept} you picked by hand ${kept === 1 ? "was" : "were"} left alone.` : "";
      status(changed ? `Smart explode turned ${changed} joint${changed === 1 ? "" : "s"} to come off clear of the other parts.${hand}` : `Every joint already comes off the clear way.${hand}`);
    }

    /** Which file each loaded model came from (ModelStore.key), by part id. */
    const modelKeys = new Map<string, string>();
    function keepModel(part: ScenePart, model: Model | Error): void {
      models.set(part.id, model);
      modelKeys.set(part.id, ModelStore.key(part));
    }

    async function loadModels(): Promise<void> {
      const missing: string[] = [];
      await Promise.all(scene.parts.map(async part => {
        // Kept only while the part still comes from the same file: a part
        // can take another's id (a scene switched to the project model).
        if (models.has(part.id) && modelKeys.get(part.id) === ModelStore.key(part)) return;
        try {
          keepModel(part, await opts.store.get(part));
        } catch (e) {
          keepModel(part, e instanceof Error ? e : new Error(String(e)));
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
        // A wire is drawn from its parts, not a link of the robot.
        return m && !(m instanceof Error) && !p.wire;
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
      const skipped = scene.parts.filter(p => !p.wire).length - parts.length;
      status(`Downloaded robot-urdf.zip: ${parts.length} part${parts.length === 1 ? "" : "s"}${skipped ? ` (${skipped} not loaded, left out)` : ""}. Unzip it and open robot.urdf in Snakie.`);
    }

    async function addModel(source: { url?: string; buffer?: ArrayBuffer; name: string; file?: string; wiringPart?: string }): Promise<void> {
      if (isStepFile(source.file || "") || isStepFile(source.url || "")) return addStep(source);
      status(`Adding ${source.name}…`, false, true);
      try {
        let model: Model;
        let data: string | undefined;
        if (source.buffer) {
          const pos = parseStl(source.buffer);
          const faces = stlFaces(source.buffer);
          // Uploads are carried inside the graphic, packed small (see mesh.ts).
          data = await packMesh(pos, faces);
          if (data.length > MAX_EMBED) throw new Error(tooBigToCarry(source.name, data.length));
          model = modelFromPositions(pos, faces);
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
        keepModel(part, model);
        scene.parts.push(part);
        // A part of the wiring diagram: linked to it, with its catalog sockets.
        if (source.wiringPart) setWiringPart(part, source.wiringPart, false);
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
     * A STEP file as one part, its solids together as the CAD has them, as
     * an STL comes in (Kev, 2026-11-04: an assembly is one part, not one per
     * solid). An upload is carried in the graphic as binary STL, with its CAD
     * faces; a project file's is read from it.
     */
    async function addStep(source: { url?: string; buffer?: ArrayBuffer; name: string; file?: string; wiringPart?: string }): Promise<void> {
      status(`Reading ${source.name}… (the first STEP file takes a moment to set up)`, false, true);
      try {
        const bodies: StepBody[] = source.buffer ? await readStep(source.buffer) : await opts.store.stepBodies(source.url!);
        if (closed) return;
        if (!bodies.length) throw new Error(`${source.name} has no solids in it. If it is an assembly that links to other STEP files, export it from your CAD as one file.`);
        const whole = mergeBodies(bodies, source.name);
        let data: string | undefined;
        if (source.buffer) {
          data = await packMesh(whole.positions, whole.faces);
          if (data.length > MAX_EMBED) throw new Error(tooBigToCarry(source.name, data.length));
        }
        const model = modelFromPositions(whole.positions.slice(), whole.faces);
        const boxes = partBoxes();
        const first = !scene.parts.length;
        const part: ScenePart = {
          id: newPartId(scene.parts),
          name: source.name.slice(0, 120),
          position: placeBeside(boxes, model.centre, model.size).map(n => round(n)) as Vec3,
          rotation: [0, 0, 0],
          file: `${source.name}.stl`.slice(0, 200),
          ...(source.url ? { url: source.url } : { data }),
        };
        opts.store.put(part, model);
        keepModel(part, model);
        scene.parts.push(part);
        // A part of the wiring diagram: linked to it, with its catalog sockets.
        if (source.wiringPart) setWiringPart(part, source.wiringPart, false);
        selectedId = part.id;
        rebuild();
        if (first || boxes.length === 0) fitView();
        commit();
        renderProps();
        status(model.triangles > 1_500_000 ? `${part.name} added. It's a big model (${Math.round(model.triangles / 1000)}k triangles), so it may be slow.` : `${part.name} added.`);
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
      // Wires ending on it go with it; a plug's socket stays on its part for the next one.
      const gone = new Set([id, ...scene.parts.filter(w => w.wire && (w.wire.from.part === id || w.wire.to.part === id)).map(w => w.id)]);
      scene.parts = scene.parts.filter(x => !gone.has(x.id));
      const off = (x: WireWaypoint) => x.part === id || (!!x.along && gone.has(x.along.wire));
      for (const w of scene.parts) if (w.wire?.waypoints.some(off)) w.wire = { ...w.wire, waypoints: w.wire.waypoints.filter(x => !off(x)) };
      gone.forEach(g => models.delete(g));
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
        const n = explodeVector(part.joint, m).multiplyScalar(part.joint.distance * f);
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

    /**
     * Whether a part is held by its joint (its faces picked), as in Fusion:
     * it goes where the joint puts it, and moves only by the joint's own
     * Angle / Slide, or once it's unjoined.
     */
    function locked(p: ScenePart | undefined): boolean {
      return (!!p?.parent && !!p.joint?.point) || !!p?.track || !!p?.wire;
    }

    function attachGizmo(): void {
      const p = selectedId ? partById(selectedId) : undefined;
      if (p && !p.hidden && !locked(p) && art.matrixOf(p.id) && !screwing && !trackPick && !wiringOn && !stepsOn) {
        placeProxy();
        gizmo.attach(proxy);
        gizmo.setMode(tool);
      } else {
        gizmo.detach();
      }
      root.querySelectorAll<HTMLElement>("[data-tool]").forEach(b => b.classList.toggle("lyr-on", b.dataset.tool === tool && !screwing));
    }

    gizmo.addEventListener("dragging-changed", e => {
      orbit.enabled = !(e as unknown as { value: boolean }).value;
      if (!(e as unknown as { value: boolean }).value) commit();
    });
    gizmo.addEventListener("objectChange", () => {
      const p = selectedId ? partById(selectedId) : undefined;
      if (!p || locked(p)) return;
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
      if (section.picking() && e.button === 0) {
        section.click(e);
        return;
      }
      // Steps mode: a click puts the part in the step shown (or takes it out), or, recording, fits it.
      if (stepsOn) {
        if (e.button !== 0) return;
        const r = canvasEl.getBoundingClientRect();
        art.scene.updateMatrixWorld(true);
        raycaster.setFromCamera(new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
        const hit = partHit(raycaster.intersectObjects(art.meshes(), false));
        const id = hit ? String(hit.object.userData.partId || "") : "";
        if (!id) return;
        stopStepPlay();
        if (recording) recordClick(id);
        else if (partById(id)?.ghost && steps.length) {
          const k = stepsAt().get(id);
          status(`${partById(id)!.name} goes on in step ${(k ?? 0) + 1}. To move it to this step, click it in the list.`);
        } else toggleInStep(id);
        return;
      }
      // A handle under the pointer is the gizmo's click, unless faces are being picked (the gizmo is put away then).
      if (!joining && !screwing && !trackPick && !wiringOn && (gizmo.dragging || (gizmo as unknown as { axis: string | null }).axis)) return;
      const r = canvasEl.getBoundingClientRect();
      const ndc = new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      // A right-click (not a right-drag, which pans): the part's menu, or the view's.
      if ((e.button === 2 || (e.button === 0 && e.ctrlKey && mac)) && !joining && !screwing && !trackPick && !wiringOn) {
        art.scene.updateMatrixWorld(true);
        raycaster.setFromCamera(ndc, camera);
        const hit = partHit(raycaster.intersectObjects(art.meshes(), false));
        const id = hit ? String(hit.object.userData.partId || "") : "";
        if (id && partById(id)) {
          if (selectedId !== id || shownJoint) select(id);
          partMenu(id, e.clientX, e.clientY);
        } else viewMenu(e.clientX, e.clientY);
        return;
      }
      if (e.button !== 0) return;
      if (screwing) {
        hoverAt(e);
        void screwClick(e.shiftKey);
        return;
      }
      if (trackPick) {
        hoverAt(e);
        trackClick();
        return;
      }
      if (wiringOn) {
        hoverAt(e);
        wireClick(e.shiftKey);
        return;
      }
      // Shift-click on a part with a wire picked: a waypoint there.
      const pickedWire = e.shiftKey ? wireById(selectedId) : undefined;
      if (pickedWire) {
        const w = surfaceAt(e.clientX, e.clientY);
        if (w) {
          addWaypoint(pickedWire, w);
          return;
        }
      }
      if (joining) {
        hoverAt(e);
        pickFace(hoverPick());
        return;
      }
      // An arrow picks its joint: tinted on the model and lit in the list. Clicking it again, or off it, lets go.
      const arrow = scene.arrows ? art.arrowAt(e.clientX - r.left, e.clientY - r.top, camera, r.width, r.height) : "";
      if (arrow && partById(arrow)?.joint) {
        if (shownJoint === arrow) select("");
        else showJoint(arrow);
        if (shownJoint) list.querySelector(".lyr-scene-joint-row.lyr-on")?.scrollIntoView({ block: "nearest" });
        return;
      }
      art.scene.updateMatrixWorld(true);
      raycaster.setFromCamera(ndc, camera);
      const hit = partHit(raycaster.intersectObjects(art.meshes(), false));
      select(hit ? String(hit.object.userData.partId || "") : "");
    });

    /** The part a click lands on: the nearest one not cut away, looking through the see-through view's glass to the electronics. */
    function partHit<T extends { point: Vector3; object: Object3D }>(hits: T[]): T | undefined {
      const kept = hits.filter(h => art.keeps(h.point));
      return kept.find(h => !art.isGlass(String(h.object.userData.partId || ""))) || kept[0];
    }

    function select(id: string, keepJoint = false): void {
      selectedId = id;
      // Picking another part (or none) ends pin mapping's fade.
      if (pinFocus && id !== pinFocus) setPinFocus("");
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

    /**
     * The view follows the parts as they explode (Kev, 2026-11-06: always
     * centred, filling the picture), as Fit does, until it's zoomed or slid
     * across by hand. Fit or a view (Iso, Front...) has it follow again;
     * turning round keeps it.
     */
    let keepFitted = true;
    /**
     * Does a saved scene open following the parts? Yes, unless its view is
     * zoomed in closer than Fit (a close-up someone chose, kept as it is).
     */
    function opensFitted(): boolean {
      return scene.camera.size >= 0.8 * fitCamera(scene.camera).size;
    }
    let fitHinted = false;
    /** Fits the view to the parts where they are now, when it follows them (as they explode). */
    function refit(): void {
      if (!keepFitted && !fitHinted && loaded().length) {
        fitHinted = true;
        status("The view stays as you zoomed it: press Fit (F) and it follows the parts as they explode again.");
      }
      if (!keepFitted || !loaded().length) return;
      const to = fitCamera(scene.camera);
      stopGlide();
      scene.camera = to;
      applyCamera();
      draw();
    }

    /** Frames all the parts; `smooth` glides there and saves the step for undo. */
    function fitView(smooth = false): void {
      keepFitted = true;
      art.scene.updateMatrixWorld(true);
      const to = fitCamera(scene.camera);
      if (smooth) return glideTo(to, commit);
      stopGlide();
      scene.camera = to;
      applyCamera();
      draw();
    }

    /** The camera that fills the picture with the shown parts (and their arrows) from `cam`'s direction. */
    function fitCamera(cam: SceneCamera): SceneCamera {
      art.scene.updateMatrixWorld(true);
      const { meshes, points } = art.placed();
      return frameTight(cam, meshes, aspect, 1.05, points, scene.section ? p => art.keeps(p) : undefined);
    }

    /** Turns the camera to show `box` (zooming in or out), keeping the direction it looks from. */
    function frameOn(box: Bounds): void {
      if (box.isEmpty()) return;
      keepFitted = false;
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
      keepFitted = true;
      glideTo(fitCamera({ ...scene.camera, direction: [...v.direction] }), commit);
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
      if (stepsOn) {
        if (recording) return recordTakeBack();
        if (!stepsPast.length) return;
        stepsFuture.push(stepsNow);
        return stepsRestore(stepsPast.pop()!);
      }
      commit();
      if (!past.length) return;
      future.push(current);
      current = past.pop()!;
      restore(current);
      syncHistory();
    }
    function redo(): void {
      if (stepsOn) {
        if (recording || !stepsFuture.length) return;
        stepsPast.push(stepsNow);
        return stepsRestore(stepsFuture.pop()!);
      }
      if (!future.length) return;
      past.push(current);
      current = future.pop()!;
      restore(current);
      syncHistory();
    }
    function syncHistory(): void {
      $<HTMLButtonElement>("[data-act=undo]").disabled = stepsOn ? !(recording ? recording.steps.flat().length : stepsPast.length) : !past.length;
      $<HTMLButtonElement>("[data-act=redo]").disabled = stepsOn ? !!recording || !stepsFuture.length : !future.length;
    }

    // ------------------------------------------------------------ the parts list

    /**
     * The joints with an explode of their own don't follow the main slider:
     * a button beside it says how many, and puts them back on it.
     */
    function syncExplodeFollow(): void {
      const btn = root.querySelector<HTMLButtonElement>("[data-act=explode-follow]");
      if (!btn) return;
      const mine = scene.parts.filter(p => p.parent && p.joint && p.explode !== undefined);
      const own = mine.length;
      const still = mine.filter(p => p.explode === 0).length;
      btn.hidden = !own;
      btn.querySelector("span")!.textContent = String(own);
      const what = still === own
        ? `${own} joint${own === 1 ? " stays" : "s stay"} assembled`
        : still
          ? `${own} joints don't follow this slider (${still} stay${still === 1 ? "s" : ""} assembled)`
          : `${own} joint${own === 1 ? " has its" : "s have their"} own explode, so ${own === 1 ? "it doesn't" : "they don't"} follow this slider`;
      btn.title = `${what}. Click to make ${own === 1 ? "it" : "them"} follow it again.`;
      btn.setAttribute("aria-label", btn.title);
    }

    function renderList(): void {
      syncExplodeFollow();
      if (stepsOn) return renderStepsList();
      // A tree: each part joined to another sits under it, with its joint
      // as a row between them that can be shown, changed or undone.
      const byParent = new Map<string, ScenePart[]>();
      const ids = new Set(scene.parts.map(p => p.id));
      for (const p of scene.parts) {
        if (p.wire) continue;
        const key = p.parent && ids.has(p.parent) ? p.parent : "";
        let l = byParent.get(key);
        if (!l) byParent.set(key, (l = []));
        l.push(p);
      }
      // Joints undone or removed leave the explode slider's joints.
      explodeSet = explodeSet.filter(id => partById(id)?.parent);
      if (!explodeSet.includes(explodeOpen)) explodeOpen = explodeSet[explodeSet.length - 1] || "";
      const lit = highlightedParts(scene.parts);
      const pieces = trackPieces(scene.parts);
      const row = (p: ScenePart, depth: number): string => {
        const m = models.get(p.id);
        const on = lit.has(p.id);
        // Lit by a part above it, not by its own setting.
        const inherited = on && p.highlight === undefined;
        const ownExplode = p.explode !== undefined;
        const f = Math.round(explodeOf(p, scene.explode) * 100);
        const broken = m instanceof Error;
        const parent = p.parent ? partById(p.parent) : undefined;
        const picked = explodeSet.includes(p.id);
        const many = explodeSet.length > 1;
        // Unticked: the joint stays assembled (its own explode is 0).
        const ticked = p.explode !== 0;
        const joint = parent ? `<li class="lyr-scene-row lyr-scene-joint-row${shownJoint === p.id ? " lyr-on" : ""}${picked && many ? " lyr-picked" : ""}" style="--depth:${depth}">
              <button type="button" class="lyr-btn lyr-icon-btn lyr-scene-tick${ticked ? " lyr-on" : ""}" data-joint-tick="${esc(p.id)}" title="${ticked ? "Explodes: click to keep this joint assembled in this scene" : "Stays assembled: click to explode it again"}" aria-label="Explode the joint of ${esc(p.name)}" aria-pressed="${ticked}">${icon(ticked ? "ticked" : "border", 16)}</button>
              <button type="button" class="lyr-scene-name" data-joint="${esc(p.id)}" title="Show where they join. ⌘ or Shift-click to pick several joints and explode them together">${icon("link", 14)}<span>${esc(p.joint?.point && p.joint.type === "revolute" ? "Turns on" : p.joint?.point && p.joint.type === "prismatic" ? "Slides on" : "Joint to")} ${esc(parent.name)}</span></button>
              <button type="button" class="lyr-btn lyr-icon-btn${ownExplode && ticked ? " lyr-on" : ""}" data-joint-explode="${esc(p.id)}" title="${!ticked ? "Stays assembled" : ownExplode ? `Explodes ${f}% on its own` : "Explode just this joint"} (⌘ or Shift-click to add more joints)" aria-label="Explode the joint of ${esc(p.name)}" aria-expanded="${picked}">${icon("expand", 16)}</button>
              <button type="button" class="lyr-btn lyr-icon-btn" data-rejoin="${esc(p.id)}" title="Change the joint: pick the two faces again" aria-label="Change the joint of ${esc(p.name)}">${icon("pencil", 16)}</button>
              <button type="button" class="lyr-btn lyr-icon-btn" data-unjoin="${esc(p.id)}" title="Remove the joint (the part stays where it is)" aria-label="Remove the joint of ${esc(p.name)}">${icon("unlink", 16)}</button>
            </li>${explodeOpen === p.id ? `${many ? `<li class="lyr-scene-row lyr-scene-joint-explode-count" style="--depth:${depth}">${explodeSet.length} joints</li>` : ""}<li class="lyr-scene-row lyr-scene-joint-explode" style="--depth:${depth}" data-explode-for="${esc(p.id)}">
              <input type="range" min="0" max="100" step="1" value="${f}" data-joint-explode-range aria-label="How far this joint comes apart, per cent">
              <input type="number" class="lyr-scene-explode-num" min="0" max="100" step="1" value="${f}" data-joint-explode-num aria-label="How far this joint comes apart, per cent"><span class="lyr-scene-explode-unit">%</span>
              <button type="button" class="lyr-btn lyr-icon-btn" data-joint-explode-reset="${esc(p.id)}" title="Follow the main Explode slider again" aria-label="Follow the main Explode slider"${explodeSet.some(id => partById(id)?.explode !== undefined) ? "" : " disabled"}>${icon("rotate", 16)}</button>
            </li><li class="lyr-scene-row lyr-scene-joint-only" style="--depth:${depth}">
              <button type="button" class="lyr-wide-btn" data-explode-only title="Keep every other joint assembled in this scene, so only ${many ? `these ${explodeSet.length}` : "this one"} come${many ? "" : "s"} apart">${icon("expand", 14)}<span>Explode only ${many ? "these" : "this one"}</span></button>
            </li>` : ""}` : "";
        return `${joint}<li class="lyr-scene-row${p.id === selectedId && !shownJoint ? " lyr-on" : ""}${p.hidden ? " lyr-off" : ""}" data-id="${esc(p.id)}" style="--depth:${depth}">
              <button type="button" class="lyr-scene-name" data-pick="${esc(p.id)}" title="${broken ? "Its model couldn't be loaded" : "Select"}">${p.wire ? `<span class="lyr-wire-dot" style="--swatch:${esc(p.wire.color)}"></span>` : icon(p.plug ? "plug" : "cube", 14)}<span>${esc(p.name)}</span>${broken ? `<em>missing</em>` : ""}</button>
              <button type="button" class="lyr-btn lyr-icon-btn${on ? " lyr-on" : ""}${inherited ? " lyr-inherited" : ""}" data-highlight="${esc(p.id)}" title="${inherited ? "Highlighted with the part above it: click to leave it and the parts under it out" : on ? "Stop highlighting it and the parts under it" : "Highlight it and the parts under it"} (Shift-click: just this part)" aria-label="Highlight ${esc(p.name)}" aria-pressed="${on}">${icon("highlight", 16)}</button>
              <button type="button" class="lyr-btn lyr-icon-btn${p.ghost ? " lyr-on" : ""}" data-ghost-part="${esc(p.id)}" title="${p.ghost ? "Draw it and the parts under it normally" : "Ghost it and the parts under it: draw them faint, as fitted in an earlier step"} (Shift-click: just this part)" aria-label="Ghost ${esc(p.name)}" aria-pressed="${!!p.ghost}">${icon("opacity", 16)}</button>
              ${pieces.has(p.id) ? `<button type="button" class="lyr-btn lyr-icon-btn" disabled title="The piece a track is made from: the track stands for it, so it stays out of the pictures. Edit track uses it." aria-label="${esc(p.name)} is a track's piece, kept out of the pictures">${icon("track", 16)}</button>` : `<button type="button" class="lyr-btn lyr-icon-btn" data-hide="${esc(p.id)}" title="${linked() ? (p.hidden ? "Show it and the parts under it in this scene" : "Leave it and the parts under it out of this scene (they stay in the model)") : p.hidden ? "Show it and the parts under it" : "Hide it and the parts under it"} (Shift-click: just this part)" aria-label="${p.hidden ? "Show" : "Hide"} ${esc(p.name)}">${icon(p.hidden ? "eyeOff" : "eye", 16)}</button>`}
              <button type="button" class="lyr-btn lyr-icon-btn" data-remove="${esc(p.id)}" title="${linked() ? "Remove it from the project's model (every scene)" : "Remove"}" aria-label="Remove ${esc(p.name)}">${icon("trash", 16)}</button>
            </li>${(byParent.get(p.id) || []).map(c => row(c, depth + 1)).join("")}`;
      };
      renderModelNote();
      const had = list.contains(document.activeElement);
      const wires = scene.parts.filter(p => p.wire);
      list.innerHTML = scene.parts.length
        ? (byParent.get("") || []).map(p => row(p, 0)).join("") + (wires.length ? `<li class="lyr-scene-row lyr-scene-list-head">${icon("wire", 14)}<span>Wiring · ${wires.length} wire${wires.length === 1 ? "" : "s"}</span></li>${wires.map(p => row(p, 0)).join("")}` : "")
        : `<li class="lyr-note">No parts yet.</li>`;
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
        modelNote.innerHTML = `<p class="lyr-note">${modelOnly ? "The project's parts and how they join. Every 3D scene in the project picks its parts from here." : scene.parts.length ? `Parts and joints are shared by every scene in this project. This scene shows ${shown} of ${scene.parts.length}: the eye picks which.` : "The parts you add here are the project's model: every scene can show them."}</p>`;
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
      } else if (d.joint && (e.shiftKey || e.metaKey || e.ctrlKey)) {
        pickExplode(d.joint, true);
      } else if (d.joint) {
        const off = shownJoint === d.joint;
        showJoint(off ? "" : d.joint);
        if (!off) zoomTo(d.joint, true);
      }
      else if (d.rejoin) {
        select(d.rejoin);
        if (partById(d.rejoin)?.track) openTrackDialog(d.rejoin);
        else openJointDialog(d.rejoin);
      } else if (d.unjoin) {
        const p = partById(d.unjoin);
        if (p) unjoin(p);
      } else if (d.jointTick) {
        const p = partById(d.jointTick);
        if (!p) return;
        if (p.explode === 0) delete p.explode;
        else p.explode = 0;
        follow();
        refit();
        commit();
        renderList();
        status(p.explode === 0 ? `${p.name} stays assembled in this scene.` : `${p.name} explodes with the slider again.`);
      } else if (d.explodeOnly !== undefined) {
        explodeOnly();
      } else if (d.jointExplode) {
        pickExplode(d.jointExplode, e.shiftKey || e.metaKey || e.ctrlKey);
      } else if (d.jointExplodeReset) {
        const ps = explodeSet.map(partById).filter((x): x is ScenePart => !!x && x.explode !== undefined);
        if (ps.length) {
          ps.forEach(x => delete x.explode);
          follow();
          refit();
          commit();
          renderList();
          list.querySelector<HTMLInputElement>("[data-joint-explode-num]")?.focus();
        }
      } else if (d.highlight) toggleHighlight(d.highlight, e.shiftKey);
      else if (d.ghostPart) toggle(d.ghostPart, "ghost", e.shiftKey);
      else if (d.hide) toggle(d.hide, "hidden", e.shiftKey);
      else if (d.remove) removePart(d.remove);
    });

    /**
     * Keeps every joint but the picked ones assembled: they're unticked
     * (explode 0), and a picked joint that was unticked follows the main
     * slider again.
     */
    function explodeOnly(): void {
      const set = new Set(explodeSet);
      for (const p of scene.parts) {
        if (!p.parent || !p.joint) continue;
        if (!set.has(p.id)) p.explode = 0;
        else if (p.explode === 0) delete p.explode;
      }
      // Nothing would move with the main slider at 0: open it fully.
      const moves = explodeSet.map(partById).some(p => p && explodeOf(p, scene.explode) > 0);
      if (!moves) {
        scene.explode = 1;
        syncExplode();
      }
      follow();
      refit();
      commit();
      renderList();
      status(`Only ${set.size === 1 ? "this joint explodes" : `these ${set.size} joints explode`}: the rest stay assembled.`);
    }

    /**
     * Opens a joint's explode slider, or with `add` (⌘ or Shift held) adds
     * it to the joints the slider sets, or takes it out again.
     */
    function pickExplode(id: string, add: boolean): void {
      if (add) {
        explodeSet = explodeSet.includes(id) ? explodeSet.filter(x => x !== id) : [...explodeSet, id];
      } else explodeSet = explodeSet.length === 1 && explodeSet[0] === id ? [] : [id];
      explodeOpen = explodeSet.includes(id) ? id : explodeSet[explodeSet.length - 1] || "";
      renderList();
      if (explodeOpen) list.querySelector<HTMLInputElement>("[data-joint-explode-num]")?.focus();
    }

    // A joint's own explode (every picked joint's), from its row's slider or number.
    list.addEventListener("input", e => {
      const t = e.target as HTMLInputElement;
      const rowEl = t.closest<HTMLElement>("[data-explode-for]");
      const p = rowEl ? partById(rowEl.dataset.explodeFor || "") : undefined;
      if (!p || !rowEl) return;
      const v = Number(t.value);
      if (t.value === "" || !Number.isFinite(v)) return;
      const pc = Math.max(0, Math.min(100, Math.round(v)));
      const all = explodeSet.map(partById).filter((x): x is ScenePart => !!x);
      for (const x of all.length ? all : [p]) x.explode = pc / 100;
      syncExplodeFollow();
      const other = rowEl.querySelector<HTMLInputElement>(t.matches("[data-joint-explode-range]") ? "[data-joint-explode-num]" : "[data-joint-explode-range]");
      if (other) other.value = String(pc);
      rowEl.querySelector<HTMLButtonElement>("[data-joint-explode-reset]")!.disabled = false;
      for (const x of all.length ? all : [p]) {
        const btn = list.querySelector<HTMLElement>(`[data-joint-explode="${CSS.escape(x.id)}"]`);
        btn?.classList.toggle("lyr-on", pc > 0);
        if (btn) btn.title = pc ? `Explodes ${pc}% on its own` : "Stays assembled";
        // At 0 it stays assembled, so its tick goes too.
        const tick = list.querySelector<HTMLElement>(`[data-joint-tick="${CSS.escape(x.id)}"]`);
        if (tick) {
          tick.classList.toggle("lyr-on", pc > 0);
          tick.setAttribute("aria-pressed", String(pc > 0));
          tick.innerHTML = icon(pc > 0 ? "ticked" : "border", 16);
        }
      }
      follow();
      refit();
    });
    list.addEventListener("change", e => {
      const t = e.target as HTMLInputElement;
      if (!t.closest("[data-explode-for]")) return;
      const p = partById(t.closest<HTMLElement>("[data-explode-for]")!.dataset.explodeFor || "");
      if (p) t.value = String(Math.round(explodeOf(p, scene.explode) * 100));
      commit();
    });

    /** The parts joined under a part, all the way down its branch (not the part itself). */
    function branchUnder(id: string): ScenePart[] {
      const under = new Set([id]);
      const out: ScenePart[] = [];
      let grew = true;
      while (grew) {
        grew = false;
        for (const c of scene.parts) if (c.parent && under.has(c.parent) && !under.has(c.id)) {
          under.add(c.id);
          out.push(c);
          grew = true;
        }
      }
      return out;
    }

    /**
     * Turns a part's highlight on or off. Normally for its whole branch: the
     * parts under it follow it again, and it keeps a setting of its own only
     * where it differs from the part above it. With `only` (Shift-click),
     * just this part: the parts joined to it keep how they look now.
     */
    function toggleHighlight(id: string, only = false): void {
      const p = partById(id);
      if (!p) return;
      const lit = highlightedParts(scene.parts);
      const want = !lit.has(id);
      const above = p.parent ? lit.has(p.parent) : false;
      if (only) {
        // Its children followed it: pin them to how they are now.
        for (const c of scene.parts) if (c.parent === id && c.highlight === undefined) c.highlight = lit.has(c.id);
      } else {
        for (const c of branchUnder(id)) delete c.highlight;
      }
      if (want === above) delete p.highlight;
      else p.highlight = want;
      if (only) {
        // A child pinned to what it would follow anyway follows again.
        const now = highlightedParts(scene.parts).has(id);
        for (const c of scene.parts) if (c.parent === id && c.highlight === now) delete c.highlight;
      }
      rebuild();
      commit();
      renderList();
      renderProps();
      status(only ? `${want ? "Highlighted" : "Stopped highlighting"} just ${p.name}.` : `${want ? "Highlighted" : "Stopped highlighting"} ${p.name}${branchUnder(id).length ? " and the parts under it" : ""}. Shift-click for just this part.`);
    }

    /**
     * Turns a part's ghost or hidden on or off: normally for it and every part
     * joined under it, or with `only` (Shift-click) just this part.
     */
    function toggle(id: string, key: "ghost" | "hidden", only = false): void {
      const p = partById(id);
      if (!p) return;
      const want = !p[key];
      const branch = only ? [] : branchUnder(id);
      for (const x of [p, ...branch]) {
        if (want) x[key] = true;
        else delete x[key];
      }
      rebuild();
      commit();
      renderList();
      renderProps();
      const what = key === "ghost" ? (want ? "Ghosted" : "Stopped ghosting") : want ? "Hid" : "Showed";
      status(`${what} ${only || !branch.length ? `just ${p.name}` : `${p.name} and ${branch.length === 1 ? "the part" : `the ${branch.length} parts`} under it`}.${only || !branch.length ? "" : " Shift-click for just this part."}`);
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
      keepModel(copy, model);
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
        ...(broken || isWiring(p) ? [] : [{ label: "Duplicate", icon: "copy", keys: keyName("D"), run: () => duplicatePart(id) }]),
        null,
        ...(p.wire ? [] : [parent
          ? { label: `Edit joint to ${parent.name}`, icon: "link", run: () => { select(id); openJointDialog(id); } }
          : { label: "Join to another part…", icon: "link", run: () => { select(id); openJointDialog(id); } }]),
        ...(parent ? [{ label: "Remove joint", icon: "unlink", run: () => unjoin(p) }] : []),
        ...(p.screw || isWiring(p) || broken || scene.parts.length < 2 ? [] : [{ label: p.track ? "Edit track…" : "Make track…", icon: "track", run: () => { select(id); openTrackDialog(id); } }]),
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
        case "offsetX": return p?.joint?.offset?.[0] || 0;
        case "offsetY": return p?.joint?.offset?.[1] || 0;
        case "offsetZ": return p?.joint?.offset?.[2] || 0;
        case "distance": return p?.joint?.distance || 0;
        case "lower": return p?.joint?.lower ?? 0;
        case "upper": return p?.joint?.upper ?? 0;
        case "arrowFrom": return Math.round((p?.arrow?.from ?? ARROW_FROM) * 100);
        case "arrowTo": return Math.round((p?.arrow?.to ?? ARROW_TO) * 100);
        case "wireDiameter": return p?.wire?.diameter ?? 0;
        case "wireSlack": return p?.wire?.slack ?? 0;
        case "wireTwist": return p?.wire ? p.wire.twist ?? (p.wire.lay === "flat" ? 0 : BUNDLE_TWIST) : 0;
        case "alongFrom": return Math.round((p?.wire?.waypoints.find(w => w.along)?.along?.from ?? 0) * 100);
        case "alongTo": return Math.round((p?.wire?.waypoints.find(w => w.along)?.along?.to ?? 1) * 100);
      }
      return 0;
    }

    function setField(key: string, value: number): void {
      if (!Number.isFinite(value)) return;
      const p = partById(selectedId);
      const s = scene.style;
      const pos = ["x", "y", "z"].indexOf(key);
      const rot = ["roll", "pitch", "yaw"].indexOf(key);
      // A part held by its joint isn't placed by hand.
      if ((pos >= 0 || rot >= 0) && locked(p)) return;
      if ((key === "wireDiameter" || key === "wireSlack") && p?.wire) {
        const v = key === "wireDiameter" ? Math.max(WIRE_LIMITS.diameter[0], Math.min(WIRE_LIMITS.diameter[1], round(value, 2))) : Math.max(0, Math.min(WIRE_LIMITS.slack[1], round(value, 1)));
        setWire(w => (key === "wireDiameter" ? { ...w, diameter: v } : { ...w, slack: v }));
        return;
      }
      if ((key === "alongFrom" || key === "alongTo") && p?.wire) {
        const v = Math.max(0, Math.min(1, Math.round(value) / 100));
        setWire(w => ({ ...w, waypoints: w.waypoints.map(x => (x.along ? { along: { ...x.along, [key === "alongFrom" ? "from" : "to"]: v } } : x)) }));
        return;
      }
      if (key === "wireTwist" && p?.wire) {
        const v = Math.max(WIRE_LIMITS.twist[0], Math.min(WIRE_LIMITS.twist[1], Math.round(value)));
        setWire(w => ({ ...w, twist: v }));
        return;
      }
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
      } else if (key.startsWith("offset") && p?.joint?.point) {
        const o: Vec3 = [...(p.joint.offset || [0, 0, 0])];
        o["XYZ".indexOf(key.slice(6))] = round(Math.max(-100_000, Math.min(100_000, value)), 2);
        if (o.some(v => v !== 0)) p.joint.offset = o;
        else delete p.joint.offset;
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
      } else if ((key === "arrowFrom" || key === "arrowTo") && p?.joint) {
        // Where the arrow runs, as a share of the gap from the part to where it fits.
        const v = Math.max(0, Math.min(100, Math.round(value))) / 100;
        const a = { ...(p.arrow || {}) };
        if (key === "arrowFrom") a.from = v;
        else a.to = v;
        if (a.from === ARROW_FROM) delete a.from;
        if (a.to === ARROW_TO) delete a.to;
        if (Object.keys(a).length) p.arrow = a;
        else delete p.arrow;
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
    /** Putting screws in holes: armed while true (see the screw tool, below). */
    let screwing = false;

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
      smartOne(child);
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
    /** The joints the open explode slider sets (⌘ or Shift-click adds more). */
    let explodeSet: string[] = [];

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

    // ------------------------------------------------------------ section view

    // Fusion's section analysis: pick a face, slide a cut through the parts (sectionTool.ts).
    const section = createSectionTool({
      frame: frameEl,
      canvas: canvasEl,
      camera,
      art,
      size: () => ({ w: viewW, h: viewH }),
      get: () => scene.section,
      set: s => {
        if (s) scene.section = s;
        else delete scene.section;
        art.setSection(s);
        syncSectionButton();
        draw();
      },
      commit: () => commit(),
      status,
      draw,
      face: (id, triangle) => {
        const m = models.get(id);
        if (!m || m instanceof Error) return null;
        const f = topologyOf(m)?.faceAt(triangle);
        return f ? { geometry: faceGeometry(m, f), normal: f.curved ? null : ([...f.normal] as Vec3) } : null;
      },
      onPicking: on => {
        if (on) {
          if (joining) stopJoin();
          if (screwing) stopScrews();
          gizmo.detach();
        } else attachGizmo();
        syncSectionButton();
      },
    });
    function syncSectionButton(): void {
      $("[data-act=section]").classList.toggle("lyr-on", section.picking() || !!scene.section);
    }

    // ------------------------------------------------------------ the angle dial

    // While the joint dialog is open, a dial round the joint turns the part
    // about the joint's normal (its Spin, or a turning joint's Angle), as
    // Fusion's does: drag the handle or the ring, or type the angle.
    const dialEl = document.createElement("div");
    dialEl.className = "lyr-scene-dial";
    dialEl.hidden = true;
    dialEl.innerHTML = `<svg>
        <path class="lyr-dial-limits"></path>
        <path class="lyr-dial-ring"></path>
        <path class="lyr-dial-sweep"></path>
        <line class="lyr-dial-zero"></line>
        <path class="lyr-dial-hit"></path>
        <circle class="lyr-dial-handle" r="7"></circle>
      </svg>
      <label class="lyr-dial-field" title="The angle about the joint. Drag the dial (Shift for 15° steps) or type it.">
        <input type="number" step="1" aria-label="Angle about the joint, degrees"><em>°</em>
      </label>`;
    frameEl.appendChild(dialEl);
    const dialPart = (sel: string) => dialEl.querySelector(sel)!;
    const dialInput = dialEl.querySelector<HTMLInputElement>("input")!;
    /** The dial as drawn now: its middle, the plane's axes (world) and its radius (mm). */
    let dial: { c: Vector3; n: Vector3; u: Vector3; w: Vector3; r: number } | null = null;

    function dialPartNow(): ScenePart | undefined {
      if (!draft || joining) return undefined;
      const p = partById(draft.childId);
      return p?.parent && p.joint?.point && p.joint.childPoint ? p : undefined;
    }

    function placeDial(): void {
      const p = dialPartNow();
      const cm = p && art.matrixOf(p.id);
      const pm = p && art.matrixOf(p.parent!);
      if (!p || !cm || !pm) {
        dialEl.hidden = true;
        dial = null;
        return;
      }
      const j = p.joint!;
      // Where the faces meet, as drawn (exploded too), and the parent's face normal.
      const c = new Vector3(...j.childPoint!).applyMatrix4(cm);
      const n = new Vector3(...j.normal).transformDirection(pm).normalize();
      // Nought degrees: the parent's X across the face (Y when X is the normal), as Spin counts.
      const lu = new Vector3(1, 0, 0).cross(new Vector3(...j.normal).normalize());
      if (lu.lengthSq() < 1e-6) lu.set(0, 1, 0).cross(new Vector3(...j.normal).normalize());
      const u = lu.normalize().transformDirection(pm).normalize();
      const w = n.clone().cross(u).normalize();
      const toScreen = (v: Vector3) => {
        const q = v.clone().project(camera);
        return { x: ((q.x + 1) / 2) * viewW, y: ((1 - q.y) / 2) * viewH };
      };
      // About 70 px across on screen, whatever the zoom.
      const right = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      const a0 = toScreen(c), a1 = toScreen(c.clone().add(right));
      const pxPerMm = Math.hypot(a1.x - a0.x, a1.y - a0.y) || 1;
      const r = 70 / pxPerMm;
      dial = { c, n, u, w, r };
      const at = (deg: number) => toScreen(c.clone().addScaledVector(u, Math.cos(deg * DEG) * r).addScaledVector(w, Math.sin(deg * DEG) * r));
      const arc = (from: number, to: number) => {
        const steps = Math.max(2, Math.ceil(Math.abs(to - from) / 5));
        let d = "";
        for (let k = 0; k <= steps; k++) {
          const pt = at(from + ((to - from) * k) / steps);
          d += `${k ? "L" : "M"}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`;
        }
        return d;
      };
      const spin = j.spin || 0;
      const ringD = arc(0, 360) + "Z";
      dialPart(".lyr-dial-ring").setAttribute("d", ringD);
      dialPart(".lyr-dial-hit").setAttribute("d", ringD);
      dialPart(".lyr-dial-sweep").setAttribute("d", Math.abs(spin) > 0.05 ? arc(0, spin) : "");
      dialPart(".lyr-dial-limits").setAttribute("d", j.type === "revolute" ? arc(j.lower ?? 0, j.upper ?? 0) : "");
      const z = at(0);
      const zero = dialPart(".lyr-dial-zero");
      zero.setAttribute("x1", a0.x.toFixed(1));
      zero.setAttribute("y1", a0.y.toFixed(1));
      zero.setAttribute("x2", z.x.toFixed(1));
      zero.setAttribute("y2", z.y.toFixed(1));
      const h = at(spin);
      const handle = dialPart(".lyr-dial-handle");
      handle.setAttribute("cx", h.x.toFixed(1));
      handle.setAttribute("cy", h.y.toFixed(1));
      // The number sits outside the ring, beyond the handle.
      const ox = h.x - a0.x, oy = h.y - a0.y;
      const ol = Math.hypot(ox, oy) || 1;
      const field = dialEl.querySelector<HTMLElement>(".lyr-dial-field")!;
      // Clear of the handle whichever side it's on.
      const fw = field.offsetWidth || 80, fh = field.offsetHeight || 24;
      const dx = ox / ol, dy = oy / ol;
      const gap = 12 + Math.min(Math.abs(dx) > 1e-3 ? fw / 2 / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-3 ? fh / 2 / Math.abs(dy) : Infinity);
      field.style.left = `${Math.round(h.x + dx * gap)}px`;
      field.style.top = `${Math.round(h.y + dy * gap)}px`;
      if (document.activeElement !== dialInput) dialInput.value = String(round(spin, 1));
      dialEl.hidden = false;
    }

    /** Turns the dialog's part to `deg` about its joint. */
    function setDial(deg: number): void {
      const p = dialPartNow();
      if (!p?.joint || !Number.isFinite(deg)) return;
      p.joint.spin = round(wrapAngle(deg), 1);
      keepInLimits(p.joint);
      applyJoint(p);
      follow();
      syncJointFields();
      syncFields();
    }

    dialEl.addEventListener("pointerdown", e => {
      const t = e.target as Element;
      if (e.button !== 0 || !(t.matches(".lyr-dial-handle") || t.matches(".lyr-dial-hit"))) return;
      e.preventDefault();
      e.stopPropagation();
      stopGlide();
      const el = t as SVGElement;
      el.setPointerCapture(e.pointerId);
      dialEl.classList.add("lyr-dragging");
      const plane = new Plane();
      const hitV = new Vector3();
      const turn = (m: PointerEvent) => {
        if (!dial) return;
        const box = canvasEl.getBoundingClientRect();
        raycaster.setFromCamera(new Vector2(((m.clientX - box.left) / box.width) * 2 - 1, -((m.clientY - box.top) / box.height) * 2 + 1), camera);
        plane.setFromNormalAndCoplanarPoint(dial.n, dial.c);
        if (!raycaster.ray.intersectPlane(plane, hitV)) return;
        hitV.sub(dial.c);
        let deg = Math.atan2(hitV.dot(dial.w), hitV.dot(dial.u)) / DEG;
        deg = m.shiftKey ? Math.round(deg / 15) * 15 : Math.round(deg);
        setDial(deg);
      };
      turn(e);
      const up = () => {
        dialEl.classList.remove("lyr-dragging");
        el.removeEventListener("pointermove", turn);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
      };
      el.addEventListener("pointermove", turn);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
    });
    dialInput.addEventListener("input", () => {
      if (dialInput.value !== "") setDial(Number(dialInput.value));
    });
    dialInput.addEventListener("change", () => {
      const p = dialPartNow();
      if (p?.joint) dialInput.value = String(round(p.joint.spin || 0, 1));
    });
    // Keys typed in the angle stay out of the scene's shortcuts.
    dialInput.addEventListener("keydown", e => e.stopPropagation());

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
      if ((joining || trackPick) && hover) placeSnaps();
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

    const ROLE_LABEL: Record<Snap["role"], string> = { centre: "middle of the face", corner: "corner", edge: "middle of the edge", hole: "centre of the hole", rim: "centre of the rim", pocket: "middle of the recess", pin: "base of the pin", tip: "end of the pin" };

    /** The meshes a join may pick now: the part being joined, then any part not on its branch. */
    function pickable(): Mesh[] {
      if (screwing) return art.meshes().filter(m => !partById(String(m.userData.partId || ""))?.screw);
      if (wiringOn) return art.meshes().filter(m => {
        const q = partById(String(m.userData.partId || ""));
        return q && !isWiring(q) && (!pinPick || q.id === pinPick.part);
      });
      if (trackPick && trackDraft) {
        const d = trackDraft;
        return art.meshes().filter(m => {
          const id = String(m.userData.partId || "");
          return trackPick === "wheel" ? id !== d.linkId && id !== d.trackId : id === d.linkId;
        });
      }
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
      const hit = raycaster.intersectObjects(pickable(), false).find(h => h.face && h.faceIndex !== undefined && art.keeps(h.point));
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
        // Wiring, a pin or socket near the pointer is caught off the part too.
        if (wiringOn && !hover) placeSnaps();
        draw();
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
      if (trackDraft) {
        // The track's picks: the piece's pivots, and the middle of each wheel's circle.
        const td = trackDraft;
        const g = art.groupOf(td.linkId);
        if (g) {
          g.updateMatrixWorld(true);
          for (const at of [td.spec.start, td.spec.end]) {
            if (!at) continue;
            const q = project(at, g.matrixWorld);
            marks.push(`<span class="lyr-snap lyr-snap-picked" style="left:${q.x}px;top:${q.y}px"></span>`);
          }
        }
        for (const w of td.spec.wheels) {
          const wg = art.groupOf(w.id);
          if (!wg) continue;
          wg.updateMatrixWorld(true);
          const q = project(w.point, wg.matrixWorld);
          marks.push(`<span class="lyr-snap lyr-snap-joined" style="left:${q.x}px;top:${q.y}px"></span>`);
        }
      }
      if (joining?.childPoint) {
        const g = art.groupOf(joining.childId);
        if (g) {
          const at = project(joining.childPoint, g.matrix);
          marks.push(`<span class="lyr-snap lyr-snap-picked" style="left:${at.x}px;top:${at.y}px"></span>`);
        }
      }
      // Wiring: every socket on the view, and the one near the pointer taken over the face's snaps.
      socketHover = null;
      if (wiringOn) {
        // A pin or socket is a magnet: it takes the pointer from 20 px, on the part or just off it.
        let best = 20;
        for (const so of socketsOnView()) {
          const d = Math.hypot(so.x - pointer.x, so.y - pointer.y);
          if (d < best && !pinPick) {
            best = d;
            socketHover = { part: so.part, socket: so.socket };
          }
        }
        // A placed wire's end nearer than any socket is picked up by a click.
        endHover = null;
        if (!wireDraft && !endCarry && !pinPick) {
          let bestEnd = Math.min(best, 16);
          const ends = wireEndsOnView();
          for (const en of ends) {
            const d = Math.hypot(en.x - pointer.x, en.y - pointer.y);
            if (d < bestEnd) {
              bestEnd = d;
              endHover = { wire: en.wire, end: en.end };
            }
          }
          if (endHover) socketHover = null;
          for (const en of ends) {
            const on = endHover?.wire === en.wire && endHover.end === en.end;
            marks.push(`<span class="lyr-snap lyr-snap-wire-end${on ? " lyr-on" : ""}" style="left:${en.x}px;top:${en.y}px"></span>`);
            if (on) marks.push(`<span class="lyr-snap-label" style="left:${en.x}px;top:${en.y}px">${esc(`Pick up this end · ${partById(en.wire)?.name || "wire"}`)}</span>`);
          }
        }
        for (const so of socketsOnView()) {
          const on = socketHover?.socket === so.socket && socketHover.part === so.part;
          marks.push(`<span class="lyr-snap lyr-snap-socket${on ? " lyr-on" : ""}" style="left:${so.x}px;top:${so.y}px"></span>`);
          if (on) {
            const c = connectorOf(so.socket.connector);
            const busy = plugIn(so.part, so.socket.id);
            marks.push(`<span class="lyr-snap-label" style="left:${so.x}px;top:${so.y}px">${endCarry ? "Drop the end here · " : ""}${esc(isBarePin(so.socket) ? `Pin ${so.socket.name || so.socket.pin || ""} · bare, no plug` : `${so.socket.name || "Socket"}${c ? ` · ${c.family.label} ${c.ways}-way` : ""}${busy ? " · has a plug" : ""}`)}</span>`);
          }
        }
        if (wireDraft) {
          const world = worldMatrices(scene.parts, scene.explode);
          wireDraft.waypoints.forEach(w => {
            const mm = w.part ? world.get(w.part) : undefined;
            if (!mm || !w.point) return;
            const q = project(w.point, mm);
            marks.push(`<span class="lyr-snap lyr-snap-picked" style="left:${q.x}px;top:${q.y}px"></span>`);
          });
          const fm = world.get(wireDraft.from.part);
          if (fm) {
            const q = project(wireDraft.from.socket.point, fm);
            marks.push(`<span class="lyr-snap lyr-snap-joined" style="left:${q.x}px;top:${q.y}px"></span>`);
          }
        }
      }
      if (hover && !socketHover && !endHover) {
        const snaps = hoverSnaps();
        const m = hover.mesh.matrixWorld;
        const screen = snaps.map(s => project(s.p, m));
        hover.snap = nearestSnap(screen, snaps, pointer, 22, 40, snapReach(snaps, m, project), faceHeld);
        screen.forEach((p, i) => {
          marks.push(`<span class="lyr-snap lyr-snap-${snaps[i].role}${i === hover!.snap ? " lyr-on" : ""}" style="left:${p.x}px;top:${p.y}px"></span>`);
        });
        const on = hover.snap >= 0 ? snaps[hover.snap] : null;
        // Shift held with the screw tool: every hole a click would fill, marked.
        if (on && screwing && shiftDown) {
          for (const h of holesFor(hover.id, on, true)) {
            if (h === on) continue;
            const p = project(h.p, m);
            marks.push(`<span class="lyr-snap lyr-snap-hole lyr-on" style="left:${p.x}px;top:${p.y}px"></span>`);
          }
        }
        if (on) {
          const p = screen[hover.snap];
          const text = pinPick ? `${pinPickLabel(pinPick)} · ${ROLE_LABEL[on.role]}` : endCarry ? `Drop the end here · ${ROLE_LABEL[on.role]}` : wiringOn ? `${wireDraft ? (shiftDown ? "End the wire here" : "Waypoint") : "First plug"} · ${ROLE_LABEL[on.role]}` : screwing ? screwHint(hover.id, on) : trackPick === "wheel" && on.radius ? `Ø${round(on.radius * 2, 1)} mm circle` : `${ROLE_LABEL[on.role]}${faceHeld ? " · face held" : ""}`;
          marks.push(`<span class="lyr-snap-label" style="left:${p.x}px;top:${p.y}px">${esc(text)}</span>`);
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
    /** The hovered face's snaps a click can take: only its round holes while putting screws in. */
    function hoverSnaps(): Snap[] {
      const all = hover?.face?.snaps || [];
      if (trackPick === "wheel") return all.filter(s => !!s.radius);
      return screwing ? all.filter(isHoleSnap) : all;
    }

    function hoverPick(): Pick | null {
      if (!hover) return null;
      const s = hover.snap >= 0 ? hoverSnaps()[hover.snap] : undefined;
      const p = s ? s.p : hover.point;
      const n = s ? s.n : hover.normal;
      return { id: hover.id, point: [round(p[0], 3), round(p[1], 3), round(p[2], 3)], normal: [round(n[0], 5), round(n[1], 5), round(n[2], 5)] };
    }

    let hoverQueued = 0;
    canvasEl.addEventListener("pointermove", e => {
      if (section.picking() && !e.buttons) {
        const at = { clientX: e.clientX, clientY: e.clientY };
        cancelAnimationFrame(hoverQueued);
        hoverQueued = requestAnimationFrame(() => section.hover(at));
        return;
      }
      if (!(joining || screwing || trackPick || wiringOn) || e.buttons) return;
      faceHeld = !screwing && holdKey(e) && !!hover;
      shiftDown = e.shiftKey;
      const at = { clientX: e.clientX, clientY: e.clientY };
      cancelAnimationFrame(hoverQueued);
      hoverQueued = requestAnimationFrame(() => {
        if (joining || screwing || trackPick || wiringOn) hoverAt(at);
        if (wiringOn) drawWirePreview();
      });
    });
    canvasEl.addEventListener("pointerleave", () => {
      cancelAnimationFrame(hoverQueued);
      if (joining || screwing || trackPick || wiringOn) clearHover();
    });

    // ------------------------------------------------------------ the screw tool

    // Arm it (the Screw button, or S), and each click on a round hole puts
    // a screw in it, joined to the part with the hole and drawn out of it
    // (this picture's explode), so the next step shows it fitted. The tool
    // stays armed for the next hole. Its size is measured from the hole
    // (Auto) unless one is chosen; the choice is remembered. Shift-click
    // fills every hole like it on that part, facing the same way.

    interface ScrewChoice { d: number | "auto"; length: number | "auto"; head: ScrewHead }
    const SCREW_KEY = "layers.screwTool";
    const readChoice = (): ScrewChoice => {
      try {
        const v = JSON.parse(localStorage.getItem(SCREW_KEY) || "null") as Partial<ScrewChoice> | null;
        if (v && typeof v === "object") {
          return {
            d: SCREW_SIZES.some(x => x.d === v.d) ? (v.d as number) : "auto",
            length: SCREW_LENGTHS.includes(v.length as number) ? (v.length as number) : "auto",
            head: SCREW_HEADS.some(h => h.id === v.head) ? (v.head as ScrewHead) : "socket",
          };
        }
      } catch {
        // No storage here: start from Auto.
      }
      return { d: "auto", length: "auto", head: "socket" };
    };
    let screwChoice = readChoice();
    let shiftDown = false;
    const screwBar = $(".lyr-screw-bar");

    function renderScrewBar(): void {
      const opt = (v: string, label: string, on: boolean) => `<option value="${v}"${on ? " selected" : ""}>${esc(label)}</option>`;
      screwBar.innerHTML = `
        <span class="lyr-screw-bar-title">${icon("screw", 16)}<span>Screw</span></span>
        <label title="Thread size. Auto: the biggest screw that goes through the hole"><span>Size</span><select data-screw="d">${opt("auto", "Auto", screwChoice.d === "auto")}${SCREW_SIZES.map(x => opt(String(x.d), `M${x.d}`, screwChoice.d === x.d)).join("")}</select></label>
        <label title="Length in mm (overall for countersunk). Auto: as deep as a blind hole, or through the part with some to spare"><span>×</span><select data-screw="length">${opt("auto", "Auto", screwChoice.length === "auto")}${SCREW_LENGTHS.map(l => opt(String(l), `${l} mm`, screwChoice.length === l)).join("")}</select></label>
        <label title="Head"><select data-screw="head">${SCREW_HEADS.map(h => opt(h.id, h.label, screwChoice.head === h.id)).join("")}</select></label>
        <span class="lyr-screw-bar-hint">Click a hole · Shift-click: every hole like it · Esc: stop</span>
        <button type="button" class="lyr-btn lyr-icon-btn" data-act="screw-stop" title="Stop putting screws in (Esc)" aria-label="Stop">${icon("close", 16)}</button>`;
    }
    screwBar.addEventListener("change", e => {
      const el = e.target as HTMLSelectElement;
      const key = el.dataset.screw;
      if (!key) return;
      if (key === "head") screwChoice.head = el.value as ScrewHead;
      else screwChoice[key as "d" | "length"] = el.value === "auto" ? "auto" : Number(el.value);
      try {
        localStorage.setItem(SCREW_KEY, JSON.stringify(screwChoice));
      } catch {
        // Not kept: fine for this session.
      }
      screwSpecs.clear();
      el.blur();
      if (hover) placeSnaps();
      draw();
    });
    screwBar.addEventListener("keydown", e => {
      if (e.key === "Escape") {
        e.stopPropagation();
        stopScrews();
      }
    });

    function startScrews(): void {
      stopWires();
      if (joining) stopJoin();
      if (section.picking()) section.stop();
      if (draft) closeJointDialog();
      screwing = true;
      shownJoint = "";
      renderScrewBar();
      screwBar.hidden = false;
      $("[data-act=screw]").classList.add("lyr-on");
      layout();
      canvasEl.classList.add("lyr-scene-picking");
      attachGizmo();
      status("Click a round hole to put a screw in it. Shift-click to fill every hole like it.", false, true);
      draw();
    }

    function stopScrews(message = ""): void {
      if (!screwing) return;
      screwing = false;
      screwBar.hidden = true;
      $("[data-act=screw]").classList.remove("lyr-on");
      layout();
      clearHover();
      canvasEl.classList.remove("lyr-scene-picking");
      attachGizmo();
      status(message);
      draw();
    }

    /** The screw a hole takes, by the choice: as chosen, or measured from the hole. Kept per hole. */
    const screwSpecs = new Map<string, ScrewSpec>();
    function screwFor(partId: string, hole: Snap): ScrewSpec {
      const key = `${partId}:${hole.p.map(n => n.toFixed(3)).join(",")}:${hole.n.map(n => n.toFixed(3)).join(",")}`;
      const had = screwSpecs.get(key);
      if (had) return had;
      const head = screwChoice.head;
      const d = screwChoice.d === "auto" ? fitDiameter(hole.radius || 1.5, head) : screwChoice.d;
      let length = screwChoice.length;
      if (length === "auto") {
        const m = models.get(partId);
        const topo = m && !(m instanceof Error) ? topologyOf(m) : null;
        let depth = { depth: d * 2, through: true };
        try {
          if (topo) depth = holeDepth(topo, hole.p, hole.n, hole.radius || d / 2);
        } catch (e) {
          console.warn("Layers: the hole's depth couldn't be measured", e);
        }
        length = fitLength(d, depth, head);
      }
      const spec: ScrewSpec = { d, length, head };
      screwSpecs.set(key, spec);
      return spec;
    }

    /** The holes a click fills: this one, or (Shift) every one like it on the part. */
    const holeSets = new Map<string, Snap[]>();
    function holesFor(partId: string, hole: Snap, all: boolean): Snap[] {
      if (!all) return [hole];
      const key = `${partId}:${hole.p.join(",")}:${hole.n.join(",")}`;
      let set = holeSets.get(key);
      if (!set) {
        const m = models.get(partId);
        const topo = m && !(m instanceof Error) ? topologyOf(m) : null;
        set = topo ? matchingHoles(topo, hole) : [hole];
        holeSets.set(key, set);
      }
      return set;
    }

    /** What the label by the hole says: the screw it takes, and how many holes a Shift-click fills. */
    function screwHint(partId: string, hole: Snap): string {
      const spec = screwFor(partId, hole);
      if (!shiftDown) return `${screwLabel(spec)} · Shift: all like it`;
      const n = holesFor(partId, hole, true).length;
      return `${screwLabel(spec)} in ${n} hole${n === 1 ? "" : "s"}`;
    }

    /** The screw already in this hole of this part, if any. */
    function screwIn(partId: string, hole: Snap): ScenePart | undefined {
      return scene.parts.find(p => {
        if (!p.screw || p.parent !== partId || !p.joint?.point) return false;
        const j = p.joint;
        return Math.hypot(j.point![0] - hole.p[0], j.point![1] - hole.p[1], j.point![2] - hole.p[2]) < 0.05 && j.normal[0] * hole.n[0] + j.normal[1] * hole.n[1] + j.normal[2] * hole.n[2] > 0.99;
      });
    }

    /** Each size's model, packed to carry in the graphic, made once (copies share it when saved). */
    const screwData = new Map<string, Promise<string>>();
    function screwModelData(spec: ScrewSpec): Promise<string> {
      const key = JSON.stringify(spec);
      let d = screwData.get(key);
      if (!d) {
        d = packMesh(screwMesh(spec).positions);
        screwData.set(key, d);
        d.catch(() => screwData.delete(key));
      }
      return d;
    }

    let screwBusy = false;
    async function screwClick(all: boolean): Promise<void> {
      if (screwBusy) return;
      const snaps = hoverSnaps();
      const hole = hover && hover.snap >= 0 ? snaps[hover.snap] : undefined;
      const parent = hover ? partById(hover.id) : undefined;
      if (!hover || !hole || !parent) {
        status("Click a round hole to put a screw in it. Esc to stop.", true, true);
        return;
      }
      screwBusy = true;
      try {
        const holes = holesFor(parent.id, hole, all);
        let added = 0;
        let changed = 0;
        let last: ScrewSpec | null = null;
        for (const h of holes) {
          const spec = screwFor(parent.id, h);
          last = spec;
          const had = screwIn(parent.id, h);
          if (had && JSON.stringify(had.screw) === JSON.stringify(spec)) continue;
          const built = screwMesh(spec);
          const data = await screwModelData(spec);
          if (closed) return;
          const part: ScenePart = had || { id: newPartId(scene.parts), name: "", position: [0, 0, 0], rotation: [0, 0, 0] };
          part.name = screwName(spec);
          part.file = screwFile(spec);
          part.data = data;
          part.screw = spec;
          part.parent = parent.id;
          part.joint = {
            normal: [round(h.n[0], 5), round(h.n[1], 5), round(h.n[2], 5)],
            distance: screwLift(spec),
            point: [round(h.p[0], 3), round(h.p[1], 3), round(h.p[2], 3)],
            childPoint: built.contact.map(n => round(n, 4)) as Vec3,
            childNormal: built.normal,
            spin: 0,
            gap: 0,
          };
          // Drawn out of its hole here; the next step draws it fitted.
          if (!had) part.explode = 1;
          applyJoint(part);
          const model = modelFromPositions(built.positions, null);
          opts.store.put(part, model);
          keepModel(part, model);
          if (had) changed++;
          else {
            scene.parts.push(part);
            added++;
          }
        }
        if (!added && !changed) {
          status(holes.length > 1 ? `Those holes have ${screwLabel(last!)} ${screwNoun(last!)}s in already.` : `That hole has an ${screwLabel(last!)} ${screwNoun(last!)} in already. Undo (Ctrl+Z) takes one out.`);
          return;
        }
        clearHover();
        rebuild();
        syncExplode();
        commit();
        renderProps();
        const what = added + changed === 1 ? `An ${screwLabel(last!)} ${screwNoun(last!)}` : `${added + changed} ${screwLabel(last!)} ${screwNoun(last!)}s`;
        status(`${what} ${changed && !added ? "changed" : "put in"} “${parent.name}”. Click more holes, or Esc when done.`, false, true);
      } finally {
        screwBusy = false;
      }
    }

    // ------------------------------------------------------------ the wire tool

    // Arm it (the Wire button, or W). The first click on a part puts a plug
    // there (in a socket already on the part, or a new one on the face
    // clicked); each click after that adds a waypoint on the face clicked;
    // clicking a socket, or Shift-clicking a face, ends the wire with a plug
    // there. Enter ends it at the last waypoint; Esc drops the wire being
    // made, then puts the tool away. Each end and waypoint belongs to its
    // part, so the wire follows the parts as they move or explode.

    interface WireChoice { color: string | "auto"; diameter: number; slack: number; connector: string; cores: number }
    const WIRE_KEY = "layers.wireTool";
    const readWireChoice = (): WireChoice => {
      try {
        const v = JSON.parse(localStorage.getItem(WIRE_KEY) || "null") as Partial<WireChoice> | null;
        if (v) {
          return {
            color: typeof v.color === "string" && (v.color === "auto" || /^#[0-9a-f]{6}$/i.test(v.color)) ? v.color : "auto",
            diameter: Number.isFinite(v.diameter) ? Math.max(WIRE_LIMITS.diameter[0], Math.min(WIRE_LIMITS.diameter[1], Number(v.diameter))) : WIRE_DEFAULTS.diameter,
            slack: Number.isFinite(v.slack) ? Math.max(0, Math.min(WIRE_LIMITS.slack[1], Number(v.slack))) : WIRE_DEFAULTS.slack,
            connector: v.connector === BARE_PIN || connectorOf(String(v.connector || "")) ? String(v.connector) : DEFAULT_CONNECTOR,
            cores: Number.isInteger(v.cores) ? Math.max(1, Math.min(WIRE_LIMITS.cores, Number(v.cores))) : 1,
          };
        }
      } catch {
        /* storage off: the defaults */
      }
      return { color: "auto", diameter: WIRE_DEFAULTS.diameter, slack: WIRE_DEFAULTS.slack, connector: DEFAULT_CONNECTOR, cores: 1 };
    };
    let wireChoice = readWireChoice();
    /** Armed while true. */
    let wiringOn = false;
    /**
     * Placing a linked part's port on its model (its Pins, under Wiring
     * diagram), with the wire tool's picking: `plug` set, the socket a plug
     * of that connector goes in (one click); null, its pins one by one, from
     * `pins[at]` (each a bare pin: a tab, a terminal, a battery snap).
     */
    let pinPick: { part: string; port: string; plug: string | null; pins: string[]; at: number } | null = null;
    /** One end of a wire being made: a socket on a part (one already there, or one to add). */
    interface DraftEnd { part: string; socket: PartSocket; fresh: boolean }
    let wireDraft: { from: DraftEnd; waypoints: WireWaypoint[] } | null = null;
    /** The socket under the pointer while wiring, if any. */
    let socketHover: { part: string; socket: PartSocket } | null = null;
    /** A wire end being moved: picked up off its plug or pin, dropped on another socket or face. */
    interface EndCarry { wire: string; end: "from" | "to"; armed: boolean; justPicked: boolean }
    let endCarry: EndCarry | null = null;
    /** A placed wire's end under the pointer (wire tool, nothing being made): a click picks it up. */
    let endHover: { wire: string; end: "from" | "to" } | null = null;
    const wireBar = $(".lyr-wire-bar");
    const connectorOptions = (on: string) => CONNECTOR_FAMILIES.map(f => `<optgroup label="${esc(f.label)}">${f.ways.map(n => {
      const id = `${f.id}-${n}`;
      return `<option value="${id}"${id === on ? " selected" : ""}>${esc(`${f.label}, ${n} way`)}</option>`;
    }).join("")}</optgroup>`).join("");

    function renderWireBar(): void {
      if (pinPick) return renderPinBar(pinPick);
      const used = scene.parts.flatMap(p => (p.wire ? [p.wire.color] : []));
      const auto = nextWireColour(used);
      wireBar.innerHTML = `
        <span class="lyr-screw-bar-title">${icon("wire", 16)}<span>Wire</span></span>
        <label title="The wire's colour. Auto: the next colour not used yet"><span>Colour</span><select data-wire="color"><option value="auto"${wireChoice.color === "auto" ? " selected" : ""}>Auto (${esc(wireColourName(auto))})</option>${WIRE_COLOURS.map(c => `<option value="${c.id}"${wireChoice.color === c.id ? " selected" : ""}>${esc(c.label)}</option>`).join("")}</select></label>
        <label title="How many wires: more than one makes a cable, its wires side by side from each plug (a servo lead is 3)"><span>Wires</span><input type="number" min="1" max="${WIRE_LIMITS.cores}" step="1" data-wire="cores" value="${wireChoice.cores}"></label>
        <label title="Mm across (each wire's, in a cable)"><span>Ø</span><input type="number" min="${WIRE_LIMITS.diameter[0]}" max="${WIRE_LIMITS.diameter[1]}" step="0.1" data-wire="diameter" value="${wireChoice.diameter}"><span>mm</span></label>
        <label title="Mm of extra length: the wire bows out between the points it passes"><span>Slack</span><input type="number" min="0" max="${WIRE_LIMITS.slack[1]}" step="1" data-wire="slack" value="${wireChoice.slack}"><span>mm</span></label>
        <label title="The plug a new socket takes (the STS3215 servo lead's is Molex Mini-SPOX 5264, 3 way); None: the wire ends on a bare pin, tab or terminal"><span>Plug</span><select data-wire="connector"><option value="${BARE_PIN}"${wireChoice.connector === BARE_PIN ? " selected" : ""}>None (bare pin)</option>${connectorOptions(wireChoice.connector)}</select></label>
        <button type="button" class="lyr-btn lyr-icon-btn" data-act="wire-stop" title="Stop making wires (Esc)" aria-label="Stop">${icon("close", 16)}</button>`;
    }
    wireBar.addEventListener("change", e => {
      const el = e.target as HTMLInputElement | HTMLSelectElement;
      const key = el.dataset.wire;
      if (key === "color") wireChoice.color = el.value;
      else if (key === "connector") wireChoice.connector = el.value === BARE_PIN || connectorOf(el.value) ? el.value : DEFAULT_CONNECTOR;
      if (el.dataset.pinPlug !== undefined && pinPick) pinPick.plug = connectorOf(el.value) ? el.value : pinPick.plug;
      else if (key === "diameter") wireChoice.diameter = Math.max(WIRE_LIMITS.diameter[0], Math.min(WIRE_LIMITS.diameter[1], Number(el.value) || WIRE_DEFAULTS.diameter));
      else if (key === "slack") wireChoice.slack = Math.max(0, Math.min(WIRE_LIMITS.slack[1], Number(el.value) || 0));
      else if (key === "cores") wireChoice.cores = Math.max(1, Math.min(WIRE_LIMITS.cores, Math.round(Number(el.value) || 1)));
      try {
        localStorage.setItem(WIRE_KEY, JSON.stringify(wireChoice));
      } catch {
        /* storage off: kept for now */
      }
      drawWirePreview();
    });
    wireBar.addEventListener("click", e => {
      if ((e.target as HTMLElement).closest("[data-act=wire-stop]")) stopWires();
    });
    wireBar.addEventListener("keydown", e => {
      if (e.key === "Escape") {
        e.stopPropagation();
        stopWires();
      }
    });

    function startWires(): void {
      stopScrews();
      if (joining) stopJoin();
      if (trackPick) stopTrackPick();
      if (section.picking()) section.stop("");
      wiringOn = true;
      wireDraft = null;
      renderWireBar();
      wireBar.hidden = false;
      $("[data-act=wire]").classList.add("lyr-on");
      canvasEl.classList.add("lyr-scene-picking");
      attachGizmo();
      layout();
      status("Click a part where the first plug goes: a socket's face, or a dot for a socket already there. To move a wire's end, drag it (or click it, then click where it goes).", false, true);
    }

    function stopWires(message = ""): void {
      if (!wiringOn) return;
      if (endCarry) putEndBack();
      wiringOn = false;
      wireDraft = null;
      socketHover = null;
      endHover = null;
      if (pinPick) {
        pinPick = null;
        renderProps();
      }
      wireBar.hidden = true;
      $("[data-act=wire]").classList.remove("lyr-on");
      canvasEl.classList.remove("lyr-scene-picking");
      drawWirePreview();
      clearHover();
      attachGizmo();
      layout();
      status(message);
    }

    /** Every socket on a shown part, where it is on the view. */
    function socketsOnView(): { part: string; socket: PartSocket; x: number; y: number }[] {
      const out: { part: string; socket: PartSocket; x: number; y: number }[] = [];
      for (const p of scene.parts) {
        if (!p.sockets?.length || p.hidden) continue;
        const g = art.groupOf(p.id);
        if (!g) continue;
        g.updateMatrixWorld(true);
        for (const s of p.sockets) {
          const v = new Vector3(...s.point).applyMatrix4(g.matrixWorld).project(camera);
          out.push({ part: p.id, socket: s, x: ((v.x + 1) / 2) * viewW, y: ((1 - v.y) / 2) * viewH });
        }
      }
      return out;
    }

    /** The plug sitting in a socket, if one is. */
    const plugIn = (partId: string, socketId: string) => scene.parts.find(p => p.plug?.socket === socketId && p.parent === partId);

    /** The socket a wire end would take from the pointer now: a socket's dot, or a new one on the face (with its snap). */
    function wireTarget(): DraftEnd | null {
      if (socketHover) return { part: socketHover.part, socket: socketHover.socket, fresh: false };
      const pick = hoverPick();
      const p = pick ? partById(pick.id) : undefined;
      if (!pick || !p || isWiring(p)) return null;
      const socket: PartSocket = { id: newSocketId(p.sockets), point: pick.point, normal: pick.normal, connector: endCarry ? carriedConnector(endCarry) : wireChoice.connector };
      return { part: p.id, socket, fresh: true };
    }

    /** A waypoint at the point under the pointer (on its face), or null off the parts. */
    function wireWaypointHere(): WireWaypoint | null {
      const pick = hoverPick();
      const p = pick ? partById(pick.id) : undefined;
      if (!pick || !p || isWiring(p)) return null;
      return { part: pick.id, point: pick.point, normal: pick.normal };
    }

    let wireBusy = false;
    function wireClick(shift: boolean): void {
      if (wireBusy) return;
      if (pinPick) return pinClick();
      if (endCarry) {
        // The click that picked it up isn't the drop.
        if (endCarry.justPicked) return;
        const t = wireTarget();
        if (!t) {
          status("Click a socket, a pin or a face to drop the end there, or Esc to put it back.", true, true);
          return;
        }
        void dropEnd(t);
        return;
      }
      if (!wireDraft) {
        const t = wireTarget();
        if (!t) {
          status("Click a part where the wire starts. Esc to stop.", true, true);
          return;
        }
        wireDraft = { from: t, waypoints: [] };
        status(`Wire started at ${partById(t.part)?.name || "the part"}. Click faces for it to pass over, then click a socket (or Shift-click a face) to end it.`, false, true);
        drawWirePreview();
        return;
      }
      if (socketHover || shift) {
        const t = wireTarget();
        if (!t) return;
        if (t.part === wireDraft.from.part && t.socket.id === wireDraft.from.socket.id && !t.fresh) {
          status("That's where the wire starts: end it at another socket.", true);
          return;
        }
        void finishWire(t);
        return;
      }
      const w = wireWaypointHere();
      if (!w) return;
      wireDraft.waypoints.push(w);
      status(`${wireDraft.waypoints.length} waypoint${wireDraft.waypoints.length === 1 ? "" : "s"}. Click a socket or Shift-click a face to end the wire there, Enter to end it at the last point, Esc to drop it.`, false, true);
      drawWirePreview();
    }

    /** Ends the wire being made at its last waypoint (Enter). */
    function endWireHere(): void {
      if (!wireDraft || pinPick) return;
      const last = wireDraft.waypoints.pop();
      if (!last?.part || !last.point || !last.normal) {
        status("Click at least one point past the first plug, or click a socket to end the wire.", true);
        return;
      }
      const p = partById(last.part)!;
      void finishWire({ part: p.id, socket: { id: newSocketId(p.sockets), point: last.point, normal: last.normal, connector: wireChoice.connector }, fresh: true });
    }

    // ------------------------------------------------------------ moving a wire's end

    // As in the 2D wiring editor, a placed wire's end can be picked up and
    // put somewhere else: with the wire tool, click (or drag) an end; with a
    // wire picked, its end handles do the same. The end then follows the
    // pointer, snapping to sockets and pins as a new wire's does, and a click
    // drops it there (a new socket on a face, Shift not needed). Its
    // waypoints stay; a plug no wire is in any more goes. Esc puts it back.

    /** Where a wire end is on the view. */
    function wireEndsOnView(): { wire: string; end: "from" | "to"; x: number; y: number }[] {
      const out: { wire: string; end: "from" | "to"; x: number; y: number }[] = [];
      const world = worldMatrices(scene.parts, scene.explode);
      for (const p of scene.parts) {
        if (!p.wire || p.hidden) continue;
        for (const end of ["from", "to"] as const) {
          const e = p.wire[end];
          const m = world.get(e.part);
          if (!m) continue;
          const v = new Vector3(...e.point).applyMatrix4(m).project(camera);
          if (v.z > 1) continue;
          out.push({ wire: p.id, end, x: ((v.x + 1) / 2) * viewW, y: ((1 - v.y) / 2) * viewH });
        }
      }
      return out;
    }

    /** The part a wire end is on: its plug's part, or the part with the bare pin. */
    function endHost(e: WireEnd): ScenePart | undefined {
      const on = partById(e.part);
      return on?.plug && on.parent ? partById(on.parent) : on;
    }

    /** The connector the carried end has (its plug's), so a new socket takes the same. */
    function carriedConnector(c: EndCarry): string {
      const e = wireById(c.wire)?.wire?.[c.end];
      const on = e ? partById(e.part) : undefined;
      return on?.plug?.connector || BARE_PIN;
    }

    /** Which of its plug's pins a wire of its own leaves from (pin 1 is 0); none for a whole cable or a bare pin. */
    function endPinIndex(e: WireEnd): number | undefined {
      const plug = partById(e.part);
      if (!plug?.plug) return undefined;
      const exit = plugExit(plug);
      const row = exit.row || [1, 0, 0];
      // Out of the plug's back as a whole (a cable, or a lone wire): no one pin.
      if (e.row) return undefined;
      const k = e.point.reduce((sum, v, i) => sum + (v - exit.point[i]) * row[i], 0);
      const n = connectorOf(plug.plug.connector)?.ways || 1;
      return Math.round(k / (exit.pitch || 2.54) + (n - 1) / 2);
    }

    /** Picks up a wire's end: it follows the pointer until dropped. `armed`: the wire tool was armed for this. */
    function pickUpEnd(wireId: string, end: "from" | "to", armed: boolean): void {
      const p = wireById(wireId);
      if (!p?.wire) return;
      if (selectedId !== wireId) select(wireId);
      endCarry = { wire: wireId, end, armed, justPicked: true };
      endHover = null;
      showCarried(false);
      renderWireBar();
      status(`Moving the ${end === "from" ? "first" : "far"} end of ${p.name}: click a socket, a pin or a face to drop it there. Esc puts it back.`, false, true);
      drawWirePreview();
    }

    /**
     * The press that picked an end up: dragged, the end drops where it's
     * let go; a click leaves it on the pointer for the next click to drop.
     */
    function carryPress(e: PointerEvent): void {
      const x0 = e.clientX, y0 = e.clientY;
      let dragged = false;
      orbit.enabled = false;
      const onMove = (m: PointerEvent) => {
        if (!endCarry) return;
        if (!dragged && Math.hypot(m.clientX - x0, m.clientY - y0) <= 4) return;
        dragged = true;
        hoverAt(m);
        drawWirePreview();
      };
      const onUp = (u: PointerEvent) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        orbit.enabled = true;
        if (!endCarry) return;
        endCarry.justPicked = false;
        if (!dragged || u.type === "pointercancel") return;
        hoverAt(u);
        const t = wireTarget();
        if (t) void dropEnd(t);
        else status("Not on a part: click a socket, a pin or a face to drop the end, or Esc to put it back.", true, true);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    }

    // With the wire tool, pressing on a placed wire's end picks it up.
    canvasEl.addEventListener("pointerdown", e => {
      if (!wiringOn || e.button !== 0 || wireDraft || endCarry || pinPick || wireBusy) return;
      hoverAt(e);
      if (!endHover) return;
      pickUpEnd(endHover.wire, endHover.end, false);
      carryPress(e);
    });

    /** Puts the carried end back as it was. */
    /** The carried wire, and the plug it's leaving when no other wire is in it, shown or left out as it moves. */
    function showCarried(shown: boolean): void {
      if (!endCarry) return;
      art.setShown(endCarry.wire, shown);
      const e = wireById(endCarry.wire)?.wire?.[endCarry.end];
      const plug = e && partById(e.part)?.plug ? partById(e.part) : undefined;
      if (plug && !scene.parts.some(w => w.wire && w.id !== endCarry!.wire && (w.wire.from.part === plug.id || w.wire.to.part === plug.id))) art.setShown(plug.id, shown);
    }

    function putEndBack(): void {
      if (!endCarry) return;
      showCarried(true);
      endCarry = null;
      preview.visible = false;
      renderWireBar();
      draw();
    }

    /** Whether a draft end is where a wire end is now (the same socket, or the same bare pin). */
    function endIsAt(e: WireEnd, t: DraftEnd): boolean {
      if (t.fresh) return false;
      const on = partById(e.part);
      if (on?.plug) return on.parent === t.part && on.plug.socket === t.socket.id;
      return e.part === t.part && e.point.every((v, i) => Math.abs(v - t.socket.point[i]) < 0.01);
    }

    /** Drops the carried end on this socket (or a new one), and lays the wire again. */
    async function dropEnd(t: DraftEnd): Promise<void> {
      const c = endCarry;
      const p = c ? wireById(c.wire) : undefined;
      if (!c || !p?.wire || wireBusy) return;
      const other = p.wire[c.end === "from" ? "to" : "from"];
      if (endIsAt(other, t)) {
        status("The wire's other end is there: drop this one somewhere else.", true);
        return;
      }
      const old = p.wire[c.end];
      if (endIsAt(old, t)) {
        putEndBack();
        if (c.armed) stopWires("The end is where it was.");
        else status("The end is where it was.", false, true);
        return;
      }
      wireBusy = true;
      try {
        const oldName = wireName(p.wire, endHost(p.wire.from)?.name || "", endHost(p.wire.to)?.name || "");
        const oldPlug = partById(old.part)?.plug ? partById(old.part) : undefined;
        // Where it was in the 2D wiring diagram (before its plug goes).
        const wasOn = diagramEnd(old);
        let index = endPinIndex(old);
        const ways = isBarePin(t.socket) ? 1 : connectorOf(t.socket.connector)?.ways || 1;
        if (index !== undefined) index = Math.max(0, Math.min(ways - 1, index));
        const moved = await wireEndAt(t, index);
        if (closed) return;
        p.wire = { ...p.wire, [c.end]: moved };
        const unlinked = await afterEndMoved(p, wasOn, moved);
        if (closed) return;
        if (p.name === oldName) p.name = wireName(p.wire, endHost(p.wire.from)?.name || "", endHost(p.wire.to)?.name || "");
        // The plug it left goes, when no other wire is in it.
        if (oldPlug && oldPlug.id !== moved.part && !scene.parts.some(w => w.wire && (w.wire.from.part === oldPlug.id || w.wire.to.part === oldPlug.id))) {
          scene.parts = scene.parts.filter(x => x.id !== oldPlug.id);
          models.delete(oldPlug.id);
        }
        endCarry = null;
        preview.visible = false;
        renderWireBar();
        clearHover();
        rebuild();
        commit();
        renderProps();
        const msg = `Moved the end of ${p.name} to ${endHost(moved)?.name || "the part"}.${unlinked}`;
        if (c.armed) stopWires(msg);
        else status(`${msg} Click a part to start a wire, or a wire's end to move it.`, false, true);
      } finally {
        wireBusy = false;
      }
    }

    /**
     * After an end has moved: the wire's 2D wiring links, as its new ends
     * have them (the diagram's cable between its ports, if there is one).
     * Says what changed, or "".
     */
    async function afterEndMoved(p: ScenePart, wasOn: DiagramEnd | null, moved: WireEnd): Promise<string> {
      if (!p.wire) return "";
      const had = connectionsOf(p.wire);
      // Linked to the diagram: its connections move to the new pins there too.
      const nowOn = diagramEnd(moved);
      let failed = "";
      if (had.length && diagram && wasOn && nowOn) {
        if (wasOn.part === nowOn.part && wasOn.port === nowOn.port) return "";
        const changes = movedConnections(diagram, had, wasOn, nowOn, endPinIndex(moved));
        if (changes && wiringHost?.updateConnections) {
          if (!changes.length) return "";
          try {
            const saved = await wiringHost.updateConnections(changes);
            const byId = new Map(saved.map(x => [x.id, x]));
            diagram = { ...diagram, connections: diagram.connections.map(x => byId.get(x.id) || x) };
            return ` The wiring diagram has it on ${portName(nowOn)} now too.`;
          } catch (err) {
            failed = ` Couldn't change the wiring diagram (${(err as Error).message || err}).`;
          }
        }
      }
      const plain = withCoreList(p.wire, coresOf(p.wire).map(k => ({ color: k.color })));
      p.wire = plain;
      const linked = linkToDiagram(p);
      if (linked) return `${failed} It's the wiring diagram's ${linked} now.`;
      if (!had.length) return failed;
      return `${failed} It's no longer linked to the wiring diagram, which is unchanged: ${nowOn ? "its pins there don't fit" : "it isn't on one of the diagram's pins now"}.`;
    }

    /** The carried end's wire drawn to the pointer (or as it was, off the parts). */
    function drawCarryPreview(): void {
      const c = endCarry!;
      const p = wireById(c.wire);
      if (!p?.wire) return draw();
      const t = wireTarget();
      if (!t) {
        showCarried(true);
        return draw();
      }
      showCarried(false);
      const lead = (s: PartSocket) => (isBarePin(s) ? 0 : connectorMesh(s.connector).size[2]);
      const to: WireEnd = { part: t.part, point: t.socket.point.map((v, i) => v + t.socket.normal[i] * lead(t.socket)) as Vec3, normal: t.socket.normal };
      const spec: WireSpec = { ...p.wire, [c.end]: to };
      const world = worldMatrices(scene.parts, scene.explode);
      const tris = wireTriangles({ id: "", name: "", position: [0, 0, 0], rotation: [0, 0, 0], wire: spec }, world, loomsOf(scene.parts.filter(x => x.id !== p.id)));
      preview.geometry.dispose();
      preview.geometry = new BufferGeometry();
      preview.geometry.setAttribute("position", new BufferAttribute(tris, 3));
      previewMaterial.color.set(spec.color);
      preview.visible = tris.length > 0;
      draw();
    }

    // ------------------------------------------------------------ the pins on a part's model

    // A part linked to the 2D wiring diagram has its ports and pins from the
    // diagram's pinout. Pins (under Wiring diagram) says where each is on
    // its model: a port a plug goes in (JST, Molex, Dupont) as the plug's
    // socket, its pins following the connector's pitch; or each pin on its
    // own (a motor's tabs, a battery snap, a screw terminal), the wire ending
    // right on it. Picking works as the joint picker's does: the face's
    // natural points (hole and rim centres, middles, corners) snap. Wires
    // then start where the pins are, and "Save pins to the catalog part"
    // keeps them for every project.

    /** The connector a plug for a port of `n` pins would be: the one there, else one that fits. */
    function plugForPort(n: number, had?: string): string | null {
      if (had && connectorOf(had)?.ways === n) return had;
      const like = connectorOf(wireChoice.connector);
      if (like && like.family.ways.includes(n)) return `${like.family.id}-${n}`;
      const f = CONNECTOR_FAMILIES.find(x => x.ways.includes(n));
      return f ? `${f.id}-${n}` : null;
    }

    const pinLabel = (w: WiringPart | undefined, pin: string) => {
      const q = w?.ports.flatMap(x => x.pins).find(x => x.name === pin);
      return q?.label && q.label !== pin ? `${pin} (${q.label})` : pin;
    };

    /** What's being placed now, for the pointer's label. */
    function pinPickLabel(pp: NonNullable<typeof pinPick>): string {
      const w = diagram?.parts.find(x => x.id === partById(pp.part)?.wiringPart);
      const port = portById(w, pp.port);
      if (pp.plug) return `${port?.name || "Port"} socket`;
      return `Pin ${pinLabel(w, pp.pins[pp.at] || "")}`;
    }

    function renderPinBar(pp: NonNullable<typeof pinPick>): void {
      const w = diagram?.parts.find(x => x.id === partById(pp.part)?.wiringPart);
      const port = portById(w, pp.port);
      const n = port?.pins.length || 1;
      const plugs = CONNECTOR_FAMILIES.filter(f => f.ways.includes(n)).map(f => `${f.id}-${n}`);
      wireBar.innerHTML = `
        <span class="lyr-screw-bar-title">${icon("plug", 16)}<span>Pins</span></span>
        <span class="lyr-play-name">${esc(`${w?.name || ""} ${port?.name || ""}`.trim())}${pp.plug ? "" : ` · pin ${Math.min(pp.at + 1, pp.pins.length)} of ${pp.pins.length}: ${esc(pinLabel(w, pp.pins[pp.at] || ""))}`}</span>
        ${pp.plug ? `<label title="The plug that goes in this port"><span>Plug</span><select data-pin-plug>${plugs.map(id => `<option value="${id}"${id === pp.plug ? " selected" : ""}>${esc(connectorOf(id)!.name)}</option>`).join("")}</select></label>` : ""}
        <button type="button" class="lyr-btn lyr-icon-btn" data-act="wire-stop" title="Done (Esc)" aria-label="Done">${icon("close", 16)}</button>`;
    }

    /** Starts placing a port of the picked part: its plug's socket, or its pins from `pin` (the first not placed, else the first). */
    function startPinPick(p: ScenePart, portId: string, plug: boolean, pin?: string): void {
      const w = diagram?.parts.find(x => x.id === p.wiringPart);
      const port = portById(w, portId);
      if (!w || !port) return;
      if (plug && !plugForPort(port.pins.length)) {
        status(`No plug in the list has ${port.pins.length} ways: place its pins one by one.`, true);
        return;
      }
      const placed = portPlacements(w, p.sockets).find(x => x.port.id === portId);
      const names = port.pins.map(q => q.name);
      // One pin: it, then the port's others not placed yet (one placed: just it); else every pin, from the first one not placed yet.
      const pins = pin ? (placed?.pins.has(pin) ? [pin] : [pin, ...names.filter(n => n !== pin && !placed?.pins.has(n))]) : names;
      const at = pin ? 0 : Math.max(0, names.findIndex(n => !placed?.pins.has(n)));
      startWires();
      setPinFocus(p.id);
      pinPick = { part: p.id, port: portId, plug: plug ? plugForPort(port.pins.length, placed?.plug?.connector) : null, pins, at };
      renderWireBar();
      select(p.id);
      status(plug ? `Click where ${port.name}'s socket is on ${p.name}: the face the plug goes in against (its middle, or a hole or rim). Esc when done.` : `Click pin ${pinLabel(w, pins[at])} on ${p.name}: the base of a tab or terminal, or a hole's centre. Esc when done.`, false, true);
    }

    function pinClick(): void {
      const pp = pinPick;
      if (!pp) return;
      const pick = hoverPick();
      const p = partById(pp.part);
      if (!p) return stopWires();
      if (!pick || pick.id !== p.id) {
        status(`Click on ${p.name}: ${pinPickLabel(pp)} is on it.`, true, true);
        return;
      }
      const w = diagram?.parts.find(x => x.id === p.wiringPart);
      const port = portById(w, pp.port);
      if (pp.plug) {
        placePlugSocket(p, pp.port, port?.name || pp.port, pp.plug, pick.point, pick.normal);
        commit();
        stopWires(`${port?.name || "The port"}'s socket placed on ${p.name}: wires from the diagram plug in there.`);
        return;
      }
      placePin(p, pp.port, pp.pins[pp.at], pinLabel(w, pp.pins[pp.at]), pick.point, pick.normal);
      commit();
      pp.at++;
      if (pp.at >= pp.pins.length) {
        stopWires(pp.pins.length === 1 ? `Pin ${pinLabel(w, pp.pins[0])} placed on ${p.name}.` : `${port?.name || "Port"}: all ${pp.pins.length} pins placed on ${p.name}.`);
        return;
      }
      renderWireBar();
      draw();
      status(`Pin ${pinLabel(w, pp.pins[pp.at - 1])} placed. Now click pin ${pinLabel(w, pp.pins[pp.at])}.`, false, true);
    }

    /** Whether a wire ends on this point of a part (a bare pin there). */
    const wiresAt = (part: string, point: Vec3) => scene.parts.filter(q => q.wire && [q.wire.from, q.wire.to].some(e => e.part === part && e.point.every((v, i) => Math.abs(v - point[i]) < 0.01)));

    /** Puts a port's plug socket on the part here (moving the one there, and its plug), dropping its bare pins no wire is on. */
    function placePlugSocket(p: ScenePart, portId: string, name: string, connector: string, point: Vec3, normal: Vec3): void {
      const had = p.sockets?.find(s => s.port === portId && !isBarePin(s));
      let sockets = (p.sockets || []).filter(s => !(isBarePin(s) && s.port === portId && !wiresAt(p.id, s.point).length));
      if (had) {
        sockets = sockets.map(s => (s.id === had.id ? { ...s, point, normal, connector } : s));
      } else {
        sockets.push({ id: newSocketId(p.sockets), point, normal, connector, port: portId, name });
      }
      p.sockets = sockets;
      const plug = had ? plugIn(p.id, had.id) : undefined;
      if (plug?.joint) {
        plug.joint = { ...plug.joint, point: point.map(v => round(v, 3)) as Vec3, normal: normal.map(v => round(v, 5)) as Vec3 };
        applyJoint(plug);
        if (plug.plug?.connector !== connector) void setPlugConnector(plug, connector);
        else {
          rebuild();
          renderProps();
        }
      } else {
        draw();
        renderProps();
      }
    }

    /** Puts a bare pin on the part here (moving the one there, and the wires on it), dropping the port's empty plug socket. */
    function placePin(p: ScenePart, portId: string, pin: string, name: string, point: Vec3, normal: Vec3): void {
      const had = p.sockets?.find(s => isBarePin(s) && s.pin === pin);
      let sockets = (p.sockets || []).filter(s => !(s.port === portId && !isBarePin(s) && !plugIn(p.id, s.id)));
      if (had) {
        for (const q of wiresAt(p.id, had.point)) {
          const at = (e: WireEnd) => (e.part === p.id && e.point.every((v, i) => Math.abs(v - had.point[i]) < 0.01) ? { ...e, point: [...point] as Vec3, normal: [...normal] as Vec3 } : e);
          q.wire = { ...q.wire!, from: at(q.wire!.from), to: at(q.wire!.to) };
        }
        sockets = sockets.map(s => (s.id === had.id ? { ...s, point, normal } : s));
      } else {
        const s: PartSocket = { id: newSocketId(p.sockets), point, normal, connector: BARE_PIN, pin, name };
        if (!portId.startsWith("pin:")) s.port = portId;
        sockets.push(s);
      }
      p.sockets = sockets;
      rebuild();
      renderProps();
    }

    /** Takes a port's pins or plug socket off the part (those no wire or plug is on). */
    function clearPort(p: ScenePart, portId: string, pins: string[]): void {
      const before = p.sockets?.length || 0;
      p.sockets = (p.sockets || []).filter(s => {
        const mine = isBarePin(s) ? !!s.pin && pins.includes(s.pin) : s.port === portId;
        if (!mine) return true;
        return isBarePin(s) ? wiresAt(p.id, s.point).length > 0 : !!plugIn(p.id, s.id);
      });
      const gone = before - p.sockets.length;
      if (!p.sockets.length) delete p.sockets;
      draw();
      renderProps();
      commit();
      status(gone ? `Took ${gone === 1 ? "it" : `${gone} of them`} off ${p.name}.` : "Each has a wire or plug on it: take those off first.", !gone);
    }

    /** A linked part's ports, how far each is placed on its model, and the buttons to place them. */
    function pinsPanel(p: ScenePart, w: WiringPart): string {
      const list = portPlacements(w, p.sockets);
      if (!list.length) return `<p class="lyr-note">${esc(w.name)} has no pins in the wiring diagram's pinout.</p>`;
      const rows = list.map((x: PortPlacement) => {
        const n = x.port.pins.length;
        const c = x.plug ? connectorOf(x.plug.connector) : null;
        const state = x.plug ? `${c ? `${c.family.label} ${c.ways}-way` : "Plug"} socket` : x.pins.size ? `${x.pins.size} of ${n} pin${n === 1 ? "" : "s"} placed` : "Not placed";
        const pins = x.port.pins.map(q => {
          const on = x.pins.has(q.name);
          return `<button type="button" class="lyr-pin-chip${on ? " lyr-on" : ""}${x.plug ? " lyr-pin-plugged" : ""}" data-act="pin-one" data-port="${esc(x.port.id)}" data-pin="${esc(q.name)}" title="${on ? "Placed as a bare pin: click to place it again" : "Place this pin on its own"}">${esc(q.label || q.name)}</button>`;
        }).join("");
        const canPlug = !!plugForPort(n, x.plug?.connector);
        return `<div class="lyr-pins-port">
          <div class="lyr-pins-row"><span class="lyr-pins-name" title="${esc(x.port.id)}">${esc(x.port.name)}</span><span class="lyr-pins-state${x.plug || x.pins.size === n ? " lyr-pins-ok" : ""}">${esc(state)}</span></div>
          <div class="lyr-pins-pins">${pins}</div>
          <div class="lyr-pins-acts">
            <button type="button" class="lyr-btn" data-act="pin-plug" data-port="${esc(x.port.id)}"${canPlug ? "" : " disabled"} title="A plug goes in here (JST, Molex, Dupont): click its socket's face on the model, and its pins follow the connector">${icon("plug", 14)}<span>${x.plug ? "Move socket" : "Plug"}</span></button>
            <button type="button" class="lyr-btn" data-act="pin-bare" data-port="${esc(x.port.id)}" title="Wires end right on each pin (tabs, terminals, a battery snap): click each pin on the model in turn">${icon("wire", 14)}<span>${x.pins.size ? "Place pins again" : "Bare pins"}</span></button>
            ${x.plug || x.pins.size ? `<button type="button" class="lyr-btn lyr-icon-btn" data-act="pin-clear" data-port="${esc(x.port.id)}" title="Take these off the model" aria-label="Take these off the model">${icon("close", 14)}</button>` : ""}
          </div>
        </div>`;
      }).join("");
      const model = models.get(p.id);
      const mapped = list.flatMap(x => x.port.pins).filter(q => q.x !== undefined && q.y !== undefined);
      const unplaced = list.flatMap(x => (x.plug ? [] : x.port.pins.filter(q => !x.pins.has(q.name))));
      const fits = model && !(model instanceof Error) && fitsPicture(model.size as Vec3, w);
      const find = mapped.length && unplaced.length
        ? fits
          ? `<button type="button" class="lyr-wide-btn" data-act="pins-find" title="Place each pin not placed yet from where it is on ${esc(w.name)}'s picture">${icon("wand", 14)} Find ${unplaced.length === 1 ? "its pin" : `its ${unplaced.length} pins`} on the model</button>`
          : `<p class="lyr-note">Its model isn't drawn the way its picture is, so its pins can't be found for you: click a pin on the picture, then where it is on the model.</p>`
        : "";
      return `<div class="lyr-pins"><div class="lyr-pins-head">Pins on the model</div>${pinMap(p, w, list)}${find}${rows}</div>`;
    }

    /**
     * The part's 2D picture with its pins on it: green placed, hollow not
     * yet, the one being placed ringed. Clicking one places it on the model
     * (then the rest not placed, in turn).
     */
    /** The least distance between any two points (Infinity for fewer than two). */
    function minGap(pts: number[][]): number {
      let best = Infinity;
      for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) best = Math.min(best, Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]));
      return best;
    }

    function pinMap(p: ScenePart, w: WiringPart, list: PortPlacement[]): string {
      const dots = list.flatMap(x => x.port.pins.filter(q => q.x !== undefined && q.y !== undefined).map(q => ({ port: x.port.id, pin: q, on: !!x.plug || x.pins.has(q.name) })));
      if (!dots.length) return "";
      const [wd, ht] = w.size && w.size[0] > 0 && w.size[1] > 0 ? w.size : [1, 1];
      // Fits the panel's width, at most 180 px tall.
      const vw = 100, vh = Math.min(180, Math.max(40, (vw * ht) / wd));
      const sx = Math.min(vw, (vh * wd) / ht);
      const ox = (vw - sx) / 2;
      // The map is drawn about a pixel a unit: dots big enough to click, smaller when they're close together.
      const r = Math.max(2.5, Math.min(4.5, minGap(dots.map(d => [ox + d.pin.x! * sx, d.pin.y! * vh])) / 2.4));
      const picking = pinPick?.part === p.id && !pinPick.plug ? pinPick.pins[pinPick.at] : "";
      const marks = dots.map(d => {
        const cx = ox + d.pin.x! * sx, cy = d.pin.y! * vh;
        const name = d.pin.label || d.pin.name;
        return `<g class="lyr-pin-dot${d.on ? " lyr-on" : ""}${d.pin.name === picking ? " lyr-picking" : ""}" data-act="pin-one" data-port="${esc(d.port)}" data-pin="${esc(d.pin.name)}" role="button" tabindex="0" aria-label="${esc(`Pin ${name}${d.on ? ", placed" : ""}`)}"><title>${esc(`${name}: ${d.on ? "placed, click to place it again" : "click, then click where it is on the model"}`)}</title><circle cx="${cx}" cy="${cy}" r="${r * 1.8}" class="lyr-pin-hit"/><circle cx="${cx}" cy="${cy}" r="${r}" class="lyr-pin-mark"/>${dots.length <= 12 ? `<text x="${cx}" y="${cy - r - 2}" text-anchor="middle">${esc(name)}</text>` : ""}</g>`;
      }).join("");
      const pic = w.image ? `<image href="${esc(w.image)}" x="${ox}" y="0" width="${sx}" height="${vh}" preserveAspectRatio="none"/>` : `<rect x="${ox}" y="0" width="${sx}" height="${vh}" rx="2" class="lyr-pin-board"/>`;
      return `<svg class="lyr-pin-map" viewBox="0 0 ${vw} ${vh}" style="aspect-ratio:${vw}/${vh}" aria-label="${esc(w.name)}'s pins">${pic}${marks}</svg>`;
    }

    /** Each connector's model, packed to carry, made once. */
    const plugData = new Map<string, Promise<string>>();
    function plugModelData(id: string): Promise<string> {
      let d = plugData.get(id);
      if (!d) {
        d = packMesh(connectorMesh(id).positions);
        plugData.set(id, d);
        d.catch(() => plugData.delete(id));
      }
      return d;
    }

    /** The plug in this socket: the one there, or a new one joined to the part, from the connector's model. */
    async function plugFor(end: DraftEnd): Promise<ScenePart> {
      const host = partById(end.part)!;
      if (end.fresh) {
        // A new socket on a part in the wiring diagram takes the first of its ports that fits and has none.
        if (!end.socket.port && host.wiringPart && diagram) {
          const port = freePort(diagram.parts.find(w => w.id === host.wiringPart), connectorOf(end.socket.connector)?.ways || 0, host.sockets);
          if (port) end.socket = { ...end.socket, port };
        }
        host.sockets = [...(host.sockets || []), end.socket];
      }
      const had = plugIn(host.id, end.socket.id);
      if (had) return had;
      const built = connectorMesh(end.socket.connector);
      const data = await plugModelData(end.socket.connector);
      const c = connectorOf(end.socket.connector);
      const plug: ScenePart = {
        id: newPartId(scene.parts),
        name: c ? `${c.family.label} ${c.ways}-way plug` : "Plug",
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        file: connectorFile(end.socket.connector),
        data,
        parent: host.id,
        plug: { connector: end.socket.connector, socket: end.socket.id },
        joint: {
          normal: end.socket.normal.map(n => round(n, 5)) as Vec3,
          distance: plugLift(end.socket.connector),
          point: end.socket.point.map(n => round(n, 3)) as Vec3,
          childPoint: built.contact,
          childNormal: built.normal,
          spin: end.socket.spin || 0,
          gap: 0,
        },
      };
      applyJoint(plug);
      const model = modelFromPositions(built.positions.slice(), null);
      opts.store.put(plug, model);
      keepModel(plug, model);
      scene.parts.push(plug);
      return plug;
    }

    /** Where a wire leaves a plug (its back), in the plug's frame. */
    function plugExit(plug: ScenePart): WireEnd {
      const id = plug.plug?.connector || DEFAULT_CONNECTOR;
      const m = connectorMesh(id);
      // A cable's wires leave it side by side, one at each pin.
      return { part: plug.id, point: m.exit, normal: m.exitNormal, row: [1, 0, 0], pitch: connectorOf(id)?.family.pitch || 2.54 };
    }

    /**
     * Where a wire ends at this socket: a bare pin's point (the wire soldered
     * or screwed on there), else the back of the plug in it (put in when
     * there's none). A pin of a plug's (`index`, pin 1 is 0) for a wire of
     * its own: that pin's place along the plug's back.
     */
    async function wireEndAt(end: DraftEnd, index?: number): Promise<WireEnd> {
      if (isBarePin(end.socket)) {
        const host = partById(end.part)!;
        if (end.fresh) host.sockets = [...(host.sockets || []), end.socket];
        return { part: end.part, point: [...end.socket.point] as Vec3, normal: [...end.socket.normal] as Vec3 };
      }
      const exit = plugExit(await plugFor(end));
      if (index === undefined) return exit;
      const n = connectorOf(end.socket.connector)?.ways || 1;
      const k = (index - (n - 1) / 2) * (exit.pitch || 2.54);
      return { part: exit.part, point: exit.point.map((v, i) => round(v + (exit.row || [1, 0, 0])[i] * k, 3)) as Vec3, normal: exit.normal };
    }

    async function finishWire(to: DraftEnd): Promise<void> {
      const draft = wireDraft;
      if (!draft || wireBusy) return;
      wireBusy = true;
      try {
        const a = await wireEndAt(draft.from);
        const b = await wireEndAt(to);
        if (closed) return;
        const spec = newWireSpec(a, b, draft.waypoints);
        const from = partById(draft.from.part)?.name || "";
        const toName = partById(to.part)?.name || "";
        const wire: ScenePart = {
          id: newPartId(scene.parts),
          name: wireName(spec, from, toName),
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          wire: spec,
        };
        const linked = linkToDiagram(wire);
        keepModel(wire, emptyModel());
        scene.parts.push(wire);
        wireDraft = null;
        renderWireBar();
        drawWirePreview();
        clearHover();
        rebuild();
        commit();
        status(`${wire.name} added${linked ? `, as the wiring diagram has it (${linked})` : ""}. Click a part to start the next wire, or Esc when done.`, false, true);
      } finally {
        wireBusy = false;
      }
    }

    /** A new wire (or cable) between these ends, as the wire bar has it. */
    function newWireSpec(from: WireEnd, to: WireEnd, waypoints: WireWaypoint[]): WireSpec {
      const used = scene.parts.flatMap(p => (p.wire ? coresOf(p.wire).map(c => c.color) : []));
      const spec: WireSpec = { from, to, waypoints, color: wireChoice.color === "auto" ? nextWireColour(used) : wireChoice.color, diameter: wireChoice.diameter, slack: wireChoice.slack };
      if (wireChoice.cores > 1) {
        spec.cores = cableColours(wireChoice.cores).map(color => ({ color }));
        // A cable's wires are thinner than a lone hookup wire: a servo lead's are about 1.2 mm.
        spec.diameter = Math.min(spec.diameter, CABLE_CORE);
        spec.color = spec.cores[0].color;
        // A few wires lie side by side, as a servo lead's; more are bundled.
        if (wireChoice.cores <= 4) spec.lay = "flat";
      }
      return spec;
    }

    /** "Red wire, Servo to Board", or "3-wire cable, …". */
    function wireName(spec: WireSpec, from: string, to: string): string {
      const n = coresOf(spec).length;
      return `${n > 1 ? `${n}-wire cable` : `${wireColourName(spec.color)} wire`}, ${from} to ${to}`.slice(0, 120);
    }

    // The wire being made, drawn live (in the overlay, over the picture) to the pointer.
    const previewMaterial = new MeshBasicMaterial({ color: 0xd33a2c, transparent: true, opacity: 0.85, depthTest: true });
    const preview = new Mesh(new BufferGeometry(), previewMaterial);
    preview.raycast = () => {};
    preview.visible = false;
    art.overlay.add(preview);
    function drawWirePreview(): void {
      preview.visible = false;
      if (wiringOn && endCarry) return drawCarryPreview();
      if (!wiringOn || !wireDraft) return draw();
      const world = worldMatrices(scene.parts, scene.explode);
      const d = wireDraft;
      const fromM = world.get(d.from.part);
      if (!fromM) return draw();
      // The ends as they'd be: out of each socket by the plug's length.
      const lead = (s: PartSocket) => connectorMesh(s.connector).size[2];
      const endAt = (e: DraftEnd): WireEnd => ({ part: e.part, point: e.socket.point.map((v, i) => v + e.socket.normal[i] * lead(e.socket)) as Vec3, normal: e.socket.normal });
      const t = wireTarget();
      const here = socketHover || (wireDraft && t) ? t : null;
      const ways = [...d.waypoints];
      let to: WireEnd | null = here && !(here.part === d.from.part && here.socket.id === d.from.socket.id) ? endAt(here) : null;
      if (!to && ways.length) {
        // The last waypoint stands in for the end until there's a target.
        const last = ways[ways.length - 1];
        if (last.part && last.point && last.normal) to = { part: last.part, point: last.point, normal: last.normal };
        ways.pop();
      }
      if (!to) return draw();
      const spec = newWireSpec(endAt(d.from), to, ways);
      const color = spec.color;
      const tris = wireTriangles({ id: "", name: "", position: [0, 0, 0], rotation: [0, 0, 0], wire: spec }, world, loomsOf(scene.parts));
      preview.geometry.dispose();
      preview.geometry = new BufferGeometry();
      preview.geometry.setAttribute("position", new BufferAttribute(tris, 3));
      previewMaterial.color.set(color);
      preview.visible = tris.length > 0;
      draw();
    }

    // ------------------------------------------------------------ editing a wire

    // A wire picked (not while making one) shows its waypoints as handles:
    // drag one over the parts to move it, click it to take it out, and
    // Shift-click a part to add one where it lengthens the wire least.
    const wireLayer = document.createElement("div");
    wireLayer.className = "lyr-wire-handles";
    frameEl.appendChild(wireLayer);
    const wireById = (id: string) => {
      const p = partById(id);
      return p?.wire ? p : undefined;
    };
    function placeWireHandles(): void {
      const p = !wiringOn ? wireById(selectedId) : undefined;
      if (!p?.wire || p.hidden) {
        if (wireLayer.childElementCount) wireLayer.innerHTML = "";
        return;
      }
      const world = worldMatrices(scene.parts, scene.explode);
      const r = p.wire.diameter / 2;
      const spots = p.wire.waypoints.map(w => {
        let at: Vector3 | null = null;
        if (w.part && w.point) {
          const m = world.get(w.part);
          if (m) {
            at = new Vector3(...w.point).applyMatrix4(m);
            if (w.normal) at.addScaledVector(new Vector3(...w.normal).applyMatrix3(new Matrix3().setFromMatrix4(m)).normalize(), r);
          }
        }
        if (!at) return null;
        const v = at.project(camera);
        return { x: ((v.x + 1) / 2) * viewW, y: ((1 - v.y) / 2) * viewH };
      });
      // Its two ends, to pick up and put somewhere else.
      const ends = (["from", "to"] as const).map(end => {
        const e = p.wire![end];
        const m = world.get(e.part);
        if (!m) return null;
        const v = new Vector3(...e.point).applyMatrix4(m).project(camera);
        return { x: ((v.x + 1) / 2) * viewW, y: ((1 - v.y) / 2) * viewH };
      });
      const all = [...spots, ...ends];
      // The same handles moved, not made again (one may be held by a drag).
      const have = [...wireLayer.querySelectorAll<HTMLElement>("[data-wp],[data-end]")];
      if (have.length === all.length) {
        all.forEach((sp, i) => {
          have[i].hidden = !sp;
          if (sp) Object.assign(have[i].style, { left: `${sp.x}px`, top: `${sp.y}px` });
        });
        return;
      }
      wireLayer.innerHTML = spots.map((sp, i) => `<button type="button" class="lyr-wire-point" data-wp="${i}"${sp ? ` style="left:${sp.x}px;top:${sp.y}px"` : " hidden"} title="Drag over the parts to move this point; click to take it out" aria-label="Waypoint ${i + 1}"></button>`).join("")
        + ends.map((sp, i) => `<button type="button" class="lyr-wire-point lyr-wire-end" data-end="${i ? "to" : "from"}"${sp ? ` style="left:${sp.x}px;top:${sp.y}px"` : " hidden"} title="Pick up this end and put it on another socket or pin (drag it, or click it then click where it goes)" aria-label="${i ? "Far" : "First"} end"></button>`).join("");
    }

    /** The part's face under a point on the view, as a waypoint (wires and plugs aren't faces to run over). */
    function surfaceAt(clientX: number, clientY: number): WireWaypoint | null {
      const r = canvasEl.getBoundingClientRect();
      art.scene.updateMatrixWorld(true);
      raycaster.setFromCamera(new Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), camera);
      const meshes = art.meshes().filter(m => {
        const q = partById(String(m.userData.partId || ""));
        return q && !isWiring(q);
      });
      const hit = raycaster.intersectObjects(meshes, false).find(h => h.face && art.keeps(h.point));
      if (!hit) return null;
      const local = hit.object.worldToLocal(hit.point.clone());
      const n = hit.face!.normal.clone().normalize();
      return { part: String(hit.object.userData.partId), point: [round(local.x, 3), round(local.y, 3), round(local.z, 3)], normal: [round(n.x, 5), round(n.y, 5), round(n.z, 5)] };
    }

    /** Lays the wire again where it now runs. */
    function relay(p: ScenePart): void {
      art.rewire(p, scene.parts, scene.explode);
      placeWireHandles();
      draw();
    }

    /** Adds a waypoint to a wire where it makes the wire least longer. */
    function addWaypoint(p: ScenePart, w: WireWaypoint): void {
      if (!p.wire) return;
      const world = worldMatrices(scene.parts, scene.explode);
      let best = 0;
      let bestLen = Infinity;
      for (let i = 0; i <= p.wire.waypoints.length; i++) {
        const ways = [...p.wire.waypoints];
        ways.splice(i, 0, w);
        const len = wireLength({ ...p, wire: { ...p.wire, waypoints: ways, slack: 0 } }, world, loomsOf(scene.parts));
        if (len && len < bestLen) {
          bestLen = len;
          best = i;
        }
      }
      const ways = [...p.wire.waypoints];
      ways.splice(best, 0, w);
      p.wire = { ...p.wire, waypoints: ways };
      relay(p);
      commit();
      renderProps();
      status("Waypoint added. Drag it to move it, click it to take it out.");
    }

    wireLayer.addEventListener("pointerdown", e => {
      const endEl = (e.target as HTMLElement).closest<HTMLElement>("[data-end]");
      if (endEl && wireById(selectedId) && e.button === 0) {
        e.preventDefault();
        e.stopPropagation();
        const wire = selectedId;
        startWires();
        pickUpEnd(wire, endEl.dataset.end === "to" ? "to" : "from", true);
        carryPress(e);
        return;
      }
      const h = (e.target as HTMLElement).closest<HTMLElement>("[data-wp]");
      const p = wireById(selectedId);
      if (!h || !p?.wire) return;
      e.preventDefault();
      e.stopPropagation();
      const i = Number(h.dataset.wp);
      const x0 = e.clientX, y0 = e.clientY;
      let moved = false;
      h.setPointerCapture(e.pointerId);
      wireLayer.classList.add("lyr-dragging");
      const onMove = (m: PointerEvent) => {
        if (!moved && Math.hypot(m.clientX - x0, m.clientY - y0) < 4) return;
        moved = true;
        const w = surfaceAt(m.clientX, m.clientY);
        if (!w || !p.wire) return;
        const ways = [...p.wire.waypoints];
        ways[i] = w;
        p.wire = { ...p.wire, waypoints: ways };
        relay(p);
      };
      const onUp = () => {
        h.removeEventListener("pointermove", onMove);
        h.removeEventListener("pointerup", onUp);
        wireLayer.classList.remove("lyr-dragging");
        if (!p.wire) return;
        if (!moved) {
          p.wire = { ...p.wire, waypoints: p.wire.waypoints.filter((_, k) => k !== i) };
          relay(p);
          status("Waypoint taken out. Shift-click a part to add one.");
        }
        commit();
        renderProps();
      };
      h.addEventListener("pointermove", onMove);
      h.addEventListener("pointerup", onUp);
    });

    /** Sets something about the picked wire and lays it again. */
    function setWire(change: (w: WireSpec) => WireSpec): void {
      const p = wireById(selectedId);
      if (!p?.wire) return;
      p.wire = change(p.wire);
      relay(p);
    }

    /** Swaps a plug for another connector (the socket takes it too), keeping it in its socket. */
    async function setPlugConnector(plug: ScenePart, id: string): Promise<void> {
      if (!plug.plug || !connectorOf(id) || !plug.joint) return;
      const built = connectorMesh(id);
      const data = await plugModelData(id);
      const host = plug.parent ? partById(plug.parent) : undefined;
      if (host?.sockets) host.sockets = host.sockets.map(s => (s.id === plug.plug!.socket ? { ...s, connector: id } : s));
      const c = connectorOf(id)!;
      plug.plug = { ...plug.plug, connector: id };
      plug.name = `${c.family.label} ${c.ways}-way plug`;
      plug.file = connectorFile(id);
      plug.data = data;
      plug.joint = { ...plug.joint, childPoint: built.contact, childNormal: built.normal, distance: plugLift(id) };
      applyJoint(plug);
      const model = modelFromPositions(built.positions.slice(), null);
      opts.store.put(plug, model);
      keepModel(plug, model);
      // Its wires leave its new back.
      for (const w of scene.parts) {
        if (!w.wire) continue;
        if (w.wire.from.part === plug.id) w.wire = { ...w.wire, from: plugExit(plug) };
        if (w.wire.to.part === plug.id) w.wire = { ...w.wire, to: plugExit(plug) };
      }
      rebuild();
      commit();
      renderProps();
    }

    /** Turns a plug a quarter turn in its socket. */
    function turnPlug(plug: ScenePart): void {
      if (!plug.joint) return;
      const spin = wrapAngle((plug.joint.spin || 0) + 90);
      plug.joint = { ...plug.joint, spin };
      const host = plug.parent ? partById(plug.parent) : undefined;
      if (host?.sockets && plug.plug) host.sockets = host.sockets.map(s => (s.id === plug.plug!.socket ? { ...s, spin } : s));
      applyJoint(plug);
      follow();
      commit();
    }

    /** Mm across a new cable's wires, at most. */
    const CABLE_CORE = 1.2;

    /** Which of a cable's wires the panel's colours are for. */
    let coreAt = 0;
    let coreOf = "";

    /** The cable (or wire) with wire `i`'s colour set. */
    function withCoreColour(w: WireSpec, i: number, color: string): WireSpec {
      if (!w.cores || w.cores.length < 2) return { ...w, color };
      const cores = w.cores.map((c, k) => (k === i ? { ...c, color } : c));
      return { ...w, cores, color: cores[0].color };
    }

    /** The cable with one more wire (in the next colour it hasn't got), or one fewer. */
    function withCores(w: WireSpec, count: number): WireSpec {
      const have = coresOf(w);
      const n = Math.max(1, Math.min(WIRE_LIMITS.cores, count));
      if (n === have.length) return w;
      let cores: WireCore[];
      if (n > have.length) {
        cores = [...have];
        while (cores.length < n) cores.push({ color: nextWireColour(cores.map(c => c.color)) });
      } else {
        // The picked wire comes out.
        cores = have.filter((_, k) => k !== Math.min(coreAt, have.length - 1));
        while (cores.length > n) cores.pop();
      }
      const out: WireSpec = { ...w, color: cores[0].color };
      delete out.cores;
      delete out.connection;
      delete out.lay;
      delete out.twist;
      if (cores.length > 1) {
        out.cores = cores;
        if (w.lay === "flat" || (!w.cores && cores.length <= 4)) out.lay = "flat";
        if (w.twist !== undefined) out.twist = w.twist;
      } else if (cores[0].connection) out.connection = cores[0].connection;
      return out;
    }

    /** The wire's settings, in the side panel. */
    function wireSection(p: ScenePart): string {
      const w = p.wire!;
      const cores = coresOf(w);
      if (coreOf !== p.id || coreAt >= cores.length) {
        coreAt = 0;
        coreOf = p.id;
      }
      const cable = cores.length > 1;
      const colour = cores[coreAt].color;
      const world = worldMatrices(scene.parts, scene.explode);
      const assembled = worldMatrices(scene.parts, 0, false);
      const looms = loomsOf(scene.parts);
      const len = wireLength(p, assembled, looms);
      // Too tight a bend kinks a wire or cracks its strands: under MIN_BEND times across.
      const outer = cableRadius(w) * 2;
      const route = wireRoute(w, assembled, looms);
      const bend = route ? tightestBend(route, outer) : null;
      const tight = bend && bend.radius < MIN_BEND * outer ? bend.radius : 0;
      const endName = (e: WireEnd) => {
        const q = partById(e.part);
        const host = q?.parent ? partById(q.parent) : undefined;
        return q ? (q.plug && host ? `${q.name} on ${host.name}` : q.name) : "missing";
      };
      void world;
      return `
        <div class="lyr-scene-sub">${cable ? `Wires · ${cores.length}` : "Wires"}</div>
        <div class="lyr-wire-cores" role="radiogroup" aria-label="Wires">
          ${cores.map((c, i) => `<button type="button" class="lyr-wire-core${cable && i === coreAt ? " lyr-on" : ""}" data-core="${i}" role="radio" aria-checked="${cable && i === coreAt}" title="${esc(`Wire ${i + 1}${i === 0 ? " (pin 1)" : ""}: ${wireColourName(c.color)}${c.connection ? " · in the wiring diagram" : ""}`)}"><span class="lyr-wire-dot" style="--swatch:${esc(c.color)}"></span><span>${i + 1}</span></button>`).join("")}
          <button type="button" class="lyr-btn lyr-icon-btn" data-act="core-add" title="${cable ? "Add a wire to the cable" : "Add a wire: makes it a cable, the wires side by side from each plug"}" aria-label="Add a wire"${cores.length >= WIRE_LIMITS.cores ? " disabled" : ""}>${icon("plus", 16)}</button>
          ${cable ? `<button type="button" class="lyr-btn lyr-icon-btn" data-act="core-remove" title="Take wire ${coreAt + 1} out of the cable" aria-label="Take a wire out">${icon("minus", 16)}</button>` : ""}
        </div>
        <div class="lyr-scene-sub">${cable ? `Colour of wire ${coreAt + 1}` : "Colour"}</div>
        <div class="lyr-wire-swatches" role="radiogroup" aria-label="Colour">
          ${WIRE_COLOURS.map(c => `<button type="button" class="lyr-wire-swatch${c.id.toLowerCase() === colour.toLowerCase() ? " lyr-on" : ""}" data-wire-colour="${c.id}" style="--swatch:${c.id}" title="${esc(c.label)}" aria-label="${esc(c.label)}" role="radio" aria-checked="${c.id.toLowerCase() === colour.toLowerCase()}"></button>`).join("")}
          <label class="lyr-wire-swatch lyr-wire-swatch-pick" title="Another colour"><input type="color" data-wire-colour-pick value="${esc(colour.slice(0, 7))}" aria-label="Another colour"></label>
        </div>
        ${cable ? `<label class="lyr-scene-namebox">Lay <select data-wire-lay><option value="flat"${w.lay === "flat" ? " selected" : ""}>Flat, side by side (a servo lead)</option><option value="round"${w.lay === "flat" ? "" : " selected"}>Round, in a bundle</option></select></label>` : ""}
        <div class="lyr-scene-fields">
          ${field("wireDiameter", "Ø", "mm", w.diameter, 0.1, cable ? "Mm across each wire" : "Mm across")}
          ${field("wireSlack", "Slack", "mm", w.slack, 1, "Mm of extra length: it bows out between the points it passes")}
          ${cable ? field("wireTwist", "Twist", "°", fieldValue("wireTwist", p), 10, "Degrees the wires turn round each other every 100 mm") : ""}
        </div>
        ${(() => {
          // Into a loom: beside another wire for a stretch of it.
          const along = w.waypoints.find(x => x.along)?.along;
          const others = wiresInOrder(scene.parts).filter(o => o !== p && !o.wire!.waypoints.some(x => x.along?.wire === p.id));
          if (!others.length && !along) return "";
          return `<label class="lyr-scene-namebox" title="Run it beside another wire for part of the way, as wires tied into a loom">Runs with <select data-wire-along><option value="">No other wire</option>${others.map(o => `<option value="${esc(o.id)}"${along?.wire === o.id ? " selected" : ""}>${esc(o.name)}</option>`).join("")}</select></label>
          ${along ? `<div class="lyr-scene-fields">${field("alongFrom", "From", "%", fieldValue("alongFrom", p), 1, "Where along the other wire it joins it")}${field("alongTo", "To", "%", fieldValue("alongTo", p), 1, "Where along the other wire it leaves it")}</div>` : ""}`;
        })()}
        <p class="lyr-note">${esc(endName(w.from))} → ${esc(endName(w.to))}. About ${Math.round(len)} mm long, assembled.</p>
        ${tight ? `<p class="lyr-note lyr-note-warn" role="note">Bends too tightly: ${tight < 1 ? "under 1" : Math.round(tight * 10) / 10} mm round at its tightest, and wire this thick wants at least ${Math.round(MIN_BEND * outer * 10) / 10} mm. Give it more slack, or move a waypoint.</p>` : ""}
        <p class="lyr-note">${w.waypoints.length ? `${w.waypoints.length} waypoint${w.waypoints.length === 1 ? "" : "s"}: drag one over the parts to move it, click it to take it out.` : "No waypoints: it takes the shortest smooth run."} Shift-click a part to add one.</p>
        <button type="button" class="lyr-wide-btn" data-act="wire-route" title="Work out its waypoints so it runs round the parts, not through them (waypoints you put in yourself stay)">${icon("wand", 14)} Route round parts</button>
        ${wiresInOrder(scene.parts).length > 1 ? `<button type="button" class="lyr-wide-btn" data-act="wires-route" title="Every wire's waypoints worked out so it runs round the parts, not through them (waypoints you put in yourself stay)">${icon("wand", 14)} Route all ${wiresInOrder(scene.parts).length} wires round parts</button>` : ""}
        ${w.waypoints.length ? `<button type="button" class="lyr-wide-btn" data-act="wire-clear">${icon("close", 14)} Take out every waypoint</button>` : ""}
        ${(() => {
          const wires = wiresInOrder(scene.parts);
          const i = wires.indexOf(p);
          return wires.length > 1 ? `<div class="lyr-scene-quick"><span class="lyr-label" title="The order the wires go in: wiring steps and Assemble the wires follow it">Goes in ${i + 1} of ${wires.length}</span>
            <button type="button" class="lyr-btn lyr-icon-btn" data-act="wire-earlier" title="Put it in earlier" aria-label="Earlier"${i === 0 ? " disabled" : ""}>${icon("chevronUp", 16)}</button>
            <button type="button" class="lyr-btn lyr-icon-btn" data-act="wire-later" title="Put it in later" aria-label="Later"${i === wires.length - 1 ? " disabled" : ""}>${icon("chevronDown", 16)}</button></div>` : "";
        })()}
        <button type="button" class="lyr-wide-btn" data-act="wire-mirror" title="Make this wire again on the other side of the model (left leg to right leg), across its middle">${icon("flipH", 14)} Mirror to the other side</button>`;
    }

    /**
     * Makes the picked wire again on the other side of the model (across its
     * YZ plane): the left leg's lead on the right leg. Each end goes in the
     * mirrored socket on the partner part (made when it has none there), and
     * each waypoint on the partner's face.
     */
    async function mirrorWire(p: ScenePart): Promise<void> {
      const w = p.wire;
      if (!w || wireBusy) return;
      const world = worldMatrices(scene.parts, 0, false);
      const plane = mirrorPlane(scene.parts, world);
      // Near enough to count as the same part's place: a few percent of the model.
      const xs = scene.parts.filter(q => !isWiring(q)).map(q => world.get(q.id)?.elements ?? null).filter((e): e is Matrix4["elements"] => !!e);
      const span = xs.length ? Math.hypot(...[12, 13, 14].map(k => Math.max(...xs.map(e => e[k])) - Math.min(...xs.map(e => e[k])))) : 0;
      const tolerance = Math.max(3, span * 0.06);
      const missing: string[] = [];
      const partner = (id: string) => {
        const to = mirrorPartner(scene.parts, world, id, plane, tolerance);
        if (!to) missing.push(partById(id)?.name || id);
        return to;
      };
      /** The far side's end: the mirrored socket (one there, or a new one) for a plug, else the mirrored point. */
      const endFor = (e: WireEnd): DraftEnd | WireEnd | null => {
        const at = partById(e.part);
        const host = at?.plug && at.parent ? partById(at.parent) : undefined;
        const socket = host?.sockets?.find(s => s.id === at!.plug!.socket);
        if (host && socket) {
          const other = partner(host.id);
          if (!other) return null;
          const m = mirrorPoint(socket.point, socket.normal, world.get(host.id)!, world.get(other)!, plane);
          const q = partById(other)!;
          const there = q.sockets?.find(s => s.connector === socket.connector && new Vector3(...s.point).distanceTo(new Vector3(...m.point)) < 1.5);
          if (there) return { part: other, socket: there, fresh: false };
          const fresh: PartSocket = { id: newSocketId(q.sockets), point: m.point, normal: m.normal!, connector: socket.connector };
          if (socket.spin) fresh.spin = wrapAngle(-socket.spin);
          if (socket.port) fresh.port = socket.port;
          return { part: other, socket: fresh, fresh: true };
        }
        const other = partner(e.part);
        if (!other) return null;
        const m = mirrorPoint(e.point, e.normal, world.get(e.part)!, world.get(other)!, plane);
        return { ...e, part: other, point: m.point, normal: m.normal! };
      };
      const a = endFor(w.from);
      const b = endFor(w.to);
      const ways: WireWaypoint[] = [];
      for (const x of w.waypoints) {
        // Beside a wire on this side: not on the other (run it along one there by hand).
        if (x.along) continue;
        if (!x.part || !x.point) {
          ways.push({ ...x });
          continue;
        }
        const other = partner(x.part);
        if (!other) continue;
        const m = mirrorPoint(x.point, x.normal, world.get(x.part)!, world.get(other)!, plane);
        ways.push(m.normal ? { part: other, point: m.point, normal: m.normal } : { part: other, point: m.point });
      }
      if (!a || !b) {
        status(`Couldn't find ${[...new Set(missing)].join(" or ")} on the other side of the model to mirror the wire onto.`, true);
        return;
      }
      const isDraft = (e: DraftEnd | WireEnd): e is DraftEnd => "socket" in e;
      const sameEnd = (x: DraftEnd | WireEnd, e: WireEnd) => {
        if (!isDraft(x)) return x.part === e.part && new Vector3(...x.point).distanceTo(new Vector3(...e.point)) < 1;
        const plug = plugIn(x.part, x.socket.id);
        return !x.fresh && !!plug && plug.id === e.part;
      };
      // A wire across the middle mirrors onto itself.
      if ((sameEnd(a, w.from) && sameEnd(b, w.to)) || (sameEnd(a, w.to) && sameEnd(b, w.from))) {
        status("This wire is its own mirror image: it runs across the middle of the model.", true);
        return;
      }
      wireBusy = true;
      try {
        const from = isDraft(a) ? await wireEndAt(a) : a;
        const to = isDraft(b) ? await wireEndAt(b) : b;
        if (closed) return;
        // Its cores aren't the 2D wiring's connections (the original's are).
        const spec: WireSpec = { ...w, from, to, waypoints: ways };
        delete spec.connection;
        if (spec.cores) spec.cores = spec.cores.map(c => ({ color: c.color }));
        const hostName = (e: WireEnd) => {
          const q = partById(e.part);
          return (q?.plug && q.parent ? partById(q.parent)?.name : q?.name) || "";
        };
        const made: ScenePart = { id: newPartId(scene.parts), name: wireName(spec, hostName(from), hostName(to)), position: [0, 0, 0], rotation: [0, 0, 0], wire: spec };
        keepModel(made, emptyModel());
        scene.parts.push(made);
        rebuild();
        select(made.id);
        commit();
        status(`${made.name} added, mirrored from ${p.name}.`);
      } finally {
        wireBusy = false;
      }
    }

    // ------------------------------------------------------------ the 2D wiring diagram

    // The host's wiring diagram (wiring2d.ts), loaded once the workspace
    // opens: model parts link to its placed parts and sockets to their
    // ports, and a wire's cores to its connections, so they share colours,
    // and either can be made first.
    const wiringHost: WiringHost | undefined = opts.wiring;
    let diagram: WiringInfo | null = null;
    let diagramState: "off" | "loading" | "ready" | "failed" = wiringHost ? "loading" : "off";
    async function loadDiagram(): Promise<void> {
      if (!wiringHost) return;
      diagramState = "loading";
      try {
        diagram = await wiringHost.load();
        diagramState = "ready";
      } catch {
        diagram = null;
        diagramState = "failed";
      }
      if (closed) return;
      // Wires in the diagram take its colours now.
      let recoloured = 0;
      if (diagram) {
        for (const p of scene.parts) {
          if (!p.wire) continue;
          const cores = coloursFromDiagram(diagram, coresOf(p.wire));
          if (!cores || cores.every((c, i) => c.color === coresOf(p.wire!)[i].color)) continue;
          p.wire = withCoreList(p.wire, cores);
          recoloured++;
        }
      }
      if (recoloured) {
        rebuild();
        status(`${recoloured} wire${recoloured === 1 ? "" : "s"} recoloured to match the wiring diagram.`);
      }
      renderList();
      renderProps();
    }

    /** The wire with these cores (one core: a plain wire). */
    function withCoreList(w: WireSpec, cores: WireCore[]): WireSpec {
      const out: WireSpec = { ...w, color: cores[0].color };
      delete out.cores;
      delete out.connection;
      if (cores.length > 1) {
        out.cores = cores;
        if (!w.cores && cores.length <= 4) out.lay = "flat";
        if (!w.cores) out.diameter = Math.min(w.diameter, CABLE_CORE);
      } else {
        delete out.lay;
        delete out.twist;
        if (cores[0].connection) out.connection = cores[0].connection;
      }
      return out;
    }

    /** The diagram end a wire end is at: its plug's socket's port, on the part linked to the diagram. */
    function diagramEnd(e: WireEnd): DiagramEnd | null {
      const on = partById(e.part);
      if (on && !on.plug && on.wiringPart) {
        // A bare pin: the one the end is on.
        const pin = on.sockets?.find(s => isBarePin(s) && s.pin && s.point.every((v, i) => Math.abs(v - e.point[i]) < 0.01));
        return pin ? { part: on.wiringPart, port: `pin:${pin.pin}` } : null;
      }
      const plug = partById(e.part);
      const host = plug?.plug && plug.parent ? partById(plug.parent) : undefined;
      const socket = host?.sockets?.find(s => s.id === plug!.plug!.socket);
      return host?.wiringPart && socket?.port ? { part: host.wiringPart, port: socket.port } : null;
    }

    /**
     * Makes a wire the diagram's cable between its ends' ports, when the
     * diagram has one (its wires' colours and connections); says which, or "".
     */
    function linkToDiagram(p: ScenePart): string {
      if (!diagram || !p.wire) return "";
      const a = diagramEnd(p.wire.from);
      const b = diagramEnd(p.wire.to);
      if (!a || !b) return "";
      const cable = cableBetween(diagram, a, b);
      if (!cable) return "";
      p.wire = withCoreList(p.wire, cable.connections.map(c => ({ color: coloursFromDiagram(diagram!, [{ color: "#000000", connection: c.id }])![0].color, connection: c.id })));
      return portName(a) + " to " + portName(b);
    }

    const portName = (e: DiagramEnd) => {
      const w = diagram?.parts.find(x => x.id === e.part);
      return `${w?.name || e.part} ${portById(w, e.port)?.name || e.port}`;
    };
    /** "Motor 1 M+": a pin ("m1.M+") by its part's name. */
    const pinName = (ref: string) => {
      const at = ref.indexOf(".");
      const w = diagram?.parts.find(x => x.id === ref.slice(0, at));
      return `${w?.name || ref.slice(0, at)} ${ref.slice(at + 1)}`;
    };

    /** Adds the picked wire to the diagram as new connections (pin to pin by label), and links them. */
    async function addWireToDiagram(p: ScenePart): Promise<void> {
      if (!diagram || !p.wire || !wiringHost?.addConnections) return;
      const a = diagramEnd(p.wire.from);
      const b = diagramEnd(p.wire.to);
      const want = a && b ? connectionsFor(diagram, a, b, coresOf(p.wire).map(c => c.color)) : null;
      if (!a || !b || !want) {
        status("Its ends don't match up in the wiring diagram: each needs a plug in a port's socket, or a placed pin, on a part linked to the diagram, with as many pins at each end.", true);
        return;
      }
      status("Adding it to the wiring diagram…", false, true);
      try {
        const saved = await wiringHost.addConnections(want);
        if (closed) return;
        diagram = { ...diagram, connections: [...diagram.connections, ...saved] };
        const cores = saved.map((c, i) => ({ color: coresOf(p.wire!)[i]?.color || c.color || "#f2c400", connection: c.id }));
        p.wire = withCoreList(p.wire, cores);
        relay(p);
        commit();
        renderProps();
        status(`Added to the wiring diagram: ${portName(a)} to ${portName(b)}, ${saved.length} wire${saved.length === 1 ? "" : "s"}.`);
      } catch (err) {
        status(`Couldn't add it to the wiring diagram: ${(err as Error).message || err}`, true);
      }
    }

    /** The model's solid parts as they sit assembled, drawn into a grid for routing wires round them (null with none loaded). */
    function solidsGrid(wires: ScenePart[]): SolidGrid | null {
      const assembled = worldMatrices(scene.parts, 0, false);
      const solids: Solid[] = [];
      for (const o of scene.parts) {
        const m = models.get(o.id);
        const mw = assembled.get(o.id);
        if (o.wire || !m || m instanceof Error || !mw) continue;
        solids.push({ part: o.id, positions: m.geometry.getAttribute("position").array, matrix: mw });
      }
      if (!solids.length) return null;
      // The wires' ends too, so a wire off the model's edge still fits.
      const ends = wires.flatMap(w => [w.wire!.from, w.wire!.to].flatMap(e => {
        const m = assembled.get(e.part);
        return m ? [new Vector3(...e.point).applyMatrix4(m)] : [];
      }));
      return solidGrid(solids, ends);
    }

    /**
     * "Route round parts": each wire's waypoints worked out so it runs round
     * the solid parts, not through them. Waypoints put in by hand stay; ones
     * from an earlier routing are replaced. Says how it went.
     */
    async function routeWiresRound(wires: ScenePart[], quiet = false): Promise<void> {
      wires = wires.filter(w => w.wire);
      if (!wires.length || wireBusy) return;
      wireBusy = true;
      try {
        status(`Routing ${wires.length === 1 ? "the wire" : `${wires.length} wires`} round the parts…`, false, true);
        // Let the status show before the grid is drawn.
        await new Promise(r => setTimeout(r, 30));
        const g = solidsGrid(wires);
        if (!g) {
          status("The parts' models need to be loaded first.", true);
          return;
        }
        const assembled = worldMatrices(scene.parts, 0, false);
        let moved = 0, stuck = 0, close = 0;
        // Each wire after the ones it runs beside, so it follows their new way; those beside a routed wire come too.
        const movedIds = new Set<string>();
        const order = routeOrder(wires, scene.parts);
        const routing = new Set(order.map(w => w.id));
        // Wires laid so far: each next one goes beside them, not through them.
        const laid = new Map<string, LaidWire>();
        const lay = (q: ScenePart) => {
          const r = wireRoute(q.wire!, assembled, loomsOf(scene.parts));
          if (r) laid.set(q.id, { centre: r.centre, r: cableRadius(q.wire!) });
        };
        for (const q of scene.parts) if (q.wire && !routing.has(q.id)) lay(q);
        for (const w of order) {
          if (closed) return;
          const looms = loomsOf(scene.parts);
          const follows = w.wire!.waypoints.some(x => x.along && movedIds.has(x.along.wire));
          // Already clear with no routing of its own: left as it is.
          if (!follows && !w.wire!.waypoints.some(x => x.auto) && !wireHitsParts(w.wire!, assembled, g, looms)) {
            lay(w);
            continue;
          }
          const got = routeWire(w.wire!, assembled, g, looms, followRoom(w.id, looms), othersFor(w.id, w.wire!, laid, looms));
          if (!got) continue;
          w.wire = { ...w.wire!, waypoints: got.waypoints };
          lay(w);
          relay(w);
          movedIds.add(w.id);
          moved++;
          if (got.stuck) stuck++;
          else if (!got.clear) close++;
          await new Promise(r => setTimeout(r, 0));
        }
        commit();
        renderList();
        renderProps();
        if (quiet && !stuck && !close) return;
        const n = (k: number) => `${k} wire${k === 1 ? "" : "s"}`;
        status(moved
          ? `${n(moved)} routed round the parts.${stuck ? ` ${n(stuck)} couldn't find a way round: add a waypoint by hand (Shift-click a part).` : ""}${close ? ` ${n(close)} still brush${close === 1 ? "es" : ""} a part: less slack helps.` : ""}`
          : `${wires.length === 1 ? "The wire already runs" : "The wires already run"} clear of the parts.`, !!stuck);
      } finally {
        wireBusy = false;
      }
    }

    /** "Add missing wires": a cable for each of the diagram's not in the model yet, between the sockets for its ports. */
    async function addMissingWires(): Promise<void> {
      if (!diagram || wireBusy) return;
      const { wires, skipped } = missingWires(diagram, scene.parts);
      if (!wires.length) {
        status(skipped ? `None can be added: ${skipped} of the diagram's cables need their pins placed at each end, on parts linked to the diagram (pick a part, then Pins under Wiring diagram).` : "Every wire in the diagram is in the model.", !!skipped);
        return;
      }
      wireBusy = true;
      const added: ScenePart[] = [];
      try {
        for (const m of wires) {
          const a = await wireEndAt({ part: m.from.part, socket: m.from.socket, fresh: false }, m.fromIndex);
          const b = await wireEndAt({ part: m.to.part, socket: m.to.socket, fresh: false }, m.toIndex);
          if (closed) return;
          const spec = withCoreList(newWireSpec(a, b, []), m.cores);
          if (m.cores.length > 1 && m.cores.length <= 4) spec.lay = "flat";
          const one = m.cable.connections.length === 1 && (m.fromIndex !== undefined || m.toIndex !== undefined || isBarePin(m.from.socket) || isBarePin(m.to.socket));
          const label = one ? `${pinName(m.cable.connections[0].from)} to ${pinName(m.cable.connections[0].to)}` : `${portName(m.cable.from)} to ${portName(m.cable.to)}`;
          const made: ScenePart = { id: newPartId(scene.parts), name: label.slice(0, 120), position: [0, 0, 0], rotation: [0, 0, 0], wire: spec };
          keepModel(made, emptyModel());
          scene.parts.push(made);
          added.push(made);
        }
        rebuild();
        commit();
        renderList();
        renderProps();
      } finally {
        wireBusy = false;
      }
      // Round the parts, not through them.
      await routeWiresRound(added, true);
      if (closed) return;
      if (!/couldn't|brush/.test($(".lyr-status").textContent || "")) {
        status(`${wires.length} wire${wires.length === 1 ? "" : "s"} added from the wiring diagram, routed round the parts: pick one and Shift-click the parts to change its way.${skipped ? ` ${skipped} more need their pins placed first (a part's Pins, under Wiring diagram).` : ""}`);
      }
    }

    /**
     * "Wire it up": links the parts whose names match the diagram's, puts
     * each linked part's pins on its model (the catalog's, else found from
     * its picture), then adds every wire of the diagram with its pins placed
     * at both ends. Pins it can't find are left for Pins on the model.
     */
    async function wireItUp(): Promise<void> {
      if (!diagram || wireBusy) return;
      const had = new Map(scene.parts.map(p => [p.id, p.sockets?.length || 0]));
      for (const l of linkByName(diagram, scene.parts)) setWiringPart(partById(l.part)!, l.wiringPart, false);
      let pins = 0;
      for (const p of scene.parts) {
        if (!p.wiringPart || isWiring(p)) continue;
        const before = p.sockets?.length || 0;
        if (!before) setWiringPart(p, p.wiringPart, false);
        if (!p.sockets?.length || before) findPins(p);
        pins += (p.sockets?.length || 0) - (had.get(p.id) || 0);
      }
      const { wires, skipped } = missingWires(diagram, scene.parts);
      if (wires.length) await addMissingWires();
      else {
        rebuild();
        commit();
        renderList();
        renderProps();
      }
      const said: string[] = [];
      if (pins) said.push(`${pins} pin${pins === 1 ? "" : "s"} placed`);
      if (wires.length) said.push(`${wires.length} wire${wires.length === 1 ? "" : "s"} added`);
      status(said.length
        ? `${said.join(", ")}.${skipped ? ` ${skipped} more wire${skipped === 1 ? "" : "s"} need${skipped === 1 ? "s" : ""} pins placed by hand: pick the part, then click its pins under Pins on the model.` : " The wires run round the parts: pick one and Shift-click parts to change its way."}`
        : skipped ? `${skipped} wire${skipped === 1 ? "" : "s"} need${skipped === 1 ? "s" : ""} pins placed by hand: pick the part, then click its pins under Pins on the model.` : "Every wire in the diagram is in the model.", !said.length && !!skipped);
    }

    /**
     * Mapping a part's pins (Map pins, or placing them): the other parts fade
     * so it stands out. Ends when another part (or none) is picked.
     */
    function setPinFocus(id: string): void {
      if (pinFocus === id) return;
      pinFocus = id;
      rebuild();
    }

    /** Picks a linked part and brings its Pins on the model (its picture with its pins) into view. */
    function showPins(id: string): void {
      select(id);
      setPinFocus(id);
      const box = props.querySelector<HTMLElement>(".lyr-pins");
      box?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      const p = partById(id);
      const w = diagram?.parts.find(x => x.id === p?.wiringPart);
      if (!p || !w) return;
      const left = portPlacements(w, p.sockets).reduce((n, x) => n + (x.plug ? 0 : x.port.pins.filter(q => !x.pins.has(q.name)).length), 0);
      status(left ? `${p.name}: click a pin on its picture, then where it is on the model.` : `${p.name}: its pins are placed (green). To move one, click it on the picture, then where it really is on the model.`, false, true);
    }

        /** Links each part whose name matches one in the diagram. */
    function linkPartsByName(): void {
      if (!diagram) return;
      const links = linkByName(diagram, scene.parts);
      for (const l of links) setWiringPart(partById(l.part)!, l.wiringPart, false);
      renderList();
      renderProps();
      commit();
      status(links.length ? `${links.length} part${links.length === 1 ? "" : "s"} linked to the wiring diagram by name.` : "No more parts' names match the wiring diagram's.");
    }

    /** Links a part to a placed part of the diagram (or unlinks it), taking the catalog's sockets for it when it has none. */
    function setWiringPart(p: ScenePart, id: string, say = true): void {
      if (id) p.wiringPart = id;
      else delete p.wiringPart;
      const w = diagram?.parts.find(x => x.id === id);
      const model = models.get(p.id);
      if (w && !p.sockets?.length && model && !(model instanceof Error)) {
        const got = catalogSocketsFor(w.sockets, model.size as Vec3);
        if (got) {
          p.sockets = got;
          if (say) status(`${got.length} socket${got.length === 1 ? "" : "s"} from the catalog's ${w.name}.`);
          draw();
          return;
        }
        // Not in the catalog: its pins found from its 2D pinout.
        const found = findPins(p);
        if (found && say) status(`${found} pin${found === 1 ? "" : "s"} found on ${p.name} from the wiring diagram's picture of it: check them under Pins on the model.`);
      }
    }

    /**
     * Places the linked part's pins not on its model yet from where they are
     * on its 2D picture (pinGuess.ts): the number placed, or 0 when its model
     * isn't drawn the picture's way round (they're then placed by hand).
     */
    function findPins(p: ScenePart): number {
      const w = diagram?.parts.find(x => x.id === p.wiringPart);
      const model = models.get(p.id);
      if (!w || !model || model instanceof Error) return 0;
      const pos = model.geometry.getAttribute("position")?.array;
      if (!pos) return 0;
      const placed = new Set((p.sockets || []).filter(s => isBarePin(s) && s.pin).map(s => s.pin!));
      // Pins of a port with a plug socket go with the plug.
      for (const x of portPlacements(w, p.sockets)) if (x.plug) x.port.pins.forEach(q => placed.add(q.name));
      const got = guessPins(w, pos, model.centre as Vec3, model.size as Vec3, placed);
      if (!got?.length) return 0;
      p.sockets = guessedSockets(got, p.sockets, pin => pinLabel(w, pin));
      draw();
      return got.length;
    }

    /** Keeps the part's sockets on its catalog part (through the diagram's link), for every project. */
    async function saveSocketsToCatalog(p: ScenePart): Promise<void> {
      const w = diagram?.parts.find(x => x.id === p.wiringPart);
      const model = models.get(p.id);
      if (!w?.slug || !p.sockets?.length || !wiringHost?.saveSockets || !model || model instanceof Error) return;
      const saved = { size: (model.size as Vec3).map(v => round(v, 2)) as Vec3, sockets: p.sockets.map(s => ({ ...s })) };
      status("Saving the sockets to the catalog…", false, true);
      try {
        await wiringHost.saveSockets(w.slug, saved);
        w.sockets = saved;
        status(`${p.sockets.length} socket${p.sockets.length === 1 ? "" : "s"} saved to the catalog's ${w.name}: projects that use it get them.`);
        renderProps();
      } catch (err) {
        status(`Couldn't save the sockets to the catalog: ${(err as Error).message || err}`, true);
      }
    }

    /** The wiring diagram's settings for the picked part, plug or wire (and the scene's, under them). */
    /** In the see-through view: whether a part is drawn solid or see-through, worked out or set. */
    function xrayRow(p: ScenePart): string {
      // The Model workspace too: it's what the wiring showcase draws.
      if ((!scene.seeThrough && !modelOnly) || isWiring(p)) return "";
      const auto = seeThroughParts(scene.parts.map(q => (q.id === p.id ? { ...q, xray: undefined } : q))).has(p.id) ? "see-through" : "solid";
      return `<label class="lyr-scene-namebox" title="How the see-through view draws it. Automatic: electronics (on the wiring diagram, with sockets, wired to, or named like a board or motor) solid, the rest see-through">See-through view <select data-xray><option value="">Automatic (${auto})</option><option value="solid"${p.xray === "solid" ? " selected" : ""}>Solid</option><option value="glass"${p.xray === "glass" ? " selected" : ""}>See-through</option></select></label>`;
    }

    function diagramSection(p: ScenePart | undefined): string {
      if (diagramState === "off") return "";
      const head = `<div class="lyr-panel-title">Wiring diagram</div>`;
      if (diagramState === "loading") return `<section class="lyr-scene-section">${head}<p class="lyr-note">Loading the wiring diagram…</p></section>`;
      if (!diagram || !diagram.parts.length) {
        return `<section class="lyr-scene-section">${head}<p class="lyr-note">${diagramState === "failed" ? "The wiring diagram couldn't be loaded." : "The project has no wiring diagram yet. Wires made here can be added to one once it has their parts."}</p>
          ${wiringHost?.open ? `<button type="button" class="lyr-wide-btn" data-act="diagram-open">${icon("wire", 14)} Open the wiring diagram</button>` : ""}${showcaseButton(p)}</section>`;
      }
      const d = diagram;
      let mine = "";
      if (p?.wire) {
        const labels = diagramLabels(d, coresOf(p.wire));
        const first = coresOf(p.wire).find(c => c.connection)?.connection;
        if (first) {
          mine = `<p class="lyr-note">${labels.map((l, i) => (l ? `${coresOf(p.wire!).length > 1 ? `${i + 1}: ` : ""}${esc(l)}` : "")).filter(Boolean).join("<br>")}</p>
            ${wiringHost?.open ? `<button type="button" class="lyr-wide-btn" data-act="diagram-open" data-connection="${esc(first)}">${icon("wire", 14)} Open in wiring diagram</button>` : ""}`;
        } else {
          const a = diagramEnd(p.wire.from);
          const b = diagramEnd(p.wire.to);
          const has = a && b ? cableBetween(d, a, b) : null;
          const can = a && b && !has ? connectionsFor(d, a, b) : null;
          mine = has
            ? `<p class="lyr-note">The diagram has a cable between these ports.</p><button type="button" class="lyr-wide-btn" data-act="diagram-link">${icon("link", 14)} Take the diagram's wires and colours</button>`
            : can && wiringHost?.addConnections
              ? `<p class="lyr-note">Not in the diagram yet: ${esc(portName(a!))} to ${esc(portName(b!))}.</p><button type="button" class="lyr-wide-btn" data-act="diagram-add">${icon("plus", 14)} Add to the wiring diagram</button>`
              : `<p class="lyr-note">Not in the wiring diagram. To link it, put its plugs in sockets on parts linked to the diagram, each on a port.</p>`;
        }
      } else if (p?.plug) {
        const host = p.parent ? partById(p.parent) : undefined;
        const w = host?.wiringPart ? d.parts.find(x => x.id === host.wiringPart) : undefined;
        const socket = host?.sockets?.find(s => s.id === p.plug!.socket);
        mine = w && socket
          ? `<label class="lyr-scene-namebox">Port on ${esc(w.name)} <select data-socket-port><option value="">None</option>${w.ports.map(x => `<option value="${esc(x.id)}"${x.id === socket.port ? " selected" : ""}>${esc(`${x.name} (${x.pins.map(q => q.label || q.name).join(" ")})`)}</option>`).join("")}</select></label>`
          : `<p class="lyr-note">Link ${esc(host?.name || "its part")} to the diagram to say which port this plug is on.</p>`;
      } else if (p) {
        const w = p.wiringPart ? d.parts.find(x => x.id === p.wiringPart) : undefined;
        const taken = new Set(scene.parts.filter(q => q.id !== p.id && q.wiringPart).map(q => q.wiringPart));
        const model = models.get(p.id);
        const fits = w && model && !(model instanceof Error) ? catalogSocketsFor(w.sockets, model.size as Vec3) : null;
        mine = `<label class="lyr-scene-namebox">This part is <select data-wiring-part><option value="">Not in the diagram</option>${d.parts.map(x => `<option value="${esc(x.id)}"${x.id === p.wiringPart ? " selected" : ""}${taken.has(x.id) ? " disabled" : ""}>${esc(x.name)}${taken.has(x.id) ? " (linked)" : ""}</option>`).join("")}</select></label>
          ${w ? pinsPanel(p, w) : ""}
          ${w && fits && !p.sockets?.length ? `<button type="button" class="lyr-wide-btn" data-act="sockets-from-catalog">${icon("plug", 14)} Use the catalog's ${fits.length} socket${fits.length === 1 ? "" : "s"}</button>` : ""}
          ${w?.slug && p.sockets?.length && wiringHost?.saveSockets ? `<button type="button" class="lyr-wide-btn" data-act="sockets-to-catalog" title="Keep where its pins and sockets are on the catalog part, so every project that uses ${esc(w.name)} gets them">${icon("plug", 14)} Save pins to the catalog part</button>` : ""}`;
      }
      const { routed, total } = routedCount(d, scene.parts);
      const missing = missingWires(d, scene.parts);
      const byName = linkByName(d, scene.parts).length;
      const away = partsNotInScene(d, scene.parts);
      return `<section class="lyr-scene-section">${head}
        ${routed < total ? `<button type="button" class="lyr-wide-btn" data-act="wire-it-up" title="Link parts by name, put their pins on the models (from the catalog, or from each part's picture), and add every wire of the diagram">${icon("wand", 14)} Wire it up</button>` : ""}
        ${mine}
        ${away.withModel.length || away.noModel.length ? `<p class="lyr-note">Not in this scene yet: ${esc(listNames([...away.withModel, ...away.noModel].map(w => w.name)))}.</p>` : ""}
        ${away.withModel.length ? `<button type="button" class="lyr-wide-btn" data-act="diagram-parts" title="Each from its catalog part's 3D model, linked to the diagram">${icon("plus", 14)} Add ${away.withModel.length === 1 ? esc(away.withModel[0].name) : `the diagram's ${away.withModel.length} parts`}</button>` : ""}
        <p class="lyr-note">${routed} of ${total} wire${total === 1 ? "" : "s"} in the diagram routed here.</p>
        ${p ? "" : pinsOverview(d)}
        ${missing.wires.length ? `<button type="button" class="lyr-wide-btn" data-act="diagram-missing" title="A wire or cable for each of the diagram's with its pins placed at both ends, by the shortest smooth run">${icon("wire", 14)} Add missing wires (${missing.wires.length})</button>` : ""}
        ${!p && scene.parts.some(q => q.wire) ? `<button type="button" class="lyr-wide-btn" data-act="wires-route" title="Every wire's waypoints worked out so it runs round the parts, not through them (waypoints you put in yourself stay)">${icon("wand", 14)} Route all wires round parts</button>` : ""}
        ${!p ? wiringMovieButton() : ""}
        ${byName ? `<button type="button" class="lyr-wide-btn" data-act="diagram-names" title="Link parts whose names match the diagram's">${icon("link", 14)} Link parts by name (${byName})</button>` : ""}
        ${!p?.wire && wiringHost?.open ? `<button type="button" class="lyr-wide-btn" data-act="diagram-open">${icon("wire", 14)} Open the wiring diagram</button>` : ""}
        ${showcaseButton(p)}
      </section>`;
    }

    /** "Wiring showcase": the see-through video of the wires growing in, previewed here, to save for social media. */
    function showcaseButton(p: ScenePart | undefined): string {
      if (p || !scene.parts.some(q => q.wire && !q.hidden)) return "";
      return `<button type="button" class="lyr-wide-btn" data-act="showcase" title="Preview the wiring showcase from this view: the printed parts see-through, each wire growing out of its component. Save it as a video for social media">${icon("play", 14)} Wiring showcase</button>`;
    }

    /**
     * Each part of the wiring diagram and how many of its pins are on its
     * model, with Map pins (picks the part and opens its Pins on the model)
     * or, when no part here is linked to it yet, a list to pick which one is.
     */
    function pinsOverview(d: WiringInfo): string {
      const withPins = d.parts.filter(w => w.ports.some(x => x.pins.length));
      if (!withPins.length) return "";
      const free = scene.parts.filter(q => !isWiring(q) && !q.plug && !q.screw && !q.wiringPart);
      const rows = withPins.map(w => {
        const q = scene.parts.find(x => x.wiringPart === w.id);
        const total = new Set(w.ports.flatMap(x => x.pins.map(y => y.name))).size;
        if (!q) {
          return `<div class="lyr-pins-row lyr-map-row"><span class="lyr-pins-name" title="${esc(w.name)}">${esc(w.name)}</span>
            <select data-link-diagram="${esc(w.id)}" aria-label="Which part here is ${esc(w.name)}" title="Which part here is ${esc(w.name)}"><option value="">Which part is it?</option>${free.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join("")}</select></div>`;
        }
        const placed = new Set<string>();
        for (const x of portPlacements(w, q.sockets)) (x.plug ? x.port.pins.map(y => y.name) : [...x.pins.keys()]).forEach(n => placed.add(n));
        const done = placed.size >= total;
        return `<div class="lyr-pins-row lyr-map-row"><span class="lyr-pins-name" title="${esc(`${w.name}: ${q.name}`)}">${esc(w.name)}</span>
          <span class="lyr-pins-state${done ? " lyr-pins-ok" : ""}">${placed.size} of ${total}</span>
          <button type="button" class="lyr-btn" data-act="map-pins" data-part="${esc(q.id)}" title="Show ${esc(q.name)}'s pins on its picture and its model, to place or move them">${icon("plug", 14)}<span>Map pins</span></button></div>`;
      }).join("");
      return `<div class="lyr-pins"><div class="lyr-pins-head">Pins on the models</div>${rows}</div>`;
    }

    // ------------------------------------------------------------ the wires going in

    // "Assemble n wires": each wire (in the model's order) appears with its
    // plugs and grows along its route out of its component, up to where it
    // ends (see growsFromTo), one after another,
    // as they'd be put in. A play bar sets the speed, skips a wire or stops.
    const playBar = $(".lyr-play-bar");
    let playing: { order: ScenePart[]; at: number; grown: number; speed: number; rest: number; frame: number; last: number } | null = null;
    const PLAY_SPEEDS = [1, 2, 4];
    function renderPlayBar(): void {
      if (!playing) return;
      const p = playing.order[Math.min(playing.at, playing.order.length - 1)];
      playBar.innerHTML = `
        <span class="lyr-screw-bar-title">${icon("wire", 16)}<span>Wire ${Math.min(playing.at + 1, playing.order.length)} of ${playing.order.length}</span></span>
        <span class="lyr-play-name">${esc(p?.name || "")}</span>
        <label title="How fast the wires go in"><span>Speed</span><select data-play="speed">${PLAY_SPEEDS.map(v => `<option value="${v}"${v === playing!.speed ? " selected" : ""}>${v}×</option>`).join("")}</select></label>
        <button type="button" class="lyr-btn" data-act="play-skip" title="Put this wire straight in and go to the next">${icon("chevronRight", 16)}<span>Skip</span></button>
        <button type="button" class="lyr-btn lyr-icon-btn" data-act="play-stop" title="Stop (Esc)" aria-label="Stop">${icon("close", 16)}</button>`;
    }
    /** The plugs a wire ends on. */
    const plugsOf = (w: ScenePart) => [w.wire!.from.part, w.wire!.to.part].filter(id => partById(id)?.plug);
    function startPlayback(): void {
      const order = wiresInOrder(scene.parts).filter(w => !w.hidden && !scene.hideWiring);
      if (!order.length) return status("No wires to put in.", true);
      stopWires();
      stopScrews();
      select("");
      // Every wire, and every plug on one, out until its turn.
      const onWire = new Set(order.flatMap(plugsOf));
      for (const p of scene.parts) if (p.wire || onWire.has(p.id)) art.setShown(p.id, false);
      playing = { order, at: 0, grown: 0, speed: playing?.speed || 1, rest: 0, frame: 0, last: performance.now() };
      renderPlayBar();
      playBar.hidden = false;
      layout();
      status(`Putting in ${order.length} wire${order.length === 1 ? "" : "s"}, in the model's order (set it in a wire's settings).`, false, true);
      playing.frame = requestAnimationFrame(playTick);
    }
    function playTick(now: number): void {
      if (!playing || closed) return;
      const pl = playing;
      const dt = Math.min(0.1, (now - pl.last) / 1000) * pl.speed;
      pl.last = now;
      if (pl.at >= pl.order.length) {
        // A moment on the whole wiring, then back as it was.
        pl.rest += dt;
        if (pl.rest > 1.2) return stopPlayback(`${pl.order.length} wire${pl.order.length === 1 ? "" : "s"} put in.`);
      } else if (pl.rest > 0) {
        pl.rest -= dt;
      } else {
        const w = pl.order[pl.at];
        if (pl.grown === 0) {
          plugsOf(w).forEach(id => art.setShown(id, true));
          art.setShown(w.id, true);
          renderPlayBar();
        }
        // About 120 mm a second, each wire a second or two.
        const world = worldMatrices(scene.parts, scene.explode);
        const len = wireLength(w, world, loomsOf(scene.parts)) || 60;
        pl.grown = Math.min(1, pl.grown + dt / Math.max(0.6, Math.min(2.5, len / 120)));
        art.growWire(w, scene.parts, scene.explode, pl.grown, growsFromTo(w, scene.parts, world), world);
        if (pl.grown >= 1) {
          pl.at++;
          pl.grown = 0;
          pl.rest = 0.35;
        }
      }
      draw();
      pl.frame = requestAnimationFrame(playTick);
    }
    function skipWire(): void {
      if (!playing || playing.at >= playing.order.length) return;
      const w = playing.order[playing.at];
      plugsOf(w).forEach(id => art.setShown(id, true));
      art.setShown(w.id, true);
      art.growWire(w, scene.parts, scene.explode, 1);
      playing.at++;
      playing.grown = 0;
      playing.rest = 0;
      renderPlayBar();
      draw();
    }
    function stopPlayback(message = ""): void {
      if (!playing) return;
      cancelAnimationFrame(playing.frame);
      playing = null;
      playBar.hidden = true;
      rebuild();
      layout();
      status(message);
    }
    playBar.addEventListener("click", e => {
      const b = (e.target as HTMLElement).closest("button");
      if (b?.dataset.act === "play-skip") skipWire();
      else if (b?.dataset.act === "play-stop") stopPlayback();
    });
    playBar.addEventListener("change", e => {
      const el = e.target as HTMLSelectElement;
      if (el.dataset.play === "speed" && playing) playing.speed = PLAY_SPEEDS.includes(Number(el.value)) ? Number(el.value) : 1;
    });

    // ------------------------------------------------------------ the wiring animation

    // "Play the wiring animation": the wiring showcase (wiringAnimation.ts,
    // as /Wiring showcase puts on a page) made from the model as it is now,
    // seen from this view, and played over the stage, with Save to keep it.
    const player = $(".lyr-wiring-player");
    let playerUrl = "";
    function wiringMovieButton(): string {
      if (!wiresInOrder(scene.parts).length) return "";
      const label = wiringMovie ? `Making the animation… ${wiringMovie.pct}%` : "Play the wiring animation";
      const title = wiringMovie ? "Stop making the wiring animation" : "Watch the wires grow out of their parts, one after another, in the see-through view (as the Wiring showcase shows it), from this view";
      return `<button type="button" class="lyr-wide-btn" data-act="wiring-movie" title="${esc(title)}">${icon(wiringMovie ? "close" : "play", 14)} <span>${esc(label)}</span></button>`;
    }
    async function playWiringMovie(): Promise<void> {
      if (wiringMovie) {
        wiringMovie.stopped = true;
        return;
      }
      if (!wiresInOrder(scene.parts).length) return status("No wires to animate yet: add them with the Wire tool (W).", true);
      const me = (wiringMovie = { pct: 0, stopped: false });
      renderProps();
      status("Making the wiring animation…", false, true);
      try {
        const frame = $(".lyr-scene-stage").getBoundingClientRect();
        // As big as the stage shows it (even sizes, as H.264 wants), within reason.
        const w = Math.max(480, Math.min(1280, Math.round(frame.width * 0.85 / 2) * 2));
        const h = Math.max(360, Math.min(960, Math.round((w * 0.75) / 2) * 2));
        const made = await renderWiringAnimation({ parts: scene.parts }, opts.store, scene.camera.direction, {
          width: w,
          height: h,
          progress: (done, total) => {
            const pct = Math.floor((done / total) * 100);
            if (pct === me.pct) return;
            me.pct = pct;
            const label = props.querySelector('[data-act="wiring-movie"] span');
            if (label) label.textContent = `Making the animation… ${pct}%`;
          },
          cancelled: () => me.stopped || closed,
        });
        if (closed || me.stopped) throw new Error("stopped");
        showWiringMovie(made.blob, made.type);
        status("");
      } catch (e) {
        if (!closed) status(me.stopped ? "Stopped making the wiring animation." : `The wiring animation couldn't be made: ${e instanceof Error ? e.message : String(e)}`, !me.stopped);
      } finally {
        if (wiringMovie === me) wiringMovie = null;
        if (!closed) renderProps();
      }
    }
    function showWiringMovie(blob: Blob, type: string): void {
      closeWiringMovie();
      playerUrl = URL.createObjectURL(blob);
      const mp4 = type === "video/mp4";
      const name = `wiring.${mp4 ? "mp4" : "gif"}`;
      player.innerHTML = `
        <div class="lyr-wiring-player-box">
          <div class="lyr-wiring-player-head">
            <strong>${icon("wire", 16)}<span>Wiring animation</span></strong>
            <span class="lyr-grow"></span>
            <a class="lyr-btn" href="${playerUrl}" download="${name}" title="Save the animation as a file (${mp4 ? "MP4 video" : "animated GIF"})">${icon("download", 16)}<span>Save</span></a>
            <button type="button" class="lyr-btn lyr-icon-btn" data-act="wiring-close" title="Close (Esc)" aria-label="Close">${icon("close", 16)}</button>
          </div>
          ${mp4 ? `<video src="${playerUrl}" autoplay loop muted playsinline controls></video>` : `<img src="${playerUrl}" alt="The wires going in, one after another">`}
        </div>`;
      player.hidden = false;
      (player.querySelector('[data-act="wiring-close"]') as HTMLElement).focus({ preventScroll: true });
    }
    function closeWiringMovie(): boolean {
      if (player.hidden) return false;
      player.hidden = true;
      player.innerHTML = "";
      if (playerUrl) URL.revokeObjectURL(playerUrl);
      playerUrl = "";
      root.focus({ preventScroll: true });
      return true;
    }
    player.addEventListener("click", e => {
      // Closed by its button, or a click on the dimmed stage round it.
      if (e.target === player || (e.target as HTMLElement).closest('[data-act="wiring-close"]')) {
        e.stopPropagation();
        closeWiringMovie();
      }
    });
    player.addEventListener("keydown", e => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeWiringMovie();
      }
    });

    /** Moves a wire earlier or later in the order the wires go in (the model's order of wires). */
    function moveWire(p: ScenePart, by: -1 | 1): void {
      const wires = wiresInOrder(scene.parts);
      const i = wires.indexOf(p);
      const other = wires[i + by];
      if (!other) return;
      const a = scene.parts.indexOf(p);
      const b = scene.parts.indexOf(other);
      scene.parts[a] = other;
      scene.parts[b] = p;
      rebuild();
      commit();
      renderList();
      renderProps();
    }

    /** A plug's settings, in the side panel. */
    function plugSection(p: ScenePart): string {
      return `
        <label class="lyr-scene-namebox">Connector <select data-plug-connector>${connectorOptions(p.plug!.connector)}</select></label>
        <div class="lyr-scene-quick">
          <button type="button" class="lyr-btn" data-act="plug-turn" title="Turn the plug a quarter turn in its socket">${icon("rotate", 16)}<span>Turn 90°</span></button>
        </div>`;
    }

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
      delete j.offset;
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
    /** The part whose Joints list opened the dialog, selected again when it closes. */
    let jointHome = "";
    /** Whether the joint dialog shows its X/Y/Z offset row (hidden until asked for, or the joint has one). */
    let offsetOpen = false;

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
      stopScrews();
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
      offsetOpen = !!j?.offset;
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
      // Opened from a part's Joints list: back to that part, its joint still shown.
      if (jointHome && partById(jointHome)) {
        selectedId = jointHome;
        attachGizmo();
        if (shownJoint) gizmo.detach();
      }
      jointHome = "";
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
        ...(was?.offset ? { offset: was.offset } : {}),
        // A way picked by hand stays; Smart's is worked out again for the new faces.
        ...(was?.explodeDir && !was.explodeAuto ? { explodeDir: was.explodeDir } : {}),
      };
      keepInLimits(p.joint);
      applyJoint(p);
      if (!p.joint.explodeDir) smartOne(p);
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
            <div class="lyr-panel-title lyr-joint-title">
              <span>Line-up</span>
              <button type="button" class="lyr-btn lyr-icon-btn${offsetOpen ? " lyr-on" : ""}" data-act="joint-offset" aria-pressed="${offsetOpen}" title="${offsetOpen ? "Hide the offset" : "Nudge it along X, Y and Z"}" aria-label="Offset along X, Y and Z">${icon("move", 16)}</button>
            </div>
            <div class="lyr-scene-fields">
              ${jf("spin", turns ? "Angle" : "Spin", "°", j?.spin || 0, 1, "Turn it about the joint, keeping the faces together")}
              ${jf("gap", slides ? "Slide" : "Gap", "mm", j?.gap || 0, 0.1, "How far it stands off the face")}
            </div>
            ${offsetOpen ? `<div class="lyr-scene-fields lyr-joint-offset" aria-label="Offset">
              ${(["X", "Y", "Z"] as const).map(a => jf(`offset${a}`, `Offset ${a}`, "mm", fieldValue(`offset${a}`, p), 0.1, `Move it along ${partById(draft!.parentId)?.name || "the part"}'s ${a} axis, after the rest of the line-up`)).join("")}
            </div>` : ""}
            <div class="lyr-panel-title">Explode</div>
            <div class="lyr-scene-fields lyr-joint-explode">
              <label class="lyr-scene-field lyr-joint-way" title="Which way it comes off in the exploded view">
                <span>Comes off</span>
                <select data-joint-explode-dir aria-label="Which way it comes off">
                  <option value="smart"${j?.explodeAuto ? " selected" : ""}>Smart${j?.explodeAuto ? `: ${esc(explodeDirLabel(j.explodeDir))}` : ""}</option>
                  ${EXPLODE_DIRS.map(o => `<option value="${o.id}" title="${esc(o.detail)}"${!j?.explodeAuto && (j?.explodeDir || "joint") === o.id ? " selected" : ""}>${esc(o.label)}</option>`).join("")}
                </select>
              </label>
              ${jf("distance", "How far", "mm", j?.distance || 0, 1, "How far it slides out in the exploded view")}
            </div>
            <div class="lyr-scene-quick">
              <button type="button" class="lyr-btn" data-act="joint-flip" title="Turn the part over, so it sits on the other side of the face">${icon("flipV", 16)}<span>Flip</span></button>
              <button type="button" class="lyr-btn" data-act="joint-sit" title="Drop it straight down until it rests on the part beneath it (its joint's Offset takes up the move)">${icon("sit", 16)}<span>Sit on part</span></button>
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

    // A dialog moves by its title bar, so it needn't cover the parts.
    function draggable(dialog: HTMLElement): void {
    dialog.addEventListener("pointerdown", e => {
      const head = (e.target as HTMLElement).closest<HTMLElement>(".lyr-joint-head");
      if (!head || (e.target as HTMLElement).closest("button") || e.button !== 0) return;
      e.preventDefault();
      const box = dialog.getBoundingClientRect();
      const area = stage.getBoundingClientRect();
      const dx = e.clientX - box.left, dy = e.clientY - box.top;
      head.setPointerCapture(e.pointerId);
      head.classList.add("lyr-dragging");
      const move = (m: PointerEvent) => {
        const x = Math.max(0, Math.min(m.clientX - dx - area.left, area.width - box.width));
        const y = Math.max(0, Math.min(m.clientY - dy - area.top, area.height - 40));
        dialog.style.left = `${Math.round(x)}px`;
        dialog.style.top = `${Math.round(y)}px`;
        dialog.style.right = "auto";
        dialog.style.bottom = "auto";
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
    }
    draggable(jointDialog);

    jointDialog.addEventListener("change", e => {
      const t = e.target as HTMLSelectElement;
      if (draft && t.dataset.jointExplodeDir !== undefined) {
        const p = partById(draft.childId);
        if (!p?.joint) return;
        if (t.value === "smart") {
          if (!smartOne(p)) status("Smart explode needs the parts' models loaded first.", true);
        } else {
          delete p.joint.explodeAuto;
          if (t.value === "joint") delete p.joint.explodeDir;
          else p.joint.explodeDir = t.value as ExplodeDir;
        }
        // Show it coming off, so the change can be seen.
        if (p.explode === undefined && scene.explode <= 0) {
          scene.explode = 0.6;
          syncExplode();
        }
        follow();
        refit();
        renderJointDialog();
        return;
      }
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
      } else if (d.act === "joint-offset") {
        offsetOpen = !offsetOpen;
        renderJointDialog();
        if (offsetOpen) jointDialog.querySelector<HTMLInputElement>('[data-joint-field="offsetX"]')?.focus();
      } else if (d.act === "joint-sit" && p?.joint?.point) {
        sitOnParent(p);
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

    /**
     * Drops a joined part straight down (world -Z, as gravity would) until it
     * rests on whatever is beneath it, keeping its joint's faces and Gap and
     * taking up the move in the joint's Offset. A part floating over the
     * chassis drops onto it; one sunk into it rises out.
     */
    function sitOnParent(p: ScenePart): void {
      const j = p.joint;
      const cm = models.get(p.id);
      if (!j?.point || !p.parent || !cm || cm instanceof Error) {
        status("The part's model needs to be loaded first.", true);
        return;
      }
      const world = worldMatrices(scene.parts, 0, false);
      const cw = world.get(p.id);
      const pw = world.get(p.parent);
      if (!cw || !pw) return;
      cm.geometry.computeBoundingBox();
      const cb = cm.geometry.boundingBox!.clone().applyMatrix4(cw);
      // Everything shown that isn't carried by this part, and is under it.
      const own = branch(p.id);
      const chunks: Float32Array[] = [];
      const v = new Vector3();
      for (const o of scene.parts) {
        const m = models.get(o.id);
        const mw = world.get(o.id);
        if (own.has(o.id) || o.hidden || o.wire || !m || m instanceof Error || !mw) continue;
        m.geometry.computeBoundingBox();
        const ob = m.geometry.boundingBox!.clone().applyMatrix4(mw);
        if (ob.max.x < cb.min.x || ob.min.x > cb.max.x || ob.max.y < cb.min.y || ob.min.y > cb.max.y) continue;
        const pos = m.geometry.getAttribute("position").array;
        const out = new Float32Array(pos.length);
        for (let i = 0; i + 2 < pos.length; i += 3) {
          v.set(pos[i], pos[i + 1], pos[i + 2]).applyMatrix4(mw);
          out[i] = v.x;
          out[i + 1] = v.y;
          out[i + 2] = v.z;
        }
        chunks.push(out);
      }
      const all = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
      chunks.reduce((at, c) => (all.set(c, at), at + c.length), 0);
      const move = chunks.length ? sitDelta(all, cm.geometry.getAttribute("position").array, cw, [0, 0, 1]) : null;
      if (move === null) {
        status(`Nothing is beneath “${p.name}” for it to sit on.`, true);
        return;
      }
      if (Math.abs(move) < 0.01) {
        status(`“${p.name}” already sits on what's beneath it.`);
        return;
      }
      // The move is straight up or down in the world; the Offset is in the parent's frame.
      const up = new Vector3(0, 0, 1).transformDirection(new Matrix4().copy(pw).invert()).multiplyScalar(move);
      const o: Vec3 = [...(j.offset || [0, 0, 0])];
      const next = o.map((x, i) => round(x + up.getComponent(i), 2)) as Vec3;
      if (next.some(x => x !== 0)) j.offset = next;
      else delete j.offset;
      applyJoint(p);
      follow();
      offsetOpen = true;
      renderJointDialog();
      showJoint(p.id);
      renderProps();
      status(`“${p.name}” sits on what's beneath it (moved ${round(Math.abs(move), 2)} mm ${move > 0 ? "up" : "down"}).`);
    }

    // ------------------------------------------------------------ the track dialog

    // Make track: one piece (a track link) repeated round two or more wheels.
    // Pick the piece's two pivots (where it joins the piece before and the
    // piece after), then a round edge on each wheel; the track is laid round
    // them as a belt (track.ts) and drawn as one part, joined to the part
    // the wheels are on. Count, Offset (round the loop), Lift (off the
    // wheels), Sideways and Flip line it up; it's redrawn as they change.

    interface TrackDraft {
      linkId: string;
      /** The track's part, once there's one to show. */
      trackId: string;
      spec: { count: number; start?: Vec3; end?: Vec3; axis?: Vec3; wheels: TrackWheel[]; offset: number; lift: number; side: number; flip?: boolean };
      /** The lift was typed in: Flip and new pivots leave it. */
      liftSet: boolean;
      /** How many pieces go round exactly, as last laid. */
      fits: number;
      pitch: number;
      before: string;
      busy?: boolean;
    }
    let trackDraft: TrackDraft | null = null;
    /** What a click in the view picks for the track: a pivot on the piece, or a wheel's circle. */
    let trackPick: "start" | "end" | "wheel" | null = null;

    const trackDialog = document.createElement("div");
    trackDialog.className = "lyr-joint-dialog lyr-track-dialog";
    trackDialog.setAttribute("role", "dialog");
    trackDialog.setAttribute("aria-label", "Make track");
    trackDialog.hidden = true;
    stage.appendChild(trackDialog);
    draggable(trackDialog);

    const trackSpecOf = (d: TrackDraft): TrackSpec | null => {
      const s = d.spec;
      if (!s.start || !s.end || !s.axis) return null;
      return { link: d.linkId, count: s.count, start: s.start, end: s.end, axis: s.axis, wheels: s.wheels, offset: s.offset, lift: s.lift, side: s.side, ...(s.flip ? { flip: true } : {}) };
    };
    const linkModel = (): Model | null => {
      const m = trackDraft ? models.get(trackDraft.linkId) : undefined;
      return m && !(m instanceof Error) ? m : null;
    };

    function openTrackDialog(id: string): void {
      const p = partById(id);
      if (!p) return;
      // A track's own button changes it; any other part is the piece.
      const old = p.track;
      const linkId = old ? old.link : id;
      const link = partById(linkId);
      if (!link || !(models.get(linkId) && !(models.get(linkId) instanceof Error))) {
        status(old ? "The piece this track was made from isn't in the scene any more, so it can't be changed." : "That part's model isn't loaded.", true);
        return;
      }
      if (draft) closeJointDialog();
      if (joining) stopJoin();
      stopScrews();
      if (section.picking()) section.stop();
      trackDraft = {
        linkId,
        trackId: old ? id : "",
        spec: old
          ? { count: old.count, start: old.start, end: old.end, axis: old.axis, wheels: structuredClone(old.wheels), offset: old.offset, lift: old.lift, side: old.side, ...(old.flip ? { flip: true } : {}) }
          : { count: 0, wheels: [], offset: 0, lift: 0, side: 0 },
        liftSet: !!old,
        fits: 0,
        pitch: 0,
        before: snap(),
      };
      // The piece is shown while the dialog is open, so its pivots can be picked; OK puts it away.
      if (link.hidden) {
        delete link.hidden;
        rebuild();
      }
      selectedId = trackDraft.trackId || linkId;
      shownJoint = "";
      renderList();
      renderProps();
      renderTrackDialog();
      if (old) layTrackNow();
      else startTrackPick("start");
    }

    function closeTrackDialog(): void {
      if (trackPick) stopTrackPick();
      trackDraft = null;
      trackDialog.hidden = true;
      attachGizmo();
      renderList();
      renderProps();
      placeSnaps();
      draw();
    }

    function startTrackPick(which: "start" | "end" | "wheel"): void {
      if (!trackDraft) return;
      trackPick = which;
      canvasEl.classList.add("lyr-scene-picking");
      gizmo.detach();
      clearHover();
      const name = esc(partById(trackDraft.linkId)?.name);
      status(which === "start"
        ? `Click the pivot on “${name}” where it joins the piece before it: the centre of its pin or hole. Esc to stop.`
        : which === "end"
          ? `Now the pivot at its other end, where the next piece joins on. Esc to stop.`
          : `Click a round edge on each wheel the track goes round (two or more). Esc when they're all picked.`, false, true);
      renderTrackDialog();
      placeSnaps();
      draw();
    }

    function stopTrackPick(message = ""): void {
      trackPick = null;
      faceHeld = false;
      clearHover();
      canvasEl.classList.remove("lyr-scene-picking");
      status(message);
      if (trackDraft) renderTrackDialog();
      placeSnaps();
      draw();
    }

    function trackClick(): void {
      if (!trackDraft || !trackPick) return;
      const s = hover && hover.snap >= 0 ? hoverSnaps()[hover.snap] : undefined;
      const d = trackDraft;
      if (trackPick === "wheel") {
        if (!hover || !s?.radius) {
          status("Click a round edge on a wheel: its rim, or the edge of its hub or axle hole. Esc when they're all picked.", true, true);
          return;
        }
        if (hover.id === d.linkId || hover.id === d.trackId) return;
        const r3 = (v: number[]) => v.map(n => round(n, 4)) as Vec3;
        const w: TrackWheel = { id: hover.id, point: r3(s.p), normal: r3(s.n), radius: round(s.radius, 3) };
        // The same circle again takes it out.
        const at = d.spec.wheels.findIndex(x => x.id === w.id && Math.hypot(x.point[0] - w.point[0], x.point[1] - w.point[1], x.point[2] - w.point[2]) < 0.05);
        if (at >= 0) d.spec.wheels.splice(at, 1);
        else d.spec.wheels.push(w);
        const n = d.spec.wheels.length;
        status(n < 2 ? "Now a round edge on the next wheel. Esc when they're all picked." : `${n} wheels. Click another, or Esc when they're all picked.`, false, true);
        clearHover();
        layTrackNow();
        renderTrackDialog();
        return;
      }
      const f = hoverPick();
      if (!f || f.id !== d.linkId) {
        status(`Click a pivot on “${esc(partById(d.linkId)?.name)}” itself. Esc to stop.`, true, true);
        return;
      }
      if (trackPick === "start") {
        d.spec.start = f.point;
        d.spec.axis = f.normal;
      } else {
        d.spec.end = f.point;
        if (!d.spec.axis) d.spec.axis = f.normal;
      }
      const which = trackPick;
      stopTrackPick();
      if (d.spec.start && d.spec.end && !(trackPitch(trackSpecOf(d)!) > 0.5)) {
        status("Those pivots are on the same pin: pick the pivot at the piece's other end.", true);
        delete d.spec.end;
        startTrackPick("end");
        return;
      }
      autoLift();
      if (which === "start" && !d.spec.end) startTrackPick("end");
      else if (d.spec.wheels.length < 2) startTrackPick("wheel");
      else layTrackNow();
      renderTrackDialog();
    }

    /** The lift that sets the piece's inside on the wheels, unless one was typed in. */
    function autoLift(force = false): void {
      const d = trackDraft;
      const spec = d && trackSpecOf(d);
      const m = linkModel();
      if (!d || !spec || !m || (d.liftSet && !force)) return;
      d.spec.lift = insideReach(m.geometry.getAttribute("position").array as ArrayLike<number>, spec);
      if (force) d.liftSet = false;
    }

    /** The deepest part every wheel is joined under (not a wheel, nor the piece): the track joins it. */
    function trackParent(d: TrackDraft): ScenePart | undefined {
      const chain = (id: string) => {
        const out: string[] = [];
        for (let p = partById(id)?.parent ? partById(partById(id)!.parent!) : undefined, k = 0; p && k < 64; p = p.parent ? partById(p.parent) : undefined, k++) out.push(p.id);
        return out;
      };
      const chains = d.spec.wheels.map(w => chain(w.id));
      if (!chains.length) return undefined;
      const skip = new Set([d.linkId, d.trackId, ...d.spec.wheels.map(w => w.id), ...branch(d.trackId || d.linkId)]);
      const common = chains[0].find(id => chains.every(c => c.includes(id)) && !skip.has(id));
      return common ? partById(common) : undefined;
    }

    /** Lays the track round the wheels and shows it, as a part (made the first time). */
    let trackPreview: Model | null = null;
    function layTrackNow(): void {
      const d = trackDraft;
      const spec = d && trackSpecOf(d);
      const m = linkModel();
      if (!d || !spec || !m) return;
      const link = partById(d.linkId)!;
      const world = worldMatrices(scene.parts, 0, false);
      const circles: WorldCircle[] = [];
      for (const w of spec.wheels) {
        const at = world.get(w.id);
        if (!at || !partById(w.id)) continue;
        circles.push({ centre: new Vector3(...w.point).applyMatrix4(at), normal: new Vector3(...w.normal).transformDirection(at), radius: w.radius });
      }
      if (circles.length < 2) {
        d.fits = 0;
        syncTrackInfo();
        return;
      }
      // First time round: as many pieces as fit.
      if (!d.spec.count) {
        const trial = layTrack({ ...spec, count: 1 }, circles);
        d.spec.count = Math.max(2, Math.min(MAX_TRACK_PIECES, Math.round(trial.fits) || 2));
        spec.count = d.spec.count;
      }
      const lay = layTrack(spec, circles);
      d.fits = lay.fits;
      d.pitch = lay.pitch;
      if (!lay.pieces.length) {
        syncTrackInfo();
        return;
      }
      const parent = trackParent(d);
      const toParent = parent ? (world.get(parent.id) || new Matrix4()).clone().invert() : new Matrix4();
      const tri = trackTriangles(m.geometry.getAttribute("position").array as ArrayLike<number>, lay.pieces, toParent);
      const model = modelFromPositions(tri, null);
      let part = d.trackId ? partById(d.trackId) : undefined;
      if (!part) {
        part = { id: newPartId(scene.parts), name: `${link.name} track`.slice(0, 120), position: [0, 0, 0], rotation: [0, 0, 0] };
        scene.parts.push(part);
        d.trackId = part.id;
      }
      part.position = model.centre.map(n => round(n, 3)) as Vec3;
      part.rotation = [0, 0, 0];
      part.track = { ...spec, wheels: structuredClone(spec.wheels) };
      // It comes off sideways in an exploded view, along the axle, away from what it's on.
      const W = circles[0].normal.clone().normalize();
      if (parent) {
        const pm = new Vector3().setFromMatrixPosition(world.get(parent.id) || new Matrix4());
        const mid = new Vector3(...model.centre).applyMatrix4(world.get(parent.id) || new Matrix4());
        if (mid.sub(pm).dot(W) < 0) W.negate();
        part.parent = parent.id;
        const n = W.transformDirection(toParent);
        part.joint = { normal: [round(n.x, 5), round(n.y, 5), round(n.z, 5)], distance: Math.max(20, Math.round(Math.max(...m.size) * 2.5)) };
      } else {
        delete part.parent;
        delete part.joint;
      }
      const was = trackPreview;
      trackPreview = model;
      keepModel(part, model);
      selectedId = part.id;
      rebuild();
      if (was && was !== model) {
        was.geometry.dispose();
        was.edges.forEach(e => e.dispose());
      }
      renderProps();
      syncTrackInfo();
    }
    let trackQueued = 0;
    const layTrackSoon = () => {
      clearTimeout(trackQueued);
      trackQueued = window.setTimeout(layTrackNow, 120);
    };

    /** How the count compares with the loop: tight, slack or just right. */
    function trackFitText(d: TrackDraft): string {
      if (!d.fits) return "";
      const f = round(d.fits, 1);
      const off = d.spec.count - d.fits;
      const by = Math.abs(off) * d.pitch;
      const how = by < 0.5 ? "a good fit" : off > 0 ? `${round(by, 1)} mm too long, so it overlaps` : `${round(by, 1)} mm short of closing`;
      return `${f} pieces go round: ${how}.`;
    }

    function syncTrackInfo(): void {
      const d = trackDraft;
      const el = trackDialog.querySelector<HTMLElement>("[data-track-info]");
      if (!d || !el) return;
      el.textContent = trackFitText(d);
      const fit = trackDialog.querySelector<HTMLButtonElement>("[data-act=track-fit]");
      if (fit) {
        const n = Math.max(2, Math.round(d.fits));
        fit.disabled = !d.fits || n === d.spec.count;
        fit.querySelector("span")!.textContent = d.fits ? `Use ${n}` : "Use";
      }
      trackDialog.querySelectorAll<HTMLInputElement>("[data-track-field]").forEach(inp => {
        if (document.activeElement !== inp) inp.value = String(round((d.spec as unknown as Record<string, number>)[inp.dataset.trackField!] || 0, 2));
      });
      const ok = trackDialog.querySelector<HTMLButtonElement>("[data-act=track-ok]");
      if (ok) ok.disabled = !d.trackId || !!d.busy;
    }

    const tf = (key: string, label: string, unit: string, value: number, step: number, title: string) => `
      <label class="lyr-scene-field" title="${esc(title)}">
        <span>${esc(label)}</span>
        <input class="lyr-num" type="number" step="${step}" data-track-field="${key}" value="${round(value, 2)}">
        <em>${esc(unit)}</em>
      </label>`;

    function renderTrackDialog(): void {
      const d = trackDraft;
      if (!d) {
        trackDialog.hidden = true;
        return;
      }
      const link = partById(d.linkId);
      if (!link) return closeTrackDialog();
      const s = d.spec;
      const pivot = (which: "start" | "end", label: string, title: string) => {
        const picked = s[which];
        const picking = trackPick === which;
        return `<div class="lyr-joint-face" title="${esc(title)}">
          <button type="button" class="lyr-wide-btn${picking ? " lyr-on" : ""}" data-track-pick="${which}">
            ${icon(picked ? "check" : "plus", 14)} ${picking ? "Click the pivot in the view…" : picked ? `${esc(label)} at ${esc(mm(picked))}` : `${esc(label)}: pick…`}
          </button>
        </div>`;
      };
      const ready = !!(s.start && s.end && s.wheels.length >= 2);
      trackDialog.innerHTML = `
        <div class="lyr-joint-head">
          ${icon("track", 16)}<strong title="Drag here to move the dialog">${d.trackId && partById(d.trackId)?.data ? "Edit track" : "Make track"}</strong>
          <span class="lyr-grow"></span>
          <button type="button" class="lyr-btn lyr-icon-btn" data-act="track-cancel" title="Close without keeping the track" aria-label="Close">${icon("close", 16)}</button>
        </div>
        <div class="lyr-joint-body">
          <div class="lyr-panel-title">Track piece</div>
          <p class="lyr-note lyr-track-piece">${icon("cube", 14)} <strong>${esc(link.name)}</strong></p>
          <div class="lyr-panel-title">Pivots on the piece</div>
          ${pivot("start", "Start pivot", "Where it joins the piece before it: the centre of its pin or hole")}
          ${pivot("end", "End pivot", "Where the next piece joins on, at its other end")}
          ${d.pitch ? `<p class="lyr-note">Pitch ${round(d.pitch, 2)} mm.</p>` : ""}
          <div class="lyr-panel-title">Wheels to wrap</div>
          <ul class="lyr-track-wheels">
            ${s.wheels.map((w, i) => `<li><span>${icon("rotate", 14)} ${esc(partById(w.id)?.name || "Missing part")}</span><em>Ø${round(w.radius * 2, 1)}</em>
              <button type="button" class="lyr-btn lyr-icon-btn" data-track-unwheel="${i}" title="Leave this wheel out" aria-label="Leave this wheel out">${icon("close", 14)}</button></li>`).join("")}
          </ul>
          <div class="lyr-joint-face">
            <button type="button" class="lyr-wide-btn${trackPick === "wheel" ? " lyr-on" : ""}" data-track-pick="wheel" title="Click a round edge on each wheel: its rim, or the edge of its hub">
              ${icon("plus", 14)} ${trackPick === "wheel" ? "Click each wheel's round edge…" : s.wheels.length ? "Add a wheel…" : "Pick the wheels…"}
            </button>
          </div>
          ${ready ? `
            <div class="lyr-panel-title">Pieces</div>
            <div class="lyr-scene-fields">
              ${tf("count", "How many", "", s.count, 1, "How many pieces make the track")}
            </div>
            <div class="lyr-track-fit">
              <p class="lyr-note" data-track-info>${esc(trackFitText(d))}</p>
              <button type="button" class="lyr-btn" data-act="track-fit" title="As many pieces as go round the wheels"><span>Use</span></button>
            </div>
            <div class="lyr-panel-title">Line-up</div>
            <div class="lyr-scene-fields">
              ${tf("offset", "Offset", "mm", s.offset, 0.5, "Move the pieces on round the wheels, to line teeth up with holes")}
              ${tf("lift", "Lift", "mm", s.lift, 0.1, "How far the pivots sit outside the wheels' round edges")}
              ${tf("side", "Sideways", "mm", s.side, 0.5, "Move the track along the axles")}
            </div>
            <div class="lyr-scene-quick">
              <button type="button" class="lyr-btn" data-act="track-flip" title="Turn the pieces over, so their other side faces the wheels">${icon("flipV", 16)}<span>Flip</span></button>
              <button type="button" class="lyr-btn" data-act="track-lift" title="Set the lift so the pieces' insides sit on the wheels">Sit on wheels</button>
            </div>`
          : `<p class="lyr-note">Pick the piece's two pivots, then a round edge on two or more wheels. The track is laid round them.</p>`}
        </div>
        <div class="lyr-joint-foot">
          <button type="button" class="lyr-btn" data-act="track-cancel">Cancel</button>
          <button type="button" class="lyr-btn lyr-done" data-act="track-ok">${icon("check", 16)}<span>OK</span></button>
        </div>`;
      trackDialog.hidden = false;
      syncTrackInfo();
    }

    trackDialog.addEventListener("input", e => {
      const t = e.target as HTMLInputElement;
      const d = trackDraft;
      const key = t.dataset.trackField;
      if (!d || !key) return;
      const v = Number(t.value);
      if (!Number.isFinite(v)) return;
      if (key === "count") d.spec.count = Math.max(1, Math.min(MAX_TRACK_PIECES, Math.round(v)));
      else if (key === "offset" || key === "side") d.spec[key] = Math.max(-1e4, Math.min(1e4, v));
      else if (key === "lift") {
        d.spec.lift = Math.max(-1e3, Math.min(1e3, v));
        d.liftSet = true;
      }
      layTrackSoon();
    });
    trackDialog.addEventListener("keydown", e => {
      const t = e.target as HTMLInputElement;
      if (!t.dataset.trackField || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
      e.preventDefault();
      const step = Number(t.step) || 1;
      const by = step * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1) * (e.key === "ArrowUp" ? 1 : -1);
      t.value = String(round(Number(t.value) + by, 3));
      t.dispatchEvent(new Event("input", { bubbles: true }));
    });
    trackDialog.addEventListener("click", e => {
      const b = (e.target as HTMLElement).closest("button");
      const d = trackDraft;
      if (!b || !d) return;
      const a = b.dataset;
      if (a.trackPick) {
        if (trackPick === a.trackPick) stopTrackPick();
        else startTrackPick(a.trackPick as "start" | "end" | "wheel");
      } else if (a.trackUnwheel) {
        d.spec.wheels.splice(Number(a.trackUnwheel), 1);
        layTrackNow();
        renderTrackDialog();
      } else if (a.act === "track-fit") {
        if (d.fits) d.spec.count = Math.max(2, Math.round(d.fits));
        layTrackNow();
      } else if (a.act === "track-flip") {
        d.spec.flip = !d.spec.flip || undefined;
        autoLift();
        layTrackNow();
      } else if (a.act === "track-lift") {
        autoLift(true);
        layTrackNow();
      } else if (a.act === "track-ok") void finishTrack();
      else if (a.act === "track-cancel") cancelTrack();
    });

    function cancelTrack(): void {
      const d = trackDraft;
      if (!d) return;
      clearTimeout(trackQueued);
      const before = d.before;
      closeTrackDialog();
      trackPreview = null;
      restore(before);
      syncHistory();
      status("");
    }

    async function finishTrack(): Promise<void> {
      const d = trackDraft;
      if (!d || d.busy) return;
      clearTimeout(trackQueued);
      layTrackNow();
      const part = d.trackId ? partById(d.trackId) : undefined;
      const model = part ? models.get(part.id) : undefined;
      if (!part || !model || model instanceof Error) return;
      d.busy = true;
      syncTrackInfo();
      status("Saving the track…", false, true);
      try {
        const data = await packMesh(model.geometry.getAttribute("position").array as Float32Array);
        if (closed || trackDraft !== d) return;
        if (data.length > MAX_EMBED) {
          status(tooBigToCarry(`The track (${part.track?.count} pieces)`, data.length), true, true);
          return;
        }
        part.data = data;
        part.file = `${(partById(d.linkId)?.name || "track").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "piece"}-track.stl`;
        opts.store.put(part, model);
        keepModel(part, model);
        trackPreview = null;
        // The piece is in the track now: it's put away.
        const link = partById(d.linkId);
        if (link) link.hidden = true;
        const n = part.track?.count || 0;
        const wheels = part.track?.wheels.length || 0;
        selectedId = part.id;
        closeTrackDialog();
        rebuild();
        commit();
        status(`“${part.name}” made: ${n} pieces round ${wheels} wheels. The piece it's made from stays out of the pictures (Edit track still uses it).`);
      } catch (e) {
        status(`The track couldn't be saved: ${e instanceof Error ? e.message : String(e)}`, true, true);
      } finally {
        d.busy = false;
        if (trackDraft === d) syncTrackInfo();
      }
    }

    /** Make track (or Edit track, on a track): under the joint's buttons. */
    function trackButton(p: ScenePart): string {
      if (p.screw || scene.parts.length < 2) return "";
      return p.track
        ? `<div class="lyr-scene-join"><button type="button" class="lyr-wide-btn" data-act="track" title="Change the track: its pieces, pivots, wheels and line-up">${icon("track", 16)} Edit track…</button></div>`
        : `<div class="lyr-scene-join"><button type="button" class="lyr-wide-btn" data-act="track" title="Repeat this part as a track round two or more wheels, joined at its pivots">${icon("track", 16)} Make track…</button></div>`;
    }

    function jointSection(p: ScenePart, parent: ScenePart | undefined): string {
      const others = scene.parts.length > 1;
      if (p.track) {
        return `<div class="lyr-scene-join"><p class="lyr-note">A track of ${p.track.count} pieces round ${p.track.wheels.length} wheels${parent ? `, on <strong>${esc(parent.name)}</strong>` : ""}. Change it with Edit track.</p></div>
          ${parent ? `<div class="lyr-scene-fields">${field("distance", "Explode", "mm", p.joint?.distance || 0, 1, "How far it slides off in the exploded view")}</div>` : ""}
          ${trackButton(p)}`;
      }
      if (!parent) {
        return (others
          ? `<div class="lyr-scene-join"><button type="button" class="lyr-wide-btn" data-act="join" title="Pick a face on this part, then the face on another part it fits against">${icon("layers", 16)} Join to another part…</button></div>`
          : "") + trackButton(p);
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
        ${scene.arrows ? `<div class="lyr-scene-sub">Arrow</div>
        <label class="lyr-scene-check" title="An arrow in the picture along this part's gap when it's drawn apart"><input type="checkbox" data-arrow${p.arrow?.off ? "" : " checked"}> Arrow when exploded</label>
        ${p.arrow?.off ? "" : `<div class="lyr-scene-fields">
          ${field("arrowFrom", "From", "%", fieldValue("arrowFrom", p), 5, "Where the arrow starts: 0 at the part, 100 where it fits")}
          ${field("arrowTo", "To", "%", fieldValue("arrowTo", p), 5, "Where the arrow's head is: 0 at the part, 100 where it fits")}
        </div>`}` : ""}
        <div class="lyr-scene-quick">
          <button type="button" class="lyr-btn" data-act="join" title="Pick the two faces again">Re-join</button>
          <button type="button" class="lyr-btn" data-act="unjoin" title="Stand on its own again, where it is now">Unjoin</button>
        </div>
      </div>${trackButton(p)}`;
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
      refit();
      syncJointExplode();
    });
    explodeInput.addEventListener("change", () => commit());
    explodeNum.addEventListener("input", () => {
      const v = Number(explodeNum.value);
      if (explodeNum.value === "" || !Number.isFinite(v)) return;
      scene.explode = Math.max(0, Math.min(100, Math.round(v))) / 100;
      explodeInput.value = String(Math.round(scene.explode * 100));
      follow();
      refit();
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

    /** Every joint the part has, its own and the ones on it, each one click from its tools. */
    function jointsList(p: ScenePart): string {
      const js = partJoints(scene.parts, p.id);
      if (!js.length) return "";
      const kind = (t: JointType) => JOINT_TYPES.find(x => x.id === t)?.label || "Fixed";
      const row = (j: (typeof js)[number]) => `<li class="lyr-scene-row lyr-scene-pjoint${shownJoint === j.id ? " lyr-on" : ""}">
          <button type="button" class="lyr-btn lyr-icon-btn lyr-scene-tick${j.explodes ? " lyr-on" : ""}" data-pj-tick="${esc(j.id)}" title="${j.explodes ? "Explodes: click to keep this joint assembled in this scene" : "Stays assembled: click to explode it again"}" aria-label="Explode this joint" aria-pressed="${j.explodes}">${icon(j.explodes ? "ticked" : "border", 16)}</button>
          <button type="button" class="lyr-scene-name" data-pj-show="${esc(j.id)}" title="Show where they join">${icon("link", 14)}<span>${esc(j.other.name)}</span><small>${esc(kind(j.type))}</small></button>
          <button type="button" class="lyr-btn lyr-icon-btn" data-pj-go="${esc(j.other.id)}" title="Select ${esc(j.other.name)}" aria-label="Select ${esc(j.other.name)}">${icon("chevronRight", 16)}</button>
          <button type="button" class="lyr-btn lyr-icon-btn" data-pj-edit="${esc(j.id)}" title="Edit the joint" aria-label="Edit the joint to ${esc(j.other.name)}">${icon("pencil", 16)}</button>
          <button type="button" class="lyr-btn lyr-icon-btn" data-pj-remove="${esc(j.id)}" title="Remove the joint (the parts stay where they are)" aria-label="Remove the joint to ${esc(j.other.name)}">${icon("unlink", 16)}</button>
        </li>`;
      const on = js.filter(j => j.role === "on");
      const holds = js.filter(j => j.role === "holds");
      return `<div class="lyr-scene-pjoints">
        <div class="lyr-scene-sub">Joints <span class="lyr-scene-count">${js.length}</span></div>
        ${on.length ? `<div class="lyr-scene-pjoints-head">Joined to</div><ul class="lyr-scene-list">${on.map(row).join("")}</ul>` : ""}
        ${holds.length ? `<div class="lyr-scene-pjoints-head">Joined to this part</div><ul class="lyr-scene-list">${holds.map(row).join("")}</ul>` : ""}
      </div>`;
    }

    function renderProps(): void {
      if (stepsOn) {
        props.innerHTML = stepPanel();
        return;
      }
      const p = partById(selectedId);
      const parent = p?.parent ? partById(p.parent) : undefined;
      props.innerHTML = `
        <section class="lyr-scene-section">
          <div class="lyr-panel-title">${p?.wire ? "Wire" : p?.plug ? "Plug" : "Part"}</div>
          ${p?.wire ? `
            <label class="lyr-scene-namebox">Name <input type="text" maxlength="120" data-name value="${esc(p.name)}"></label>
            ${wireSection(p)}`
          : p ? `
            <label class="lyr-scene-namebox">Name <input type="text" maxlength="120" data-name value="${esc(p.name)}"></label>
            ${p.plug ? plugSection(p) : ""}
            ${jointsList(p)}
            ${jointSection(p, parent)}
            ${locked(p) && !p.track ? `<p class="lyr-note lyr-scene-locked-note">${icon("link", 14)} Held in place by its joint to ${esc(parent?.name || "its parent")}, so it moves with it. Turn or slide it with the joint's ${p.joint?.type === "prismatic" ? "Slide" : p.joint?.type === "revolute" ? "Angle" : "Spin and Gap"}, or Unjoin it to place it by hand.</p>` : ""}
            <fieldset class="lyr-scene-placing"${locked(p) ? " disabled" : ""}>
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
            </fieldset>
            <label class="lyr-scene-check" title="Draw it faint, for a part fitted in an earlier step"><input type="checkbox" data-ghost${p.ghost ? " checked" : ""}> Ghost (fitted earlier)</label>
            ${xrayRow(p)}
            <p class="lyr-note">Arrow keys in a box: ±1 step, Shift ×10, Alt ×0.1. Or drag a label sideways.</p>`
          : `<p class="lyr-note">${scene.parts.length ? "Click a part, in the view or the list, to place it." : "Add a part to start."}</p>`}
        </section>
        ${diagramSection(p)}
        <section class="lyr-scene-section"${modelOnly ? " hidden" : ""}>
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
          <label class="lyr-scene-check" title="Thin lines where a flat face turns into a rounded edge, so fillets and rounded ends show"><input type="checkbox" data-rounds${scene.style.rounds === false ? "" : " checked"}> Rounded edges</label>
          <label class="lyr-scene-check" title="In an exploded view, a line from each part back to where it fits"><input type="checkbox" data-draft${scene.style.draft === false ? "" : " checked"}> Draft lines when exploded</label>
          ${scene.style.draft === false ? "" : `<label class="lyr-scene-check" title="Thin solid lines, as on a flat-pack sheet, instead of dashed ones"><input type="checkbox" data-draft-solid${scene.style.draftSolid ? " checked" : ""}> Solid draft lines</label>`}
          <label class="lyr-scene-check" title="Solid arrows in the picture along each exploded part's gap, from the part to where it fits, as on a flat-pack sheet"><input type="checkbox" data-arrows${scene.arrows ? " checked" : ""}> Arrows when exploded</label>
          ${scene.parts.some(isWiring) || scene.wiring || scene.hideWiring ? `
          <label class="lyr-scene-check" title="Ghost every part but the wires and plugs, so the wiring reads"><input type="checkbox" data-wiring${scene.wiring && !scene.seeThrough ? " checked" : ""}${scene.hideWiring ? " disabled" : ""}> Wiring view</label>
          <label class="lyr-scene-check" title="Leave the wires and plugs out of this picture (they stay in the model)"><input type="checkbox" data-hide-wiring${scene.hideWiring ? " checked" : ""}> Hide wiring</label>` : ""}
          ${scene.parts.length ? `<label class="lyr-scene-check" title="The printed parts drawn as glass, so the electronics inside and the wires between them show. Set a part's own in its settings"><input type="checkbox" data-see-through${scene.seeThrough ? " checked" : ""}> See-through (show the electronics)</label>` : ""}
          ${wiresInOrder(scene.parts).length ? `
          <label class="lyr-scene-namebox" title="A wiring step: this wire is put in, the ones before it ghosted, the ones after it left out">Wiring step <select data-wire-step><option value="">None</option>${wiresInOrder(scene.parts).map((w, i) => `<option value="${esc(w.id)}"${w.id === scene.wireStep ? " selected" : ""}>${i + 1}. ${esc(w.name)}</option>`).join("")}</select></label>
          <button type="button" class="lyr-wide-btn" data-act="wires-play" title="Watch the wires go in, one after another, in their order">${icon("play", 14)} Assemble ${wiresInOrder(scene.parts).length} wire${wiresInOrder(scene.parts).length === 1 ? "" : "s"}</button>` : ""}
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
        renderProps();
        commit();
      } else if (t.dataset.rounds !== undefined) {
        if (t.checked) delete scene.style.rounds;
        else scene.style.rounds = false;
        rebuild();
        commit();
      } else if (t.dataset.draftSolid !== undefined) {
        if (t.checked) scene.style.draftSolid = true;
        else delete scene.style.draftSolid;
        rebuild();
        commit();
      } else if (t.dataset.arrows !== undefined) {
        if (t.checked) scene.arrows = true;
        else delete scene.arrows;
        renderProps();
        draw();
        commit();
      } else if (t.dataset.wiring !== undefined || t.dataset.hideWiring !== undefined || t.dataset.seeThrough !== undefined) {
        const key = t.dataset.wiring !== undefined ? "wiring" : t.dataset.hideWiring !== undefined ? "hideWiring" : "seeThrough";
        if (t.checked) scene[key] = true;
        else delete scene[key];
        // The wiring view ghosts the electronics too; the see-through view keeps them: one or the other.
        if (t.checked && key === "wiring") delete scene.seeThrough;
        if (t.checked && key === "seeThrough") delete scene.wiring;
        rebuild();
        renderProps();
        commit();
      } else if (t.dataset.wireColourPick !== undefined) {
        setWire(w => withCoreColour(w, coreAt, t.value));
      } else if (t.dataset.arrow !== undefined) {
        const p = partById(selectedId);
        if (!p) return;
        const a = { ...(p.arrow || {}) };
        if (t.checked) delete a.off;
        else a.off = true;
        if (Object.keys(a).length) p.arrow = a;
        else delete p.arrow;
        renderProps();
        follow();
        commit();
      } else if (t.dataset.xray !== undefined) {
        const p = partById(selectedId);
        if (!p) return;
        if (t.value === "solid" || t.value === "glass") p.xray = t.value;
        else delete p.xray;
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
      if (t.dataset.plugConnector !== undefined) {
        const p = partById(selectedId);
        if (p?.plug) void setPlugConnector(p, t.value);
        return;
      }
      if (t.dataset.wireStep !== undefined) {
        if (t.value && wireById(t.value)) scene.wireStep = t.value;
        else delete scene.wireStep;
        rebuild();
        commit();
        renderProps();
        return;
      }
      if (t.dataset.linkDiagram !== undefined) {
        const p = partById(t.value);
        if (p && !isWiring(p)) {
          setWiringPart(p, t.dataset.linkDiagram);
          commit();
          showPins(p.id);
        }
        return;
      }
      if (t.dataset.wiringPart !== undefined) {
        const p = partById(selectedId);
        if (p && !isWiring(p)) setWiringPart(p, t.value);
        commit();
        renderProps();
        return;
      }
      if (t.dataset.socketPort !== undefined) {
        const plug = partById(selectedId);
        const host = plug?.parent ? partById(plug.parent) : undefined;
        if (plug?.plug && host?.sockets) {
          host.sockets = host.sockets.map(x => {
            if (x.id !== plug.plug!.socket) return x;
            const out = { ...x };
            if (t.value) out.port = t.value;
            else delete out.port;
            return out;
          });
        }
        commit();
        renderProps();
        return;
      }
      if (t.dataset.wireAlong !== undefined) {
        const p = wireById(selectedId);
        if (!p?.wire) return;
        const ways = p.wire.waypoints.filter(x => !x.along);
        const loom = t.value ? wireById(t.value) : undefined;
        if (!loom?.wire) {
          p.wire = { ...p.wire, waypoints: ways };
          relay(p);
          commit();
          renderProps();
          status("It runs on its own again.");
          return;
        }
        // Where it joins and leaves: the other wire's points nearest this one's ends.
        const world = worldMatrices(scene.parts, scene.explode);
        const looms = loomsOf(scene.parts);
        const route = wireRoute({ ...loom.wire, waypoints: loom.wire.waypoints.filter(x => !x.along) }, world, looms);
        const own = wireRoute({ ...p.wire, waypoints: ways }, world, looms);
        let from = 0.2;
        let to = 0.8;
        if (route && own) {
          const nearest = (q: Vector3) => {
            let best = 0;
            route.centre.forEach((c, i) => {
              if (c.distanceTo(q) < route.centre[best].distanceTo(q)) best = i;
            });
            return best / (route.centre.length - 1);
          };
          from = nearest(own.centre[0]);
          to = nearest(own.centre[own.centre.length - 1]);
          // Joining it a little in from its ends, not at its plugs.
          const inside = (t: number) => Math.max(0.15, Math.min(0.85, t));
          from = inside(from);
          to = inside(to);
          if (Math.abs(to - from) < 0.05) [from, to] = [0.2, 0.8];
        }
        p.wire = { ...p.wire, waypoints: ways };
        addWaypoint(p, { along: { wire: loom.id, from: Math.round(from * 100) / 100, to: Math.round(to * 100) / 100 } });
        status(`It runs beside ${loom.name} from ${Math.round(from * 100)}% to ${Math.round(to * 100)}% of the way along it. Set where with From and To.`);
        return;
      }
      if (t.dataset.wireLay !== undefined) {
        setWire(w => {
          const out = { ...w };
          if (t.value === "flat") out.lay = "flat";
          else delete out.lay;
          // Its twist goes back to the lay's own.
          delete out.twist;
          return out;
        });
        commit();
        renderProps();
        return;
      }
      if (t.dataset.wireColourPick !== undefined) renderProps();
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
    props.addEventListener("input", e => {
      const t = e.target as HTMLInputElement;
      if (t.dataset?.guideToolFind === undefined) return;
      toolFind = t.value;
      const box = props.querySelector<HTMLElement>("[data-tool-catalogue]");
      if (box) box.innerHTML = toolCatalogue();
      const d = props.querySelector<HTMLDetailsElement>(".lyr-tool-catalogue");
      if (d && toolFind) d.open = true;
    });
    props.addEventListener("toggle", e => {
      const d = e.target as HTMLElement;
      if (d.classList?.contains("lyr-tool-catalogue")) toolsOpen = (d as HTMLDetailsElement).open;
    }, true);
    props.addEventListener("keydown", e => {
      const add = e.target as HTMLInputElement;
      if (add.dataset?.guideToolFind !== undefined && e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        addGuideTool(add.value);
        return;
      }
      const dot = (e.target as Element).closest?.(".lyr-pin-dot");
      if (dot && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        dot.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }
    });
    props.addEventListener("click", e => {
      // Buttons, and the pins on a part's picture (Pins on the model).
      const b = (e.target as Element).closest<HTMLElement>("button, .lyr-pin-dot");
      if (!b) return;
      if (b.dataset.pjShow) {
        // Show the joint, but keep this part in the inspector so its other joints stay to hand.
        const home = selectedId;
        const id = b.dataset.pjShow;
        if (shownJoint === id) {
          select(home);
          return;
        }
        showJoint(id);
        zoomTo(id, true);
        selectedId = home;
        renderList();
        renderProps();
        draw();
      } else if (b.dataset.pjGo) {
        select(b.dataset.pjGo);
        zoomTo(b.dataset.pjGo, false);
      } else if (b.dataset.pjEdit) {
        const id = b.dataset.pjEdit;
        if (partById(id)?.track) {
          select(id);
          openTrackDialog(id);
        } else {
          jointHome = selectedId;
          openJointDialog(id);
        }
      } else if (b.dataset.pjRemove) {
        const p = partById(b.dataset.pjRemove);
        if (p) {
          const to = p.parent ? partById(p.parent)?.name : "";
          unjoin(p);
          status(`“${p.name}” is no longer joined to “${to}”. It stays where it is.`);
        }
      } else if (b.dataset.pjTick) {
        const p = partById(b.dataset.pjTick);
        if (!p) return;
        if (p.explode === 0) delete p.explode;
        else p.explode = 0;
        follow();
        refit();
        commit();
        renderList();
        renderProps();
        status(p.explode === 0 ? `${p.name} stays assembled in this scene.` : `${p.name} explodes with the slider again.`);
      } else if (b.dataset.wireColour) {
        setWire(w => withCoreColour(w, coreAt, b.dataset.wireColour!));
        commit();
        renderProps();
      } else if (b.dataset.core) {
        coreAt = Number(b.dataset.core) || 0;
        renderProps();
      } else if (b.dataset.act === "core-add" || b.dataset.act === "core-remove") {
        const add = b.dataset.act === "core-add";
        setWire(w => withCores(w, coresOf(w).length + (add ? 1 : -1)));
        const w = wireById(selectedId)?.wire;
        if (w && add) coreAt = coresOf(w).length - 1;
        else coreAt = Math.max(0, coreAt - 1);
        commit();
        renderList();
        renderProps();
      } else if (b.dataset.act === "showcase") {
        openShowcase();
      } else if (b.dataset.act === "diagram-open") {
        // The diagram may change while it's open: read it again when it closes.
        const shut = wiringHost?.open?.(b.dataset.connection || undefined);
        if (shut && typeof (shut as Promise<void>).then === "function") void (shut as Promise<void>).then(() => loadDiagram());
      } else if (b.dataset.act === "diagram-add") {
        const p = wireById(selectedId);
        if (p) void addWireToDiagram(p);
      } else if (b.dataset.act === "diagram-link") {
        const p = wireById(selectedId);
        if (p && linkToDiagram(p)) {
          relay(p);
          commit();
          renderList();
          renderProps();
        }
      } else if (b.dataset.act === "map-pins") {
        if (b.dataset.part) showPins(b.dataset.part);
      } else if (b.dataset.act === "wire-it-up") {
        void wireItUp();
      } else if (b.dataset.act === "diagram-missing") {
        void addMissingWires();
      } else if (b.dataset.act === "diagram-parts") {
        if (diagram) void addDiagramParts(partsNotInScene(diagram, scene.parts).withModel.map(w => w.id));
      } else if (b.dataset.act === "diagram-names") {
        linkPartsByName();
      } else if (b.dataset.act === "sockets-from-catalog") {
        const p = partById(selectedId);
        if (p?.wiringPart) {
          setWiringPart(p, p.wiringPart);
          commit();
          renderProps();
        }
      } else if (b.dataset.act === "pin-plug" || b.dataset.act === "pin-bare" || b.dataset.act === "pin-one") {
        const p = partById(selectedId);
        if (p && b.dataset.port) startPinPick(p, b.dataset.port, b.dataset.act === "pin-plug", b.dataset.act === "pin-one" ? b.dataset.pin : undefined);
      } else if (b.dataset.act === "pins-find") {
        const p = partById(selectedId);
        if (p) {
          const n = findPins(p);
          commit();
          renderProps();
          status(n ? `${n} pin${n === 1 ? "" : "s"} placed on ${p.name} from its picture. Wrong one? Click it on the picture, then where it really is.` : "No pins could be found from its picture.", !n);
        }
      } else if (b.dataset.act === "pin-clear") {
        const p = partById(selectedId);
        const w = diagram?.parts.find(x => x.id === p?.wiringPart);
        const port = portById(w, b.dataset.port || "");
        if (p && port) clearPort(p, port.id, port.pins.map(q => q.name));
      } else if (b.dataset.act === "sockets-to-catalog") {
        const p = partById(selectedId);
        if (p) void saveSocketsToCatalog(p);
      } else if (b.dataset.act === "wires-play") {
        startPlayback();
      } else if (b.dataset.act === "wire-earlier" || b.dataset.act === "wire-later") {
        const p = wireById(selectedId);
        if (p) moveWire(p, b.dataset.act === "wire-earlier" ? -1 : 1);
      } else if (b.dataset.act === "wire-mirror") {
        const p = wireById(selectedId);
        if (p) void mirrorWire(p);
      } else if (b.dataset.act === "wire-route") {
        const p = wireById(selectedId);
        if (p) void routeWiresRound([p]);
      } else if (b.dataset.act === "wires-route") {
        void routeWiresRound(scene.parts.filter(q => q.wire));
      } else if (b.dataset.act === "wiring-movie") {
        void playWiringMovie();
      } else if (b.dataset.act === "wire-clear") {
        setWire(w => ({ ...w, waypoints: [] }));
        commit();
        renderProps();
      } else if (b.dataset.act === "plug-turn") {
        const p = partById(selectedId);
        if (p?.plug) turnPlug(p);
      } else if (b.dataset.preset) {
        scene.style = applyPreset(scene.style, b.dataset.preset);
        rebuild();
        commit();
        renderProps();
      } else if (b.dataset.turn) {
        const p = partById(selectedId);
        if (!p || locked(p)) return;
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
      } else if (b.dataset.act === "track") {
        if (selectedId) openTrackDialog(selectedId);
      } else if (b.dataset.act === "unjoin") {
        const p = partById(selectedId);
        if (p) unjoin(p);
      } else if (b.dataset.act === "reset-turn") {
        const p = partById(selectedId);
        if (!p || locked(p)) return;
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
        ${diagramMenu()}
        ${opts.listModels ? `<div class="lyr-scene-parts-list"></div><div class="lyr-panel-title">Your project's models</div><div class="lyr-scene-models"><span class="lyr-note">Loading…</span></div>` : ""}`;
      menu.querySelectorAll<HTMLElement>("[data-diagram-part]").forEach(b => {
        const w = diagram?.parts.find(x => x.id === b.dataset.diagramPart);
        if (!w?.model) return;
        b.addEventListener("click", () => {
          closeMenu();
          void addDiagramParts([w.id]);
        });
        showThumb(b.querySelector<HTMLElement>(".lyr-scene-thumb")!, { url: w.model.url, title: w.model.file, thumbnail: w.model.thumbnail });
      });
      if (!opts.listModels) return;
      try {
        const all = (await opts.listModels()).filter(m => [m.url, m.title || "", m.file || ""].some(x => /\.(stl|step|stp)(\?|#|$)/i.test(x)));
        const box = menu.querySelector(".lyr-scene-models");
        if (!box || menu.hidden) return;
        // The parts list's catalog models (a battery, a board, motors), apart
        // from the files; not those the diagram's section already offers.
        const offered = new Set(diagram ? partsNotInScene(diagram, scene.parts).withModel.flatMap(w => (w.slug ? [w.slug] : [])) : []);
        const parts = all.filter(m => m.group === "parts" && !(m.slug && offered.has(m.slug)));
        const found = all.filter(m => m.group !== "parts");
        const partsBox = menu.querySelector<HTMLElement>(".lyr-scene-parts-list");
        if (partsBox && parts.length) {
          partsBox.innerHTML = `<div class="lyr-panel-title">From the parts list</div><div class="lyr-scene-diagram-tiles">${parts.map((m, i) => {
            const name = esc(m.title || partName(m.file || m.url));
            return `<button type="button" class="lyr-scene-tile" role="menuitem" data-parts-model="${i}" title="${name}: the catalog part's model"><span class="lyr-scene-thumb">${icon("cube", 24)}</span><span class="lyr-scene-tile-name">${name}</span></button>`;
          }).join("")}</div>`;
          partsBox.querySelectorAll<HTMLElement>("[data-parts-model]").forEach(b => {
            const m = parts[Number(b.dataset.partsModel)];
            b.addEventListener("click", () => {
              closeMenu();
              // The next of the diagram's parts of this catalog part that nothing stands for yet.
              const linked = new Set(scene.parts.flatMap(p => (p.wiringPart ? [p.wiringPart] : [])));
              const w = m.slug ? diagram?.parts.find(x => x.slug === m.slug && !linked.has(x.id)) : undefined;
              void addModel({ url: m.url, name: m.title || partName(m.file || m.url), file: m.file || m.title, ...(w ? { wiringPart: w.id } : {}) });
            });
            showThumb(b.querySelector<HTMLElement>(".lyr-scene-thumb")!, { ...m, title: m.file || m.title });
          });
        }
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
    /** The Add a part menu's "From the wiring diagram": its parts not in the scene yet, those with catalog models as tiles. */
    function diagramMenu(): string {
      if (!diagram) return "";
      const { withModel, noModel } = partsNotInScene(diagram, scene.parts);
      if (!withModel.length && !noModel.length) return "";
      return `<div class="lyr-panel-title">From the wiring diagram</div>
        ${withModel.length ? `<div class="lyr-scene-diagram-tiles">${withModel.map(w => `<button type="button" class="lyr-scene-tile" role="menuitem" data-diagram-part="${esc(w.id)}" title="${esc(`${w.name}: the catalog part's model, linked to the diagram`)}"><span class="lyr-scene-thumb">${icon("cube", 24)}</span><span class="lyr-scene-tile-name">${esc(w.name)}</span></button>`).join("")}</div>` : ""}
        ${noModel.length ? `<p class="lyr-note">No 3D model in the catalog for ${esc(listNames(noModel.map(w => w.name)))}. Add one to the catalog part, or its STL or STEP file to the project.</p>` : ""}`;
    }
    /** "N20 motor ×2, 9V battery": each name once, with how many. */
    const listNames = (all: string[]) => {
      const counts = new Map<string, number>();
      for (const n of all) counts.set(n, (counts.get(n) || 0) + 1);
      const names = [...counts].map(([n, k]) => (k > 1 ? `${n} ×${k}` : n));
      return names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
    };

    /** Adds the diagram's parts with these ids, each from its catalog model, linked to the diagram. */
    async function addDiagramParts(ids: string[]): Promise<void> {
      for (const id of ids) {
        const w = diagram?.parts.find(x => x.id === id);
        if (!w?.model || closed) continue;
        await addModel({ url: w.model.url, file: w.model.file, name: w.name, wiringPart: w.id });
      }
      renderList();
      renderProps();
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
    // The view new steps start from (the project's, with a model).
    let defaultView = shared && views.some(v => v.id === opts.model?.defaultView) ? opts.model!.defaultView! : "";
    const startViews = JSON.stringify([views, defaultView]);
    const stepsOut = () => ({ ...(steps.length ? { steps } : { steps: undefined }), guide: guideToolList ? { tools: guideToolList } : undefined });
    const viewsOut = () => (views.length ? { views, ...(defaultView ? { defaultView } : {}) } : { views: [], defaultView: undefined });
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
              <button type="button" class="lyr-scene-menu-item" role="menuitem" data-named-view="${esc(v.id)}" title="Look from this view"><span>${esc(v.name)}${v.id === defaultView ? " · new steps" : ""}</span></button>
              ${shared ? `<button type="button" class="lyr-btn lyr-icon-btn${v.id === defaultView ? " lyr-on" : ""}" data-default-view="${esc(v.id)}" title="${v.id === defaultView ? "New steps start from this view" : "Start new steps from this view, so every picture looks from the same side"}" aria-label="${v.id === defaultView ? "New steps start from" : "Use for new steps:"} ${esc(v.name)}">${icon("star", 16)}</button>` : ""}
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
      const v = views.find(x => x.id === (d.namedView || d.updateView || d.deleteView || d.defaultView));
      if (!v) return;
      if (d.defaultView) {
        defaultView = defaultView === v.id ? "" : v.id;
        openViews();
        status(defaultView ? `New steps start from “${v.name}”. Kept with the project's model when you click Done.` : `New steps no longer start from “${v.name}”.`);
      } else if (d.namedView) {
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
        if (defaultView === v.id) defaultView = "";
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
        stopScrews();
        attachGizmo();
        draw();
      } else if (b.dataset.view) setView(b.dataset.view);
      switch (b.dataset.act) {
        case "add": if (menu.hidden) void openMenu(); else closeMenu(); break;
        case "upload": closeMenu(); fileInput.click(); break;
        case "fit": fitView(true); break;
        case "screw": stopWires(); if (screwing) stopScrews(); else startScrews(); break;
        case "wire": if (wiringOn) stopWires(); else startWires(); break;
        case "screw-stop": stopScrews(); break;
        case "views": if (viewsMenu.hidden) openViews(); else viewsMenu.hidden = true; break;
        case "urdf": exportUrdf(); break;
        case "section": if (section.picking()) section.stop(""); else section.start(); break;
        case "undo": undo(); break;
        case "redo": redo(); break;
        case "cancel": cancel(); break;
        case "done": void finish(); break;
        case "explode-smart": smartAll(); break;
        case "explode-follow": {
          const own = scene.parts.filter(p => p.explode !== undefined);
          own.forEach(p => delete p.explode);
          follow();
          refit();
          commit();
          renderList();
          status(`${own.length} joint${own.length === 1 ? " follows" : "s follow"} the Explode slider again.`);
          break;
        }
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
      if ((joining || trackPick) && (e.key === "Meta" || e.key === "Control")) setFaceHeld(holdKey(e) && !!hover);
      if (e.key === "Shift" && wiringOn && !shiftDown) {
        shiftDown = true;
        if (hover) placeSnaps();
      }
      if (e.key === "Shift" && screwing && !shiftDown) {
        shiftDown = true;
        if (hover) placeSnaps();
      }
      if (e.key === "Shift") {
        gizmo.setTranslationSnap(5);
        gizmo.setRotationSnap(15 * DEG);
      }
      if (mod && (key === "s" || key === "enter")) {
        e.preventDefault();
        void finish();
        return;
      }
      if (e.key === "Escape" && closeWiringMovie()) return;
      if (isTyping(e.target)) {
        if (e.key === "Escape") (e.target as HTMLElement).blur();
        return;
      }
      // Steps mode: the model's keys (move, turn, screw, wire, delete, duplicate) are put away.
      if (stepsOn) {
        if (mod && (key === "z" || key === "y")) {
          e.preventDefault();
          if (key === "y" || e.shiftKey) redo();
          else undo();
        } else if (e.key === "Escape") {
          if (stepPlay) stopStepPlay();
          else if (recording) stepsAction("rec-stop");
          else setMode(false);
        } else if (!mod && key === "f") {
          fitView(true);
        } else if (!mod && (e.key === "ArrowLeft" || e.key === "ArrowRight") && steps.length && !recording) {
          stepAt = Math.max(0, Math.min(steps.length - 1, stepAt + (e.key === "ArrowLeft" ? -1 : 1)));
          showStep();
        }
        return;
      }
      if (mod && key === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && key === "y") {
        e.preventDefault();
        redo();
      } else if (mod && key === "d" && selectedId && !isWiring(partById(selectedId) || {})) {
        e.preventDefault();
        duplicatePart(selectedId);
      } else if (e.key === "Escape") {
        if (!ctx.hidden) closeCtx();
        else if (playing) stopPlayback("Stopped putting the wires in.");
        else if (section.picking()) section.stop(scene.section ? "" : "Section stopped.");
        else if (screwing) stopScrews();
        else if (wiringOn && endCarry) {
          const armed = endCarry.armed;
          putEndBack();
          if (armed) stopWires("The wire end is back where it was.");
          else status("The wire end is back where it was. Click a part to start a wire, or a wire's end to move it.", false, true);
        } else if (wiringOn && wireDraft) {
          wireDraft = null;
          renderWireBar();
          drawWirePreview();
          status("Wire dropped. Click a part to start another, or Esc to stop.", false, true);
        } else if (wiringOn) stopWires();
        else if (trackPick) stopTrackPick();
        else if (trackDraft) cancelTrack();
        else if (joining) stopJoin("Join stopped.");
        else if (!menu.hidden) closeMenu();
        else if (selectedId) select("");
        else cancel();
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        e.preventDefault();
        removePart(selectedId);
      } else if (e.key === "Enter" && wiringOn) {
        e.preventDefault();
        endWireHere();
      } else if (!mod && key === "w") {
        if (wiringOn) stopWires();
        else startWires();
      } else if (!mod && key === "s") {
        stopWires();
        if (screwing) stopScrews();
        else startScrews();
      } else if (!mod && key === "m") {
        stopScrews();
        tool = "translate";
        attachGizmo();
        draw();
      } else if (!mod && key === "r") {
        stopScrews();
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
      if (e.key === "Shift" && shiftDown) {
        shiftDown = false;
        if ((screwing || wiringOn) && hover) placeSnaps();
      }
      if (e.key === "Shift") {
        gizmo.setTranslationSnap(null);
        gizmo.setRotationSnap(null);
      }
    };
    overlay.addEventListener("keydown", onKey);
    overlay.addEventListener("keyup", onKeyUp);

    // ------------------------------------------------------------ steps

    // Steps mode: the model is built (Model mode), then each step says which
    // parts are fitted in it. A step is shown as its guide page will be:
    // earlier steps ghosted, its parts highlighted and drawn apart along
    // their joints, later parts hidden. The steps are the project model's,
    // saved with it on Done (without making pictures out of date); what this
    // scene showed comes back when Steps mode ends, unless a step was picked
    // for this picture.
    const stepsPast: string[] = [];
    const stepsFuture: string[] = [];
    let stepsNow = stepsState();
    const strip = $(".lyr-steps-strip");
    /** The model as it was when Steps mode started (it can't change in it): step pictures drawn from another are drawn again. */
    let stepsSig = "";

    const isFixing = (p: ScenePart): boolean => {
      const m = models.get(p.id);
      return !!m && !(m instanceof Error) && isFastener(m.size);
    };
    const showingOf = (p: ScenePart): Showing => ({ hidden: p.hidden, ghost: p.ghost, highlight: p.highlight, explode: p.explode });
    function setShowing(p: ScenePart, s: Showing): void {
      for (const k of ["hidden", "ghost", "highlight", "explode"] as const) {
        if (s[k] === undefined) delete p[k];
        else Object.assign(p, { [k]: s[k] });
      }
    }
    /** The steps' parts, tidied against the model as it is now. */
    function tidy(): void {
      steps = tidySteps(steps, scene.parts.filter(p => !p.wire), views);
      stepAt = Math.max(0, Math.min(stepAt, steps.length - 1));
    }
    function stepsCommit(): void {
      const next = stepsState();
      if (next === stepsNow) return;
      stepsPast.push(stepsNow);
      if (stepsPast.length > 80) stepsPast.shift();
      stepsFuture.length = 0;
      stepsNow = next;
      syncHistory();
    }
    function stepsRestore(text: string): void {
      const [was, tools] = JSON.parse(text) as [BuildStep[], string[] | null];
      steps = was;
      guideToolList = tools ?? undefined;
      stepsNow = text;
      tidy();
      showStep();
      syncHistory();
    }
    const stepsAt = () => stepOfParts(scene.parts, steps, isFixing);
    const stepName = (i: number, at = stepsAt()): string => {
      const s = steps[i];
      if (!s) return "";
      if (s.title) return s.title;
      const names = [...new Set(steppable(scene.parts).filter(p => s.parts.includes(p.id) && !isFixing(p)).map(p => p.name.trim() || "part"))];
      if (!names.length) {
        const fix = [...at].filter(([, k]) => k === i).length;
        return fix ? `${fix} fixing${fix === 1 ? "" : "s"}` : "Empty";
      }
      return names.length <= 2 ? names.join(" and ") : `${names[0]} and ${names.length - 1} more`;
    };

    function setMode(on: boolean): void {
      if (on === stepsOn) return;
      if (on) {
        if (!linked()) return status("Steps are for the project's model: use the project model here first.", true);
        stopScrews();
        stopWires();
        stopPlayback();
        if (section.picking()) section.stop("");
        if (joining) stopJoin("");
        commit();
        kept = { parts: new Map(scene.parts.map(p => [p.id, showingOf(p)])), explode: scene.explode, arrows: scene.arrows, historyAt: past.length };
        stepsOn = true;
        selectedId = "";
        shownJoint = "";
        tidy();
        stepsSig = JSON.stringify(scene.parts.map(p => [p.id, p.position, p.rotation, p.joint, p.parent]));
        status(steps.length ? "" : "No steps yet: press Suggest steps to start from the joints, or Record steps to click the parts in the order they go on.", false, !steps.length);
      } else {
        stopStepPlay();
        recording = null;
        stepsOn = false;
        if (kept) {
          for (const p of scene.parts) setShowing(p, kept.parts.get(p.id) || {});
          scene.explode = kept.explode;
          if (kept.arrows) scene.arrows = true;
          else delete scene.arrows;
          // The pictures of the steps aren't this scene's history.
          past.length = Math.min(past.length, kept.historyAt);
          future.length = 0;
          current = snap();
          kept = null;
        }
        status("");
        syncHistory();
      }
      root.classList.toggle("lyr-steps-on", stepsOn);
      root.querySelectorAll<HTMLElement>("[data-mode]").forEach(b => {
        const me = b.dataset.mode === (stepsOn ? "steps" : "model");
        b.classList.toggle("lyr-on", me);
        b.setAttribute("aria-pressed", String(me));
      });
      strip.hidden = !stepsOn;
      attachGizmo();
      showStep();
      syncExplode();
      layout();
    }

    /** The step last shown in the view (-1 while recording), so a new one is fitted. */
    let shownStep = -2;
    /** Shows the step picked (or the recording so far) in the view, the list, the strip and the panel. */
    function showStep(): void {
      if (stepsOn) {
        const at = recording ? recordedAt() : stepsAt();
        const pieces = trackPieces(scene.parts);
        for (const p of scene.parts) {
          const k = at.get(p.id);
          const s: Showing = {};
          if (p.wire || pieces.has(p.id)) s.hidden = true;
          else if (recording) {
            const last = recording.steps.length - 1;
            if (k === undefined) s.ghost = true;
            else if (k === last) Object.assign(s, { highlight: true, explode: 1 });
            else Object.assign(s, { highlight: false, explode: 0 });
          } else if (!steps.length) {
            // No steps yet: the whole model, to pick from.
          } else if (k === undefined || k > stepAt) s.hidden = true;
          else if (k === stepAt) Object.assign(s, { highlight: true, explode: 1 });
          else Object.assign(s, { ghost: true, highlight: false, explode: 0 });
          setShowing(p, s);
        }
        scene.explode = 0;
        scene.arrows = true;
        rebuild();
        renderStrip();
        // Each step fills the picture, drawn apart (as it plays, too): a new step is fitted even after zooming by hand.
        const shown = recording ? -1 : stepAt;
        if (shown !== shownStep) keepFitted = true;
        shownStep = shown;
        if (keepFitted && loaded().length) glideTo(fitCamera(scene.camera));
      } else rebuild();
      renderList();
      renderProps();
      // The button clicked has gone: keep the keys (undo, arrows) working in the scene.
      if (!overlay.contains(document.activeElement) || document.activeElement === document.body) root.focus({ preventScroll: true });
    }

    // The strip under the view: a card per step with its picture.
    const stepThumbs = new Map<string, string>();
    let thumbGen = 0;
    let thumbTimer = 0;
    function renderStrip(): void {
      if (!stepsOn) return;
      const at = stepsAt();
      const rec = recording;
      const loose = steppable(scene.parts).filter(p => !isFixing(p) && !at.has(p.id));
      const cards = rec
        ? rec.steps.map((ids, i) => `<div class="lyr-step-card${i === rec.steps.length - 1 ? " lyr-on" : ""}">
            <div class="lyr-step-cap"><span class="lyr-step-badge">${i + 1}</span><span>${esc(ids.length ? ids.filter(id => !isFixing(partById(id)!)).map(id => partById(id)?.name || "part").join(", ") || "Fixings" : "Click parts to fit them")}</span></div>
          </div>`).join("")
        : steps.map((_, i) => {
            // Between two steps: a + that shows on hover, to put a new step there.
            const gap = i ? `<div class="lyr-step-gap"><button type="button" data-step-insert="${i}" title="Add a step between ${i} and ${i + 1}" aria-label="Add a step between ${i} and ${i + 1}">${icon("plus", 14)}</button></div>` : "";
            const warn = stepWarnings(scene.parts, at, i).length > 0;
            const img = stepThumbs.get(thumbKey(i));
            return `${gap}<div class="lyr-step-card${i === stepAt ? " lyr-on" : ""}" data-step-card="${i}" draggable="true" role="button" tabindex="0" title="Step ${i + 1}: ${esc(stepName(i, at))}. Drag to move it.">
              <div class="lyr-step-thumb">${img ? `<img src="${img}" alt="">` : icon("cube", 22)}</div>
              <div class="lyr-step-cap"><span class="lyr-step-badge">${i + 1}</span><span>${esc(stepName(i, at))}</span>${warn ? `<span class="lyr-step-warn" title="A part in this step is joined to one fitted later">!</span>` : ""}</div>
            </div>`;
          }).join("");
      strip.innerHTML = `
        <div class="lyr-steps-bar">
          ${rec ? `<strong class="lyr-steps-title lyr-rec">${icon("play", 14)}<span>Recording step ${rec.steps.length}</span></strong>
            <span class="lyr-grow"></span>
            <button type="button" class="lyr-btn" data-steps="take-back" title="Put the last part fitted back"${rec.steps.flat().length ? "" : " disabled"}>${icon("undo", 16)}<span>Take back</span></button>
            <button type="button" class="lyr-btn lyr-steps-primary" data-steps="rec-next" title="Start the next step"${rec.steps[rec.steps.length - 1].length ? "" : " disabled"}>${icon("chevronRight", 16)}<span>Next step</span></button>
            <button type="button" class="lyr-btn" data-steps="rec-finish" title="Keep these steps">${icon("check", 16)}<span>Finish</span></button>
            <button type="button" class="lyr-btn" data-steps="rec-stop" title="Stop without keeping them">${icon("close", 16)}<span>Stop</span></button>`
          : `<strong class="lyr-steps-title">Steps${steps.length ? ` · ${steps.length}` : ""}</strong>
            <span class="lyr-grow"></span>
            <button type="button" class="lyr-btn" data-steps="suggest" title="Work out steps from the joints: one per part, fixings with their part">${icon("wand", 16)}<span>Suggest steps</span></button>
            <button type="button" class="lyr-btn" data-steps="record" title="Click the parts in the order they go on, pressing Next step between steps">${icon("pencil", 16)}<span>Record steps</span></button>
            <button type="button" class="lyr-btn" data-steps="play" title="Watch the steps go together, one after another"${steps.length ? "" : " disabled"}>${icon("play", 16)}<span>${stepPlay ? "Stop" : "Play steps"}</span></button>
            <button type="button" class="lyr-btn" data-steps="movie" title="${movie ? "Stop making the movie" : "Save the steps going together as a video file (MP4)"}"${steps.length ? "" : " disabled"}>${icon("film", 16)}<span>${movie ? `Saving… ${movie.pct}%` : "Save as movie"}</span></button>`}
        </div>
        <div class="lyr-steps-cards">
          ${cards}
          ${rec ? "" : `<button type="button" class="lyr-step-card lyr-step-new" data-steps="new" title="Add an empty step after this one">${icon("plus", 16)}<span>New step</span></button>`}
          ${!rec && loose.length ? `<div class="lyr-step-tray" data-step-tray>
            <div class="lyr-step-tray-title">Not in a step · ${loose.length}</div>
            ${loose.map(p => `<button type="button" class="lyr-step-tray-part" data-step-add="${esc(p.id)}" draggable="true" title="Fit it in step ${stepAt + 1}">${icon("cube", 12)}<span>${esc(p.name)}</span></button>`).join("")}
            <p class="lyr-note">Click one to put it in step ${steps.length ? stepAt + 1 : "1"}. Left out, the guide fits it in a step of its own at the end.</p>
          </div>` : ""}
        </div>`;
      strip.querySelector(".lyr-step-card.lyr-on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
      if (!rec) queueThumbs();
    }

    /** What a step's picture depends on: its parts and the earlier steps', the model, and the camera. */
    function thumbKey(i: number): string {
      return JSON.stringify([steps.slice(0, i + 1).map(s => s.parts), stepsSig]);
    }
    function queueThumbs(): void {
      clearTimeout(thumbTimer);
      thumbTimer = window.setTimeout(() => void drawThumbs(), 250);
    }
    async function drawThumbs(): Promise<void> {
      const gen = ++thumbGen;
      const at = stepsAt();
      const sceneFor = (i: number): SceneData => ({ ...clone(scene), explode: 0, arrows: true, section: undefined, parts: stepParts(i, at) });
      const todo = steps.map((_, i) => i).filter(i => !stepThumbs.has(thumbKey(i)));
      if (!todo.length) return;
      const W = 132, H = 84;
      for (const i of todo) {
        if (gen !== thumbGen || closed || !stepsOn || recording) return;
        const key = thumbKey(i);
        try {
          // Each step's picture is framed round itself, as its guide page is.
          const one = sceneFor(i);
          const cam = await frameAll(scene.camera, [one], opts.store, W / H, 1.08);
          if (gen !== thumbGen) return;
          const pic = await renderPicture({ ...one, camera: cam }, opts.store, W, H, 2);
          if (gen !== thumbGen) return;
          stepThumbs.set(key, pic.toDataURL("image/png"));
          const img = strip.querySelector<HTMLElement>(`[data-step-card="${i}"] .lyr-step-thumb`);
          if (img) img.innerHTML = `<img src="${stepThumbs.get(key)}" alt="">`;
        } catch {
          // A step whose picture can't be drawn keeps its plain card.
        }
      }
    }

    /** Every part as step `i` shows it: earlier steps' ghosted and fitted, this step's highlighted and apart, later ones hidden. */
    function stepParts(i: number, at = stepsAt()): ScenePart[] {
      const pieces = trackPieces(scene.parts);
      return scene.parts.map(p => {
        const k = at.get(p.id);
        const out: ScenePart = { ...p };
        for (const f of ["hidden", "ghost", "highlight", "explode"] as const) delete out[f];
        if (p.wire || pieces.has(p.id) || k === undefined || k > i) out.hidden = true;
        else if (k === i) Object.assign(out, { highlight: true, explode: 1 });
        else Object.assign(out, { ghost: true, highlight: false, explode: 0 });
        return out;
      });
    }

    // ------------------------------------------------------------ wiring showcase

    /** The wiring showcase's sizes: shaped for where it's posted. */
    const SHOWCASE_SHAPES = [
      { id: "wide", label: "Landscape 16:9 (YouTube, X)", w: 1280, h: 720 },
      { id: "square", label: "Square 1:1 (Instagram feed)", w: 1080, h: 1080 },
      { id: "tall", label: "Portrait 4:5 (Instagram, Facebook)", w: 1080, h: 1350 },
      { id: "story", label: "Vertical 9:16 (Reels, TikTok, Shorts)", w: 1080, h: 1920 },
    ];
    const showcaseDialog = document.createElement("div");
    showcaseDialog.className = "lyr-joint-dialog lyr-showcase-dialog";
    showcaseDialog.setAttribute("role", "dialog");
    showcaseDialog.setAttribute("aria-label", "Wiring showcase");
    showcaseDialog.hidden = true;
    stage.appendChild(showcaseDialog);
    draggable(showcaseDialog);
    /** The showcase being made or shown: its shape, how far it's got, and the video once made. */
    type Showcase = { shape: string; pct: number; stopped: boolean; made?: { url: string; type: string; blob: Blob }; error?: string };
    let showcase: Showcase | null = null;

    /** Opens the wiring showcase's preview, made from the view as it is now. */
    function openShowcase(shape = showcase?.shape || "wide"): void {
      stopShowcase();
      const me: Showcase = (showcase = { shape, pct: 0, stopped: false });
      showcaseDialog.hidden = false;
      renderShowcase();
      const size = SHOWCASE_SHAPES.find(x => x.id === shape) || SHOWCASE_SHAPES[0];
      const parts = clone(scene).parts.filter(p => !p.hidden);
      void renderWiringAnimation({ parts }, opts.store, [...scene.camera.direction] as Vec3, {
        width: size.w,
        height: size.h,
        progress: (done, total) => {
          const pct = Math.floor((done / total) * 100);
          if (pct === me.pct || showcase !== me) return;
          me.pct = pct;
          const el = showcaseDialog.querySelector("[data-showcase-pct]");
          if (el) el.textContent = `Making it… ${pct}%`;
        },
        cancelled: () => me.stopped || closed,
      }).then(
        made => {
          if (me.stopped || closed) return;
          me.made = { url: URL.createObjectURL(made.blob), type: made.type, blob: made.blob };
          renderShowcase();
        },
        e => {
          if (me.stopped || closed) return;
          me.error = e instanceof Error && e.message ? e.message : String(e);
          renderShowcase();
        },
      );
    }

    /** Stops the showcase being made (if it is) and lets its video go. */
    function stopShowcase(): void {
      if (!showcase) return;
      showcase.stopped = true;
      if (showcase.made) URL.revokeObjectURL(showcase.made.url);
      showcase = null;
    }

    function closeShowcase(): void {
      stopShowcase();
      showcaseDialog.hidden = true;
      showcaseDialog.innerHTML = "";
    }

    function renderShowcase(): void {
      const sc = showcase;
      if (!sc) return;
      const size = SHOWCASE_SHAPES.find(x => x.id === sc.shape) || SHOWCASE_SHAPES[0];
      const video = sc.made?.type === "video/mp4";
      const preview = sc.made
        ? video
          ? `<video src="${sc.made.url}" autoplay loop muted playsinline></video>`
          : `<img src="${sc.made.url}" alt="Wiring showcase">`
        : sc.error
          ? `<p class="lyr-note lyr-error">It couldn't be made: ${esc(sc.error)}</p>`
          : `<p class="lyr-note" data-showcase-pct>Making it… ${sc.pct}%</p>`;
      showcaseDialog.innerHTML = `
        <div class="lyr-joint-head">
          ${icon("play", 16)}<strong title="Drag here to move the dialog">Wiring showcase</strong>
          <span class="lyr-grow"></span>
          <button type="button" class="lyr-btn lyr-icon-btn" data-act="showcase-close" title="Close" aria-label="Close">${icon("close", 16)}</button>
        </div>
        <div class="lyr-joint-body">
          <label class="lyr-joint-half lyr-showcase-shape">Shape
            <select data-showcase-shape>${SHOWCASE_SHAPES.map(x => `<option value="${x.id}"${x.id === sc.shape ? " selected" : ""}>${esc(x.label)}</option>`).join("")}</select>
          </label>
          <div class="lyr-showcase-preview" style="aspect-ratio: ${size.w} / ${size.h}">${preview}</div>
          <p class="lyr-note">From the view as it is now: turn the model and press Again to change it.${sc.made && !video ? " This browser can't make an MP4, so it's an animated GIF." : ""}</p>
        </div>
        <div class="lyr-joint-foot">
          <button type="button" class="lyr-btn" data-act="showcase-again" title="Make it again from the view as it is now">${icon("rotate", 16)}<span>Again</span></button>
          <button type="button" class="lyr-btn lyr-done" data-act="showcase-save"${sc.made ? "" : " disabled"} title="Download it, ${size.w} × ${size.h}">${icon("download", 16)}<span>Save video</span></button>
        </div>`;
    }

    showcaseDialog.addEventListener("change", e => {
      const t = e.target as HTMLSelectElement;
      if (t.dataset.showcaseShape !== undefined) openShowcase(t.value);
    });
    showcaseDialog.addEventListener("click", e => {
      const b = (e.target as HTMLElement).closest("button");
      if (!b) return;
      if (b.dataset.act === "showcase-close") closeShowcase();
      else if (b.dataset.act === "showcase-again") openShowcase();
      else if (b.dataset.act === "showcase-save" && showcase?.made) {
        const name = `wiring-showcase.${showcase.made.type === "video/mp4" ? "mp4" : "gif"}`;
        const a = document.createElement("a");
        a.href = showcase.made.url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        status(`Downloaded ${name} (${(showcase.made.blob.size / 1024 / 1024).toFixed(1)} MB).`);
      }
    });

    /** Save as movie: the steps going together, as Play steps shows them, made into a video and downloaded. */
    async function saveMovie(): Promise<void> {
      if (movie) {
        movie.stopped = true;
        return;
      }
      if (!steps.length) return;
      stopStepPlay();
      const me = (movie = { pct: 0, stopped: false });
      renderStrip();
      status("Making the movie of the steps…");
      try {
        const at = stepsAt();
        const list = steps.map((_, i) => {
          const parts = stepParts(i, at);
          return { parts, moving: parts.filter(p => !p.hidden && at.get(p.id) === i).map(p => p.id) };
        });
        const made = await renderStepsMovie(list, scene.style, scene.camera.direction, opts.store, {
          progress: (done, total) => {
            const pct = Math.floor((done / total) * 100);
            if (pct === me.pct) return;
            me.pct = pct;
            const label = strip.querySelector('[data-steps="movie"] span');
            if (label) label.textContent = `Saving… ${pct}%`;
          },
          cancelled: () => me.stopped || closed,
        });
        const name = `assembly-steps.${made.type === "video/mp4" ? "mp4" : "gif"}`;
        const a = document.createElement("a");
        a.href = URL.createObjectURL(made.blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
        const mb = (made.blob.size / 1024 / 1024).toFixed(1);
        status(made.type === "video/mp4" ? `Downloaded ${name} (${mb} MB).` : `Downloaded ${name} (${mb} MB): this browser can't make an MP4, so it's an animated GIF.`);
      } catch (e) {
        if (!closed) status(me.stopped ? "Stopped: no movie saved." : `The movie couldn't be made: ${e instanceof Error ? e.message : String(e)}`, !me.stopped);
      } finally {
        if (movie === me) movie = null;
        if (!closed) renderStrip();
      }
    }

    /** Puts a part in step `i` (taking it out of any other), or, already there, out of every step. */
    function toggleInStep(id: string, i = stepAt): void {
      const p = partById(id);
      if (!p || p.wire) return;
      if (!steps.length) {
        steps.push({ id: newStepId(steps), parts: [] });
        i = stepAt = 0;
      }
      const was = steps.findIndex(s => s.parts.includes(id));
      const at = stepsAt();
      steps.forEach(s => (s.parts = s.parts.filter(x => x !== id)));
      const auto = was < 0 && at.get(id) === i && isFixing(p);
      if (was === i || auto) {
        status(auto ? `${p.name} goes with its part in step ${i + 1} by itself.` : `${p.name} is out of step ${i + 1}.`);
        if (auto) steps[i].parts.push(id);
      } else {
        steps[i].parts.push(id);
        status(`${p.name} is fitted in step ${i + 1}${was >= 0 ? ` (moved from step ${was + 1})` : ""}.`);
      }
      stepsCommit();
      showStep();
    }

    /** Adds an empty step at `i` (after the one shown when not given) and shows it. */
    function newStep(at?: number): void {
      const s: BuildStep = { id: newStepId(steps), parts: [] };
      const i = at ?? (steps.length ? stepAt + 1 : 0);
      steps.splice(i, 0, s);
      stepAt = i;
      stepsCommit();
      showStep();
      status(`Step ${i + 1}: click parts, in the list or the view, to fit them in it.`);
    }

    function deleteStep(i: number): void {
      if (!steps[i]) return;
      steps.splice(i, 1);
      stepAt = Math.max(0, Math.min(i, steps.length - 1));
      stepsCommit();
      showStep();
      status(`Step ${i + 1} deleted: its parts are in no step now (Undo brings it back).`);
    }

    function moveStep(from: number, to: number): void {
      if (from === to || !steps[from] || to < 0 || to >= steps.length) return;
      const [s] = steps.splice(from, 1);
      steps.splice(to, 0, s);
      stepAt = to;
      stepsCommit();
      showStep();
    }

    function suggest(): void {
      const fresh = suggestSteps({ parts: scene.parts }, isFixing);
      if (!fresh.length) return status("Add parts to the model first.", true);
      if (steps.some(s => s.parts.length) && !window.confirm(`Replace your ${steps.length} step${steps.length === 1 ? "" : "s"} with ${fresh.length} worked out from the joints?`)) return;
      steps = fresh;
      stepAt = 0;
      stepsCommit();
      showStep();
      status(`${fresh.length} steps from the joints: one per part, fixings with their part. Move parts between steps to group them.`);
    }

    // Record steps: every part starts faint; click them in the order they go on.
    function recordedAt(): Map<string, number> {
      const out = new Map<string, number>();
      recording?.steps.forEach((ids, i) => ids.forEach(id => out.set(id, i)));
      return out;
    }
    function startRecording(): void {
      if (steps.some(s => s.parts.length) && !window.confirm("Record new steps? The ones you have are replaced when you press Finish.")) return;
      stopStepPlay();
      recording = { steps: [[]] };
      showStep();
      status("Click the part that goes on first. Parts joined to one not fitted yet wait their turn.", false, true);
    }
    function recordClick(id: string): void {
      if (!recording) return;
      const p = partById(id);
      if (!p || p.wire) return;
      const at = recordedAt();
      const last = recording.steps.length - 1;
      if (at.has(id)) {
        if (at.get(id) !== last) return status(`${p.name} went on in step ${at.get(id)! + 1}. Take back works on this step's parts.`, true);
        // Taken back, with the fixings that came with it.
        const going = new Set([id, ...[...fixingOwners(scene.parts, isFixing)].filter(([, o]) => o === id).map(([f]) => f)]);
        recording.steps[last] = recording.steps[last].filter(x => !going.has(x));
        status(`${p.name} taken back.`);
      } else {
        const fitted = new Set(at.keys());
        if (!readyToFit(p, fitted, scene.parts)) return status(`${partById(p.parent!)?.name || "Its part"} goes on before ${p.name}: fit that first.`, true);
        const with_ = isFixing(p) ? [] : [...fixingOwners(scene.parts, isFixing)].filter(([f, o]) => o === id && !at.has(f)).map(([f]) => f);
        recording.steps[last].push(id, ...with_);
        status(`${p.name}${with_.length ? ` and ${with_.length} fixing${with_.length === 1 ? "" : "s"}` : ""} fitted in step ${last + 1}.`);
      }
      showStep();
    }
    function recordTakeBack(): void {
      if (!recording) return;
      let last = recording.steps.length - 1;
      if (!recording.steps[last].length && last > 0) {
        recording.steps.pop();
        last--;
      }
      recording.steps[last].pop();
      showStep();
    }
    function finishRecording(): void {
      if (!recording) return;
      const kept = recording.steps.filter(s => s.length);
      recording = null;
      if (kept.length) {
        steps = [];
        for (const ids of kept) steps.push({ id: newStepId(steps), parts: ids });
        stepAt = 0;
        stepsCommit();
        status(`${kept.length} step${kept.length === 1 ? "" : "s"} recorded.`);
      } else status("Nothing recorded: your steps are as they were.");
      showStep();
    }

    // Play steps: each step shown drawn apart, then put together, one after another.
    function stopStepPlay(): void {
      if (!stepPlay) return;
      cancelAnimationFrame(stepPlay.frame);
      stepPlay = null;
      if (stepsOn) showStep();
    }
    function playSteps(): void {
      if (stepPlay) return stopStepPlay();
      if (!steps.length) return;
      stepAt = 0;
      showStep();
      stepPlay = { frame: 0, at: 0, t0: performance.now() };
      renderStrip();
      const HOLD = 600, MOVE = 900, REST = 400, FADE = 500;
      const tick = (now: number) => {
        if (!stepPlay || closed) return;
        const t = now - stepPlay.t0;
        const f = Math.max(0, Math.min(1, (t - HOLD) / MOVE));
        const e = 1 - (f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2);
        const at = stepsAt();
        for (const p of scene.parts) if (at.get(p.id) === stepPlay.at) p.explode = e;
        art.move(scene.parts, scene.explode);
        // The last step's parts fade from the highlight back to white as this step comes on (as the saved movie shows it).
        if (stepPlay.at > 0 && t < FADE + 100) {
          const k = Math.min(1, t / FADE);
          const g = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
          for (const p of scene.parts) if (at.get(p.id) === stepPlay.at - 1) art.fadeFill(p.id, scene.style.highlight, g);
        }
        draw();
        if (t > HOLD + MOVE + REST) {
          if (stepPlay.at >= steps.length - 1) {
            stepPlay = null;
            renderStrip();
            status("That's every step.");
            return;
          }
          stepPlay.at++;
          stepAt = stepPlay.at;
          stepPlay.t0 = now;
          showStep();
        }
        stepPlay.frame = requestAnimationFrame(tick);
      };
      stepPlay.frame = requestAnimationFrame(tick);
    }

    /** This picture keeps the step shown, when Steps mode ends. */
    function useStepHere(): void {
      if (!kept) return;
      kept.parts = new Map(scene.parts.map(p => [p.id, showingOf(p)]));
      kept.explode = 0;
      kept.arrows = true;
      status(`This picture shows step ${stepAt + 1} now: it stays when you go back to Model or press Done.`);
    }

    /** Parts in this step that run into parts fitted before them on their way off. */
    function blockedInStep(): ScenePart[] {
      const at = stepsAt();
      const mine = scene.parts.filter(p => at.get(p.id) === stepAt && p.parent && p.joint && (at.get(p.parent) ?? 99) < stepAt);
      if (!mine.length) return [];
      const shapes = new Map<string, ExplodeShape>();
      for (const q of scene.parts) {
        const m = models.get(q.id);
        if (!m || m instanceof Error) continue;
        const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry;
        shapes.set(q.id, { size: m.size, triangles: g.getAttribute("position")?.array as ArrayLike<number> | undefined });
      }
      // Only what's fitted by now is in the way.
      const now = scene.parts.map(p => ({ ...p, hidden: (at.get(p.id) ?? 99) > stepAt || !!p.wire }));
      const choose = explodeChooser(now, worldMatrices(now, 0, false), shapes);
      return mine.filter(p => {
        const c = choose(p.id);
        return !!c && (c.costs[p.joint!.explodeDir || "joint"] ?? 0) > 0.02;
      });
    }

    function stepPanel(): string {
      if (recording) {
        const at = recordedAt();
        const fitted = new Set(at.keys());
        const left = steppable(scene.parts).filter(p => !at.has(p.id) && !isFixing(p));
        return `<section class="lyr-scene-section">
          <div class="lyr-panel-title">Still to fit · ${left.length}</div>
          ${left.length ? `<ul class="lyr-step-parts">${left.map(p => {
            const ready = readyToFit(p, fitted, scene.parts);
            return `<li><button type="button" class="lyr-step-part${ready ? "" : " lyr-off"}" data-rec-part="${esc(p.id)}" title="${ready ? "Fit it in this step" : `Fit ${esc(partById(p.parent!)?.name || "its part")} first`}">${icon("cube", 12)}<span>${esc(p.name)}</span><em>${ready ? "ready" : `needs ${esc(partById(p.parent!)?.name || "its part")}`}</em></button></li>`;
          }).join("")}</ul>` : `<p class="lyr-note">Every part is on. Press Finish to keep these steps.</p>`}
          <div class="lyr-panel-title">Steps so far</div>
          <ol class="lyr-step-sofar">${recording.steps.map(ids => `<li>${esc(ids.filter(id => !isFixing(partById(id)!)).map(id => partById(id)?.name || "part").join(", ") || "…")}</li>`).join("")}</ol>
          <p class="lyr-note">Click a faint part in the view, or one here, to fit it now. Its screws come with it. Click a highlighted part to take it back.</p>
        </section>`;
      }
      const s = steps[stepAt];
      if (!s) return `<section class="lyr-scene-section"><div class="lyr-panel-title">Steps</div>
        <p class="lyr-note">Build the model in Model mode, joints and all. Then make the steps here: each says which parts go on in it, and the assembly guide draws a page for each.</p>
        <button type="button" class="lyr-wide-btn" data-steps="suggest">${icon("wand", 16)} Suggest steps</button>
        <button type="button" class="lyr-wide-btn" data-steps="record">${icon("pencil", 16)} Record steps</button>
        <button type="button" class="lyr-wide-btn" data-steps="new">${icon("plus", 16)} New step</button></section>${toolsPanel()}`;
      const at = stepsAt();
      const own = s.parts.map(id => partById(id)).filter((p): p is ScenePart => !!p);
      const follow = scene.parts.filter(p => at.get(p.id) === stepAt && !s.parts.includes(p.id));
      const warns = stepWarnings(scene.parts, at, stepAt);
      const blocked = blockedInStep();
      return `<section class="lyr-scene-section lyr-step-panel">
        <div class="lyr-step-head"><span class="lyr-step-badge">${stepAt + 1}</span><div class="lyr-panel-title">Step ${stepAt + 1} of ${steps.length}</div>
          <span class="lyr-grow"></span>
          <button type="button" class="lyr-btn lyr-icon-btn" data-steps="earlier" title="Move it earlier"${stepAt ? "" : " disabled"} aria-label="Move the step earlier">${icon("chevronUp", 16)}</button>
          <button type="button" class="lyr-btn lyr-icon-btn" data-steps="later" title="Move it later"${stepAt < steps.length - 1 ? "" : " disabled"} aria-label="Move the step later">${icon("chevronDown", 16)}</button>
          <button type="button" class="lyr-btn lyr-icon-btn" data-steps="delete" title="Delete this step (its parts go back to Not in a step)" aria-label="Delete the step">${icon("trash", 16)}</button>
        </div>
        <label class="lyr-scene-namebox">Title <input type="text" maxlength="120" data-step-title value="${esc(s.title || "")}" placeholder="${esc(stepName(stepAt, at))}"></label>
        <div class="lyr-scene-sub">Fitted in this step · ${own.length}</div>
        ${own.length ? `<ul class="lyr-step-parts">${own.map(p => `<li><button type="button" class="lyr-step-part" data-step-part="${esc(p.id)}" title="Take it out of this step">${icon("cube", 12)}<span>${esc(p.name)}</span>${icon("close", 12)}</button></li>`).join("")}</ul>`
          : `<p class="lyr-note">Click parts in the list, the view, or Not in a step to fit them here.</p>`}
        ${follow.length ? `<div class="lyr-scene-sub">With their parts · ${follow.length}</div><p class="lyr-note">${esc(follow.map(p => p.name).join(", "))}: fixings go in their part's step unless you put them in another.</p>` : ""}
        <label class="lyr-scene-namebox">View <select data-step-view>
          <option value="">Same as every step</option>
          ${views.map(v => `<option value="${esc(v.id)}"${s.view === v.id ? " selected" : ""}>${esc(v.name)}</option>`).join("")}
        </select></label>
        ${views.length ? "" : `<p class="lyr-note">Save a view under Views to draw a step from another side (turned over, say).</p>`}
        <div class="lyr-scene-sub">Checks</div>
        <ul class="lyr-step-checks">
          ${warns.map(w => `<li class="lyr-bad">${esc(partById(w.part)?.name || "A part")} is joined to ${esc(partById(w.needs)?.name || "a part")}, which ${w.later < 0 ? "is in no step" : `goes on in step ${w.later + 1}`}.</li>`).join("")}
          ${blocked.map(p => `<li class="lyr-bad">${esc(p.name)} runs into a part fitted earlier on its way off: change its Comes off way in Model mode (the joint's pencil).</li>`).join("")}
          ${!own.length && !follow.length ? `<li class="lyr-bad">Nothing in it: the guide leaves it out.</li>` : ""}
          ${!warns.length && !blocked.length && (own.length || follow.length) ? `<li class="lyr-ok">${icon("check", 12)} Every part goes onto one already fitted, and comes off clear.</li>` : ""}
        </ul>
        <button type="button" class="lyr-wide-btn" data-steps="use"${modelOnly ? " hidden" : ""} title="This picture shows this step when Steps mode ends">${icon("camera", 16)} Use this step for this picture</button>
        <p class="lyr-note">The project's /Assembly guide draws a page for each step, in this order.</p>
      </section>${toolsPanel()}`;
    }

    /** Tools for the guide: what its Before you start page lists under You will need. */
    let toolFind = "";
    let toolsOpen = false;
    const toolList = () => guideToolList ?? DEFAULT_GUIDE_TOOLS;
    function toolsPanel(): string {
      const list = toolList();
      const picked = list.map(t => {
        const r = readTool(t);
        return `<button type="button" class="lyr-tool-chip lyr-on" data-guide-tool="${esc(t)}" title="Take it off the list">${r.kind ? toolSvg(r.kind, 14) : ""}<span>${esc(r.label)}</span>${icon("close", 12)}</button>`;
      }).join("");
      return `<section class="lyr-scene-section lyr-guide-tools">
        <div class="lyr-panel-title">Tools for the guide</div>
        <p class="lyr-note">Listed under You will need on the guide's Before you start page.</p>
        <div class="lyr-tool-chips">${picked || `<span class="lyr-note">None: the page says no tools are needed.</span>`}</div>
        <input type="search" class="lyr-tool-add" data-guide-tool-find maxlength="${MAX_TOOL_LENGTH}" value="${esc(toolFind)}" placeholder="Find or type a tool, then Enter"${list.length >= MAX_GUIDE_TOOLS ? ` disabled title="That's the most a page lists (${MAX_GUIDE_TOOLS})"` : ""}>
        <details class="lyr-tool-catalogue"${toolsOpen || toolFind ? " open" : ""}><summary>All tools</summary><div data-tool-catalogue>${toolCatalogue()}</div></details>
      </section>`;
    }
    /** The catalogue, grouped, as far as the search goes. */
    function toolCatalogue(): string {
      const list = toolList();
      const found = findTools(toolFind);
      if (!found.length) return `<p class="lyr-note">No tool called that: press Enter to add "${esc(toolFind.trim())}" as it is.</p>`;
      return TOOL_GROUPS.map(g => {
        const tools = found.filter(t => t.group === g);
        if (!tools.length) return "";
        return `<div class="lyr-tool-group">${esc(g)}</div>${tools.map(t => {
          const on = list.includes(t.id);
          return `<div class="lyr-tool-row">
            <button type="button" class="lyr-tool-pick${on ? " lyr-on" : ""}" data-guide-tool="${esc(t.id)}" aria-pressed="${on}" title="${on ? "Take it off the list" : "Add it to the list"}"><span class="lyr-tool-ico">${toolSvg(t, 18)}</span><span>${esc(t.label)}</span>${on ? icon("check", 12) : ""}</button>
            ${t.sizes ? `<div class="lyr-tool-sizes">${t.sizes.map(sz => {
              const id = `${t.id}:${sz}`;
              const son = list.includes(id);
              return `<button type="button" class="lyr-tool-size${son ? " lyr-on" : ""}" data-guide-tool="${esc(id)}" aria-pressed="${son}" title="${esc(`${t.label} ${sz}`)}">${esc(sz)}</button>`;
            }).join("")}</div>` : ""}
          </div>`;
        }).join("")}`;
      }).join("");
    }
    /** Picks in catalogue order (sizes in theirs), any typed in last. */
    function sortTools(list: string[]): string[] {
      const rank = (t: string) => {
        const r = readTool(t);
        if (!r.kind) return 1e6;
        return TOOL_CATALOGUE.indexOf(r.kind) * 100 + (r.size ? (r.kind.sizes?.indexOf(r.size) ?? 50) + 1 : 0);
      };
      return list.map((t, i) => [t, rank(t) + i / 1000] as const).sort((a, b) => a[1] - b[1]).map(x => x[0]);
    }
    function setGuideTools(next: string[]): void {
      guideToolList = sortTools(next).slice(0, MAX_GUIDE_TOOLS);
      stepsCommit();
      renderProps();
    }
    function toggleGuideTool(id: string): void {
      const list = toolList();
      if (list.includes(id)) return setGuideTools(list.filter(t => t !== id));
      // A size stands for the tool itself, and the tool alone for any size.
      const base = id.split(":")[0];
      const rest = list.filter(t => (id.includes(":") ? t !== base : !t.startsWith(`${base}:`)));
      if (rest.length >= MAX_GUIDE_TOOLS) return status(`A page lists ${MAX_GUIDE_TOOLS} tools at most: take one off first.`, true);
      setGuideTools([...rest, id]);
    }
    function addGuideTool(name: string): void {
      const t = name.replace(/\s+/g, " ").trim().slice(0, MAX_TOOL_LENGTH);
      if (!t) return;
      const list = toolList();
      // A tool in the catalogue (by any of its names) is picked from it.
      const known = bestTool(t);
      const pick = known ? known.id : t;
      if (list.some(x => x.toLowerCase() === pick.toLowerCase())) return status(`${known ? known.label : t} is on the list already.`);
      toolFind = "";
      toggleGuideTool(pick);
      props.querySelector<HTMLInputElement>("[data-guide-tool-find]")?.focus();
    }

    function renderStepsList(): void {
      const at = recording ? recordedAt() : stepsAt();
      const owners = fixingOwners(scene.parts, isFixing);
      const handPicked = stepIndex(steps);
      const ids = new Set(scene.parts.map(p => p.id));
      const byParent = new Map<string, ScenePart[]>();
      for (const p of steppable(scene.parts)) {
        const key = p.parent && ids.has(p.parent) ? p.parent : "";
        (byParent.get(key) || byParent.set(key, []).get(key)!).push(p);
      }
      const row = (p: ScenePart, depth: number): string => {
        const k = at.get(p.id);
        const auto = !recording && k !== undefined && !handPicked.has(p.id);
        const cur = recording ? k === recording.steps.length - 1 : k === stepAt;
        const chip = k === undefined ? "–" : String(k + 1);
        const title = recording
          ? (k === undefined ? "Not fitted yet: click to fit it now" : `Fitted in step ${k + 1}`)
          : k === undefined ? `In no step: click to fit it in step ${stepAt + 1}`
          : auto ? `Goes with ${esc(partById(owners.get(p.id) || "")?.name || "its part")} in step ${k + 1}: click to put it in step ${stepAt + 1} instead`
          : cur ? `Fitted in step ${k + 1}: click to take it out` : `Fitted in step ${k + 1}: click to move it to step ${stepAt + 1}`;
        return `<li class="lyr-scene-row lyr-step-row${cur ? " lyr-on" : ""}" style="--depth:${depth}" data-id="${esc(p.id)}" draggable="${recording ? "false" : "true"}">
          <button type="button" class="lyr-scene-name" data-step-toggle="${esc(p.id)}" title="${title}"><span class="lyr-step-chip${cur ? " lyr-cur" : ""}${k === undefined ? " lyr-none" : ""}${auto ? " lyr-auto" : ""}">${chip}</span>${icon("cube", 14)}<span>${esc(p.name)}</span></button>
        </li>${(byParent.get(p.id) || []).map(c => row(c, depth + 1)).join("")}`;
      };
      list.innerHTML = (byParent.get("") || []).map(p => row(p, 0)).join("") || `<li class="lyr-note">No parts yet.</li>`;
      modelNote.hidden = false;
      modelNote.innerHTML = `<p class="lyr-note">${recording ? "Click parts in the order they go on." : "The number is the step a part goes on in. Click a part to put it in the step shown, or drag it onto a step."}</p>`;
      $(".lyr-scene-parts-title").textContent = "Build order";
    }

    root.querySelector(".lyr-scene-modes")?.addEventListener("click", e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-mode]");
      if (b) setMode(b.dataset.mode === "steps");
    });
    list.addEventListener("click", e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-step-toggle]");
      if (!b || !stepsOn) return;
      if (recording) recordClick(b.dataset.stepToggle!);
      else toggleInStep(b.dataset.stepToggle!);
    });
    list.addEventListener("dragstart", e => {
      const li = (e.target as HTMLElement).closest<HTMLElement>(".lyr-step-row");
      if (!li || !stepsOn) return;
      e.dataTransfer?.setData("text/x-lyr-part", li.dataset.id || "");
    });
    function stepsAction(act: string): void {
      switch (act) {
        case "suggest": suggest(); break;
        case "record": startRecording(); break;
        case "play": playSteps(); break;
        case "movie": void saveMovie(); break;
        case "new": newStep(); break;
        case "delete": deleteStep(stepAt); break;
        case "earlier": moveStep(stepAt, stepAt - 1); break;
        case "later": moveStep(stepAt, stepAt + 1); break;
        case "use": useStepHere(); break;
        case "take-back": recordTakeBack(); break;
        case "rec-next":
          if (recording && recording.steps[recording.steps.length - 1].length) {
            recording.steps.push([]);
            showStep();
            status(`Step ${recording.steps.length}: click the parts that go on next.`, false, true);
          }
          break;
        case "rec-finish": finishRecording(); break;
        case "rec-stop": recording = null; showStep(); status("Recording stopped: your steps are as they were."); break;
      }
    }
    strip.addEventListener("click", e => {
      const t = e.target as HTMLElement;
      const b = t.closest<HTMLElement>("[data-steps], [data-step-add], [data-step-insert], [data-step-card]");
      if (!b) return;
      if (b.dataset.steps) stepsAction(b.dataset.steps);
      else if (b.dataset.stepInsert) {
        stopStepPlay();
        newStep(Number(b.dataset.stepInsert));
      }
      else if (b.dataset.stepAdd) toggleInStep(b.dataset.stepAdd);
      else if (b.dataset.stepCard) {
        stopStepPlay();
        stepAt = Number(b.dataset.stepCard);
        showStep();
      }
    });
    strip.addEventListener("keydown", e => {
      const card = (e.target as HTMLElement).closest<HTMLElement>("[data-step-card]");
      if (!card) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        stepAt = Number(card.dataset.stepCard);
        showStep();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        stepAt = Math.max(0, Math.min(steps.length - 1, stepAt + (e.key === "ArrowLeft" ? -1 : 1)));
        showStep();
        strip.querySelector<HTMLElement>(`[data-step-card="${stepAt}"]`)?.focus();
      }
    });
    strip.addEventListener("dragstart", e => {
      const card = (e.target as HTMLElement).closest<HTMLElement>("[data-step-card]");
      const part = (e.target as HTMLElement).closest<HTMLElement>("[data-step-add]");
      if (card) e.dataTransfer?.setData("text/x-lyr-step", card.dataset.stepCard!);
      else if (part) e.dataTransfer?.setData("text/x-lyr-part", part.dataset.stepAdd!);
    });
    strip.addEventListener("dragover", e => {
      if (!(e.target as HTMLElement).closest("[data-step-card]")) return;
      const types = e.dataTransfer?.types || [];
      if (types.includes("text/x-lyr-step") || types.includes("text/x-lyr-part")) {
        e.preventDefault();
        strip.querySelectorAll(".lyr-drop-on").forEach(c => c.classList.remove("lyr-drop-on"));
        (e.target as HTMLElement).closest("[data-step-card]")!.classList.add("lyr-drop-on");
      }
    });
    strip.addEventListener("dragleave", e => (e.target as HTMLElement).closest("[data-step-card]")?.classList.remove("lyr-drop-on"));
    strip.addEventListener("drop", e => {
      const card = (e.target as HTMLElement).closest<HTMLElement>("[data-step-card]");
      if (!card) return;
      e.preventDefault();
      const to = Number(card.dataset.stepCard);
      const from = e.dataTransfer?.getData("text/x-lyr-step");
      const part = e.dataTransfer?.getData("text/x-lyr-part");
      if (from) moveStep(Number(from), to);
      else if (part) {
        const was = steps.findIndex(s => s.parts.includes(part));
        stepAt = to;
        if (was !== to) toggleInStep(part, to);
        else showStep();
      }
    });
    props.addEventListener("click", e => {
      if (!stepsOn) return;
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-steps], [data-step-part], [data-rec-part], [data-guide-tool]");
      if (!b) return;
      if (b.dataset.guideTool) toggleGuideTool(b.dataset.guideTool);
      else if (b.dataset.steps) stepsAction(b.dataset.steps);
      else if (b.dataset.stepPart) toggleInStep(b.dataset.stepPart);
      else if (b.dataset.recPart) recordClick(b.dataset.recPart);
    });
    props.addEventListener("change", e => {
      const t = e.target as HTMLInputElement | HTMLSelectElement;
      const s = steps[stepAt];
      if (!stepsOn || !s) return;
      if (t.dataset.stepTitle !== undefined) {
        const v = t.value.trim();
        if (v) s.title = v.slice(0, 120);
        else delete s.title;
        stepsCommit();
        renderStrip();
      } else if (t.dataset.stepView !== undefined) {
        if (t.value) {
          s.view = t.value;
          const v = views.find(x => x.id === t.value);
          if (v) glideTo(structuredClone(v.camera), () => {});
        } else delete s.view;
        stepsCommit();
      }
    });

    function close(result: WorkspaceResult | null): void {
      if (closed) return;
      closed = true;
      stopShowcase();
      cancelAnimationFrame(drawQueued);
      ro.disconnect();
      gizmo.detach();
      gizmo.dispose();
      orbit.dispose();
      section.dispose();
      art.dispose();
      viewCube.dispose();
      thumbWatch?.disconnect();
      thumbnailer?.dispose();
      blobUrls.forEach(u => URL.revokeObjectURL(u));
      if (playerUrl) URL.revokeObjectURL(playerUrl);
      overlay.remove();
      // The editor underneath may be full screen too.
      if (!document.querySelector(".lyr-overlay")) document.documentElement.classList.remove("lyr-open");
      resolve(result);
    }

    function cancel(): void {
      commit();
      if (stepsOn) setMode(false);
      if ((JSON.stringify(scene) !== start || stepsChanged()) && !window.confirm(modelOnly ? "Leave the model without keeping your changes?" : "Leave the 3D scene without keeping your changes?")) return;
      close(null);
    }

    async function finish(): Promise<void> {
      if (busy) return;
      // A track still in its dialog is kept, as its OK would.
      if (trackDraft) {
        await finishTrack();
        if (trackDraft) return;
      }
      if (recording) finishRecording();
      // The scene shows what it showed before Steps mode (or the step picked for it).
      if (stepsOn) setMode(false);
      busy = true;
      commit();
      const btn = $<HTMLButtonElement>("[data-act=done]");
      btn.disabled = true;
      status(modelOnly ? "Saving the project's model…" : "Drawing the picture…", false, true);
      try {
        const out = clone(scene);
        // Models carried from before they were packed small are packed now
        // (the picture is drawn from the models already read, not read again).
        if (await packParts(out.parts)) {
          for (const p of out.parts) {
            const m = models.get(p.id);
            if (m && !(m instanceof Error)) opts.store.put(p, m);
          }
        }
        steps = tidySteps(steps, out.parts.filter(p => !p.wire), views);
        const viewsChanged = shared && (JSON.stringify([views, defaultView]) !== startViews || stepsChanged());
        // The project's model still carrying unpacked models is saved again, packed, as the same version.
        const repack = linked() && !!projectModel && projectModel.parts.some(p => p.data && !isPacked(p.data));
        if (linked() && opts.saveModel && (scene.parts.length || projectModel) && (!projectModel || partsDiffer(projectModel.parts, scene.parts))) {
          // The parts or joints changed: a new version of the model, which
          // pictures drawn from the old one will say they're behind.
          status("Saving the project's model…", false, true);
          const stamp = Math.max(Date.now(), (opts.model?.stamp || 0) + 1);
          await opts.saveModel({ ...modelOf(out, stamp), ...viewsOut(), ...stepsOut() });
          out.model = { stamp };
        } else if ((viewsChanged || repack) && opts.saveModel) {
          // Only the named views changed (or the models were packed): the same version, so no picture is out of date.
          status("Saving the project's model…", false, true);
          const was = opts.model || modelOf(linked() ? out : { ...out, parts: [] }, 0);
          const base = repack ? { ...was, parts: modelOf(out, was.stamp).parts } : was;
          await opts.saveModel({ ...base, ...viewsOut(), ...stepsOut() });
        }
        // Just the model: no picture to draw.
        if (modelOnly) return close({ scene: out, picture: document.createElement("canvas") });
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
        keepFitted = opensFitted();
      });
    } else {
      void openMenu();
    }
    void loadDiagram();
  });
}

export type { FetchModel };
