// The Layers editor: a Canva-style page of text, shapes and pictures.
//
// One editor works both in the page (inline, at the column's width) and full
// screen; switching moves the same editor between the two, so nothing is
// lost. The side rail adds things (templates, elements, text, uploads) and
// manages layers and the page; the bar above the page changes with what is
// selected. Done hands the host the layer document and a PNG of the page
// with the document stored inside it.

import {
  ActiveSelection, Canvas, Control, FabricImage, FabricObject, Group, Point, Polygon, Textbox, util, type TPointerEventInfo, type TPointerEvent,
} from "fabric";
import { Connector, type ConnectorEnd } from "./connector";
import { blankDoc, clampSide, embedDoc, defaultFetch, MAX_SIDE, MIN_SIDE, normalizeDoc, SIZES, type LayersDoc } from "./doc";
import {
  ACCENT, badge, boundTo, canHoldText, FONTS, INK, isLine, isText, kindOf, LINES, makeShape, makeText, newId, PALETTE, SHAPES, shapeText, TEMPLATES, TEXT_STYLES,
  type Point as XY,
} from "./elements";
import { boxSides, dist, distToSegment, facingSide, polygonSides, SIDES, snapAngle, type Pt, type Side } from "./geometry";
import { icon } from "./icons";
import { snap, type Box, type Guide } from "./snap";
import css from "./layers.css?inline";

FabricObject.customProperties = ["name", "layerId", "layerLocked", "badge", "boundTo"];
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
  focus(): void;
  destroy(): void;
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
    if (o instanceof Connector) {
      // A line is changed by its two ends, which snap to other layers.
      o.controls = lineControls;
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
      if (o instanceof Connector) syncConnector(o);
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
      return distToSegment(p, a, b) <= (Number(o.strokeWidth) || 1) / 2 + 8 / zoom;
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

  function nextBadge(): number {
    const ns = objects().map(o => Number((o as FabricObject & { badge?: number }).badge) || 0);
    return Math.max(0, ...ns) + 1;
  }

  function addKind(kind: string, at?: XY): void {
    if (kind === "badge") {
      add(badge(nextBadge(), { x: 0, y: 0 }, lastColor.badge || ACCENT), at);
      return;
    }
    const o = makeShape(kind, { x: 0, y: 0 }, isLineKind(kind) ? lastColor.line || INK : lastColor.shape || "#74c0fc");
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
    if (!t || ev?.altKey) {
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
  canvas.on("object:moving", e => {
    if (e.target instanceof Connector) {
      e.target.connFrom = null;
      e.target.connTo = null;
    }
    follow();
  });
  for (const ev of ["object:scaling", "object:rotating", "object:resizing", "object:skewing"] as const) canvas.on(ev, () => follow());
  canvas.on("after:render", ({ ctx }) => {
    if (!ctx) return;
    drawConnectHints(ctx);
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
    if (y < 4) y = (b.top + b.height) * zoom + 12;
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
        ${swatch("badgeFill", String(circle?.fill || ACCENT), "Colour")}`;
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
        <button type="button" class="lyr-btn${o.arrowEnd ? " lyr-on" : ""}" data-toggle="arrowEnd" title="Arrow at the end" aria-label="Arrow at the end">${icon("arrowEnd")}</button>` : ""}
        <button type="button" class="lyr-btn" data-act="flip-x" title="Flip direction" aria-label="Flip direction">${icon("flipH")}</button>`;
    } else if (!(o instanceof ActiveSelection) && !(o instanceof Group)) {
      html += `
        ${swatch("fill", String(o.fill || ""), "Colour")}
        ${swatch("stroke", String(o.stroke || ""), "Border colour", "border")}
        ${borderWidth(o)}
        <button type="button" class="lyr-btn${o.strokeDashArray?.length ? " lyr-on" : ""}" data-toggle="dash" title="Dashed border" aria-label="Dashed border">${icon("dash")}</button>
        ${o.type === "rect" ? cornerControl(o) : ""}`;
      if (canHoldText(o)) {
        const t = textFor(o);
        html += t
          ? `<span class="lyr-sep"></span>${textTools(t, "textFill")}`
          : `<button type="button" class="lyr-btn" data-act="shape-text" title="Add text to the shape (Enter, or double-click it)">${icon("textInShape")}<span>Add text</span></button>`;
      }
    } else {
      html += `<span class="lyr-label">${selected().length} selected</span>`;
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

  function setBadge(o: FabricObject, n: number): void {
    const g = o as Group & { badge?: number; name?: string };
    const label = g.getObjects()[1] as Textbox | undefined;
    if (!label) return;
    const was = g.badge;
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
      if (o instanceof Connector && (el.dataset.toggle === "arrowStart" || el.dataset.toggle === "arrowEnd")) {
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
    if (!prop || !o) return;
    if (prop === "fontFamily") apply({ fontFamily: el.value }, textTargets());
    if (prop === "fontSize") applyFontSize(Number(el.value));
    if (prop === "strokeWidth") {
      const w = Math.max(0, Number(el.value) || 0);
      apply({ strokeWidth: w, ...(o.strokeWidth === 0 && !o.stroke && w ? { stroke: INK } : {}) });
    }
    if (prop === "badge") setBadge(o, Number(el.value));
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
        const list = t.build(W, H);
        list.forEach(o => {
          prepare(o);
          canvas.add(o);
        });
        selectAll(list);
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
  canvas.on("object:modified", onChange);
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
    let url: string;
    try {
      url = canvas.toDataURL({ format: "png", multiplier: 1, left: 0, top: 0, width: W, height: H, enableRetinaScaling: false });
    } finally {
      canvas.backgroundColor = "";
      canvas.setViewportTransform(vpt);
      if (sel) canvas.setActiveObject(sel);
      canvas.requestRenderAll();
    }
    const bytes = Uint8Array.from(atob(url.split(",")[1]), c => c.charCodeAt(0));
    const withDoc = await embedDoc(bytes, doc);
    return new Blob([withDoc as BlobPart], { type: "image/png" });
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
    focus: () => root.focus({ preventScroll: true }),
    destroy,
  };

  root.dataset.mode = "";
  syncHistoryButtons();
  void (async () => {
    if (start.objects.length) await load(start);
    else if (opts.picture) await startFromPicture(opts.picture);
    if (destroyed) return;
    current = snapshot();
    saved = current;
    setMode(mode);
    renderContext();
    syncHistoryButtons();
  })();
  return handle;
}
