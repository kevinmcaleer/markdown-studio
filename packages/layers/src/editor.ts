// The Layers editor: a Canva-style page of text, shapes and pictures.
//
// One editor works both in the page (inline, at the column's width) and full
// screen; switching moves the same editor between the two, so nothing is
// lost. The side rail adds things (templates, elements, text, uploads) and
// manages layers and the page; the bar above the page changes with what is
// selected. Done hands the host the layer document and a PNG of the page
// with the document stored inside it.

import {
  ActiveSelection, BaseFabricObject, Canvas, Control, FabricImage, FabricObject, Group, Point, Polygon, Polyline, Rect, Textbox, util, type TPointerEventInfo, type TPointerEvent,
} from "fabric";
import { alignBoxes, distributeBoxes, type AlignHow, type DistributeHow } from "./align";
import { Connector, type ConnectorEnd } from "./connector";
import { DetailTail, isTail, TAIL_LOOKS } from "./detailTail";
import { blankDoc, clampSide, embedDoc, defaultFetch, exportScales, MAX_EXPORT_BYTES, MAX_SIDE, MIN_SIDE, normalizeDoc, SIZES, type LayersDoc } from "./doc";
import {
  ACCENT, badge, boundTo, canHoldText, FIGURES, FONTS, INK, INK_KINDS, isLine, isText, kindOf, LINES, makeShape, makeText, newId, PALETTE, SHAPES, SYMBOLS, shapeText, STEP_RED, TEMPLATES, TEXT_STYLES, TOOLS,
  type Point as XY,
} from "./elements";
import { boxSides, dist, distToSegment, facingSide, polygonSides, SIDES, snapAngle, type Pt, type Side } from "./geometry";
import { icon } from "./icons";
import { behindModel, blankScene, followModel, normalizeModel, normalizeScene, packModel, type ProjectModel, type SceneData } from "./scene/model";
import type { ModelStore } from "./scene/render";
import type { SceneModel } from "./scene/workspace";
import type { WiringHost } from "./scene/wiring2d";
import { type DetailInfo, isDetail, isScene, placeholderPicture, SceneLayer } from "./sceneLayer";
import { snap, type Box, type Guide } from "./snap";
import { inventoryOf, isFastener, partsInStep, screwInventoryOf, TURNED_DEGREES, turnedFromDefault } from "./stepFrame";
import { SCREW_HEADS } from "./scene/screw";
import css from "./layers.css?inline";

// Saved with every layer. Set on the base class: Fabric's toObject reads them
// from there, and a subclass with its own list (a scene, a line) would
// otherwise lose its name, id and links when the graphic is saved.
BaseFabricObject.customProperties = FabricObject.customProperties = ["name", "layerId", "layerLocked", "badge", "badgePinned", "boundTo", "partsStrip", "stepArrow", "turnMark", "detailOf", "inventory"];
// Corner handles that are easier to grab, and a selection colour that reads on any picture.
Object.assign(FabricObject.ownDefaults, {
  borderColor: "#8b3dff",
  cornerColor: "#ffffff",
  cornerStrokeColor: "#8b3dff",
  cornerStyle: "circle",
  cornerSize: 14,
  transparentCorners: false,
  borderScaleFactor: 2,
  padding: 0,
  snapAngle: 45,
  snapThreshold: 4,
});

export interface LayersImage {
  url: string;
  title?: string;
}

export interface LayersResult {
  doc: LayersDoc;
  /** The page as a PNG, with `doc` stored inside it. */
  png: Blob;
  title: string;
  width: number;
  height: number;
}

export interface LayersOptions {
  /** The graphic to edit; a new one when left out. */
  doc?: LayersDoc | null;
  /** For a new graphic: a picture that fills the page, to draw on. */
  picture?: string | Blob | null;
  title?: string;
  mode?: "inline" | "full";
  /** Whether the editor can be shown in the page (false: full screen only). */
  allowInline?: boolean;
  /** Loads a picture's bytes (the host's signed-in fetch). */
  fetchImage?(url: string): Promise<Blob>;
  /** The host's pictures, offered under Uploads. */
  listImages?(): Promise<LayersImage[]>;
  /** The host's 3D models (STL or STEP files), offered in a 3D scene's Add a part. */
  listModels?(): Promise<SceneModel[]>;
  /** Loads a model's bytes (the host's signed-in fetch); plain fetch when left out. */
  fetchModel?(url: string): Promise<ArrayBuffer | Blob>;
  /**
   * The project's model of joined parts, which every 3D scene picks its
   * parts from (null: none yet). With both hooks, scenes share it, and a
   * picture drawn from an older version is marked out of date.
   */
  loadModel?(): Promise<ProjectModel | null>;
  saveModel?(model: ProjectModel): Promise<void>;
  /** The project's 2D wiring diagram, which 3D scenes' wires link to (see scene/wiring2d.ts). */
  wiring?: WiringHost;
  /** Draw every 3D scene's picture again once the graphic opens (a new step, or "Update picture" from the host). */
  updateScenes?: boolean;
  /**
   * This graphic's step number, from its place among the host's steps (the
   * step before it, plus one). A graphic with one step badge takes it, unless
   * its number was typed in (pinned).
   */
  stepNumber?: number;
  doneLabel?: string;
  onDone?(result: LayersResult): void | Promise<void>;
  onCancel?(): void;
  onModeChange?(mode: "inline" | "full"): void;
}

export interface LayersHandle {
  readonly root: HTMLElement;
  mode(): "inline" | "full";
  setMode(mode: "inline" | "full"): void;
  /** Moves the editor (when inline) into `el`. */
  attach(el: HTMLElement): void;
  getDoc(): LayersDoc;
  isDirty(): boolean;
  exportResult(): Promise<LayersResult>;
  /**
   * Resolves once the graphic has opened: its layers loaded, its step
   * number set and, with `updateScenes`, its 3D pictures drawn again. A
   * host can then export it out of sight ("Update" in one press).
   */
  ready(): Promise<void>;
  /**
   * Draws an assembly guide from the project's model on this editor's page,
   * one page at a time (cover, Before you start, Parts list, then a step
   * for each part), handing each finished page to `each`. Meant for an
   * editor mounted out of sight: it clears the page as it goes. Says how
   * many pages it made.
   */
  assemblyGuide(guide: GuideOptions): Promise<number>;
  /**
   * Draws the screw inventory on this editor's page (every screw and
   * heat-set insert in the project's model, by kind, with counts): false
   * when the project has no screws yet.
   */
  screwInventory(): Promise<boolean>;
  /**
   * The project's wire list as a Markdown table: each wire, what it runs
   * between, its colours, length and the length to cut it. From the
   * project's model, or else the first 3D scene with wires ("" when there
   * are none).
   */
  wireList?(): Promise<string>;
  focus(): void;
  destroy(): void;
}

export interface GuideOptions {
  /** The project's name, for the cover. */
  title?: string;
  /** Called with each page as it is finished (upload it, say), with its place and how many there will be. */
  each(result: LayersResult, index: number, total: number): void | Promise<void>;
}

const MAX_PICTURE = 2000;
const HISTORY = 80;
/** The corner slider runs to here; the number box beside it goes further. */
const MAX_SLIDER_RADIUS = 200;
const MAX_RADIUS = 2000;
const NONE = "";

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

let styled = false;
function injectStyles(): void {
  if (styled || typeof document === "undefined") return;
  styled = true;
  const style = document.createElement("style");
  style.dataset.layers = "";
  style.textContent = css;
  document.head.appendChild(style);
}

const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

/** A picture as a data URL no bigger than MAX_PICTURE on its long side, so the graphic carries it. */
async function pictureData(source: Blob): Promise<{ url: string; width: number; height: number }> {
  const raw = await blobToDataUrl(source);
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("That picture couldn't be read."));
    el.src = raw;
  });
  const w = img.naturalWidth || 1;
  const h = img.naturalHeight || 1;
  const scale = Math.min(1, MAX_PICTURE / Math.max(w, h));
  if (scale === 1 && /^data:image\/(png|jpeg|webp|gif)/.test(raw) && source.size < 3_000_000) return { url: raw, width: w, height: h };
  const c = document.createElement("canvas");
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  const jpeg = source.type === "image/jpeg";
  return { url: c.toDataURL(jpeg ? "image/jpeg" : "image/png", 0.9), width: c.width, height: c.height };
}

type Panel = "templates" | "elements" | "text" | "uploads" | "layers" | "page";
const PANELS: [Panel, string, string][] = [
  ["templates", "template", "Templates"],
  ["elements", "shapes", "Elements"],
  ["text", "text", "Text"],
  ["uploads", "upload", "Uploads"],
  ["layers", "layers", "Layers"],
  ["page", "background", "Page"],
];

export function mount(host: HTMLElement, options: LayersOptions = {}): LayersHandle {
  injectStyles();
  const opts = { allowInline: true, ...options };
  const fetchImage = opts.fetchImage || defaultFetch;
  const start = normalizeDoc(opts.doc) || blankDoc();
  let W = start.width;
  let H = start.height;
  let mode: "inline" | "full" = opts.allowInline === false ? "full" : opts.mode || "inline";
  let home = host;

  const root = document.createElement("div");
  root.className = "lyr";
  root.tabIndex = -1;
  root.setAttribute("role", "application");
  root.setAttribute("aria-label", "Layers graphic editor");
  root.innerHTML = `
    <div class="lyr-top">
      <input class="lyr-title" type="text" maxlength="120" placeholder="Untitled graphic" aria-label="Title">
      <span class="lyr-sep"></span>
      <button type="button" class="lyr-btn" data-act="undo" title="Undo (Ctrl+Z)" aria-label="Undo">${icon("undo")}</button>
      <button type="button" class="lyr-btn" data-act="redo" title="Redo (Ctrl+Shift+Z)" aria-label="Redo">${icon("redo")}</button>
      <span class="lyr-status" role="status"></span>
      <span class="lyr-grow"></span>
      <span class="lyr-zoom">
        <button type="button" class="lyr-btn" data-act="zoom-out" title="Zoom out" aria-label="Zoom out">${icon("minus", 16)}</button>
        <button type="button" class="lyr-btn lyr-zoom-label" data-act="zoom-fit" title="Fit to screen">100%</button>
        <button type="button" class="lyr-btn" data-act="zoom-in" title="Zoom in" aria-label="Zoom in">${icon("plus", 16)}</button>
      </span>
      <button type="button" class="lyr-btn lyr-mode" data-act="mode" title="Full screen">${icon("expand")}<span>Full screen</span></button>
      <button type="button" class="lyr-btn lyr-cancel" data-act="cancel">Cancel</button>
      <button type="button" class="lyr-btn lyr-done" data-act="done">${icon("check", 16)}<span>${esc(opts.doneLabel || "Done")}</span></button>
    </div>
    <div class="lyr-context" role="toolbar" aria-label="Selection"></div>
    <div class="lyr-body">
      <nav class="lyr-rail" aria-label="Add and arrange">
        ${PANELS.map(([id, ic, label]) => `<button type="button" class="lyr-rail-btn" data-panel="${id}" aria-pressed="false">${icon(ic, 20)}<span>${label}</span></button>`).join("")}
      </nav>
      <aside class="lyr-panel" hidden>
        <div class="lyr-panel-head"><strong></strong><button type="button" class="lyr-btn" data-act="panel-close" aria-label="Close panel">${icon("close", 16)}</button></div>
        <div class="lyr-panel-body"></div>
      </aside>
      <div class="lyr-stage">
        <div class="lyr-board">
          <canvas></canvas>
          <div class="lyr-float" hidden>
            <button type="button" class="lyr-btn" data-act="duplicate" title="Duplicate (Ctrl+D)" aria-label="Duplicate">${icon("copy", 16)}</button>
            <button type="button" class="lyr-btn" data-act="lock" title="Lock" aria-label="Lock">${icon("lock", 16)}</button>
            <button type="button" class="lyr-btn" data-act="delete" title="Delete" aria-label="Delete">${icon("trash", 16)}</button>
          </div>
        </div>
        <div class="lyr-drop" hidden>Drop to add the picture</div>
      </div>
    </div>
    <div class="lyr-pop" hidden></div>
    <input type="file" class="lyr-file" accept="image/*" multiple hidden>`;

  const $ = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector(s) as T;
  const stage = $(".lyr-stage");
  const board = $(".lyr-board");
  const contextBar = $(".lyr-context");
  const panelEl = $(".lyr-panel");
  const panelBody = $(".lyr-panel-body");
  const floatBar = $(".lyr-float");
  const pop = $(".lyr-pop");
  const fileInput = $<HTMLInputElement>(".lyr-file");
  const titleInput = $<HTMLInputElement>(".lyr-title");
  titleInput.value = opts.title || start.title || "";

  let overlay: HTMLElement | null = null;
  home.appendChild(root);

  const canvas = new Canvas($<HTMLCanvasElement>("canvas"), {
    width: W,
    height: H,
    preserveObjectStacking: true,
    stopContextMenu: true,
    fireRightClick: false,
    selectionColor: "rgba(139, 61, 255, 0.08)",
    selectionBorderColor: "#8b3dff",
    selectionLineWidth: 1,
    targetFindTolerance: 6,
  });
  let background = start.background;

  let zoom = 1;
  let userZoom = 0; // 0: fit
  let fitMargin = 20; // space left around the contents by "Fit to contents"
  let busy = false;
  let destroyed = false;

  // ------------------------------------------------------------ status

  let statusTimer = 0;
  function status(text: string, bad = false, sticky = false): void {
    const el = $(".lyr-status");
    el.textContent = text;
    el.classList.toggle("lyr-bad", bad);
    clearTimeout(statusTimer);
    if (text && !sticky) statusTimer = window.setTimeout(() => (el.textContent = ""), 4000);
  }

  // ------------------------------------------------------------ sizing

  function stageSize(): { w: number; h: number } {
    const w = stage.clientWidth;
    if (mode === "inline") {
      const h = Math.max(260, Math.min(window.innerHeight * 0.72, ((w - 32) * H) / W + 32));
      stage.style.height = `${Math.round(h)}px`;
      return { w, h };
    }
    stage.style.height = "";
    return { w, h: stage.clientHeight };
  }

  function fit(): void {
    if (destroyed) return;
    const { w, h } = stageSize();
    if (!w || !h) return;
    const fitZoom = Math.max(0.05, Math.min((w - 48) / W, (h - 48) / H, mode === "full" ? 1.5 : 2));
    zoom = userZoom || fitZoom;
    canvas.setDimensions({ width: Math.round(W * zoom), height: Math.round(H * zoom) });
    canvas.setViewportTransform([zoom, 0, 0, zoom, 0, 0]);
    board.style.width = `${Math.round(W * zoom)}px`;
    board.style.height = `${Math.round(H * zoom)}px`;
    board.classList.toggle("lyr-clear", !background);
    board.style.background = background || "";
    $(".lyr-zoom-label").textContent = `${Math.round(zoom * 100)}%`;
    stage.classList.toggle("lyr-scroll", W * zoom > w - 24 || H * zoom > h - 24);
    canvas.requestRenderAll();
    placeFloat();
  }
  const ro = new ResizeObserver(() => fit());
  ro.observe(stage);
  const onWindowResize = () => fit();
  window.addEventListener("resize", onWindowResize);

  function setZoom(next: number): void {
    userZoom = Math.max(0.1, Math.min(4, next));
    fit();
  }

  // ------------------------------------------------------------ layers state

  const objects = () => canvas.getObjects();
  const active = () => canvas.getActiveObject();
  const selected = () => canvas.getActiveObjects();
  const nameOf = (o: FabricObject) => String((o as FabricObject & { name?: string }).name || kindOf(o).label);
  const locked = (o: FabricObject) => !!(o as FabricObject & { layerLocked?: boolean }).layerLocked;

  function prepare(o: FabricObject): void {
    const any = o as FabricObject & { layerId?: string; name?: string };
    if (!any.layerId) any.layerId = newId();
    if (!any.name) any.name = kindOf(o).label;
    const isLocked = locked(o);
    o.set({ selectable: !isLocked && o.visible !== false, evented: !isLocked && o.visible !== false });
    if (o.type === "image") o.setControlsVisibility({ mt: false, mb: false, ml: false, mr: false });
    // A 3D scene's frame can take any shape: the view widens or narrows with it.
    if (isScene(o)) o.setControlsVisibility({ mt: true, mb: true, ml: true, mr: true });
    if (o instanceof Rect && !o.group && (o.scaleX !== 1 || o.scaleY !== 1)) {
      // Older graphics stretched boxes by scaling them, which stretched their corners too.
      bakeScale(o, Math.min((Number(o.rx) || 0) * Math.abs(o.scaleX || 1), (Number(o.ry) || 0) * Math.abs(o.scaleY || 1)));
    }
    // A detail circle: zoom buttons under the ring.
    if (isDetail(o)) {
      o.controls = { ...o.controls, zoomOut: zoomControls.out, zoomIn: zoomControls.in };
      o.setCoords();
    }
    if (o instanceof Connector) {
      // A line is changed by its two ends, which snap to other layers (a detail circle's tail by its tip, and the size of the spot it magnifies).
      o.controls = isTail(o) ? { p2: lineControls.p2, target: targetControl } : lineControls;
      o.hasBorders = false;
      o.objectCaching = false;
      o.setCoords();
    }
    // A shape's own text goes where the shape goes; it's changed through the shape.
    if (boundTo(o)) o.set({ selectable: false, evented: false, lockMovementX: true, lockMovementY: true, hasControls: false });
  }

  // ------------------------------------------------------------ connectors and shape text

  const idOf = (o: FabricObject) => String((o as FabricObject & { layerId?: string }).layerId || "");
  const byId = (id: string) => (id ? objects().find(o => idOf(o) === id) : undefined);
  const textFor = (shape: FabricObject) => {
    const id = idOf(shape);
    return id ? (objects().find(o => boundTo(o) === id) as Textbox | undefined) : undefined;
  };
  /** The text a selection's text tools change: a text box's own, or a shape's. */
  const textOf = (o: FabricObject | undefined): Textbox | undefined => (!o ? undefined : isText(o) ? o : canHoldText(o) ? textFor(o) : undefined);
  const textTargets = () => selected().map(textOf).filter((t): t is Textbox => !!t);
  /** Whether lines can be fastened to `o`. */
  const connectable = (o: FabricObject) => o.visible !== false && !isLine(o) && !boundTo(o) && !locked(o);
  const centreOf = (o: FabricObject) => new Point(0, 0).transform(o.calcTransformMatrix());

  /** A layer's snap points on the page: the middle of each side, on the outline for a polygon. */
  function anchorsOf(o: FabricObject): Record<Side, Point> {
    let local: Record<Side, Pt>;
    if (o instanceof Polygon) {
      const off = o.pathOffset;
      local = polygonSides(o.points.map(p => ({ x: p.x - off.x, y: p.y - off.y })));
    } else {
      const d = o._getNonTransformedDimensions();
      local = boxSides(d.x, d.y);
    }
    const m = o.calcTransformMatrix();
    const out = {} as Record<Side, Point>;
    for (const side of SIDES) out[side] = new Point(local[side].x, local[side].y).transform(m);
    return out;
  }

  /** Where a fastened end sits now, aiming an "auto" end at `toward`; null when what it's fastened to is gone or hidden. */
  function endAt(end: ConnectorEnd | null | undefined, toward: Pt): Point | null {
    const t = end && byId(end.id);
    if (!end || !t || t.visible === false) return null;
    const a = anchorsOf(t);
    return a[end.side === "auto" ? facingSide(a, toward) : end.side] || null;
  }

  function syncConnector(c: Connector): void {
    const from = c.connFrom;
    const to = c.connTo;
    if (!from && !to) return;
    const [a, b] = c.ends();
    // An end fastened to a side is settled first, so an "auto" end can face it.
    const fixed = (end: ConnectorEnd | null | undefined) => (end && end.side !== "auto" ? endAt(end, a) : null);
    const aim = (end: ConnectorEnd | null | undefined, free: Point) => {
      const t = end && byId(end.id);
      return t ? centreOf(t) : free;
    };
    let na = fixed(from);
    let nb = fixed(to);
    if (!na) na = endAt(from, nb || aim(to, b)) || a;
    if (!nb) nb = endAt(to, na) || b;
    if (dist(na, a) > 0.01 || dist(nb, b) > 0.01) c.setEnds(na, nb);
  }

  /** A detail circle's tail starts at the circle's middle; only its tip moves. */
  function syncTail(tail: DetailTail): void {
    const d = byId(tail.detailOf || "");
    if (!d || !isDetail(d)) return;
    const [a, b] = tail.ends();
    const c = d.getCenterPoint();
    tail.radius = ringRadius(d);
    if (dist(a, c) > 0.01) tail.setEnds(c, b);
  }

  function syncText(t: Textbox): void {
    const shape = byId(boundTo(t));
    if (!shape) return;
    const a = anchorsOf(shape);
    const round = shape.type === "circle" || shape.type === "ellipse" || shape instanceof Polygon;
    const width = Math.max(30, dist(a.left, a.right) * (round ? 0.72 : 0.86));
    const c = centreOf(shape);
    t.set({ originX: "center", originY: "center", left: c.x, top: c.y, angle: shape.getTotalAngle(), width, visible: shape.visible !== false });
    t.setCoords();
    // Always just in front of its shape.
    const list = objects();
    const si = list.indexOf(shape);
    if (list.indexOf(t) < si) canvas.moveObjectTo(t, si);
  }

  /** Brings every line and shape text up to date with what it's fastened to. Things inside the selection move with it. */
  function follow(): void {
    for (const o of objects()) {
      if (o.group) continue;
      if (isTail(o)) syncTail(o);
      else if (o instanceof Connector) syncConnector(o);
      else if (boundTo(o)) syncText(o as Textbox);
    }
  }

  /** What a line end dropped at `p` fastens to: a snap point under the pointer, or else the side of the shape under it that faces `other`. */
  function findSnap(p: Point, exclude: FabricObject[], other: Pt): { shape: FabricObject; side: Side | "auto"; at: Point } | null {
    const list = objects().filter(o => !exclude.includes(o) && connectable(o));
    let best: { shape: FabricObject; side: Side; at: Point } | null = null;
    let bestD = 14 / zoom;
    for (const o of list) {
      const a = anchorsOf(o);
      for (const side of SIDES) {
        const d = dist(a[side], p);
        if (d <= bestD) {
          bestD = d;
          best = { shape: o, side, at: a[side] };
        }
      }
    }
    if (best) return best;
    for (let i = list.length - 1; i >= 0; i--) {
      if (!list[i].containsPoint(p)) continue;
      const a = anchorsOf(list[i]);
      return { shape: list[i], side: "auto", at: a[facingSide(a, other)] };
    }
    return null;
  }

  /** While a line end is being placed: where the pointer is and what it would fasten to (drawn by the guides). */
  let linking: { pointer: Point; hit: { shape: FabricObject; at: Point } | null; exclude: FabricObject[] } | null = null;
  let drawing = false;

  function placeEnd(c: Connector, i: 0 | 1, pointer: Point, e: { altKey?: boolean; shiftKey?: boolean }, exclude: FabricObject[]): void {
    const ends = c.ends();
    const other = ends[1 - i];
    if (isTail(c)) {
      // The tip goes exactly where it's put: it's the spot the circle magnifies, drawn again as it goes.
      if (!i) return;
      c.setEnds(other, pointer);
      aimAt(c);
      return;
    }
    const hit = e.altKey ? null : findSnap(pointer, [c, ...exclude], other);
    const p = hit ? hit.at : e.shiftKey ? snapAngle(other, pointer) : pointer;
    const end = hit ? { id: idOf(hit.shape), side: hit.side } : null;
    if (i) c.connTo = end;
    else c.connFrom = end;
    linking = { pointer, hit, exclude: [c, ...exclude] };
    c.setEnds(i ? other : p, i ? p : other);
    // The other end may be "auto" and want to face this one now.
    syncConnector(c);
  }

  function endControl(i: 0 | 1): Control {
    return new Control({
      cursorStyle: "crosshair",
      actionName: "lineEnd",
      positionHandler: (_dim, _m, obj) => {
        const p = (obj as Connector).calcLinePoints();
        return new Point(i ? p.x2 : p.x1, i ? p.y2 : p.y1).transform(util.multiplyTransformMatrices(obj.getViewportTransform(), obj.calcTransformMatrix()));
      },
      actionHandler: (e, transform, x, y) => {
        const c = transform.target as Connector;
        if (c.group) return false;
        placeEnd(c, i, new Point(x, y), e as MouseEvent, []);
        floatBar.hidden = true;
        return true;
      },
    });
  }
  const lineControls = { p1: endControl(0), p2: endControl(1) };

  /** A tail's tip, its circle and the spot's size on the page (the ring's radius over the zoom). */
  function targetOf(tail: DetailTail): { detail: SceneLayer & { detail: DetailInfo }; tip: Point; r: number } | null {
    const d = byId(tail.detailOf || "");
    if (!d || !isDetail(d)) return null;
    const [, tip] = tail.ends();
    return { detail: d, tip, r: ringRadius(d) / zoomOf(d) };
  }

  /** On the target circle's edge, out along the tail: drag it to take in more or less (the zoom follows). */
  const targetControl = new Control({
    cursorStyle: "nwse-resize",
    actionName: "targetSize",
    positionHandler: (_dim, _m, obj) => {
      const tail = obj as DetailTail;
      const t = targetOf(tail);
      const p = tail.calcLinePoints();
      if (!t) return new Point(p.x2, p.y2).transform(util.multiplyTransformMatrices(obj.getViewportTransform(), obj.calcTransformMatrix()));
      const [c] = tail.ends();
      const len = dist(c, t.tip) || 1;
      const at = new Point(t.tip.x + ((t.tip.x - c.x) / len) * t.r, t.tip.y + ((t.tip.y - c.y) / len) * t.r);
      return at.transform(obj.getViewportTransform());
    },
    actionHandler: (_e, transform, x, y) => {
      const tail = transform.target as DetailTail;
      const t = targetOf(tail);
      if (!t || tail.group) return false;
      const r = Math.max(2, dist(t.tip, { x, y }));
      const z = Math.round(Math.max(0.5, Math.min(20, ringRadius(t.detail) / r)) * 10) / 10;
      if (z === zoomOf(t.detail)) return false;
      t.detail.detail.zoom = z;
      liveDetail(t.detail);
      floatBar.hidden = true;
      return true;
    },
    render: (ctx, left, top) => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(left - 6, top - 6, 12, 12);
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#8b3dff";
      ctx.lineWidth = 1.5;
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    },
  });

  /** The − and + under a detail circle: a step of zoom each. */
  function zoomControl(by: number): Control {
    return new Control({
      x: 0,
      y: 0.5,
      offsetX: by < 0 ? -34 : 34,
      offsetY: 20,
      sizeX: 22,
      sizeY: 22,
      cursorStyle: "pointer",
      actionName: "zoomStep",
      actionHandler: () => false,
      mouseUpHandler: (_e, transform) => {
        const d = transform.target;
        if (!isDetail(d)) return false;
        const z = Math.round(Math.max(0.5, Math.min(20, zoomOf(d) + by)) * 10) / 10;
        if (z === zoomOf(d)) return false;
        d.detail.zoom = z;
        void redrawDetail(d).then(() => {
          renderContext();
          changed();
        });
        return true;
      },
      render: (ctx, left, top) => {
        ctx.save();
        ctx.beginPath();
        ctx.arc(left, top, 10, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = "#8b3dff";
        ctx.lineWidth = 1.5;
        ctx.fill();
        ctx.stroke();
        ctx.strokeStyle = "#8b3dff";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(left - 5, top);
        ctx.lineTo(left + 5, top);
        if (by > 0) {
          ctx.moveTo(left, top - 5);
          ctx.lineTo(left, top + 5);
        }
        ctx.stroke();
        ctx.restore();
      },
    });
  }
  const zoomControls = { out: zoomControl(-0.5), in: zoomControl(0.5) };

  function editShapeText(shape: FabricObject): void {
    let t = textFor(shape);
    if (!t) {
      t = shapeText("", textColourOn(shape));
      (t as Textbox & { boundTo?: string }).boundTo = idOf(shape);
      prepare(t);
      canvas.insertAt(objects().indexOf(shape) + 1, t);
      syncText(t);
    }
    t.set({ selectable: true, evented: true });
    canvas.setActiveObject(t);
    t.enterEditing();
    t.selectAll();
    canvas.requestRenderAll();
  }

  /** Dark text on a light shape, white on a dark one. */
  function textColourOn(shape: FabricObject): string {
    const c = String((typeof shape.fill === "string" && shape.fill) || "");
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c);
    if (!m) return INK;
    const [r, g, b] = [m[1], m[2], m[3]].map(h => parseInt(h, 16) / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.55 ? "#ffffff" : INK;
  }

  /** Leaves a shape's text and selects the shape again. */
  function leaveText(t: Textbox): void {
    t.exitEditing();
    const shape = boundTo(t) && byId(boundTo(t));
    if (shape && objects().includes(t)) {
      prepare(t);
      canvas.setActiveObject(shape);
    } else if (objects().includes(t)) canvas.setActiveObject(t);
    canvas.requestRenderAll();
  }

  // The connect handles: a + just outside the middle of each side of the layer under the pointer.
  // Drag one to draw an arrow to another layer, or click it for a copy of the shape, joined on.
  let hover: FabricObject | null = null;
  const HANDLE = 26;
  function handlesOf(o: FabricObject): { side: Side; at: Point }[] {
    const a = anchorsOf(o);
    const c = centreOf(o);
    // None under the floating bar.
    const fr = floatBar.hidden ? null : floatBar.getBoundingClientRect();
    const br = board.getBoundingClientRect();
    return SIDES.map(side => {
      const v = a[side];
      const d = dist(v, c) || 1;
      const k = HANDLE / zoom;
      return { side, at: new Point(v.x + ((v.x - c.x) / d) * k, v.y + ((v.y - c.y) / d) * k) };
    }).filter(h => {
      if (!fr) return true;
      const x = br.left + h.at.x * zoom;
      const y = br.top + h.at.y * zoom;
      return !(x > fr.left - 10 && x < fr.right + 10 && y > fr.top - 10 && y < fr.bottom + 10);
    });
  }
  const handleAt = (p: Point) => (hover ? handlesOf(hover).find(h => dist(h.at, p) <= 11 / zoom) : undefined);

  function updateHover(p: Point | null): void {
    let next: FabricObject | null = null;
    const editing = (active() as Textbox | undefined)?.isEditing;
    if (p && !editing && !drawing) {
      const list = objects().filter(connectable);
      for (let i = list.length - 1; i >= 0 && !next; i--) if (list[i].containsPoint(p)) next = list[i];
      // Moving out towards a handle keeps it showing.
      if (!next && hover && list.includes(hover)) {
        const b = hover.getBoundingRect();
        const m = (HANDLE + 14) / zoom;
        if (p.x > b.left - m && p.x < b.left + b.width + m && p.y > b.top - m && p.y < b.top + b.height + m) next = hover;
      }
    }
    if (next !== hover) {
      hover = next;
      canvas.requestRenderAll();
    }
    board.classList.toggle("lyr-on-handle", !!(p && handleAt(p)));
  }
  canvas.on("mouse:move", e => {
    if ((e.e as MouseEvent).buttons || canvas._currentTransform) return;
    updateHover(canvas.getScenePoint(e.e));
  });
  board.addEventListener("pointerleave", () => {
    if (!drawing) updateHover(null);
  });

  board.addEventListener(
    "pointerdown",
    e => {
      if (e.button !== 0 || !hover || floatBar.contains(e.target as Node)) return;
      const p = new Point(pointFromEvent(e));
      const h = handleAt(p);
      if (!h) return;
      e.preventDefault();
      e.stopPropagation();
      root.focus({ preventScroll: true });
      closePop();
      startLine(hover, h.side, p);
    },
    true,
  );

  /** Draws a new arrow out of `shape`'s `side`; a click without a drag adds a joined-on copy of the shape instead. */
  function startLine(shape: FabricObject, side: Side, down: Point): void {
    drawing = true;
    const from = anchorsOf(shape)[side];
    const c = makeShape("arrow", { x: 0, y: 0 }, lastColor.line || INK) as Connector;
    c.connFrom = { id: idOf(shape), side };
    c.setEnds(from, from);
    prepare(c);
    let added = false;
    const move = (ev: PointerEvent) => {
      const p = new Point(pointFromEvent(ev));
      if (!added) {
        if (dist(p, down) < 6 / zoom) return;
        canvas.discardActiveObject();
        canvas.add(c);
        added = true;
      }
      placeEnd(c, 1, p, ev, [shape]);
      canvas.requestRenderAll();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      drawing = false;
      linking = null;
      if (!added) {
        void addJoined(shape, side);
        return;
      }
      const [a, b] = c.ends();
      if (dist(a, b) < 12 / zoom) canvas.remove(c);
      else canvas.setActiveObject(c);
      canvas.requestRenderAll();
      changed();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  const OPPOSITE: Record<Side, Side> = { top: "bottom", bottom: "top", left: "right", right: "left" };
  /** A copy of `shape` (without its text) beside its `side`, with an arrow to it. */
  async function addJoined(shape: FabricObject, side: Side): Promise<void> {
    const copy = await shape.clone();
    (copy as FabricObject & { layerId?: string }).layerId = newId();
    (copy as FabricObject & { layerLocked?: boolean }).layerLocked = false;
    const b = shape.getBoundingRect();
    const gap = 120;
    const c = centreOf(shape);
    const dx = side === "left" ? -(b.width + gap) : side === "right" ? b.width + gap : 0;
    const dy = side === "top" ? -(b.height + gap) : side === "bottom" ? b.height + gap : 0;
    const at = new Point(Math.max(b.width / 2, Math.min(W - b.width / 2, c.x + dx)), Math.max(b.height / 2, Math.min(H - b.height / 2, c.y + dy)));
    copy.setPositionByOrigin(at, "center", "center");
    prepare(copy);
    const line = makeShape("arrow", { x: 0, y: 0 }, lastColor.line || INK) as Connector;
    line.connFrom = { id: idOf(shape), side };
    line.connTo = { id: idOf(copy), side: OPPOSITE[side] };
    prepare(line);
    canvas.add(copy);
    canvas.add(line);
    follow();
    canvas.setActiveObject(copy);
    canvas.requestRenderAll();
  }

  // Lines are picked by the stroke, not the box around them, so a long diagonal doesn't cover what's under it.
  const inArea = (canvas as unknown as { _pointIsInObjectSelectionArea(o: FabricObject, p: Point): boolean })._pointIsInObjectSelectionArea.bind(canvas);
  (canvas as unknown as { _pointIsInObjectSelectionArea(o: FabricObject, p: Point): boolean })._pointIsInObjectSelectionArea = (o, p) => {
    if (o instanceof Connector && !o.group) {
      const [a, b] = o.ends();
      let half = (Number(o.strokeWidth) || 1) / 2 + 8 / zoom;
      if (isTail(o)) {
        // A tail flares out from its tip to the ring: wider to grab near the circle, and no grab inside the ring. Without a line, it's picked at its tip.
        const r = Number(o.radius) || 0;
        const len = dist(a, b);
        if (dist(p, a) < r) return false;
        if (o.look === "none") return dist(p, b) <= 14 / zoom;
        if (o.look !== "line") half += Math.max(0, Math.min(1, dist(p, b) / (len || 1))) * r * 0.45;
      }
      return distToSegment(p, a, b) <= half;
    }
    return inArea(o, p);
  };

  function getDoc(): LayersDoc {
    const json = canvas.toObject() as { objects: Record<string, unknown>[] };
    const title = titleInput.value.trim();
    return { ...blankDoc({ width: W, height: H }, background), ...(title ? { title } : {}), objects: json.objects };
  }

  // ------------------------------------------------------------ history

  const past: string[] = [];
  const future: string[] = [];
  let current = "";
  let saved = "";
  let restoring = false;
  let historyTimer = 0;
  const snapshot = () => JSON.stringify(getDoc());

  function changed(): void {
    if (restoring || drawing) return;
    follow();
    clearTimeout(historyTimer);
    historyTimer = window.setTimeout(commit, 150);
    renderLayersList();
  }
  function commit(): void {
    clearTimeout(historyTimer);
    const next = snapshot();
    if (next === current) return;
    if (current) past.push(current);
    if (past.length > HISTORY) past.shift();
    future.length = 0;
    current = next;
    syncHistoryButtons();
  }
  function syncHistoryButtons(): void {
    $<HTMLButtonElement>("[data-act=undo]").disabled = !past.length;
    $<HTMLButtonElement>("[data-act=redo]").disabled = !future.length;
  }

  async function load(doc: LayersDoc): Promise<void> {
    restoring = true;
    try {
      canvas.discardActiveObject();
      W = doc.width;
      H = doc.height;
      background = doc.background;
      await canvas.loadFromJSON({ objects: doc.objects });
      canvas.backgroundColor = "";
      objects().forEach(prepare);
      follow();
    } finally {
      restoring = false;
    }
    fit();
    renderLayersList();
    renderContext();
    // Undo can change the page size, so the Page panel's numbers follow.
    if (openPanel === "page") renderPanel();
  }

  async function undo(): Promise<void> {
    commit();
    if (!past.length) return;
    future.push(current);
    current = past.pop()!;
    await load(JSON.parse(current));
    syncHistoryButtons();
  }
  async function redo(): Promise<void> {
    if (!future.length) return;
    past.push(current);
    current = future.pop()!;
    await load(JSON.parse(current));
    syncHistoryButtons();
  }

  // ------------------------------------------------------------ adding

  function centre(w = 0, h = 0): XY {
    // A little offset each time, so repeated adds don't stack exactly.
    const n = objects().length % 6;
    return { x: (W - w) / 2 + n * 12, y: (H - h) / 2 + n * 12 };
  }

  function add(o: FabricObject, at?: XY, { select = true } = {}): void {
    prepare(o);
    const box = o.getBoundingRect();
    // Big things come in at no more than 70% of the page.
    const fitScale = Math.min(1, (W * 0.7) / box.width, (H * 0.7) / box.height);
    if (fitScale < 1 && !isLine(o)) o.scale((o.scaleX || 1) * fitScale);
    const b = o.getBoundingRect();
    const p = at ? { x: at.x - b.width / 2, y: at.y - b.height / 2 } : centre(b.width, b.height);
    o.set({ left: (o.left || 0) + p.x - b.left, top: (o.top || 0) + p.y - b.top });
    o.setCoords();
    canvas.add(o);
    if (select) canvas.setActiveObject(o);
    canvas.requestRenderAll();
  }

  const badges = () => objects().filter(o => Number((o as FabricObject & { badge?: number }).badge) > 0) as (Group & { badge: number; badgePinned?: boolean })[];
  /** Whether the graphic's step badge follows its place in the host's steps: one badge, not pinned. */
  const autoBadge = () => {
    const list = badges();
    return opts.stepNumber && list.length === 1 && !list[0].badgePinned ? list[0] : null;
  };
  /** Numbers the step badge from its place in the host's steps. Says whether it changed it. */
  function numberStep(): boolean {
    const b = autoBadge();
    if (!b || !opts.stepNumber || b.badge === opts.stepNumber) return false;
    const was = b.badge;
    setBadge(b, opts.stepNumber, false);
    // A title that ends in the old number follows it: "Step 3" → "Step 4".
    const m = /(\d+)(\D*)$/.exec(titleInput.value);
    if (m && Number(m[1]) === was) titleInput.value = titleInput.value.slice(0, m.index) + opts.stepNumber + m[2];
    return true;
  }

  function nextBadge(): number {
    if (opts.stepNumber && !badges().length) return opts.stepNumber;
    const ns = objects().map(o => Number((o as FabricObject & { badge?: number }).badge) || 0);
    return Math.max(0, ...ns) + 1;
  }

  function addKind(kind: string, at?: XY): void {
    if (kind === "scene") {
      void addScene(at);
      return;
    }
    if (kind === "badge") {
      add(badge(nextBadge(), { x: 0, y: 0 }, lastColor.badge || ACCENT), at);
      return;
    }
    // Instruction symbols start in black, like the line art they sit beside.
    const color = INK_KINDS.has(kind) ? INK : isLineKind(kind) ? lastColor.line || INK : lastColor.shape || "#74c0fc";
    const o = makeShape(kind, { x: 0, y: 0 }, color);
    if (o) add(o, at);
  }
  const isLineKind = (k: string) => LINES.some(l => l.id === k);
  const lastColor: Record<string, string> = {};

  function addTextStyle(id: string, at?: XY): void {
    const style = TEXT_STYLES.find(s => s.id === id);
    if (!style) return;
    const t = makeText(style, { x: 0, y: 0 });
    add(t, at);
    t.enterEditing();
    t.selectAll();
  }

  async function addPicture(source: Blob | string, at?: XY, name = "Picture"): Promise<FabricImage | null> {
    status("Adding the picture…", false, true);
    try {
      const blob = typeof source === "string" ? (source.startsWith("data:") ? await (await fetch(source)).blob() : await fetchImage(source)) : source;
      const data = await pictureData(blob);
      const img = await FabricImage.fromURL(data.url);
      img.set({ name } as Partial<FabricImage>);
      add(img, at);
      status("");
      return img;
    } catch (e) {
      status(e instanceof Error && e.message ? e.message : "That picture couldn't be added.", true);
      return null;
    }
  }

  // ------------------------------------------------------------ 3D scenes

  let modelStore: ModelStore | null = null;

  // The project's model (undefined until asked for), and the scenes whose
  // pictures were drawn from an older version of it.
  let projectModel: ProjectModel | null | undefined;
  async function getProjectModel(): Promise<ProjectModel | null> {
    if (!opts.loadModel || !opts.saveModel) return null;
    if (projectModel === undefined) {
      try {
        projectModel = normalizeModel(await opts.loadModel());
      } catch {
        return null; // Not now: asked again next time.
      }
    }
    return projectModel;
  }
  const staleScenes = () => objects().filter((o): o is SceneLayer => isScene(o) && behindModel(o.scene, projectModel));
  function sayStale(): void {
    const n = staleScenes().length;
    if (!n && staleInventory().length) return status("The screw list is out of date: the project's screws have changed. Add the Screw inventory template again to redraw it.", false, true);
    if (n) status(`${n === 1 ? "A 3D picture is" : `${n} 3D pictures are`} out of date: the project's model has changed. Select ${n === 1 ? "it" : "one"} and click Update picture.`, false, true);
  }

  /** Draws scene pictures again from the project's model (all of them, or just `only`). Says how many it drew. */
  async function updateScenes(only?: SceneLayer[], all = false): Promise<number> {
    const model = await getProjectModel();
    const layers = only || objects().filter((o): o is SceneLayer => isScene(o) && (all || behindModel(o.scene, model)));
    // The screw inventory follows the model too (all of the page's, or only when it's behind).
    const inventory = !only && model && inventoryLayers().length && (all || staleInventory().length) ? await screwInventory(true) : false;
    if (!layers.length) return inventory ? 1 : 0;
    status(`Drawing ${layers.length === 1 ? "the picture" : `${layers.length} pictures`} again…`, false, true);
    let done = 0;
    try {
      await sceneTools();
      for (const layer of layers) {
        if (!layer.scene?.parts.length && !(model && layer.scene?.model)) continue;
        const scene = model && layer.scene?.model ? followModel(normalizeScene(layer.scene), model) : normalizeScene(layer.scene);
        const { w, h } = layer.pageSize();
        const scale = sceneScale(w, h);
        const picture = await drawLayer(layer, scene, Math.round(w), Math.round(h), scale);
        if (destroyed) return done;
        await setScenePicture(layer, scene, picture, scale, w, h);
        await followScene(layer);
        done++;
      }
      status(done ? `${done === 1 ? "Picture" : `${done} pictures`} drawn again.` : "");
    } catch (e) {
      status(e instanceof Error && e.message ? `The picture couldn't be drawn again: ${e.message}` : "The picture couldn't be drawn again.", true);
    }
    if (done) changed();
    renderContext();
    canvas.requestRenderAll();
    return done;
  }
  async function sceneTools() {
    const [workspace, render] = await Promise.all([import("./scene/workspace"), import("./scene/render")]);
    if (!modelStore) {
      const fetchModel = opts.fetchModel || ((url: string) => fetch(url).then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`That model couldn't be loaded (${r.status}).`)))));
      modelStore = new render.ModelStore(async url => {
        const got = await fetchModel(url);
        return got instanceof Blob ? got.arrayBuffer() : got;
      });
    }
    return { ...workspace, ...render, store: modelStore };
  }

  /** The picture's size, times its page size: twice, for sharpness, unless that is very big. */
  const sceneScale = (w: number, h: number) => Math.max(1, Math.min(2, 3200 / Math.max(w, h)));

  /** A new 3D scene, `box` (fractions of the page) or 60% of the page, opened to add parts. */
  async function addScene(at?: XY, box?: { left: number; top: number; width: number; height: number }): Promise<void> {
    const w = Math.round(box ? W * box.width : W * 0.6);
    const h = Math.round(box ? H * box.height : H * 0.6);
    const layer = new SceneLayer(placeholderPicture(w, h), { name: "3D scene" } as Partial<SceneLayer>);
    layer.scene = blankScene();
    layer.pictureScale = 1;
    // A canvas picture would be turned into a data URL on every save; a plain one isn't.
    await layer.setSrc(placeholderPicture(w, h).toDataURL("image/png"));
    if (box) {
      prepare(layer);
      layer.set({ left: W * box.left, top: H * box.top });
      layer.setCoords();
      canvas.add(layer);
      canvas.setActiveObject(layer);
    } else add(layer, at);
    canvas.requestRenderAll();
    await editScene(layer);
  }

  let sceneOpen = false;
  /** Opens a scene layer's 3D workspace; Done redraws its picture. */
  async function editScene(layer: SceneLayer): Promise<void> {
    if (sceneOpen || destroyed) return;
    sceneOpen = true;
    status("Opening the 3D scene…", false, true);
    try {
      const t = await sceneTools();
      status("");
      const { w, h } = layer.pageSize();
      const scale = sceneScale(w, h);
      const model = await getProjectModel();
      const result = await t.openWorkspace({
        scene: layer.scene || blankScene(),
        width: Math.round(w),
        height: Math.round(h),
        scale,
        background,
        store: t.store,
        listModels: opts.listModels,
        wiring: opts.wiring,
        ...(opts.loadModel && opts.saveModel
          ? {
              model,
              saveModel: async (m: ProjectModel) => {
                // Saved with each model once (copies of a part share it).
                await opts.saveModel!(packModel(m));
                projectModel = m;
              },
            }
          : {}),
      });
      if (!result || destroyed) return;
      const first = !layer.scene?.parts.length;
      await setScenePicture(layer, result.scene, result.picture, scale, w, h);
      await followScene(layer, first);
      canvas.setActiveObject(layer);
      changed();
      renderContext();
      sayStale();
    } catch (e) {
      status(e instanceof Error && e.message ? `The 3D scene couldn't be opened: ${e.message}` : "The 3D scene couldn't be opened.", true);
    } finally {
      sceneOpen = false;
      root.focus({ preventScroll: true });
    }
  }

  async function setScenePicture(layer: SceneLayer, scene: SceneLayer["scene"], picture: HTMLCanvasElement, scale: number, w: number, h: number): Promise<void> {
    // The picture is `scale` times the layer's page size: show it at that size, keeping the layer's middle.
    const mid = layer.getCenterPoint();
    await layer.setSrc(picture.toDataURL("image/png"));
    layer.scene = scene;
    layer.pictureScale = scale;
    layer.set({ width: picture.width, height: picture.height, scaleX: w / picture.width, scaleY: h / picture.height });
    layer.setPositionByOrigin(mid, "center", "center");
    layer.setCoords();
    canvas.requestRenderAll();
  }

  /** A layer's picture from its scene: a detail circle on its white disc, or the plain picture. */
  async function drawLayer(layer: SceneLayer, scene: SceneData, w: number, h: number, scale: number): Promise<HTMLCanvasElement> {
    const t = await sceneTools();
    if (isDetail(layer)) return t.renderDetail(scene, t.store, w, h, scale, detailLook(layer));
    return t.renderPicture(scene, t.store, w, h, scale, cutsOf(layer));
  }

  /**
   * Where a picture's detail circles point: a spot cut back to the parts'
   * fills round each tail's tip, so the outline there breaks as on a flat-pack
   * sheet. As fractions of the picture, the way the renderer takes them.
   */
  function cutsOf(layer: SceneLayer): import("./scene/render").Cut[] {
    const box = layer.getBoundingRect();
    if (!box.width || !box.height) return [];
    const out: import("./scene/render").Cut[] = [];
    for (const d of detailsOf(layer)) {
      const spot = d.detail.spot;
      if (!spot || !tailOf(d)) continue;
      const tip = { x: box.left + spot.x * box.width, y: box.top + spot.y * box.height };
      const c = d.getCenterPoint();
      const len = dist(c, tip);
      if (len < 1) continue;
      const r = (ringWidth() * 2.5) / box.height;
      out.push({ x: spot.x, y: spot.y, dx: (c.x - tip.x) / len, dy: (c.y - tip.y) / len, len: r * 3, r });
    }
    return out;
  }

  /** After a scene layer is stretched, its picture is drawn again at the new shape, so lines stay sharp (`force`: drawn again whatever its shape). */
  async function redrawScene(layer: SceneLayer, force = false): Promise<void> {
    if (isDetail(layer)) return redrawDetail(layer);
    const { w, h } = layer.pageSize();
    const scale = sceneScale(w, h);
    if (!layer.scene?.parts.length) {
      const pic = placeholderPicture(w, h);
      await setScenePicture(layer, layer.scene || blankScene(), pic, 1, w, h);
      changed();
      return;
    }
    const same = Math.abs((layer.width || 0) - w * scale) < 2 && Math.abs((layer.height || 0) - h * scale) < 2;
    if (same && !force) return;
    try {
      const picture = await drawLayer(layer, normalizeScene(layer.scene), Math.round(w), Math.round(h), scale);
      if (destroyed || !canvas.contains(layer)) return;
      await setScenePicture(layer, layer.scene, picture, scale, w, h);
      changed();
    } catch {
      // Its models can't be loaded here: it keeps the stretched picture.
    }
  }

  // ------------------------------------------------------------ the step frame

  type Owned = FabricObject & { partsStrip?: string; stepArrow?: string; turnMark?: string };
  const ownedBy = (key: "partsStrip" | "stepArrow" | "turnMark", layer: SceneLayer) => objects().filter(o => (o as Owned)[key] === idOf(layer));

  /**
   * The parts this step uses, listed beside the picture as on a flat-pack
   * sheet: a small drawing of each kind of part with its count ("2x").
   * The highlighted parts count as the step's; drawn again whenever the
   * scene changes, keeping where it was put.
   */
  async function partsStrip(layer: SceneLayer, quiet = false): Promise<void> {
    const scene = layer.scene ? normalizeScene(layer.scene) : null;
    const list = scene ? partsInStep(scene) : [];
    const old = ownedBy("partsStrip", layer);
    if (!scene || !list.length) {
      if (!quiet) status("Highlight the parts that are new in this step, then add the strip.", true);
      return;
    }
    if (!quiet) status("Drawing the parts…", false, true);
    try {
      const t = await sceneTools();
      const thumbnailer = new t.Thumbnailer();
      // A box with the parts in it, left to right, each with its count under
      // it, as on a LEGO sheet. The cells are sized so every part fits inside
      // the box, and the box fits beside the picture: more parts, more rows.
      const unit = Math.round(Math.min(W, H) * 0.11);
      const pad = Math.round(unit * 0.3);
      const gap = Math.round(unit * 0.25);
      const labelH = Math.round(unit * 0.36);
      const roomW = Math.max(unit + pad * 2, Math.round(W * 0.25));
      const cols = Math.max(1, Math.min(list.length, Math.floor((roomW - pad * 2 + gap) / (unit + gap))));
      const rows = Math.ceil(list.length / cols);
      const boxW = pad * 2 + cols * unit + (cols - 1) * gap;
      const boxH = pad * 2 + rows * (unit + labelH) + (rows - 1) * gap;
      const sw = Math.max(2, Math.round(unit * 0.035));
      const items: FabricObject[] = [];
      const box = new Rect({ left: 0, top: 0, width: boxW, height: boxH, rx: sw * 2, ry: sw * 2, fill: "", stroke: INK, strokeWidth: sw, objectCaching: false });
      Object.assign(box, { name: "Box", layerId: newId() });
      items.push(box);
      try {
        for (let i = 0; i < list.length; i++) {
          const g = list[i];
          const model = await t.store.get(g.part);
          if (destroyed) return;
          const pic = thumbnailer.draw(model, scene.style, scene.camera.direction, unit * 2);
          const img = await FabricImage.fromURL(pic);
          // Square pictures, so the part fills its cell and never leaves it.
          img.scaleToWidth(unit);
          if (img.getScaledHeight() > unit) img.scaleToHeight(unit);
          const x = pad + (i % cols) * (unit + gap);
          const y = pad + Math.floor(i / cols) * (unit + labelH + gap);
          img.set({ left: x + (unit - img.getScaledWidth()) / 2, top: y + (unit - img.getScaledHeight()) / 2 });
          Object.assign(img, { name: g.part.name || "Part", layerId: newId() });
          const label = new Textbox(`${g.count}x`, { left: x, top: y + unit + labelH * 0.1, width: unit, fontFamily: FONTS[0][1], fontSize: Math.round(labelH * 0.7), fontWeight: "700", fill: INK });
          Object.assign(label, { name: `${g.count}x ${g.part.name || "part"}`, layerId: newId() });
          items.push(img, label);
        }
      } finally {
        thumbnailer.dispose();
      }
      // Where the old strip was; or under the step number, else at the top left.
      const under = badges().map(b => b.getBoundingRect()).sort((p, q) => p.top - q.top)[0];
      const at = old.length
        ? { left: old[0].left || 0, top: old[0].top || 0 }
        : under
          ? { left: Math.round(under.left), top: Math.round(under.top + under.height + Math.min(W, H) * 0.03) }
          : { left: Math.round(W * 0.05), top: Math.round(H * 0.06) };
      old.forEach(o => canvas.remove(o));
      const g = new Group(items, at);
      Object.assign(g, { name: "Parts in this step", layerId: newId(), partsStrip: idOf(layer) });
      prepare(g);
      canvas.add(g);
      canvas.requestRenderAll();
      if (!quiet) status(`${list.length === 1 ? "One kind of part" : `${list.length} kinds of part`} listed.`);
      changed();
    } catch (e) {
      status(e instanceof Error && e.message ? `The parts couldn't be drawn: ${e.message}` : "The parts couldn't be drawn.", true);
    }
  }

  /**
   * The scene's assembly arrows, on or off: solid arrows drawn in the
   * picture along each exploded part's gap, from the part to where it fits.
   * They're part of the picture, so a part in front hides them, and each
   * is set per part in the 3D workspace (From, To, or none).
   */
  async function stepArrows(layer: SceneLayer, on?: boolean): Promise<void> {
    if (!layer.scene?.parts.length) return status("Add parts and explode the scene first.", true);
    const scene = normalizeScene(layer.scene);
    const next = on ?? !scene.arrows;
    if (next && !scene.explode && !scene.parts.some(p => p.explode)) return status("No part is drawn apart from where it fits: slide Explode up in the 3D scene, then turn arrows on.", true);
    if (next) scene.arrows = true;
    else delete scene.arrows;
    layer.scene = scene;
    // Arrows from before they were drawn in the picture go.
    ownedBy("stepArrow", layer).forEach(o => canvas.remove(o));
    await redrawScene(layer, true);
    renderContext();
    status(next ? "Arrows on: each part drawn apart gets one, along its gap. Set a part's arrow (From, To, or none) in the 3D scene." : "Arrows off.");
    changed();
  }

  /**
   * A "turn it" mark at the picture's top right when the step looks from a
   * different side than the project's chosen view (the one new steps start
   * from), and none when it doesn't.
   */
  function turnMark(layer: SceneLayer): void {
    const had = ownedBy("turnMark", layer);
    const turned = layer.scene ? turnedFromDefault(normalizeScene(layer.scene), projectModel) : null;
    if (turned === null || turned < TURNED_DEGREES) {
      had.forEach(o => canvas.remove(o));
      return;
    }
    if (had.length) return;
    const mark = makeShape("rotate", { x: 0, y: 0 }, INK)!;
    const size = Math.min(W, H) * 0.09;
    mark.scale(size / 200);
    const box = layer.getBoundingRect();
    mark.set({ left: box.left + box.width - size * 1.15, top: box.top + size * 0.15 });
    Object.assign(mark, { name: "Turn it (this step looks from another side)", turnMark: idOf(layer) });
    prepare(mark);
    canvas.add(mark);
  }

  const detailsOf = (layer: SceneLayer) => objects().filter(o => isDetail(o) && o.detail.of === idOf(layer)) as (SceneLayer & { detail: DetailInfo })[];
  const tailOf = (detail: SceneLayer) => objects().find(o => isTail(o) && o.detailOf === idOf(detail)) as DetailTail | undefined;
  const sourceOf = (detail: SceneLayer & { detail: DetailInfo }) => {
    const o = byId(detail.detail.of);
    return o && isScene(o) && !isDetail(o) ? o : undefined;
  };
  /** The ring's diameter as a fraction of the circle layer's shorter side; the rest is room for a part to poke out. */
  const DETAIL_CIRCLE = 0.72;
  const ringWidth = () => Math.max(3, Math.round(Math.min(W, H) * 0.006));
  const zoomOf = (d: SceneLayer & { detail: DetailInfo }) => Math.max(0.5, Math.min(20, Number(d.detail.zoom) || 2));
  /** The words on a detail circle's ring: the repeat count ("x1"), none when turned off or emptied. */
  const ringLabel = (d: SceneLayer & { detail: DetailInfo }): string => {
    const l = d.detail.label;
    if (l === false || l === "") return "";
    return typeof l === "string" ? l.slice(0, 12) : "x1";
  };
  const detailLook = (d: SceneLayer & { detail: DetailInfo }) => ({
    ring: { colour: INK, width: ringWidth() },
    circle: DETAIL_CIRCLE,
    featured: d.detail.part,
    label: ringLabel(d) || undefined,
  });
  const ringRadius = (d: SceneLayer) => {
    const { w, h } = d.pageSize();
    return (Math.min(w, h) * DETAIL_CIRCLE) / 2 - ringWidth() / 2;
  };

  /**
   * A detail circle, as on a flat-pack sheet: a magnifier on one spot of
   * the picture (a part's middle to start), its tail's tip on that spot.
   * Drag the tip to magnify somewhere else, set its zoom, stretch it, or
   * pick the part drawn whole over the ring. Drawn again whenever its
   * picture is.
   */
  async function addDetail(layer: SceneLayer, partId: string): Promise<void> {
    const scene = layer.scene ? normalizeScene(layer.scene) : null;
    const part = scene?.parts.find(p => p.id === partId);
    if (!scene || !part) return;
    status("Drawing the close-up…", false, true);
    try {
      const spot = await spotOf(layer, partId);
      if (!spot || destroyed) return;
      const size = Math.round((Math.min(W, H) * 0.3) / DETAIL_CIRCLE);
      const detail = new SceneLayer(placeholderPicture(size, size), { name: `Detail: ${part.name}` } as Partial<SceneLayer>);
      detail.detail = { of: idOf(layer), part: partId, spot, zoom: 2, label: "x1" };
      detail.scene = scene;
      detail.pictureScale = 1;
      await detail.setSrc(placeholderPicture(size, size).toDataURL("image/png"));
      // Beside the picture where there's room: to its left, else its right, else over its top-left corner.
      const box = layer.getBoundingRect();
      const gap = size * 0.05;
      const left = box.left - gap - size >= 0 ? box.left - gap - size : box.left + box.width + gap + size <= W ? box.left + box.width + gap : box.left + gap;
      detail.set({ left, top: Math.max(0, Math.min(H - size, box.top + gap)) });
      prepare(detail);
      canvas.add(detail);
      const tail = new DetailTail([0, 0, 0, 0], { stroke: INK, strokeWidth: ringWidth(), fill: "" });
      Object.assign(tail, { name: `Tail to ${part.name}`, detailOf: idOf(detail) });
      prepare(tail);
      canvas.add(tail);
      const d = detail as SceneLayer & { detail: DetailInfo };
      d.detail.part = undefined;
      await redrawDetail(d);
      if (await fitsRing(d, scene, partId)) {
        d.detail.part = partId;
        await redrawDetail(d);
      }
      canvas.setActiveObject(detail);
      canvas.requestRenderAll();
      status(`A close-up of ${part.name}. Drag the tail's tip to the spot to magnify; set its zoom in the bar.`);
      changed();
      await redrawScene(layer, true);
    } catch (e) {
      status(e instanceof Error && e.message ? `The close-up couldn't be drawn: ${e.message}` : "The close-up couldn't be drawn.", true);
    }
  }

  /** Where a part's middle is on its picture, as fractions across and down. */
  async function spotOf(layer: SceneLayer, partId: string): Promise<{ x: number; y: number } | null> {
    const scene = layer.scene ? normalizeScene(layer.scene) : null;
    if (!scene) return null;
    const t = await sceneTools();
    const b = await t.partBounds(scene, partId, t.store);
    if (!b) return null;
    const box = layer.getBoundingRect();
    const [p] = t.pagePoints(scene, [b.centre], box.width / box.height);
    return { x: p.x, y: p.y };
  }

  /** Puts a detail circle's tail from the circle's middle to its spot on the picture. */
  function aimTail(detail: SceneLayer & { detail: DetailInfo }, tail = tailOf(detail)): void {
    const layer = sourceOf(detail);
    const spot = detail.detail.spot;
    if (!tail || !layer || !spot) return;
    const box = layer.getBoundingRect();
    const to = { x: box.left + spot.x * box.width, y: box.top + spot.y * box.height };
    tail.radius = ringRadius(detail);
    tail.look = detail.detail.look || "tail";
    tail.set({ strokeWidth: ringWidth() });
    tail.setEnds(detail.getCenterPoint(), to);
  }

  /** The spot a tail's tip is on now, as fractions of its picture (kept on the picture). */
  function spotOfTip(tail: DetailTail): { detail: SceneLayer & { detail: DetailInfo }; layer: SceneLayer } | null {
    const detail = byId(tail.detailOf || "");
    if (!detail || !isDetail(detail)) return null;
    const layer = sourceOf(detail);
    if (!layer) return null;
    const box = layer.getBoundingRect();
    const [, tip] = tail.ends();
    detail.detail.spot = { x: Math.max(0, Math.min(1, (tip.x - box.left) / box.width)), y: Math.max(0, Math.min(1, (tip.y - box.top) / box.height)) };
    return { detail, layer };
  }

  /** While a tail's tip is dragged: the circle magnifies where the tip is now, drawn as it goes. */
  function aimAt(tail: DetailTail): void {
    const at = spotOfTip(tail);
    if (at) liveDetail(at.detail);
  }

  // One live redraw at a time: the latest asked for follows when it's done.
  let liveBusy = false;
  let liveNext: (SceneLayer & { detail: DetailInfo }) | null = null;
  function liveDetail(d: SceneLayer & { detail: DetailInfo }): void {
    if (liveBusy) {
      liveNext = d;
      return;
    }
    liveBusy = true;
    redrawDetail(d)
      .catch(() => {})
      .finally(() => {
        liveBusy = false;
        if (destroyed) return;
        canvas.requestRenderAll();
        const next = liveNext;
        liveNext = null;
        if (next) liveDetail(next);
      });
  }

  /** Whether a part is small enough to draw whole over the ring (a screw, not a panel): no bigger than the circle and a half, magnified. */
  async function fitsRing(d: SceneLayer & { detail: DetailInfo }, scene: SceneData, partId: string): Promise<boolean> {
    const t = await sceneTools();
    const b = await t.partBounds(scene, partId, t.store);
    if (!b) return false;
    const { h } = d.pageSize();
    const pxPerMm = (h / (2 * normalizeScene(d.scene).camera.size)) * 1;
    return b.radius * pxPerMm <= ringRadius(d) * 1.5;
  }

  /** A tail's tip was dragged: the circle magnifies the spot it now touches, and a small part there is drawn whole. */
  async function tailMoved(tail: DetailTail): Promise<void> {
    const at = spotOfTip(tail);
    if (!at) return;
    const { detail, layer } = at;
    const spot = detail.detail.spot!;
    const box = layer.getBoundingRect();
    try {
      const t = await sceneTools();
      const scene = layer.scene ? normalizeScene(layer.scene) : null;
      if (scene) {
        const under = await t.partAt(scene, spot, t.store, box.width / box.height);
        detail.detail.part = undefined;
        await redrawDetail(detail);
        if (under && (await fitsRing(detail, scene, under))) {
          detail.detail.part = under;
          await redrawDetail(detail);
        }
      }
      if (destroyed) return;
      renderContext();
      changed();
      // The picture's outline opens round the new spot.
      await redrawScene(layer, true);
    } catch {
      aimTail(detail, tail);
    }
  }

  /** Draws a detail circle again from its picture's scene: its spot, zoom and size set the camera. */
  async function redrawDetail(d: SceneLayer & { detail: DetailInfo }): Promise<void> {
    const layer = sourceOf(d);
    const scene = layer?.scene ? normalizeScene(layer.scene) : null;
    if (!layer || !scene) return;
    const t = await sceneTools();
    if (!d.detail.spot && d.detail.part) d.detail.spot = (await spotOf(layer, d.detail.part)) || undefined;
    const spot = d.detail.spot || { x: 0.5, y: 0.5 };
    const box = layer.getBoundingRect();
    const { w, h } = d.pageSize();
    const camera = t.magnifiedCamera(scene.camera, spot, zoomOf(d), { w: box.width, h: box.height }, { w, h });
    const scale = sceneScale(w, h);
    const next = { ...scene, camera };
    const picture = await drawLayer(d, next, Math.round(w), Math.round(h), scale);
    if (destroyed || !canvas.contains(d)) return;
    await setScenePicture(d, next, picture, scale, w, h);
    aimTail(d);
  }

  /** Draws a scene's detail circles again from it, and aims their tails; a circle whose picture or part is gone goes too. */
  async function followDetails(layer: SceneLayer): Promise<void> {
    for (const d of detailsOf(layer)) {
      const scene = layer.scene ? normalizeScene(layer.scene) : null;
      const tail = tailOf(d);
      const part = d.detail.part ? scene?.parts.find(p => p.id === d.detail.part && !p.hidden) : null;
      if (!scene || (d.detail.part && !part)) {
        canvas.remove(d);
        if (tail) canvas.remove(tail);
        continue;
      }
      if (!tail) {
        // A circle from before tails: its old straight line goes, a tail comes.
        objects().filter(o => !isTail(o) && (o as Owned & { detailOf?: string }).detailOf === idOf(d)).forEach(o => canvas.remove(o));
        const made = new DetailTail([0, 0, 0, 0], { stroke: INK, strokeWidth: ringWidth(), fill: "" });
        Object.assign(made, { name: `Tail to ${part?.name || "the spot"}`, detailOf: idOf(d) });
        prepare(made);
        canvas.add(made);
      }
      try {
        await redrawDetail(d);
      } catch {
        // Its models can't be loaded here: it keeps its picture.
      }
    }
  }

  /**
   * The project's parts list, as the first page of a flat-pack sheet: every
   * kind of part drawn at one scale with its name and count, and the
   * fixings (small parts) together in a box at the bottom, each with its
   * count. From the project's model, or the first 3D scene's parts.
   */
  async function partsInventory(): Promise<void> {
    const model = await getProjectModel();
    const first = objects().find((o): o is SceneLayer => isScene(o) && !isDetail(o) && !!o.scene?.parts.length);
    const parts = model?.parts.length ? model.parts : first?.scene ? normalizeScene(first.scene).parts : [];
    const style = first?.scene ? normalizeScene(first.scene).style : blankScene().style;
    const direction = first?.scene ? normalizeScene(first.scene).camera.direction : blankScene().camera.direction;
    if (!parts.length) return status("No parts yet: add a 3D scene with the project's parts first, then the parts list.", true);
    status("Drawing the parts…", false, true);
    try {
      const t = await sceneTools();
      const thumbnailer = new t.Thumbnailer();
      const made: FabricObject[] = [];
      try {
        const kinds = [];
        for (const g of inventoryOf(parts)) {
          const m = await t.store.get(g.part);
          if (destroyed) return;
          kinds.push({ ...g, size: m.size, radius: Math.hypot(...m.size) / 2, model: m });
        }
        const big = kinds.filter(k => !isFastener(k.size));
        const small = kinds.filter(k => isFastener(k.size));
        const maxR = Math.max(1, ...big.map(k => k.radius));
        const margin = Math.round(W * 0.05);
        const labelPx = Math.round(Math.min(W, H) * 0.032);
        let y = margin;
        made.push(tbox("Parts", { left: margin, top: y, width: W * 0.4, fontSize: Math.round(Math.min(W, H) * 0.07), fontWeight: "800" }));
        y += Math.round(Math.min(W, H) * 0.11);
        // The big parts in a grid, each drawn to the same scale (the biggest fills its cell).
        const cols = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(big.length))));
        const cell = Math.floor((W - margin * 2) / cols);
        const boxH = small.length ? Math.round(H * 0.22) : 0;
        const rows = Math.max(1, Math.ceil(big.length / cols));
        const cellH = Math.max(labelPx * 3, Math.floor((H - y - margin - boxH - (small.length ? margin : 0)) / rows));
        const pic = Math.max(16, Math.min(cell, cellH - labelPx * 2.6) - margin / 2);
        for (let i = 0; i < big.length; i++) {
          const k = big[i];
          const x = margin + (i % cols) * cell;
          const top = y + Math.floor(i / cols) * cellH;
          const px = Math.max(pic * 0.3, pic * (k.radius / maxR));
          const img = await FabricImage.fromURL(thumbnailer.draw(k.model, style, direction, Math.round(px * 2)));
          img.scaleToWidth(px);
          img.set({ left: x + (cell - px) / 2, top: top + (pic - px) / 2 });
          Object.assign(img, { name: k.part.name || "Part", layerId: newId() });
          made.push(img, tbox(`${k.count}x ${k.part.name || "part"}`, { left: x, top: top + pic + labelPx * 0.4, width: cell, fontSize: labelPx, fontWeight: "600", textAlign: "center" }));
        }
        if (small.length) {
          // The fixings together in a box, each at a size that shows it, with its count.
          const top = H - margin - boxH;
          made.push(named(new Rect({ left: margin, top, width: W - margin * 2, height: boxH, rx: 24, ry: 24, fill: "#ffffff", stroke: INK, strokeWidth: Math.max(3, Math.round(Math.min(W, H) * 0.005)), strokeUniform: true }), "Fixings"));
          const perRow = Math.min(small.length, 6);
          const slot = Math.floor((W - margin * 2) / perRow);
          const px = Math.max(16, Math.min(boxH - labelPx * 2.4, slot * 0.6));
          for (const [i, k] of small.slice(0, 12).entries()) {
            const x = margin + (i % perRow) * slot + (slot - px) / 2;
            const yy = top + margin * 0.4 + Math.floor(i / perRow) * (px + labelPx * 1.6);
            const img = await FabricImage.fromURL(thumbnailer.draw(k.model, style, direction, Math.round(px * 2)));
            if (destroyed) return;
            img.scaleToWidth(px);
            img.set({ left: x, top: yy });
            Object.assign(img, { name: k.part.name || "Fixing", layerId: newId() });
            made.push(img, tbox(`${k.count}x`, { left: x - px * 0.5, top: yy + px + labelPx * 0.2, width: px * 2, fontSize: labelPx, fontWeight: "700", textAlign: "center" }));
          }
        }
      } finally {
        thumbnailer.dispose();
      }
      if (destroyed) return;
      made.forEach(o => {
        prepare(o);
        canvas.add(o);
      });
      selectAll(made);
      canvas.requestRenderAll();
      status(`${parts.length} parts listed.`);
      changed();
    } catch (e) {
      status(e instanceof Error && e.message ? `The parts couldn't be drawn: ${e.message}` : "The parts couldn't be drawn.", true);
    }
  }
  /** The screw inventory's layers: each carries `inventory`, with the model's stamp it was drawn from. */
  type Inventory = { kind: "screws"; stamp?: number };
  const inventoryOfObject = (o: FabricObject) => (o as FabricObject & { inventory?: Inventory }).inventory;
  const inventoryLayers = () => objects().filter(o => inventoryOfObject(o)?.kind === "screws");
  /** The inventory drawn from an older version of the project's model: its layers, or none. */
  const staleInventory = () => {
    const list = inventoryLayers();
    const at = list.map(o => inventoryOfObject(o)?.stamp).find(s => typeof s === "number");
    return projectModel && typeof at === "number" && at < projectModel.stamp ? list : [];
  };

  /**
   * The screw inventory, as at the back of a flat-pack booklet: every kind
   * of screw and heat-set insert the project's 3D scenes use, drawn at one
   * scale in a box each, with its count, size and head, and a 10 mm bar to
   * hold them against. From the project's model, or the first 3D scene's
   * parts. An inventory already on the page is drawn again in its place.
   */
  async function screwInventory(quiet = false): Promise<boolean> {
    const model = await getProjectModel();
    const first = objects().find((o): o is SceneLayer => isScene(o) && !isDetail(o) && !!o.scene?.parts.length);
    const parts = model?.parts.length ? model.parts : first?.scene ? normalizeScene(first.scene).parts : [];
    const kinds = screwInventoryOf(parts);
    if (!kinds.length) {
      if (!quiet) status("No screws yet: put them in with the Screw tool (S) in a 3D scene, then add the screw inventory.", true);
      return false;
    }
    const style = first?.scene ? normalizeScene(first.scene).style : blankScene().style;
    // From a little above and to the front: the screw stands head up, its head's top in sight.
    const direction: [number, number, number] = [1, -1.4, 0.5];
    const mark: Inventory = { kind: "screws", ...(model ? { stamp: model.stamp } : {}) };
    status("Drawing the screws…", false, true);
    let fitTo = 0;
    try {
      const t = await sceneTools();
      const thumbnailer = new t.Thumbnailer();
      const made: FabricObject[] = [];
      try {
        const drawn = [];
        for (const k of kinds) {
          const m = await t.store.get(k.part);
          if (destroyed) return false;
          drawn.push({ ...k, model: m, span: thumbnailer.spanOf(m, style, direction) });
        }
        const unit = Math.min(W, H);
        const margin = Math.round(W * 0.05);
        const labelPx = Math.max(12, Math.round(unit * 0.03));
        const inserts = kinds.some(k => k.screw.head === "insert");
        const screws = kinds.some(k => k.screw.head !== "insert");
        const title = screws && inserts ? "Screws and inserts" : inserts ? "Heat-set inserts" : "Screws";
        made.push(tbox(title, { left: margin, top: margin, width: W - margin * 2, fontSize: Math.round(unit * 0.07), fontWeight: "800" }));
        const top = margin + Math.round(unit * 0.12);
        const bottom = H - margin - labelPx * 2.2;
        const availW = W - margin * 2;
        const availH = Math.max(labelPx * 6, bottom - top);
        // As many columns as keep the boxes near square.
        let cols = 1;
        let best = Infinity;
        for (let c = 1; c <= Math.min(6, drawn.length); c++) {
          const r = Math.ceil(drawn.length / c);
          const badness = Math.abs(Math.log(availW / c / (availH / r)));
          if (badness < best) {
            best = badness;
            cols = c;
          }
        }
        const rows = Math.ceil(drawn.length / cols);
        const gap = Math.round(unit * 0.025);
        const cellW = (availW - gap * (cols - 1)) / cols;
        const cellH = Math.min((availH - gap * (rows - 1)) / rows, cellW * 1.25);
        const textH = labelPx * 3.4;
        const pad = Math.round(Math.min(cellW, cellH) * 0.08);
        const picBox = Math.max(16, Math.min(cellW - pad * 2, cellH - textH - pad * 2));
        // One scale for every screw: the longest fills its box.
        const pxPerMm = picBox / Math.max(1, ...drawn.map(d => d.span));
        const stroke = Math.max(3, Math.round(unit * 0.005));
        for (const [i, k] of drawn.entries()) {
          const x = margin + (i % cols) * (cellW + gap);
          const y = top + Math.floor(i / cols) * (cellH + gap);
          const name = SCREW_HEADS.find(h => h.id === k.screw.head)?.label || "Screw";
          made.push(named(new Rect({ left: x, top: y, width: cellW, height: cellH, rx: 18, ry: 18, fill: "#ffffff", stroke: INK, strokeWidth: stroke, strokeUniform: true }), `${name} box`));
          const pic = thumbnailer.drawAt(k.model, style, direction, pxPerMm);
          const img = await FabricImage.fromURL(pic.url);
          if (destroyed) return false;
          img.scaleToWidth(pic.px);
          const picTop = y + pad;
          // Standing on the count, as in a LEGO parts box.
          img.set({ left: x + (cellW - pic.px) / 2, top: picTop + picBox - pic.px });
          Object.assign(img, { name: `M${k.screw.d} × ${k.screw.length} ${name.toLowerCase()}`, layerId: newId() });
          const textTop = y + cellH - textH - pad * 0.5;
          made.push(
            img,
            tbox(`${k.count}x`, { left: x, top: textTop, width: cellW, fontSize: Math.round(labelPx * 1.25), fontWeight: "800", textAlign: "center" }),
            tbox(`M${k.screw.d} × ${k.screw.length}`, { left: x, top: textTop + labelPx * 1.45, width: cellW, fontSize: labelPx, fontWeight: "600", textAlign: "center" }),
            tbox(name, { left: x, top: textTop + labelPx * 2.5, width: cellW, fontSize: Math.round(labelPx * 0.8), fill: "#495057", textAlign: "center" }),
          );
        }
        // A 10 mm bar, at the screws' scale.
        const bar = 10 * pxPerMm;
        const gridBottom = top + rows * cellH + (rows - 1) * gap;
        const by = gridBottom + labelPx * 1.6;
        fitTo = by + margin;
        const bx = W - margin - bar;
        const tick = labelPx * 0.5;
        made.push(
          named(new Polyline([{ x: bx, y: by - tick }, { x: bx, y: by }, { x: bx + bar, y: by }, { x: bx + bar, y: by - tick }], { fill: "", stroke: INK, strokeWidth: stroke, strokeUniform: true, objectCaching: false }), "10 mm bar"),
          tbox("10 mm", { left: bx - labelPx * 6, top: by - labelPx * 1.15, width: labelPx * 5.6, fontSize: Math.round(labelPx * 0.8), fill: "#495057", textAlign: "right" }),
        );
      } finally {
        thumbnailer.dispose();
      }
      if (destroyed) return false;
      // Drawn again in place of the old one.
      const old = inventoryLayers();
      if (old.length) canvas.remove(...old);
      // A page of its own ends below the list, rather than with a blank half.
      if (!objects().length && fitTo && fitTo < H - 1) resizePage(W, Math.round(fitTo));
      made.forEach(o => {
        Object.assign(o, { inventory: { ...mark } });
        prepare(o);
        canvas.add(o);
      });
      if (!quiet) selectAll(made);
      canvas.requestRenderAll();
      const n = kinds.reduce((a, k) => a + k.count, 0);
      status(`${kinds.length} ${kinds.length === 1 ? "kind" : "kinds"} of screw listed, ${n} in all.`);
      changed();
      return true;
    } catch (e) {
      status(e instanceof Error && e.message ? `The screws couldn't be drawn: ${e.message}` : "The screws couldn't be drawn.", true);
      return false;
    }
  }

  const tbox = (text: string, o: Record<string, unknown>) => {
    const t = new Textbox(text, { fontFamily: FONTS[0][1], fill: INK, ...o });
    Object.assign(t, { name: text, layerId: newId() });
    return t;
  };
  const named = <T extends FabricObject>(o: T, name: string): T => Object.assign(o, { name, layerId: newId() });

  /**
   * The assembly guide, as a flat-pack booklet, from the project's model:
   * a cover with the finished assembly, a "Before you start" page of tips
   * and tools, the parts list, then one step per part (the first fits the
   * second part onto the first), each with its fixings, the parts of
   * earlier steps as ghosts, the new ones highlighted and drawn apart along
   * their joints with arrows, a parts strip and a pinned step number. Every
   * page looks from one camera (the project's chosen view, if any), framed
   * round the whole assembly. Each finished page goes to `guide.each`.
   */
  async function assemblyGuide(guide: GuideOptions): Promise<number> {
    const model = await getProjectModel();
    if (!model?.parts.length) throw new Error("No project model yet: add a 3D scene with the project's parts first.");
    const [t, g, b] = await Promise.all([sceneTools(), import("./scene/guide"), import("./scene/buildSteps")]);
    const sizes = new Map<string, [number, number, number]>();
    for (const p of model.parts) {
      try {
        sizes.set(p.id, (await t.store.get(p)).size);
      } catch {
        // A part whose model can't be read counts as a part, not a fixing.
      }
      if (destroyed) return 0;
    }
    const fixing = (p: { id: string }) => {
      const s = sizes.get(p.id);
      return !!s && isFastener(s);
    };
    // The steps picked by hand in the 3D scene's Steps mode, or, with none, one per part from the joint tree.
    const steps: import("./scene/buildSteps").PlannedStep[] = model.steps?.some(s => s.parts.length) ? b.planSteps(model, fixing) : g.guideSteps(model, fixing);
    if (!steps.length) throw new Error("Every part in the model is a fixing (12 mm or less across): nothing to fit.");
    const PAGE = SIZES.find(s => s.id === "photo") || SIZES[0];
    const SCENE = { left: 0.3, top: 0.06, width: 0.66, height: 0.88 };
    const COVER = { left: 0.1, top: 0.2, width: 0.8, height: 0.76 };
    // One camera for every page: the project's chosen view, framed round every step as drawn.
    const style = { ...blankScene().style, draftSolid: true };
    const view = model.defaultView ? model.views?.find(v => v.id === model.defaultView) : undefined;
    const base = view ? view.camera : blankScene().camera;
    const scenes = [g.coverScene(model, base, style), ...steps.map(s => g.stepScene(model, steps, s.n, base, style))];
    const camera = await t.frameAll(base, scenes.slice(1), t.store, (PAGE.width * SCENE.width) / (PAGE.height * SCENE.height));
    // The cover fills its space with the finished assembly alone.
    scenes[0].camera = await t.frameAll(base, [scenes[0]], t.store, (PAGE.width * COVER.width) / (PAGE.height * COVER.height), 1.1);
    for (const s of scenes) {
      if (s !== scenes[0]) s.camera = structuredClone(camera);
      s.model = { stamp: model.stamp };
    }
    // A step drawn from a view of its own is framed round itself.
    for (const step of steps) {
      const own = step.view ? model.views?.find(v => v.id === step.view) : undefined;
      if (own) scenes[step.n].camera = await t.frameAll(own.camera, [scenes[step.n]], t.store, (PAGE.width * SCENE.width) / (PAGE.height * SCENE.height));
    }
    const total = steps.length + 3;
    let made = 0;
    const text = (s: string, o: Record<string, unknown>) => tbox(s, { fontFamily: FONTS[0][1], ...o });
    const symbol = (kind: string, height: number, left: number, top: number, name?: string, maxWidth = height * 1.3) => {
      const o = makeShape(kind, { x: 0, y: 0 }, INK)!;
      o.scaleToHeight(height);
      // A wide symbol (two people, a screwdriver) fits the box too.
      if (o.getBoundingRect().width > maxWidth) o.scaleToWidth(maxWidth);
      o.set({ left, top });
      if (name) Object.assign(o, { name });
      return o;
    };
    const page = async (title: string, bg: string, fill: () => Promise<void>) => {
      if (destroyed) throw new Error("The editor was closed.");
      canvas.discardActiveObject();
      canvas.remove(...objects());
      background = bg;
      titleInput.value = title;
      resizePage(PAGE.width, PAGE.height);
      await fill();
      if (destroyed) throw new Error("The editor was closed.");
      canvas.discardActiveObject();
      canvas.requestRenderAll();
      const result = await exportResult();
      await guide.each(result, made, total);
      made++;
    };
    const place = async (scene: SceneData, box: { left: number; top: number; width: number; height: number }) => {
      const w = Math.round(W * box.width);
      const h = Math.round(H * box.height);
      const layer = new SceneLayer(placeholderPicture(w, h), { name: "3D scene" } as Partial<SceneLayer>);
      layer.scene = scene;
      layer.pictureScale = 1;
      await layer.setSrc(placeholderPicture(w, h).toDataURL("image/png"));
      prepare(layer);
      layer.set({ left: W * box.left, top: H * box.top });
      layer.setCoords();
      canvas.add(layer);
      await updateScenes([layer]);
      return layer;
    };
    const addAll = (list: FabricObject[]) =>
      list.forEach(o => {
        prepare(o);
        canvas.add(o);
      });
    const name = (guide.title || "").trim();
    const unit = Math.min(PAGE.width, PAGE.height);

    // The cover: the finished assembly, with the project's name.
    await page(name ? `${name}: assembly guide` : "Assembly guide", "#ffffff", async () => {
      addAll([
        text(name || "Assembly guide", { left: W * 0.06, top: H * 0.06, width: W * 0.7, fontSize: Math.round(unit * 0.08), fontWeight: "800" }),
        text(name ? `Assembly guide · ${steps.length} ${steps.length === 1 ? "step" : "steps"}` : `${steps.length} ${steps.length === 1 ? "step" : "steps"}`, { left: W * 0.06, top: H * 0.06 + unit * 0.11, width: W * 0.6, fontSize: Math.round(unit * 0.035), fill: "#495057" }),
        symbol("figure", unit * 0.16, W * 0.84, H * 0.05, "Assembly figure"),
      ]);
      await place(scenes[0], COVER);
    });

    // Before you start: a few tips with their symbols, and a row of tools (to edit to match the build).
    await page("Before you start", "#ffffff", async () => {
      const tips: [string, string][] = [
        ["figure", "Lay out every part and check it against the parts list on the next page."],
        ["careful", "Keep the fixings together in a bowl, so none go missing."],
        ["two-people", "Ask for a second pair of hands for the bigger parts."],
        ["help", "Stuck? Ask for help on the project's page."],
      ];
      const list: FabricObject[] = [text("Before you start", { left: W * 0.06, top: H * 0.06, width: W * 0.8, fontSize: Math.round(unit * 0.07), fontWeight: "800" })];
      const rowH = H * 0.13;
      const top0 = H * 0.2;
      const ico = unit * 0.09;
      tips.forEach(([kind, line], i) => {
        const top = top0 + i * rowH;
        const o = symbol(kind, ico, 0, top, undefined);
        o.set({ left: W * 0.06 + (ico * 1.3 - o.getBoundingRect().width) / 2 });
        list.push(o, text(line, { left: W * 0.06 + unit * 0.16, top: top + ico * 0.2, width: W * 0.7, fontSize: Math.round(unit * 0.034), fill: "#1f2328" }));
      });
      const toolsTop = top0 + tips.length * rowH + H * 0.03;
      list.push(text("You will need", { left: W * 0.06, top: toolsTop, width: W * 0.4, fontSize: Math.round(unit * 0.04), fontWeight: "700" }));
      let x = W * 0.06;
      for (const [kind, label] of [["screwdriver", "Screwdriver"], ["allen-key", "Allen key"], ["pliers", "Pliers"]] as [string, string][]) {
        const o = symbol(kind, unit * 0.1, 0, 0, label, unit * 0.3);
        const b = o.getBoundingRect();
        o.set({ left: x, top: toolsTop + unit * 0.06 + (unit * 0.1 - b.height) / 2 });
        list.push(o);
        x += Math.max(b.width, unit * 0.12) + unit * 0.05;
      }
      addAll(list);
    });

    // The parts list, as the template draws it.
    await page("Parts", "#ffffff", () => partsInventory());

    // One page per step.
    for (const step of steps) {
      await page(step.title ? `Step ${step.n}: ${step.title}` : `Step ${step.n}`, "#ececec", async () => {
        const floor = new Polygon([{ x: 0, y: H * 0.55 }, { x: W, y: H * 0.38 }, { x: W, y: H }, { x: 0, y: H }], { fill: "#d6d6d6", strokeWidth: 0, objectCaching: false });
        Object.assign(floor, { name: "Floor", layerId: newId() });
        const b = badge(step.n, { x: W * 0.05, y: H * 0.06 }, STEP_RED);
        Object.assign(b, { badgePinned: true });
        // No words on a step, as on a flat-pack sheet: the number, the parts box and the picture say it.
        addAll([floor, b]);
        const layer = await place(scenes[step.n], SCENE);
        if (destroyed) return;
        await partsStrip(layer, true);
      });
    }
    status(`Assembly guide: ${made} pages.`);
    return made;
  }

  /** After a scene is drawn again: its parts strip and detail circles follow, and the turn mark comes or goes. */
  async function followScene(layer: SceneLayer, firstDone = false): Promise<void> {
    if (destroyed || !canvas.contains(layer) || isDetail(layer)) return;
    turnMark(layer);
    await followDetails(layer);
    const has = ownedBy("partsStrip", layer).length > 0;
    // An assembly step (one with a step number) lists its parts by itself the first time its scene is drawn.
    if (has || (firstDone && badges().length && layer.scene && partsInStep(normalizeScene(layer.scene)).length)) await partsStrip(layer, true);
  }

  /** A new graphic that starts from a picture: the page takes its shape and the picture fills it. */
  async function startFromPicture(source: Blob | string): Promise<void> {
    status("Opening the picture…", false, true);
    try {
      const blob = typeof source === "string" ? await fetchImage(source) : source;
      const data = await pictureData(blob);
      const long = Math.max(data.width, data.height);
      const scale = long > 1600 ? 1600 / long : long < 800 ? 800 / long : 1;
      W = clampSide(data.width * scale);
      H = clampSide(data.height * scale);
      const img = await FabricImage.fromURL(data.url);
      // Locked, so drawing over it doesn't move it; the Layers panel unlocks it.
      img.set({ left: 0, top: 0, scaleX: W / data.width, scaleY: H / data.height, name: "Picture", layerLocked: true } as Partial<FabricImage>);
      prepare(img);
      restoring = true;
      canvas.add(img);
      restoring = false;
      fit();
      status("");
    } catch {
      status("That picture couldn't be opened, so this is a blank page.", true);
    }
  }

  // ------------------------------------------------------------ arranging

  function removeSelected(): void {
    const sel = selected().filter(o => !locked(o));
    if (!sel.length) return;
    canvas.discardActiveObject();
    // A shape takes its text with it; lines fastened to it stay where they are.
    const gone = new Set(sel);
    sel.forEach(o => {
      const t = textFor(o);
      if (t) gone.add(t);
    });
    const ids = new Set([...gone].map(idOf));
    for (const o of objects()) {
      if (!(o instanceof Connector)) continue;
      if (o.connFrom && ids.has(o.connFrom.id)) o.connFrom = null;
      if (o.connTo && ids.has(o.connTo.id)) o.connTo = null;
    }
    gone.forEach(o => canvas.remove(o));
    canvas.requestRenderAll();
  }

  let clipboard: FabricObject[] = [];
  async function cloneAll(list: FabricObject[], offset: number): Promise<FabricObject[]> {
    // Shapes bring their text. Copied lines stay fastened only to copied layers.
    const all = [...list];
    for (const o of list) {
      const t = canvas.contains(o) ? textFor(o) : undefined;
      if (t && !all.includes(t)) all.push(t);
    }
    const out: FabricObject[] = [];
    const ids = new Map<string, string>();
    for (const o of all) {
      const c = await o.clone();
      c.set({ left: (c.left || 0) + offset, top: (c.top || 0) + offset });
      const id = newId();
      ids.set(idOf(o), id);
      (c as FabricObject & { layerId?: string }).layerId = id;
      (c as FabricObject & { layerLocked?: boolean }).layerLocked = false;
      out.push(c);
    }
    const remap = (end: ConnectorEnd | null | undefined) => (end && ids.has(end.id) ? { id: ids.get(end.id)!, side: end.side } : null);
    for (const c of out) {
      if (c instanceof Connector) {
        c.connFrom = remap(c.connFrom);
        c.connTo = remap(c.connTo);
      }
      const b = c as FabricObject & { boundTo?: string };
      if (b.boundTo) b.boundTo = ids.get(b.boundTo) || undefined;
    }
    return out;
  }
  function selectAll(list: FabricObject[]): void {
    list = list.filter(o => !boundTo(o));
    canvas.discardActiveObject();
    if (list.length === 1) canvas.setActiveObject(list[0]);
    else if (list.length) canvas.setActiveObject(new ActiveSelection(list, { canvas }));
    canvas.requestRenderAll();
  }
  function plain(): FabricObject[] {
    // The selection's objects with their own page positions (not relative to the selection box).
    const list = selected();
    canvas.discardActiveObject();
    return list;
  }
  async function duplicate(): Promise<void> {
    const list = plain();
    if (!list.length) return;
    const copies = await cloneAll(list, 24);
    copies.forEach(c => {
      prepare(c);
      canvas.add(c);
    });
    selectAll(copies);
  }
  async function copy(): Promise<void> {
    const list = plain();
    if (!list.length) return;
    clipboard = await cloneAll(list, 0);
    selectAll(list);
  }
  async function paste(): Promise<void> {
    if (!clipboard.length) return;
    const copies = await cloneAll(clipboard, 24);
    clipboard = await cloneAll(clipboard, 24);
    copies.forEach(c => {
      prepare(c);
      canvas.add(c);
    });
    selectAll(copies);
  }

  function toggleLock(o?: FabricObject): void {
    const list = o ? [o] : selected();
    if (!list.length) return;
    const lock = !list.every(locked);
    if (!o) canvas.discardActiveObject();
    list.forEach(x => {
      (x as FabricObject & { layerLocked?: boolean }).layerLocked = lock;
      prepare(x);
    });
    if (!o && !lock) selectAll(list);
    canvas.requestRenderAll();
    changed();
    renderContext();
  }

  function toggleHidden(o: FabricObject): void {
    o.visible = o.visible === false;
    if (!o.visible && selected().includes(o)) canvas.discardActiveObject();
    prepare(o);
    canvas.requestRenderAll();
    changed();
  }

  function restack(how: "forward" | "backward" | "front" | "back"): void {
    const o = active();
    if (!o) return;
    if (how === "forward") canvas.bringObjectForward(o, true);
    if (how === "backward") canvas.sendObjectBackwards(o, true);
    if (how === "front") canvas.bringObjectToFront(o);
    if (how === "back") canvas.sendObjectToBack(o);
    canvas.requestRenderAll();
    changed();
  }

  function alignToPage(where: string): void {
    const o = active();
    if (!o) return;
    const b = o.getBoundingRect();
    let dx = 0;
    let dy = 0;
    if (where === "left") dx = -b.left;
    if (where === "center") dx = (W - b.width) / 2 - b.left;
    if (where === "right") dx = W - b.width - b.left;
    if (where === "top") dy = -b.top;
    if (where === "middle") dy = (H - b.height) / 2 - b.top;
    if (where === "bottom") dy = H - b.height - b.top;
    o.set({ left: (o.left || 0) + dx, top: (o.top || 0) + dy });
    o.setCoords();
    canvas.requestRenderAll();
    canvas.fire("object:modified", { target: o });
  }

  /**
   * The selected things that line up with each other. A line fastened to a
   * shape isn't one of them (it follows its shapes), nor is a shape's text
   * or anything locked.
   */
  function lineUpTargets(): FabricObject[] {
    return selected().filter(o => !locked(o) && !boundTo(o) && !(o instanceof Connector && (o.connFrom || o.connTo)));
  }
  /** Lines the selected things up with each other, or spaces them out evenly; fastened lines follow. */
  function lineUp(how: AlignHow | DistributeHow): void {
    const list = lineUpTargets();
    const spread = how === "horizontal" || how === "vertical";
    if (list.length < (spread ? 3 : 2)) return;
    const all = [...selected()];
    // Out of the selection box, so each one's position is its own place on the page.
    canvas.discardActiveObject();
    const boxes = list.map(o => o.getBoundingRect());
    const moves = spread ? distributeBoxes(boxes, how) : alignBoxes(boxes, how);
    list.forEach((o, i) => {
      const { dx, dy } = moves[i];
      if (!dx && !dy) return;
      o.set({ left: (o.left || 0) + dx, top: (o.top || 0) + dy });
      o.setCoords();
    });
    follow();
    selectAll(all);
    const now = active();
    if (now) canvas.fire("object:modified", { target: now });
  }

  function group(): void {
    const list = [...selected()];
    if (list.length < 2) return;
    for (const o of selected()) {
      const t = textFor(o);
      if (t && !list.includes(t)) list.push(t);
    }
    canvas.discardActiveObject();
    list.forEach(o => canvas.remove(o));
    const g = new Group(list);
    (g as Group & { name?: string }).name = "Group";
    prepare(g);
    canvas.add(g);
    canvas.setActiveObject(g);
    canvas.requestRenderAll();
  }
  function ungroup(): void {
    const g = active();
    if (!(g instanceof Group) || g instanceof ActiveSelection) return;
    canvas.discardActiveObject();
    const index = objects().indexOf(g);
    const items = g.removeAll();
    canvas.remove(g);
    items.forEach((o, i) => {
      prepare(o);
      canvas.insertAt(index + i, o);
    });
    selectAll(items);
  }

  function nudge(dx: number, dy: number): void {
    const o = active();
    if (!o || locked(o)) return;
    o.set({ left: (o.left || 0) + dx, top: (o.top || 0) + dy });
    o.setCoords();
    canvas.requestRenderAll();
    canvas.fire("object:modified", { target: o });
  }

  // ------------------------------------------------------------ snapping guides

  let guides: Guide[] = [];
  canvas.on("object:moving", e => {
    floatBar.hidden = true;
    const t = e.target;
    const ev = e.e as MouseEvent;
    if (!t || ev?.altKey || isTail(t)) {
      guides = [];
      return;
    }
    const others: Box[] = objects()
      .filter(o => o !== t && o.visible !== false && !(t instanceof ActiveSelection && t.contains(o)) && !(o instanceof Connector) && !boundTo(o))
      .map(o => o.getBoundingRect());
    const r = snap(t.getBoundingRect(), { left: 0, top: 0, width: W, height: H }, others, 7 / zoom);
    if (r.dx || r.dy) {
      t.set({ left: (t.left || 0) + r.dx, top: (t.top || 0) + r.dy });
      t.setCoords();
    }
    guides = r.guides;
  });
  // Lines and shape text keep up while things move. Moving a line itself unfastens it.
  // A tail dragged by its body: the tip goes with the pointer, the start stays on the circle.
  let tailGrab: { tail: DetailTail; off: Point } | null = null;
  function dragTail(tail: DetailTail, e: { e: Event }): void {
    if (!(e.e instanceof MouseEvent || e.e instanceof PointerEvent || e.e instanceof TouchEvent)) return;
    const p = canvas.getScenePoint(e.e);
    if (tailGrab?.tail !== tail) {
      // The first move: the tip has gone with the pointer so far, so where it was is the tip less that.
      const [, tip] = tail.ends();
      tailGrab = { tail, off: new Point(tip.x - p.x, tip.y - p.y) };
    }
    const d = byId(tail.detailOf || "");
    const c = d && isDetail(d) ? d.getCenterPoint() : tail.ends()[0];
    tail.setEnds(c, { x: p.x + tailGrab.off.x, y: p.y + tailGrab.off.y });
    aimAt(tail);
  }
  canvas.on("mouse:up", () => {
    tailGrab = null;
  });
  canvas.on("object:moving", e => {
    if (isTail(e.target)) dragTail(e.target, e);
    else if (e.target instanceof Connector) {
      e.target.connFrom = null;
      e.target.connTo = null;
    }
    follow();
  });
  for (const ev of ["object:scaling", "object:rotating", "object:resizing", "object:skewing"] as const) canvas.on(ev, () => follow());

  // A box keeps its corner size while it's stretched: the stretch goes into its width and height.
  let stretching: { o: Rect; r: number } | null = null;
  canvas.on("object:scaling", e => {
    const o = e.target;
    if (!(o instanceof Rect) || o.group) return;
    if (stretching?.o !== o) {
      const t = e.transform?.original;
      const sx = Math.abs(t?.scaleX ?? 1);
      const sy = Math.abs(t?.scaleY ?? 1);
      stretching = { o, r: Math.min((Number(o.rx) || 0) * sx, (Number(o.ry) || 0) * sy) };
    }
    const r = stretching.r;
    o.set({ rx: r / Math.abs(o.scaleX || 1), ry: r / Math.abs(o.scaleY || 1) });
  });
  canvas.on("object:modified", e => {
    const o = e.target;
    if (isTail(o)) void tailMoved(o);
    if (isDetail(o) && !isTail(o)) {
      // Its tail now comes in from elsewhere: the cut in the picture follows.
      const src = sourceOf(o);
      if (src) void redrawScene(src, true);
    }
    if (stretching && o === stretching.o) {
      bakeScale(o as Rect, stretching.r);
      stretching = null;
    }
    syncSizeFields();
  });

  /** Puts a box's stretch into its width and height, so its corners and the size fields read true. */
  function bakeScale(o: Rect, r: number): void {
    const sx = o.scaleX || 1;
    const sy = o.scaleY || 1;
    if (sx === 1 && sy === 1) return;
    const centre = o.getCenterPoint();
    o.set({ width: (o.width || 0) * Math.abs(sx), height: (o.height || 0) * Math.abs(sy), scaleX: 1, scaleY: 1, rx: r, ry: r, flipX: sx < 0 !== !!o.flipX, flipY: sy < 0 !== !!o.flipY });
    o.setPositionByOrigin(centre, "center", "center");
    o.setCoords();
    canvas.requestRenderAll();
  }
  canvas.on("after:render", ({ ctx }) => {
    // Fabric also fires this for its top layer, which isn't cleared on every redraw: drawing there left old handles behind.
    if (!ctx || ctx !== canvas.getContext()) return;
    drawStale(ctx);
    drawConnectHints(ctx);
    drawTarget(ctx);
    if (!guides.length) return;
    const r = canvas.getRetinaScaling();
    ctx.save();
    ctx.setTransform(r * zoom, 0, 0, r * zoom, 0, 0);
    ctx.strokeStyle = "#ff3d8b";
    ctx.lineWidth = 1 / zoom;
    ctx.setLineDash([4 / zoom, 3 / zoom]);
    ctx.beginPath();
    for (const g of guides) {
      if (g.axis === "x") {
        ctx.moveTo(g.at, g.from);
        ctx.lineTo(g.at, g.to);
      } else {
        ctx.moveTo(g.from, g.at);
        ctx.lineTo(g.to, g.at);
      }
    }
    ctx.stroke();
    ctx.restore();
  });
  /** A faint circle at a selected tail's tip: the spot its circle magnifies, the ring's size over the zoom (only on screen). */
  function drawTarget(ctx: CanvasRenderingContext2D): void {
    const a = active();
    const tail = isTail(a) ? a : isDetail(a) ? tailOf(a) : isTail(hover) ? hover : null;
    if (!tail) return;
    const t = targetOf(tail);
    if (!t) return;
    const r = canvas.getRetinaScaling();
    ctx.save();
    ctx.setTransform(r * zoom, 0, 0, r * zoom, 0, 0);
    ctx.beginPath();
    ctx.arc(t.tip.x, t.tip.y, t.r, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(139, 61, 255, 0.08)";
    ctx.fill();
    ctx.strokeStyle = "rgba(139, 61, 255, 0.7)";
    ctx.lineWidth = 1.5 / zoom;
    ctx.setLineDash([5 / zoom, 4 / zoom]);
    ctx.stroke();
    ctx.restore();
  }

  /** An amber dashed frame and "Out of date" on scene pictures drawn from an older model (only on screen). */
  function drawStale(ctx: CanvasRenderingContext2D): void {
    const boxes: { left: number; top: number; width: number; height: number }[] = (projectModel ? staleScenes() : []).map(o => o.getBoundingRect());
    // The screw inventory as one box round all of it.
    const inv = projectModel ? staleInventory() : [];
    if (inv.length) {
      const rs = inv.map(o => o.getBoundingRect());
      const left = Math.min(...rs.map(r => r.left));
      const top = Math.min(...rs.map(r => r.top));
      boxes.push({ left, top, width: Math.max(...rs.map(r => r.left + r.width)) - left, height: Math.max(...rs.map(r => r.top + r.height)) - top });
    }
    if (!boxes.length) return;
    const r = canvas.getRetinaScaling();
    ctx.save();
    ctx.setTransform(r * zoom, 0, 0, r * zoom, 0, 0);
    const u = 1 / zoom;
    for (const b of boxes) {
      ctx.strokeStyle = "#d97706";
      ctx.lineWidth = 2 * u;
      ctx.setLineDash([8 * u, 5 * u]);
      ctx.strokeRect(b.left, b.top, b.width, b.height);
      ctx.setLineDash([]);
      const label = "Out of date";
      ctx.font = `600 ${12 * u}px system-ui, sans-serif`;
      const w = ctx.measureText(label).width + 16 * u;
      ctx.fillStyle = "#d97706";
      ctx.beginPath();
      ctx.roundRect(b.left + 8 * u, b.top + 8 * u, w, 22 * u, 6 * u);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.textBaseline = "middle";
      ctx.fillText(label, b.left + 16 * u, b.top + 19 * u);
    }
    ctx.restore();
  }

  /** The snap points near a line end being placed, and the + handles of the layer under the pointer. */
  function drawConnectHints(ctx: CanvasRenderingContext2D): void {
    const showHandles = hover && !drawing && !linking && objects().includes(hover) && !canvas._currentTransform;
    if (!linking && !showHandles) return;
    const r = canvas.getRetinaScaling();
    ctx.save();
    ctx.setTransform(r * zoom, 0, 0, r * zoom, 0, 0);
    const u = 1 / zoom;
    if (linking) {
      const near = objects().filter(o => {
        if (linking!.exclude.includes(o) || !connectable(o)) return false;
        const b = o.getBoundingRect();
        const m = 60 * u;
        const p = linking!.pointer;
        return p.x > b.left - m && p.x < b.left + b.width + m && p.y > b.top - m && p.y < b.top + b.height + m;
      });
      for (const o of near) {
        const a = anchorsOf(o);
        for (const side of SIDES) {
          const on = !!linking.hit && dist(linking.hit.at, a[side]) < 0.01;
          ctx.beginPath();
          ctx.arc(a[side].x, a[side].y, (on ? 7 : 5) * u, 0, Math.PI * 2);
          ctx.fillStyle = on ? "#8b3dff" : "#ffffff";
          ctx.strokeStyle = "#8b3dff";
          ctx.lineWidth = 2 * u;
          ctx.fill();
          ctx.stroke();
        }
      }
    }
    if (showHandles) {
      for (const h of handlesOf(hover!)) {
        ctx.beginPath();
        ctx.arc(h.at.x, h.at.y, 9 * u, 0, Math.PI * 2);
        ctx.fillStyle = "#8b3dff";
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(h.at.x - 4.5 * u, h.at.y);
        ctx.lineTo(h.at.x + 4.5 * u, h.at.y);
        ctx.moveTo(h.at.x, h.at.y - 4.5 * u);
        ctx.lineTo(h.at.x, h.at.y + 4.5 * u);
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2 * u;
        ctx.lineCap = "round";
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  canvas.on("mouse:up", () => {
    if (linking) {
      linking = null;
      canvas.requestRenderAll();
    }
    if (guides.length) {
      guides = [];
      canvas.requestRenderAll();
    }
    placeFloat();
  });

  // ------------------------------------------------------------ floating bar

  function placeFloat(): void {
    const o = active();
    if (!o || (o as Textbox).isEditing) {
      floatBar.hidden = true;
      return;
    }
    const b = o.getBoundingRect();
    floatBar.hidden = false;
    const bw = floatBar.offsetWidth || 110;
    let x = (b.left + b.width / 2) * zoom - bw / 2;
    x = Math.max(4, Math.min(W * zoom - bw - 4, x));
    let y = b.top * zoom - 48;
    // Under it when there's no room above (clear of a detail circle's zoom buttons).
    if (y < 4) y = (b.top + b.height) * zoom + (isDetail(o) ? 40 : 12);
    if (y > H * zoom - 40) y = Math.max(4, b.top * zoom + 8);
    floatBar.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    const lockBtn = floatBar.querySelector("[data-act=lock]") as HTMLElement;
    lockBtn.innerHTML = icon(selected().every(locked) ? "unlock" : "lock", 16);
  }
  ["object:scaling", "object:rotating"].forEach(ev => canvas.on(ev as "object:scaling", () => (floatBar.hidden = true)));
  canvas.on("object:modified", () => placeFloat());

  // ------------------------------------------------------------ context toolbar

  const swatch = (prop: string, value: string, label: string, ic = "") =>
    `<button type="button" class="lyr-btn lyr-swatch-btn" data-color="${prop}" title="${esc(label)}" aria-label="${esc(label)}">${ic ? icon(ic, 16) : ""}<span class="lyr-chip${value ? "" : " lyr-chip-none"}" style="background:${esc(value || "transparent")}"></span></button>`;

  function commonTools(o: FabricObject): string {
    return `
      <span class="lyr-grow"></span>
      <button type="button" class="lyr-btn" data-pop="opacity" title="Transparency" aria-label="Transparency">${icon("opacity")}</button>
      <button type="button" class="lyr-btn" data-pop="position" title="Position">${icon("position")}<span>Position</span></button>
      ${o instanceof ActiveSelection ? `<button type="button" class="lyr-btn" data-act="group" title="Group (Ctrl+G)">${icon("group")}<span>Group</span></button>` : ""}
      ${o instanceof Group && !(o instanceof ActiveSelection) && !(o as Group & { badge?: number }).badge ? `<button type="button" class="lyr-btn" data-act="ungroup" title="Ungroup (Ctrl+Shift+G)">${icon("ungroup")}<span>Ungroup</span></button>` : ""}`;
  }

  /** The options of a detail circle (shown for the circle and its tail alike). */
  function detailBar(d: SceneLayer & { detail: DetailInfo }): string {
    const zoom = zoomOf(d);
    const parts = d.scene?.parts.filter(p => !p.hidden) || [];
    return `<label class="lyr-inline" title="How much closer the circle looks than its picture">Zoom <input class="lyr-num" type="number" min="0.5" max="20" step="0.5" data-prop="detailZoom" value="${zoom}" aria-label="Zoom">x</label>
        <label class="lyr-inline" title="How many times this is done, written in a box on the ring (x1, x4…); empty for none">Repeat <input class="lyr-num lyr-num-text" type="text" maxlength="12" data-prop="detailLabel" value="${esc(ringLabel(d))}" placeholder="x1" aria-label="Repeat count on the ring"></label>
        <select class="lyr-select" data-prop="detailLook" aria-label="How the circle is joined to its spot" title="How the circle is joined to its spot: a flared tail, a thin line, or nothing">
          ${TAIL_LOOKS.map(l => `<option value="${l.id}"${(d.detail.look || "tail") === l.id ? " selected" : ""} title="${esc(l.detail)}">${esc(l.label)}</option>`).join("")}
        </select>
        <select class="lyr-select" data-prop="detailPart" aria-label="The part drawn whole over the ring" title="The part drawn whole, poking out of the circle (the one under the tail's tip, unless you pick one)">
          <option value=""${d.detail.part ? "" : " selected"}>No part over the ring</option>
          ${parts.map(p => `<option value="${esc(p.id)}"${p.id === d.detail.part ? " selected" : ""}>${esc(p.name)}</option>`).join("")}
        </select>
        <span class="lyr-hint">Drag the tail to the spot to magnify; drag the faint circle's corner to take in more or less. Stretch or move the circle; the tail follows.</span>`;
  }

  function renderContext(): void {
    const o = active();
    if (!o) {
      contextBar.innerHTML = `
        ${swatch("page", background, "Page colour", "paint")}
        <button type="button" class="lyr-btn" data-act="open-page">${icon("resize")}<span>Resize</span></button>
        ${objects().length ? `<button type="button" class="lyr-btn" data-act="fit-contents" title="Shrink or grow the page to just fit what's on it">${icon("crop")}<span>Fit to contents</span></button>` : ""}
        <span class="lyr-hint">${objects().length ? "Click something on the page to change it." : "Add text, shapes or pictures from the left, or drop a picture on the page."}</span>`;
      return;
    }
    let html = "";
    if (isText(o)) {
      html += `${textTools(o, "fill")}
        ${swatch("backgroundColor", String(o.backgroundColor || ""), "Highlight", "highlight")}`;
    } else if ((o as Group & { badge?: number }).badge) {
      const g = o as Group & { badge?: number };
      const circle = g.getObjects()[0];
      html += `
        <span class="lyr-label">Step</span>
        <span class="lyr-stepper">
          <button type="button" class="lyr-btn" data-badge="-1" aria-label="Lower number">${icon("minus", 14)}</button>
          <input class="lyr-num" type="number" min="0" max="999" data-prop="badge" value="${g.badge}" aria-label="Number">
          <button type="button" class="lyr-btn" data-badge="1" aria-label="Higher number">${icon("plus", 14)}</button>
        </span>
        ${swatch("badgeFill", String(circle?.fill || ACCENT), "Colour")}
        ${opts.stepNumber && badges().length === 1
          ? `<button type="button" class="lyr-btn" data-act="badge-auto" title="Number it from its place in the write-up again (step ${opts.stepNumber})"${(g as Group & { badgePinned?: boolean }).badgePinned ? "" : " hidden"}>${icon("rotate")}<span>Auto-number</span></button>
            <span class="lyr-hint" data-badge-auto-hint${(g as Group & { badgePinned?: boolean }).badgePinned ? " hidden" : ""}>Numbered from its place in the write-up. Change it to fix it at your number.</span>`
          : ""}`;
    } else if (isDetail(o) || (isTail(o) && isDetail(byId(o.detailOf || "")))) {
      // A tail is changed through its circle's options.
      const d = (isTail(o) ? byId(o.detailOf || "") : o) as SceneLayer & { detail: DetailInfo };
      html += detailBar(d);
    } else if (isScene(o)) {
      const stale = behindModel(o.scene, projectModel);
      const shown = o.scene?.parts.filter(p => !p.hidden).length || 0;
      html += `
        <button type="button" class="lyr-btn" data-act="edit-scene" title="Add parts, place them and pick the style (or double-click it)">${icon("cube")}<span>Edit 3D scene</span></button>
        ${o.scene?.parts.length ? `<button type="button" class="lyr-btn" data-act="parts-strip" title="List the parts this step uses beside the picture, each with its count (the highlighted parts)">${icon("list")}<span>Parts strip</span></button>
        <button type="button" class="lyr-btn${o.scene?.arrows ? " lyr-on" : ""}" data-act="step-arrows" aria-pressed="${!!o.scene?.arrows}" title="Solid arrows in the picture along the gaps of the parts drawn apart (explode the scene first); set each part's in the 3D scene">${icon("arrow")}<span>Arrows</span></button>
        <select class="lyr-select" data-detail-part aria-label="Add a detail circle" title="A close-up of one part in a circle, with a line to it">
          <option value="">Detail circle…</option>
          ${o.scene.parts.filter(p => !p.hidden).map(p => `<option value="${esc(p.id)}">${esc(p.name)}${p.ghost ? " (ghost)" : ""}</option>`).join("")}
        </select>` : ""}
        ${stale ? `<button type="button" class="lyr-btn lyr-stale-btn" data-act="update-scene" title="Draw it again from the project's model as it is now">${icon("rotate")}<span>Update picture</span></button>
        <span class="lyr-hint lyr-stale-hint">Out of date: the project's model has changed since this was drawn.</span>`
        : `<span class="lyr-hint">${o.scene?.parts.length ? `${o.scene.model ? `${shown} of the model's ${o.scene.parts.length} parts` : `${o.scene.parts.length} part${o.scene.parts.length === 1 ? "" : "s"}`}` : "No parts yet"}. Stretch it to change the picture's shape.</span>`}`;
    } else if (o.type === "image") {
      html += `
        <button type="button" class="lyr-btn" data-act="flip-x" title="Flip across">${icon("flipH")}<span>Flip</span></button>
        <button type="button" class="lyr-btn" data-act="flip-y" title="Flip up and down" aria-label="Flip up and down">${icon("flipV")}</button>
        <button type="button" class="lyr-btn" data-act="fill-page" title="Make it fill the page">${icon("expand")}<span>Fill page</span></button>
        ${swatch("stroke", String(o.stroke || ""), "Border colour", "border")}
        ${borderWidth(o)}`;
    } else if (isLine(o)) {
      html += `
        ${swatch("stroke", String(o.stroke || INK), "Colour")}
        ${borderWidth(o, "Thickness")}
        <button type="button" class="lyr-btn${o.strokeDashArray?.length ? " lyr-on" : ""}" data-toggle="dash" title="Dashed" aria-label="Dashed">${icon("dash")}</button>
        ${o instanceof Connector ? `
        <button type="button" class="lyr-btn${o.arrowStart ? " lyr-on" : ""}" data-toggle="arrowStart" title="Arrow at the start" aria-label="Arrow at the start">${icon("arrowStart")}</button>
        <button type="button" class="lyr-btn${o.arrowEnd ? " lyr-on" : ""}" data-toggle="arrowEnd" title="Arrow at the end" aria-label="Arrow at the end">${icon("arrowEnd")}</button>
        <button type="button" class="lyr-btn${o.arrowSolid ? " lyr-on" : ""}" data-toggle="arrowSolid" title="Solid arrow heads" aria-label="Solid arrow heads">${icon("arrowSolid")}</button>` : ""}
        <button type="button" class="lyr-btn" data-act="flip-x" title="Flip direction" aria-label="Flip direction">${icon("flipH")}</button>`;
    } else if (!(o instanceof ActiveSelection) && !(o instanceof Group)) {
      html += `
        ${swatch("fill", String(o.fill || ""), "Colour")}
        ${swatch("stroke", String(o.stroke || ""), "Border colour", "border")}
        ${borderWidth(o)}
        <button type="button" class="lyr-btn${o.strokeDashArray?.length ? " lyr-on" : ""}" data-toggle="dash" title="Dashed border" aria-label="Dashed border">${icon("dash")}</button>
        ${o.type === "rect" ? cornerControl(o) : ""}
        ${sizeFields(o)}`;
      if (canHoldText(o)) {
        const t = textFor(o);
        html += t
          ? `<span class="lyr-sep"></span>${textTools(t, "textFill")}`
          : `<button type="button" class="lyr-btn" data-act="shape-text" title="Add text to the shape (Enter, or double-click it)">${icon("textInShape")}<span>Add text</span></button>`;
      }
    } else {
      const n = lineUpTargets().length;
      const al = (how: string, ic: string, label: string) => `<button type="button" class="lyr-btn" data-align="${how}" title="${label}" aria-label="${label}"${n < 2 ? " disabled" : ""}>${icon(ic)}</button>`;
      const di = (how: string, ic: string, label: string) => `<button type="button" class="lyr-btn" data-distribute="${how}" title="${label}" aria-label="${label}"${n < 3 ? " disabled" : ""}>${icon(ic)}</button>`;
      html += `<span class="lyr-label">${selected().length} selected</span>
        <span class="lyr-sep"></span>
        ${al("left", "alignObjLeft", "Align left")}${al("center", "alignObjCenter", "Align centre")}${al("right", "alignObjRight", "Align right")}
        <span class="lyr-sep"></span>
        ${al("top", "alignObjTop", "Align top")}${al("middle", "alignObjMiddle", "Align middle")}${al("bottom", "alignObjBottom", "Align bottom")}
        <span class="lyr-sep"></span>
        ${di("horizontal", "distributeH", "Space evenly across (needs 3 or more)")}${di("vertical", "distributeV", "Space evenly up and down (needs 3 or more)")}`;
    }
    contextBar.innerHTML = html + commonTools(o);
  }

  /** The rounded-corners slider with a number box beside it; the two stay in step. */
  function cornerControl(o: FabricObject): string {
    const r = Math.round(Number((o as FabricObject & { rx?: number }).rx) || 0);
    return `<label class="lyr-inline" title="Rounded corners">${icon("rounded")}<input type="range" min="0" max="${MAX_SLIDER_RADIUS}" step="1" data-prop="radius" value="${Math.min(r, MAX_SLIDER_RADIUS)}" aria-label="Rounded corners"></label><input class="lyr-num" type="number" min="0" max="${MAX_RADIUS}" step="1" data-prop="radius" value="${r}" title="Corner size" aria-label="Corner size">`;
  }
  /** Shows corner size `r` in both the slider and the number box, except the one being typed in. */
  function syncRadius(r: number, from: HTMLInputElement): void {
    contextBar.querySelectorAll<HTMLInputElement>("[data-prop=radius]").forEach(x => {
      if (x !== from) x.value = String(x.type === "range" ? Math.min(r, MAX_SLIDER_RADIUS) : r);
    });
  }
  const radiusValue = (el: HTMLInputElement) => Math.max(0, Math.min(MAX_RADIUS, Math.round(Number(el.value)) || 0));

  /** The shape's width and height on the page, so shapes can be made the same size. */
  const sizeOf = (o: FabricObject) => ({ w: Math.round((o.width || 0) * Math.abs(o.scaleX || 1)), h: Math.round((o.height || 0) * Math.abs(o.scaleY || 1)) });
  function sizeFields(o: FabricObject): string {
    const { w, h } = sizeOf(o);
    return `<span class="lyr-size-fields" title="Size on the page">
        <label>W <input class="lyr-num" type="number" min="4" max="${MAX_SIDE}" step="1" data-prop="w" value="${w}" aria-label="Width"></label>
        <label>H <input class="lyr-num" type="number" min="4" max="${MAX_SIDE}" step="1" data-prop="h" value="${h}" aria-label="Height"></label>
      </span>`;
  }
  function syncSizeFields(): void {
    const o = active();
    if (!o) return;
    const { w, h } = sizeOf(o);
    contextBar.querySelectorAll<HTMLInputElement>("[data-prop=w],[data-prop=h]").forEach(el => {
      if (el !== document.activeElement) el.value = String(el.dataset.prop === "w" ? w : h);
    });
  }
  /** Sets the selected shapes' width or height, keeping each one's middle where it is. */
  function setSize(which: "w" | "h", value: number): void {
    const n = Math.max(4, Math.min(MAX_SIDE, Math.round(value) || 0));
    if (!n) return;
    const list = selected().filter(x => !isLine(x) && !isText(x) && !(x instanceof Group));
    for (const o of list) {
      const centre = o.getCenterPoint();
      const base = which === "w" ? o.width || 1 : o.height || 1;
      if (o instanceof Rect) {
        o.set(which === "w" ? { width: n, scaleX: 1 } : { height: n, scaleY: 1 });
      } else {
        const sign = Math.sign((which === "w" ? o.scaleX : o.scaleY) || 1);
        o.set(which === "w" ? { scaleX: (sign * n) / base } : { scaleY: (sign * n) / base });
      }
      o.setPositionByOrigin(centre, "center", "center");
      o.setCoords();
    }
    canvas.requestRenderAll();
    if (list[0]) canvas.fire("object:modified", { target: list[0] });
  }

  /** Font, size, colour, bold, italic, underline and alignment for the text box `t` (or a shape's text). */
  function textTools(t: Textbox, colourProp: string): string {
    const font = FONTS.find(([, v]) => v === t.fontFamily)?.[1] || t.fontFamily;
    return `
        <select class="lyr-select" data-prop="fontFamily" aria-label="Font">
          ${FONTS.map(([l, v]) => `<option value="${esc(v)}"${v === font ? " selected" : ""} style="font-family:${esc(v)}">${l}</option>`).join("")}
        </select>
        <span class="lyr-stepper">
          <button type="button" class="lyr-btn" data-step="fontSize:-4" aria-label="Smaller">${icon("minus", 14)}</button>
          <input class="lyr-num" type="number" min="6" max="600" data-prop="fontSize" value="${Math.round(Number(t.fontSize) * (t.scaleY || 1))}" aria-label="Font size">
          <button type="button" class="lyr-btn" data-step="fontSize:4" aria-label="Bigger">${icon("plus", 14)}</button>
        </span>
        ${swatch(colourProp, String(t.fill || INK), "Text colour", "text")}
        <button type="button" class="lyr-btn${Number(t.fontWeight) >= 600 || t.fontWeight === "bold" ? " lyr-on" : ""}" data-toggle="bold" title="Bold (Ctrl+B)" aria-label="Bold">${icon("bold")}</button>
        <button type="button" class="lyr-btn${t.fontStyle === "italic" ? " lyr-on" : ""}" data-toggle="italic" title="Italic (Ctrl+I)" aria-label="Italic">${icon("italic")}</button>
        <button type="button" class="lyr-btn${t.underline ? " lyr-on" : ""}" data-toggle="underline" title="Underline (Ctrl+U)" aria-label="Underline">${icon("underline")}</button>
        <button type="button" class="lyr-btn" data-act="align-text" title="Alignment" aria-label="Alignment">${icon(t.textAlign === "center" ? "alignCenter" : t.textAlign === "right" ? "alignRight" : "alignLeft")}</button>`;
  }

  function borderWidth(o: FabricObject, label = "Border width"): string {
    return `<label class="lyr-inline" title="${label}"><input class="lyr-num" type="number" min="0" max="80" data-prop="strokeWidth" value="${Math.round(Number(o.strokeWidth) || 0)}" aria-label="${label}"></label>`;
  }

  /** Sets `props` on each selected object (or the one being edited), as one change. */
  function apply(props: Record<string, unknown>, list = selected()): void {
    const t = active() as Textbox | undefined;
    for (const o of list) {
      if (t?.isEditing && o === t && t.selectionStart !== t.selectionEnd && isStyleProp(props)) {
        t.setSelectionStyles(props);
      } else {
        o.set(props);
      }
      o.setCoords();
    }
    canvas.requestRenderAll();
    if (list[0]) canvas.fire("object:modified", { target: list[0] });
  }
  const isStyleProp = (p: Record<string, unknown>) => Object.keys(p).every(k => ["fill", "fontWeight", "fontStyle", "underline", "fontFamily", "fontSize", "textBackgroundColor"].includes(k));

  /** Sets a step badge's number. A number chosen by hand is pinned: it no longer follows the step's place. */
  function setBadge(o: FabricObject, n: number, pin = true): void {
    const g = o as Group & { badge?: number; name?: string; badgePinned?: boolean };
    const label = g.getObjects()[1] as Textbox | undefined;
    if (!label) return;
    const was = g.badge;
    if (pin && opts.stepNumber) g.badgePinned = true;
    // The bar shows Auto-number for a pinned badge, without being drawn again (that would lose the typing).
    const autoBtn = contextBar.querySelector<HTMLElement>("[data-act=badge-auto]");
    const autoHint = contextBar.querySelector<HTMLElement>("[data-badge-auto-hint]");
    if (autoBtn) autoBtn.hidden = !g.badgePinned;
    if (autoHint) autoHint.hidden = !!g.badgePinned;
    g.badge = Math.max(0, Math.min(999, Math.round(n)));
    label.set({ text: String(g.badge), fontSize: g.badge > 99 ? 30 : g.badge > 9 ? 36 : 44 });
    if (!g.name || g.name === `Step ${was}`) g.name = `Step ${g.badge}`;
    g.triggerLayout();
    canvas.requestRenderAll();
    canvas.fire("object:modified", { target: g });
  }

  contextBar.addEventListener("click", e => {
    const el = (e.target as HTMLElement).closest("button");
    if (!el) return;
    const o = active();
    if (el.dataset.color) return openColor(el, el.dataset.color);
    if (el.dataset.pop) return openPop(el, el.dataset.pop);
    if (el.dataset.align) return lineUp(el.dataset.align as AlignHow);
    if (el.dataset.distribute) return lineUp(el.dataset.distribute as DistributeHow);
    if (el.dataset.step && o) {
      const [prop, by] = el.dataset.step.split(":");
      const t = textOf(o);
      if (!t) return;
      const size = Math.max(6, Math.round(Number(t.fontSize) * (t.scaleY || 1)) + Number(by));
      if (prop === "fontSize") applyFontSize(size);
      return;
    }
    if (el.dataset.badge && o) return setBadge(o, Number((o as Group & { badge?: number }).badge) + Number(el.dataset.badge));
    if (el.dataset.toggle && o) {
      const t = textOf(o);
      if (t && el.dataset.toggle === "bold") apply({ fontWeight: Number(t.fontWeight) >= 600 || t.fontWeight === "bold" ? "400" : "700" }, textTargets());
      if (t && el.dataset.toggle === "italic") apply({ fontStyle: t.fontStyle === "italic" ? "normal" : "italic" }, textTargets());
      if (t && el.dataset.toggle === "underline") apply({ underline: !t.underline }, textTargets());
      if (o instanceof Connector && (el.dataset.toggle === "arrowStart" || el.dataset.toggle === "arrowEnd" || el.dataset.toggle === "arrowSolid")) {
        const key = el.dataset.toggle;
        apply({ [key]: !o[key] }, selected().filter(x => x instanceof Connector));
      }
      if (el.dataset.toggle === "dash") {
        const w = Math.max(2, Number(o.strokeWidth) || 4);
        apply({ strokeDashArray: o.strokeDashArray?.length ? null : [w * 3, w * 2.5] });
      }
      renderContext();
      return;
    }
    act(el.dataset.act || "");
  });
  contextBar.addEventListener("change", e => {
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    const prop = el.dataset.prop;
    const o = active();
    if (el.dataset.detailPart !== undefined && o && isScene(o) && el.value) {
      void addDetail(o, el.value);
      el.value = "";
      return;
    }
    if (!prop || !o) return;
    const d = isTail(o) ? byId(o.detailOf || "") : o;
    if (prop.startsWith("detail") && d && isDetail(d)) {
      const o = d;
      if (prop === "detailZoom") o.detail.zoom = Math.max(0.5, Math.min(20, Number(el.value) || 2));
      if (prop === "detailLabel") o.detail.label = el.value.trim().slice(0, 12) || false;
      if (prop === "detailPart") o.detail.part = el.value || undefined;
      if (prop === "detailLook") {
        o.detail.look = el.value === "line" || el.value === "none" ? el.value : undefined;
        aimTail(o);
        canvas.requestRenderAll();
        changed();
        return;
      }
      void redrawDetail(o).then(() => {
        renderContext();
        changed();
      });
      return;
    }
    if (prop === "fontFamily") apply({ fontFamily: el.value }, textTargets());
    if (prop === "fontSize") applyFontSize(Number(el.value));
    if (prop === "strokeWidth") {
      const w = Math.max(0, Number(el.value) || 0);
      apply({ strokeWidth: w, ...(o.strokeWidth === 0 && !o.stroke && w ? { stroke: INK } : {}) });
    }
    if (prop === "badge") setBadge(o, Number(el.value));
    if (prop === "w" || prop === "h") setSize(prop, Number(el.value));
    if (prop === "radius") {
      const r = radiusValue(el as HTMLInputElement);
      if (el.type === "number") el.value = String(r);
      syncRadius(r, el as HTMLInputElement);
      apply({ rx: r, ry: r });
    }
  });
  contextBar.addEventListener("input", e => {
    const el = e.target as HTMLInputElement;
    if (el.dataset.prop === "radius" && active()) {
      if (el.value === "") return;
      const r = radiusValue(el);
      syncRadius(r, el);
      active()!.set({ rx: r, ry: r });
      canvas.requestRenderAll();
    }
  });

  function applyFontSize(size: number): void {
    const n = Math.max(6, Math.min(600, Math.round(size) || 12));
    // A scaled text box keeps its look: the size goes into fontSize with the scale taken out.
    for (const t of textTargets()) {
      const s = t.scaleY || 1;
      if (s !== 1) t.set({ width: (t.width || 0) * (t.scaleX || 1), scaleX: 1, scaleY: 1 });
      t.set({ fontSize: n });
      t.setCoords();
    }
    canvas.requestRenderAll();
    if (active()) canvas.fire("object:modified", { target: active()! });
    renderContext();
  }

  // ------------------------------------------------------------ popovers

  let popFor: HTMLElement | null = null;
  function closePop(): void {
    pop.hidden = true;
    pop.innerHTML = "";
    popFor = null;
  }
  function showPop(anchor: HTMLElement, html: string): void {
    if (popFor === anchor) return closePop();
    popFor = anchor;
    pop.innerHTML = html;
    pop.hidden = false;
    const r = anchor.getBoundingClientRect();
    const rr = root.getBoundingClientRect();
    const w = pop.offsetWidth;
    pop.style.left = `${Math.max(8, Math.min(rr.width - w - 8, r.left - rr.left))}px`;
    pop.style.top = `${r.bottom - rr.top + 6}px`;
  }

  function docColors(): string[] {
    const seen = new Set<string>();
    const walk = (o: FabricObject) => {
      for (const v of [o.fill, o.stroke, (o as Textbox).backgroundColor]) if (typeof v === "string" && v) seen.add(v.toLowerCase());
      if (o instanceof Group) o.getObjects().forEach(walk);
    };
    objects().forEach(walk);
    if (background) seen.add(background.toLowerCase());
    return [...seen].slice(0, 12);
  }

  function currentColor(prop: string): string {
    const o = active();
    if (prop === "page") return background;
    if (!o) return "";
    if (prop === "badgeFill") return String((o as Group).getObjects()[0]?.fill || "");
    if (prop === "textFill") return String(textOf(o)?.fill || "");
    return String((o as unknown as Record<string, unknown>)[prop] || "");
  }

  function openColor(anchor: HTMLElement, prop: string): void {
    const allowNone = prop !== "badgeFill";
    const cur = currentColor(prop).toLowerCase();
    const chip = (c: string) => `<button type="button" class="lyr-chip-btn${c === cur ? " lyr-on" : ""}" data-pick="${esc(c)}" title="${esc(c || "None")}" aria-label="${esc(c || "None")}"><span class="lyr-chip${c ? "" : " lyr-chip-none"}" style="background:${esc(c || "transparent")}"></span></button>`;
    const used = docColors();
    showPop(anchor, `
      ${used.length ? `<div class="lyr-pop-title">In this graphic</div><div class="lyr-chips">${used.map(chip).join("")}</div>` : ""}
      <div class="lyr-pop-title">Colours</div>
      <div class="lyr-chips">${allowNone ? chip(NONE) : ""}${PALETTE.map(chip).join("")}</div>
      <label class="lyr-custom">Pick any colour <input type="color" value="${/^#[0-9a-f]{6}$/i.test(cur) ? cur : "#1971c2"}"></label>`);
    const pickColor = (c: string, done: boolean) => {
      setColor(prop, c);
      if (done) closePop();
    };
    pop.querySelectorAll<HTMLElement>("[data-pick]").forEach(b => b.addEventListener("click", () => pickColor(b.dataset.pick || "", true)));
    const input = pop.querySelector("input[type=color]") as HTMLInputElement;
    input.addEventListener("input", () => pickColor(input.value, false));
  }

  function setColor(prop: string, c: string): void {
    const o = active();
    if (prop === "page") {
      background = c;
      fit();
      changed();
      renderContext();
      return;
    }
    if (!o) return;
    if (prop === "badgeFill") {
      selected().forEach(g => (g as Group).getObjects?.()[0]?.set({ fill: c }));
      lastColor.badge = c;
      (o as Group).dirty = true;
      canvas.requestRenderAll();
      canvas.fire("object:modified", { target: o });
    } else if (prop === "stroke") {
      apply({ stroke: c || null, ...(c && !Number(o.strokeWidth) ? { strokeWidth: 6 } : {}) });
      if (isLine(o)) lastColor.line = c;
    } else if (prop === "backgroundColor") {
      apply({ backgroundColor: c });
    } else if (prop === "textFill") {
      apply({ fill: c || INK }, textTargets());
    } else {
      apply({ [prop]: c });
      if (!isText(o)) lastColor.shape = c;
    }
    renderContext();
  }

  function openPop(anchor: HTMLElement, which: string): void {
    const o = active();
    if (!o) return;
    if (which === "opacity") {
      showPop(anchor, `<div class="lyr-pop-title">Transparency</div><input type="range" min="5" max="100" value="${Math.round((o.opacity ?? 1) * 100)}" class="lyr-range" aria-label="Transparency"><span class="lyr-range-val">${Math.round((o.opacity ?? 1) * 100)}%</span>`);
      const r = pop.querySelector("input") as HTMLInputElement;
      r.addEventListener("input", () => {
        selected().forEach(x => x.set({ opacity: Number(r.value) / 100 }));
        (pop.querySelector(".lyr-range-val") as HTMLElement).textContent = `${r.value}%`;
        canvas.requestRenderAll();
      });
      r.addEventListener("change", () => canvas.fire("object:modified", { target: o }));
      return;
    }
    if (which === "position") {
      const b = (act: string, ic: string, label: string) => `<button type="button" class="lyr-menu-item" data-pos="${act}">${icon(ic, 16)}<span>${label}</span></button>`;
      showPop(anchor, `
        <div class="lyr-pop-title">Layer</div>
        <div class="lyr-menu-grid">
          ${b("forward", "forward", "Forward")}${b("backward", "backward", "Backward")}
          ${b("front", "forward", "To front")}${b("back", "backward", "To back")}
        </div>
        <div class="lyr-pop-title">Line up on the page</div>
        <div class="lyr-menu-grid">
          ${b("top", "alignLeft", "Top")}${b("left", "alignLeft", "Left")}
          ${b("middle", "alignCenter", "Middle")}${b("center", "alignCenter", "Centre")}
          ${b("bottom", "alignRight", "Bottom")}${b("right", "alignRight", "Right")}
        </div>`);
      pop.querySelectorAll<HTMLElement>("[data-pos]").forEach(el =>
        el.addEventListener("click", () => {
          const p = el.dataset.pos!;
          if (["forward", "backward", "front", "back"].includes(p)) restack(p as "front");
          else alignToPage(p);
        }),
      );
    }
  }

  // ------------------------------------------------------------ side panel

  let openPanel: Panel | null = null;
  function showPanel(id: Panel | null): void {
    openPanel = openPanel === id ? null : id;
    root.querySelectorAll<HTMLElement>(".lyr-rail-btn").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.panel === openPanel)));
    panelEl.hidden = !openPanel;
    root.classList.toggle("lyr-panel-open", !!openPanel);
    if (!openPanel) return;
    const [, , label] = PANELS.find(p => p[0] === openPanel)!;
    (panelEl.querySelector(".lyr-panel-head strong") as HTMLElement).textContent = label;
    renderPanel();
  }

  const tile = (kind: string, label: string, svg: string) =>
    `<button type="button" class="lyr-tile" data-add="${kind}" title="${esc(label)}" aria-label="${esc(label)}" draggable="true"><svg viewBox="0 0 48 48" width="40" height="40">${svg}</svg></button>`;

  function renderPanel(): void {
    switch (openPanel) {
      case "templates":
        panelBody.innerHTML = `
          <p class="lyr-note">Start from a layout. It's added to the page, so you can change everything.</p>
          <div class="lyr-templates">
            ${TEMPLATES.map(t => `<button type="button" class="lyr-template" data-template="${t.id}"><strong>${esc(t.label)}</strong><span>${esc(t.detail)}</span></button>`).join("")}
          </div>`;
        break;
      case "elements":
        panelBody.innerHTML = `
          <div class="lyr-panel-title">Shapes</div>
          <div class="lyr-tiles">${SHAPES.map(s => tile(s.id, s.label, s.svg)).join("")}</div>
          <div class="lyr-panel-title">Lines, arrows and steps</div>
          <div class="lyr-tiles">${LINES.map(s => tile(s.id, s.label, s.svg)).join("")}</div>
          <div class="lyr-panel-title">Instruction symbols</div>
          <div class="lyr-tiles">${SYMBOLS.map(s => tile(s.id, s.label, s.svg)).join("")}</div>
          <div class="lyr-panel-title">People and attention</div>
          <div class="lyr-tiles">${FIGURES.map(s => tile(s.id, s.label, s.svg)).join("")}</div>
          <div class="lyr-panel-title">Tools and fixings</div>
          <div class="lyr-tiles">${TOOLS.map(s => tile(s.id, s.label, s.svg)).join("")}</div>
          <div class="lyr-panel-title">3D</div>
          <button type="button" class="lyr-wide-btn" data-add="scene" title="Bring in STL or STEP models and draw them as assembly-instruction line art">${icon("cube", 16)} 3D scene from STL or STEP files</button>
          <p class="lyr-note">Click to add, or drag onto the page.</p>`;
        break;
      case "text":
        panelBody.innerHTML = `
          <button type="button" class="lyr-wide-btn lyr-primary" data-text="body">${icon("text", 16)} Add a text box</button>
          <div class="lyr-panel-title">Text styles</div>
          ${TEXT_STYLES.map(s => `<button type="button" class="lyr-text-style" data-text="${s.id}" draggable="true"><span style="${s.css}">${esc(s.label)}</span></button>`).join("")}`;
        break;
      case "uploads":
        panelBody.innerHTML = `
          <button type="button" class="lyr-wide-btn lyr-primary" data-act="upload">${icon("upload", 16)} Upload a picture</button>
          <p class="lyr-note">Or drop pictures on the page, or paste one.</p>
          ${opts.listImages ? `<div class="lyr-panel-title">Your pictures</div><div class="lyr-pictures"><span class="lyr-note">Loading…</span></div>` : ""}`;
        if (opts.listImages) {
          opts.listImages().then(
            list => {
              const box = panelBody.querySelector(".lyr-pictures");
              if (!box || openPanel !== "uploads") return;
              box.innerHTML = list.length
                ? list.map((im, i) => `<button type="button" class="lyr-picture" data-picture="${i}" title="${esc(im.title || "")}" draggable="true"><img src="${esc(im.url)}" alt="${esc(im.title || "")}" loading="lazy"></button>`).join("")
                : `<span class="lyr-note">No pictures yet.</span>`;
              box.querySelectorAll<HTMLElement>("[data-picture]").forEach(b => {
                const im = list[Number(b.dataset.picture)];
                b.addEventListener("click", () => {
                  void addPicture(im.url, undefined, im.title || "Picture");
                  if (mode === "inline") showPanel(null);
                });
                b.addEventListener("dragstart", e => e.dataTransfer?.setData("application/x-layers", JSON.stringify({ picture: im.url, title: im.title })));
              });
            },
            () => {
              const box = panelBody.querySelector(".lyr-pictures");
              if (box) box.innerHTML = `<span class="lyr-note">Your pictures couldn't be loaded.</span>`;
            },
          );
        }
        break;
      case "layers":
        renderLayersList();
        break;
      case "page":
        panelBody.innerHTML = `
          <div class="lyr-panel-title">Size</div>
          <div class="lyr-sizes">
            ${SIZES.map(s => `<button type="button" class="lyr-size${s.width === W && s.height === H ? " lyr-on" : ""}" data-size="${s.id}"><span class="lyr-size-shape" style="aspect-ratio:${s.width}/${s.height}"></span><span>${esc(s.label)}</span></button>`).join("")}
          </div>
          <div class="lyr-custom-size">
            <label>Width <input class="lyr-num" type="number" min="${MIN_SIDE}" max="${MAX_SIDE}" data-page="width" value="${W}"></label>
            <label>Height <input class="lyr-num" type="number" min="${MIN_SIDE}" max="${MAX_SIDE}" data-page="height" value="${H}"></label>
          </div>
          <div class="lyr-fit">
            <button type="button" class="lyr-btn lyr-fit-btn" data-act="fit-contents"${shown().length ? "" : " disabled"} title="Shrink or grow the page to just fit what's on it">${icon("crop")}<span>Fit to contents</span></button>
            <label title="Space left around the contents">Margin <input class="lyr-num" type="number" min="0" max="400" data-fit-margin value="${fitMargin}"></label>
          </div>
          <div class="lyr-panel-title">Colour</div>
          <div class="lyr-chips">
            <button type="button" class="lyr-chip-btn${!background ? " lyr-on" : ""}" data-bg="" title="See-through" aria-label="See-through"><span class="lyr-chip lyr-chip-none"></span></button>
            ${PALETTE.map(c => `<button type="button" class="lyr-chip-btn${c === background ? " lyr-on" : ""}" data-bg="${c}" title="${c}" aria-label="${c}"><span class="lyr-chip" style="background:${c}"></span></button>`).join("")}
          </div>
          <label class="lyr-custom">Pick any colour <input type="color" data-bg-custom value="${/^#[0-9a-f]{6}$/i.test(background) ? background : "#ffffff"}"></label>`;
        break;
    }
  }

  /** The page's visible objects. */
  const shown = () => objects().filter(o => o.visible !== false);

  /**
   * Fits the page to what's on it: everything moves up and left so the
   * contents start `fitMargin` in from the corner, and the page takes their
   * size plus the margin on every side. A page can't go below its smallest
   * size, so small contents are centred on it.
   */
  function fitToContents(): void {
    const list = shown();
    if (!list.length) return status("There's nothing on the page to fit to.");
    canvas.discardActiveObject();
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (const o of list) {
      o.setCoords();
      const box = o.getBoundingRect();
      l = Math.min(l, box.left);
      t = Math.min(t, box.top);
      r = Math.max(r, box.left + box.width);
      b = Math.max(b, box.top + box.height);
    }
    const w = clampSide(r - l + fitMargin * 2);
    const h = clampSide(b - t + fitMargin * 2);
    const dx = (w - (r - l)) / 2 - l;
    const dy = (h - (b - t)) / 2 - t;
    for (const o of objects()) {
      o.set({ left: (o.left || 0) + dx, top: (o.top || 0) + dy });
      o.setCoords();
    }
    resizePage(w, h);
  }

  function resizePage(w: number, h: number): void {
    W = clampSide(w);
    H = clampSide(h);
    userZoom = 0;
    fit();
    changed();
    if (openPanel === "page") renderPanel();
  }

  panelEl.addEventListener("click", e => {
    const el = (e.target as HTMLElement).closest("button");
    if (!el) return;
    if (el.dataset.act === "panel-close") return showPanel(null);
    // In the page the panel covers part of the graphic, so it closes once something is added.
    const added = !!(el.dataset.add || el.dataset.text || el.dataset.template);
    if (el.dataset.add) addKind(el.dataset.add);
    if (el.dataset.text) addTextStyle(el.dataset.text);
    if (el.dataset.template) {
      const t = TEMPLATES.find(x => x.id === el.dataset.template);
      if (t) {
        if (t.background) {
          background = t.background;
          fit();
        }
        const list = t.build(W, H);
        list.forEach(o => {
          prepare(o);
          canvas.add(o);
        });
        numberStep();
        if (t.scene) void addScene(undefined, t.scene);
        else if (t.inventory === "screws") void screwInventory();
        else if (t.inventory) void partsInventory();
        else selectAll(list);
      }
    }
    if (added && mode === "inline") showPanel(null);
    if (el.dataset.act === "upload") fileInput.click();
    if (el.dataset.act === "fit-contents") fitToContents();
    if (el.dataset.size) {
      const s = SIZES.find(x => x.id === el.dataset.size);
      if (s) resizePage(s.width, s.height);
    }
    if (el.dataset.bg !== undefined) {
      setColor("page", el.dataset.bg);
      renderPanel();
    }
    if (el.dataset.layer) {
      const o = objects().find(x => (x as FabricObject & { layerId?: string }).layerId === el.dataset.layer);
      if (!o) return;
      if (el.dataset.layerAct === "hide") return toggleHidden(o);
      if (el.dataset.layerAct === "lock") return toggleLock(o);
      const pick = (boundTo(o) && byId(boundTo(o))) || o;
      if (pick.visible !== false && !locked(pick)) {
        canvas.setActiveObject(pick);
        canvas.requestRenderAll();
      }
    }
  });
  panelEl.addEventListener("change", e => {
    const el = e.target as HTMLInputElement;
    if (el.dataset.page) resizePage(el.dataset.page === "width" ? Number(el.value) : W, el.dataset.page === "height" ? Number(el.value) : H);
    if (el.matches("[data-bg-custom]")) setColor("page", el.value);
    if (el.matches("[data-fit-margin]")) {
      fitMargin = Math.max(0, Math.min(400, Math.round(Number(el.value)) || 0));
      el.value = String(fitMargin);
    }
  });
  panelEl.addEventListener("dragstart", e => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-add],[data-text]");
    if (el) e.dataTransfer?.setData("application/x-layers", JSON.stringify({ add: el.dataset.add, text: el.dataset.text }));
  });

  // The layers list: top layer first. Drag a row to restack, double-click its name to rename it.
  function renderLayersList(): void {
    if (openPanel !== "layers") return;
    const list = objects().slice().reverse();
    const sel = new Set(selected());
    panelBody.innerHTML = list.length
      ? `<ul class="lyr-layers">${list
          .map(o => {
            const id = (o as FabricObject & { layerId?: string }).layerId;
            const k = kindOf(o);
            return `<li class="lyr-layer${sel.has(o) ? " lyr-on" : ""}${o.visible === false ? " lyr-off" : ""}" draggable="true" data-row="${id}">
              <span class="lyr-grip">${icon("grip", 14)}</span>
              <button type="button" class="lyr-layer-main" data-layer="${id}">${icon(k.icon, 16)}<span class="lyr-layer-name">${esc(nameOf(o))}</span></button>
              <button type="button" class="lyr-btn" data-layer="${id}" data-layer-act="hide" title="${o.visible === false ? "Show" : "Hide"}" aria-label="${o.visible === false ? "Show" : "Hide"}">${icon(o.visible === false ? "eyeOff" : "eye", 15)}</button>
              <button type="button" class="lyr-btn${locked(o) ? " lyr-on" : ""}" data-layer="${id}" data-layer-act="lock" title="${locked(o) ? "Unlock" : "Lock"}" aria-label="${locked(o) ? "Unlock" : "Lock"}">${icon(locked(o) ? "lock" : "unlock", 15)}</button>
            </li>`;
          })
          .join("")}</ul><p class="lyr-note">Drag to reorder. Double-click a name to rename it.</p>`
      : `<p class="lyr-note">Nothing on the page yet.</p>`;
  }
  let dragRow: string | null = null;
  panelBody.addEventListener("dragstart", e => {
    const li = (e.target as HTMLElement).closest<HTMLElement>("[data-row]");
    if (!li) return;
    dragRow = li.dataset.row || null;
    e.dataTransfer?.setData("text/plain", "");
    li.classList.add("lyr-dragging");
  });
  panelBody.addEventListener("dragover", e => {
    if (!dragRow) return;
    e.preventDefault();
    const li = (e.target as HTMLElement).closest<HTMLElement>("[data-row]");
    panelBody.querySelectorAll(".lyr-drop-above,.lyr-drop-below").forEach(x => x.classList.remove("lyr-drop-above", "lyr-drop-below"));
    if (li && li.dataset.row !== dragRow) {
      const r = li.getBoundingClientRect();
      li.classList.add(e.clientY < r.top + r.height / 2 ? "lyr-drop-above" : "lyr-drop-below");
    }
  });
  panelBody.addEventListener("drop", e => {
    if (!dragRow) return;
    e.preventDefault();
    const li = (e.target as HTMLElement).closest<HTMLElement>("[data-row]");
    const moving = objects().find(o => (o as FabricObject & { layerId?: string }).layerId === dragRow);
    const target = li && objects().find(o => (o as FabricObject & { layerId?: string }).layerId === li.dataset.row);
    dragRow = null;
    if (!moving || !target || moving === target) return renderLayersList();
    const r = li!.getBoundingClientRect();
    const above = e.clientY < r.top + r.height / 2;
    // Rows run top layer first, so "above" a row means in front of it.
    const without = objects().filter(o => o !== moving);
    let index = without.indexOf(target) + (above ? 1 : 0);
    index = Math.max(0, Math.min(without.length, index));
    canvas.moveObjectTo(moving, index);
    canvas.requestRenderAll();
    changed();
  });
  panelBody.addEventListener("dragend", () => {
    dragRow = null;
    renderLayersList();
  });
  panelBody.addEventListener("dblclick", e => {
    const nameEl = (e.target as HTMLElement).closest<HTMLElement>(".lyr-layer-name");
    const btn = nameEl?.closest<HTMLElement>("[data-layer]");
    const o = btn && objects().find(x => (x as FabricObject & { layerId?: string }).layerId === btn.dataset.layer);
    if (!nameEl || !o) return;
    const input = document.createElement("input");
    input.className = "lyr-rename";
    input.value = nameOf(o);
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    const finish = (keep: boolean) => {
      if (keep && input.value.trim()) {
        (o as FabricObject & { name?: string }).name = input.value.trim().slice(0, 80);
        changed();
      }
      renderLayersList();
    };
    input.addEventListener("keydown", ev => {
      ev.stopPropagation();
      if (ev.key === "Enter") finish(true);
      if (ev.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  });

  root.querySelectorAll<HTMLElement>(".lyr-rail-btn").forEach(b => b.addEventListener("click", () => showPanel(b.dataset.panel as Panel)));

  // ------------------------------------------------------------ dropping and pasting

  const pointFromEvent = (e: { clientX: number; clientY: number }): XY => {
    const r = board.getBoundingClientRect();
    return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom };
  };
  stage.addEventListener("dragover", e => {
    if (dragRow) return;
    e.preventDefault();
    if (e.dataTransfer?.types.includes("Files")) ($(".lyr-drop").hidden = false);
  });
  stage.addEventListener("dragleave", e => {
    if (!stage.contains(e.relatedTarget as Node)) $(".lyr-drop").hidden = true;
  });
  stage.addEventListener("drop", async e => {
    if (dragRow) return;
    e.preventDefault();
    $(".lyr-drop").hidden = true;
    const at = pointFromEvent(e);
    const files = [...(e.dataTransfer?.files || [])].filter(f => f.type.startsWith("image/"));
    for (const f of files) await addPicture(f, at, f.name.replace(/\.[a-z0-9]+$/i, "") || "Picture");
    const raw = e.dataTransfer?.getData("application/x-layers");
    if (raw) {
      try {
        const d = JSON.parse(raw) as { add?: string; text?: string; picture?: string; title?: string };
        if (d.add) addKind(d.add, at);
        if (d.text) addTextStyle(d.text, at);
        if (d.picture) await addPicture(d.picture, at, d.title || "Picture");
      } catch {
        /* not ours */
      }
    }
  });
  fileInput.addEventListener("change", async () => {
    for (const f of [...(fileInput.files || [])]) await addPicture(f, undefined, f.name.replace(/\.[a-z0-9]+$/i, "") || "Picture");
    fileInput.value = "";
    if (mode === "inline" && openPanel === "uploads") showPanel(null);
  });

  const MARK = "⁣layers-copy";
  root.addEventListener("copy", e => {
    if (isTyping(e.target) || !selected().length) return;
    e.preventDefault();
    e.clipboardData?.setData("text/plain", MARK);
    void copy();
  });
  root.addEventListener("cut", e => {
    if (isTyping(e.target) || !selected().length) return;
    e.preventDefault();
    e.clipboardData?.setData("text/plain", MARK);
    void copy().then(removeSelected);
  });
  root.addEventListener("paste", async e => {
    e.stopPropagation();
    if (isTyping(e.target)) return;
    const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith("image/"));
    const text = e.clipboardData?.getData("text/plain") || "";
    e.preventDefault();
    if (files.length) {
      for (const f of files) await addPicture(f);
    } else if (text === MARK || (!text && clipboard.length)) {
      await paste();
    } else if (text.trim()) {
      const t = makeText(TEXT_STYLES[2], { x: 0, y: 0 });
      t.set({ text: text.trim().slice(0, 2000) });
      add(t);
    }
  });

  // ------------------------------------------------------------ keys

  const isTyping = (t: EventTarget | null) => {
    const el = t as HTMLElement | null;
    if (!el || !el.tagName) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName === "SELECT") return true;
    return el.tagName === "INPUT" && !["range", "color", "checkbox", "button"].includes((el as HTMLInputElement).type);
  };

  function onKey(e: KeyboardEvent): void {
    // Keys pressed in the editor are the editor's, not the page's.
    e.stopPropagation();
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && (key === "s" || key === "enter")) {
      e.preventDefault();
      act("done");
      return;
    }
    const t = active() as Textbox | undefined;
    if (t?.isEditing) {
      if (e.key === "Escape") leaveText(t);
      return;
    }
    if (isTyping(e.target)) {
      if (e.key === "Escape") (e.target as HTMLElement).blur();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (!pop.hidden) closePop();
      else if (active()) {
        canvas.discardActiveObject();
        canvas.requestRenderAll();
      } else if (mode === "full" && opts.allowInline !== false) setMode("inline");
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      removeSelected();
      return;
    }
    if (mod && key === "z") {
      e.preventDefault();
      void (e.shiftKey ? redo() : undo());
      return;
    }
    if (mod && key === "y") {
      e.preventDefault();
      void redo();
      return;
    }
    if (mod && key === "d") {
      e.preventDefault();
      void duplicate();
      return;
    }
    if (mod && key === "a") {
      e.preventDefault();
      selectAll(objects().filter(o => o.selectable));
      return;
    }
    if (mod && key === "g") {
      e.preventDefault();
      if (e.shiftKey) ungroup();
      else group();
      return;
    }
    if (mod && ["b", "i", "u"].includes(key) && textOf(active())) {
      e.preventDefault();
      const btn = contextBar.querySelector<HTMLElement>(`[data-toggle=${key === "b" ? "bold" : key === "i" ? "italic" : "underline"}]`);
      btn?.click();
      return;
    }
    const step = e.shiftKey ? 10 : 1;
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (arrows[e.key] && active()) {
      e.preventDefault();
      nudge(...arrows[e.key]);
      return;
    }
    if (e.key === "Enter" && !mod && canHoldText(active()) && !(active() instanceof ActiveSelection)) {
      e.preventDefault();
      editShapeText(active()!);
      return;
    }
    if (!mod && key === "t" && !e.altKey) {
      e.preventDefault();
      addTextStyle("body");
      return;
    }
    if (!mod && key === "r" && !e.altKey) {
      e.preventDefault();
      addKind("rect");
      return;
    }
  }
  root.addEventListener("keydown", onKey);
  for (const ev of ["keyup", "keypress", "beforeinput", "input"]) root.addEventListener(ev, e => e.stopPropagation());
  // Fabric types into a hidden textarea on <body>; keep the page's own shortcuts out of it too.
  const onDocKey = (e: KeyboardEvent) => {
    const t = active() as Textbox | undefined;
    if (t?.isEditing && e.target === t.hiddenTextarea) {
      if (e.key === "Escape") {
        e.stopPropagation();
        leaveText(t);
        root.focus({ preventScroll: true });
      } else if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "Enter")) {
        e.preventDefault();
        e.stopPropagation();
        t.exitEditing();
        act("done");
      }
    }
  };
  document.addEventListener("keydown", onDocKey, true);
  stage.addEventListener("pointerdown", e => {
    if (!(active() as Textbox | undefined)?.isEditing) root.focus({ preventScroll: true });
    closePop();
    // A click on the grey around the page clears the selection, as a click on the page's empty part does.
    if (!board.contains(e.target as Node) && active()) {
      canvas.discardActiveObject();
      canvas.requestRenderAll();
    }
  });
  // Buttons that redraw (the panels, the selection bar) drop the focus; keep it in the editor so keys still work.
  root.addEventListener("click", () => {
    setTimeout(() => {
      const a = document.activeElement;
      if (!destroyed && (!a || a === document.body)) root.focus({ preventScroll: true });
    });
  });
  // Full screen, a key pressed with the focus nowhere in particular is the editor's.
  const onBodyKey = (e: KeyboardEvent) => {
    if (mode === "full" && (e.target === document.body || e.target === document.documentElement)) onKey(e);
  };
  document.addEventListener("keydown", onBodyKey);
  root.addEventListener("pointerdown", e => {
    if (!pop.hidden && !pop.contains(e.target as Node) && !(e.target as HTMLElement).closest("[data-color],[data-pop]")) closePop();
  });

  // ------------------------------------------------------------ actions

  async function done(): Promise<void> {
    if (busy) return;
    busy = true;
    root.classList.add("lyr-busy");
    status("Saving…", false, true);
    try {
      const t = active() as Textbox | undefined;
      if (t?.isEditing) t.exitEditing();
      const result = await exportResult();
      await opts.onDone?.(result);
      saved = snapshot();
      status("Saved");
    } catch (e) {
      status(e instanceof Error && e.message ? e.message : "That didn't save. Try again.", true, true);
    } finally {
      busy = false;
      root.classList.remove("lyr-busy");
    }
  }

  function act(name: string): void {
    const o = active();
    switch (name) {
      case "undo": void undo(); break;
      case "redo": void redo(); break;
      case "zoom-in": setZoom(zoom * 1.25); break;
      case "zoom-out": setZoom(zoom / 1.25); break;
      case "zoom-fit": userZoom = 0; fit(); break;
      case "fit-contents": fitToContents(); break;
      case "mode": setMode(mode === "full" ? "inline" : "full"); break;
      case "cancel":
        if (isDirty() && !window.confirm("Throw away your changes to this graphic?")) return;
        opts.onCancel?.();
        break;
      case "done": void done(); break;
      case "duplicate": void duplicate(); break;
      case "delete": removeSelected(); break;
      case "lock": toggleLock(); break;
      case "group": group(); break;
      case "ungroup": ungroup(); break;
      case "open-page": if (openPanel !== "page") showPanel("page"); break;
      case "align-text": {
        const t = textOf(o);
        if (!t) return;
        const order = ["left", "center", "right"];
        const next = order[(order.indexOf(String(t.textAlign || "left")) + 1) % 3];
        apply({ textAlign: next }, textTargets());
        renderContext();
        break;
      }
      case "flip-x":
        if (o instanceof Connector) {
          // A line flips by swapping its ends, and what they're fastened to.
          const [a, b] = o.ends();
          const from = o.connFrom;
          o.connFrom = o.connTo;
          o.connTo = from;
          o.setEnds(b, a);
          canvas.requestRenderAll();
          canvas.fire("object:modified", { target: o });
        } else if (o) apply({ flipX: !o.flipX });
        break;
      case "shape-text": if (o && canHoldText(o)) editShapeText(o); break;
      case "edit-scene": if (isScene(o) && !isDetail(o)) void editScene(o); break;
      case "update-scene": if (isScene(o)) void updateScenes([o]); break;
      case "parts-strip": if (isScene(o)) void partsStrip(o); break;
      case "step-arrows": if (isScene(o)) void stepArrows(o); break;
      case "badge-auto":
        if (o) {
          delete (o as Group & { badgePinned?: boolean }).badgePinned;
          if (opts.stepNumber) setBadge(o, opts.stepNumber, false);
          renderContext();
        }
        break;
      case "flip-y": if (o) apply({ flipY: !o.flipY }); break;
      case "fill-page":
        if (o) {
          const s = Math.max(W / (o.width || 1), H / (o.height || 1));
          o.set({ scaleX: s, scaleY: s, angle: 0, left: (W - (o.width || 0) * s) / 2, top: (H - (o.height || 0) * s) / 2 });
          o.setCoords();
          canvas.sendObjectToBack(o);
          canvas.requestRenderAll();
          canvas.fire("object:modified", { target: o });
        }
        break;
    }
  }
  root.addEventListener("click", e => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!el || contextBar.contains(el) || panelEl.contains(el)) return;
    act(el.dataset.act || "");
  });

  // ------------------------------------------------------------ canvas events

  const onChange = () => changed();
  canvas.on("object:added", onChange);
  canvas.on("object:removed", onChange);
  canvas.on("object:removed", e => {
    const o = (e as { target?: FabricObject }).target;
    if (!isDetail(o) || restoring || destroyed) return;
    const src = sourceOf(o);
    if (src && canvas.contains(src)) void redrawScene(src, true);
  });
  canvas.on("object:modified", onChange);
  canvas.on("object:modified", e => {
    const t = (e as { target?: FabricObject }).target;
    if (isScene(t)) void redrawScene(t);
  });
  canvas.on("text:changed", onChange);
  const onSelect = () => {
    renderContext();
    placeFloat();
    if (openPanel === "layers") renderLayersList();
    closePop();
  };
  canvas.on("selection:created", onSelect);
  canvas.on("selection:updated", onSelect);
  canvas.on("selection:cleared", () => {
    follow();
    onSelect();
  });
  canvas.on("text:editing:entered", () => (floatBar.hidden = true));
  canvas.on("text:editing:exited", e => {
    // An emptied text box goes away.
    const t = canvas.getObjects().find(o => isText(o) && !(o as Textbox).text?.trim());
    if (t) canvas.remove(t);
    // A shape's text goes back to moving with the shape.
    const done = (e as { target?: FabricObject }).target;
    if (done && boundTo(done) && canvas.contains(done)) {
      prepare(done);
      follow();
    }
    placeFloat();
  });
  canvas.on("mouse:dblclick", (e: TPointerEventInfo<TPointerEvent>) => {
    // Double-click a step badge: next number. Double-click empty page: a text box there.
    const t = e.target;
    if (!t) {
      const p = canvas.getScenePoint(e.e);
      addTextStyle("body", { x: p.x + 280, y: p.y + 20 });
    } else if (isScene(t) && !locked(t) && !isDetail(t)) {
      void editScene(t);
    } else if (canHoldText(t) && !locked(t)) {
      // Double-click a shape: type in it.
      editShapeText(t);
    }
  });
  titleInput.addEventListener("change", () => changed());
  titleInput.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Enter") titleInput.blur();
  });

  // ------------------------------------------------------------ modes

  function setMode(next: "inline" | "full"): void {
    if (next === "inline" && opts.allowInline === false) next = "full";
    if (next === mode && root.dataset.mode === next) return;
    mode = next;
    root.dataset.mode = mode;
    const btn = $(".lyr-mode");
    btn.innerHTML = mode === "full" ? `${icon("shrink")}<span>Back to page</span>` : `${icon("expand")}<span>Full screen</span>`;
    btn.title = mode === "full" ? "Back to the page (Esc)" : "Full screen";
    btn.hidden = opts.allowInline === false;
    if (mode === "full") {
      if (!overlay) {
        overlay = document.createElement("div");
        overlay.className = "lyr-overlay";
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        overlay.setAttribute("aria-label", "Layers");
      }
      overlay.appendChild(root);
      document.body.appendChild(overlay);
      document.documentElement.classList.add("lyr-open");
      if (!openPanel) showPanel("elements");
    } else {
      home.appendChild(root);
      overlay?.remove();
      document.documentElement.classList.remove("lyr-open");
      if (openPanel) showPanel(null);
    }
    userZoom = 0;
    requestAnimationFrame(() => {
      fit();
      root.focus({ preventScroll: true });
    });
    opts.onModeChange?.(mode);
  }

  function isDirty(): boolean {
    commit();
    return snapshot() !== saved;
  }

  async function exportResult(): Promise<LayersResult> {
    commit();
    const doc = getDoc();
    const png = await renderPng(doc);
    return { doc, png, title: doc.title || "", width: doc.width, height: doc.height };
  }

  async function renderPng(doc: LayersDoc): Promise<Blob> {
    // The page at its own size, without the selection box or guides.
    const sel = active();
    canvas.discardActiveObject();
    guides = [];
    const vpt = canvas.viewportTransform.slice() as typeof canvas.viewportTransform;
    canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
    canvas.backgroundColor = background || "";
    // Drawn at twice the page size (or as near as fits), so text and lines stay
    // sharp on retina screens and in full-width views. A picture-heavy page that
    // would be too big to upload steps down until it fits.
    let png: Uint8Array | null = null;
    try {
      for (const multiplier of exportScales(W, H)) {
        const url = canvas.toDataURL({ format: "png", multiplier, left: 0, top: 0, width: W, height: H, enableRetinaScaling: false });
        png = await embedDoc(Uint8Array.from(atob(url.split(",")[1]), c => c.charCodeAt(0)), doc);
        if (png.length <= MAX_EXPORT_BYTES) break;
      }
    } finally {
      canvas.backgroundColor = "";
      canvas.setViewportTransform(vpt);
      if (sel) canvas.setActiveObject(sel);
      canvas.requestRenderAll();
    }
    return new Blob([png as BlobPart], { type: "image/png" });
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    ro.disconnect();
    window.removeEventListener("resize", onWindowResize);
    document.removeEventListener("keydown", onDocKey, true);
    document.removeEventListener("keydown", onBodyKey);
    clearTimeout(historyTimer);
    clearTimeout(statusTimer);
    canvas.dispose();
    root.remove();
    overlay?.remove();
    document.documentElement.classList.remove("lyr-open");
  }

  // ------------------------------------------------------------ start

  const handle: LayersHandle = {
    root,
    mode: () => mode,
    setMode,
    attach(el) {
      home = el;
      if (mode === "inline") {
        el.appendChild(root);
        requestAnimationFrame(fit);
      }
    },
    getDoc,
    isDirty,
    exportResult,
    ready: () => opened,
    assemblyGuide,
    screwInventory: async () => {
      await opened;
      return screwInventory(true);
    },
    wireList: async () => {
      await opened;
      const model = await getProjectModel();
      const scenes = objects().filter((o): o is SceneLayer => isScene(o) && !isDetail(o) && !!o.scene?.parts.length);
      const parts = model?.parts.some(p => p.wire) ? model.parts : scenes.map(o => normalizeScene(o.scene).parts).find(ps => ps.some(p => p.wire)) || [];
      if (!parts.some(p => p.wire)) return "";
      const { wireListOf, wireListMarkdown } = await import("./scene/wireList");
      return wireListMarkdown(wireListOf(parts));
    },
    focus: () => root.focus({ preventScroll: true }),
    destroy,
  };

  root.dataset.mode = "";
  syncHistoryButtons();
  const opened = (async () => {
    if (start.objects.length) await load(start);
    else if (opts.picture) await startFromPicture(opts.picture);
    if (destroyed) return;
    current = snapshot();
    saved = current;
    // A step badge follows the step's place in the write-up (left to save, so it's seen).
    if (numberStep()) {
      commit();
      status(`Numbered step ${opts.stepNumber}, from its place in the write-up.`);
    }
    setMode(mode);
    renderContext();
    syncHistoryButtons();
    // Which 3D pictures the project's model has moved on from.
    if (objects().some(isScene) || inventoryLayers().length) {
      await getProjectModel();
      if (destroyed) return;
      if (opts.updateScenes) await updateScenes(undefined, true);
      else sayStale();
      renderContext();
      canvas.requestRenderAll();
    }
  })();
  return handle;
}
