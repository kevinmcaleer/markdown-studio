// The 3D scene workspace: opened from a scene layer, full screen, over the
// editor. Parts (STL models) are added from the host's models or by
// uploading or dropping them; each is placed with handles on the view or
// with exact numbers (X, Y, Z in mm; roll, pitch, yaw in degrees). The view
// is drawn in the scene's own style, the shape of the layer, on the page's
// colour, so what you see is the picture you get. Done draws the picture.
//
// This module and three.js load only when a scene is opened.

import { Euler, Matrix4, Object3D, OrthographicCamera, Quaternion, Raycaster, Vector2, Vector3 } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { icon } from "../icons";
import {
  applyPreset, normalizeScene, newPartId, partName, placeBeside, STYLE_PRESETS, VIEWS, wrapAngle,
  type Box3 as PlainBox, type SceneData, type ScenePart, type SceneStyle, type Vec3,
} from "./model";
import { frame, LineArt, modelFromStl, ModelStore, placeCamera, radiusOf, renderPicture, worldMatrices, type FetchModel, type Model } from "./render";
import { MAX_EMBED, parseStl, toBase64, toBinaryStl } from "./stl";

export interface SceneModel {
  url: string;
  title?: string;
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
            <div class="lyr-panel-title">Parts</div>
            <ul class="lyr-scene-list"></ul>
            <p class="lyr-note">Add STL files, or drop them on the view. Click a part to place it.</p>
          </aside>
          <div class="lyr-scene-stage">
            <div class="lyr-scene-tools" role="toolbar" aria-label="View">
              <button type="button" class="lyr-btn" data-tool="translate" title="Move parts with the handles (M)">${icon("move", 16)}<span>Move</span></button>
              <button type="button" class="lyr-btn" data-tool="rotate" title="Turn parts with the handles (R)">${icon("rotate", 16)}<span>Turn</span></button>
              <span class="lyr-sep"></span>
              ${VIEWS.map(v => `<button type="button" class="lyr-btn" data-view="${v.id}" title="Look from the ${esc(v.label.toLowerCase())}">${esc(v.label)}</button>`).join("")}
              <span class="lyr-sep"></span>
              <button type="button" class="lyr-btn" data-act="fit" title="Fit the parts in the picture (F)">${icon("frame", 16)}<span>Fit</span></button>
            </div>
            <div class="lyr-scene-frame"><canvas class="lyr-scene-canvas"></canvas></div>
            <div class="lyr-scene-help">Drag to look around, right-drag to pan, scroll to zoom. Hold Shift on a handle for 5 mm or 15° steps.</div>
            <div class="lyr-drop" hidden>Drop STL files to add them</div>
          </div>
          <aside class="lyr-scene-side lyr-scene-props" aria-label="Part and style"></aside>
        </div>
        <input type="file" class="lyr-file" accept=".stl,model/stl,application/sla" multiple hidden>
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
      });
    }

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

    orbit.addEventListener("change", () => {
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

    async function addModel(source: { url?: string; buffer?: ArrayBuffer; name: string }): Promise<void> {
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

    async function addFiles(files: Iterable<File>): Promise<void> {
      for (const f of files) {
        if (!/\.stl$/i.test(f.name)) {
          status(`${f.name} isn't an STL file.`, true);
          continue;
        }
        await addModel({ buffer: await f.arrayBuffer(), name: partName(f.name) });
      }
    }

    function removePart(id: string): void {
      const p = partById(id);
      if (!p) return;
      // Parts joined to it stay where they are, standing on their own.
      const world = worldMatrices(scene.parts, 0);
      for (const c of scene.parts) {
        if (c.parent !== id) continue;
        setLocalFromWorld(c, world.get(c.id)!, null);
        delete c.parent;
        delete c.joint;
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
      if (part.joint && scene.explode > 0) {
        const n = new Vector3(...part.joint.normal).normalize().multiplyScalar(part.joint.distance * scene.explode);
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
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4 || gizmo.dragging || (gizmo as unknown as { axis: string | null }).axis) return;
      const r = canvasEl.getBoundingClientRect();
      const ndc = new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      art.scene.updateMatrixWorld(true);
      raycaster.setFromCamera(ndc, camera);
      const hit = raycaster.intersectObjects(art.meshes(), false)[0];
      select(hit ? String(hit.object.userData.partId || "") : "");
    });

    function select(id: string): void {
      selectedId = id;
      attachGizmo();
      renderList();
      renderProps();
      draw();
    }

    // ------------------------------------------------------------ views

    function fitView(): void {
      art.scene.updateMatrixWorld(true);
      scene.camera = frame(scene.camera, art.bounds(), aspect);
      applyCamera();
      draw();
    }

    function setView(id: string): void {
      const v = VIEWS.find(x => x.id === id);
      if (!v) return;
      scene.camera.direction = [...v.direction];
      fitView();
      commit();
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
      const s = JSON.parse(text) as SceneData;
      s.parts.forEach(p => {
        if (p.data?.startsWith("#")) p.data = embedded.get(p.data.slice(1));
      });
      scene = clone(s);
      if (selectedId && !partById(selectedId)) selectedId = "";
      void loadModels().then(() => {
        rebuild();
        applyCamera();
        renderProps();
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
      list.innerHTML = scene.parts.length
        ? scene.parts.map(p => {
            const m = models.get(p.id);
            const broken = m instanceof Error;
            return `<li class="lyr-scene-row${p.id === selectedId ? " lyr-on" : ""}${p.hidden ? " lyr-off" : ""}" data-id="${esc(p.id)}">
              <button type="button" class="lyr-scene-name" data-pick="${esc(p.id)}" title="${broken ? "Its model couldn't be loaded" : "Select"}">${icon("cube", 14)}<span>${esc(p.name)}</span>${broken ? `<em>missing</em>` : ""}</button>
              <button type="button" class="lyr-btn lyr-icon-btn${p.highlight ? " lyr-on" : ""}" data-highlight="${esc(p.id)}" title="${p.highlight ? "Stop highlighting" : "Highlight"}" aria-label="Highlight ${esc(p.name)}" aria-pressed="${!!p.highlight}">${icon("highlight", 16)}</button>
              <button type="button" class="lyr-btn lyr-icon-btn" data-hide="${esc(p.id)}" title="${p.hidden ? "Show" : "Hide"}" aria-label="${p.hidden ? "Show" : "Hide"} ${esc(p.name)}">${icon(p.hidden ? "eyeOff" : "eye", 16)}</button>
              <button type="button" class="lyr-btn lyr-icon-btn" data-remove="${esc(p.id)}" title="Remove" aria-label="Remove ${esc(p.name)}">${icon("trash", 16)}</button>
            </li>`;
          }).join("")
        : `<li class="lyr-note">No parts yet.</li>`;
    }

    list.addEventListener("click", e => {
      const b = (e.target as HTMLElement).closest("button");
      if (!b) return;
      const d = b.dataset;
      if (d.pick) select(d.pick === selectedId ? "" : d.pick);
      else if (d.highlight) {
        const p = partById(d.highlight);
        if (!p) return;
        p.highlight = !p.highlight || undefined;
        if (!p.highlight) delete p.highlight;
        rebuild();
        commit();
        renderProps();
      } else if (d.hide) {
        const p = partById(d.hide);
        if (!p) return;
        if (p.hidden) delete p.hidden;
        else p.hidden = true;
        rebuild();
        commit();
      } else if (d.remove) removePart(d.remove);
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
        follow();
      } else if (rot >= 0 && p) {
        p.rotation[rot] = round(wrapAngle(value));
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

    function renderProps(): void {
      const p = partById(selectedId);
      const parent = p?.parent ? partById(p.parent) : undefined;
      props.innerHTML = `
        <section class="lyr-scene-section">
          <div class="lyr-panel-title">Part</div>
          ${p ? `
            <label class="lyr-scene-namebox">Name <input type="text" maxlength="120" data-name value="${esc(p.name)}"></label>
            ${parent ? `<p class="lyr-note">Joined to ${esc(parent.name)}: its numbers are from that part.</p>` : ""}
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
          </div>
          <div class="lyr-scene-fields">
            ${field("lineWidth", "Lines", "px", scene.style.lineWidth, 0.5, "Fine fold lines")}
            ${field("outline", "Outline", "px", scene.style.outline, 0.5, "The bold line round each part")}
            ${field("crease", "Folds", "°", scene.style.crease, 1, "How sharp a fold must be to get a line (180: none)")}
          </div>
          <p class="lyr-note">The background is the page's colour: change it in Layers.</p>
        </section>`;
      syncPresets();
    }

    props.addEventListener("input", e => {
      const t = e.target as HTMLInputElement;
      if (t.dataset.field) setField(t.dataset.field, Number(t.value));
      else if (t.dataset.colour) {
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
        <button type="button" class="lyr-scene-menu-item" role="menuitem" data-act="upload">${icon("upload", 16)}<span>Upload an STL file…</span></button>
        ${opts.listModels ? `<div class="lyr-panel-title">Your project's models</div><div class="lyr-scene-models"><span class="lyr-note">Loading…</span></div>` : ""}`;
      if (!opts.listModels) return;
      try {
        const found = (await opts.listModels()).filter(m => /\.stl(\?|#|$)/i.test(m.url) || /\.stl$/i.test(m.title || ""));
        const box = menu.querySelector(".lyr-scene-models");
        if (!box || menu.hidden) return;
        box.innerHTML = found.length
          ? found.map((m, i) => `<button type="button" class="lyr-scene-menu-item" role="menuitem" data-model="${i}">${icon("cube", 16)}<span>${esc(m.title || partName(m.url))}</span></button>`).join("")
          : `<span class="lyr-note">No STL files in this project yet.</span>`;
        box.querySelectorAll<HTMLElement>("[data-model]").forEach(b => {
          const m = found[Number(b.dataset.model)];
          b.addEventListener("click", () => {
            closeMenu();
            void addModel({ url: m.url, name: partName(m.title || m.url) });
          });
        });
      } catch {
        const box = menu.querySelector(".lyr-scene-models");
        if (box) box.innerHTML = `<span class="lyr-note">Your models couldn't be loaded.</span>`;
      }
    }
    function closeMenu(): void {
      menu.hidden = true;
      menu.innerHTML = "";
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

    // ------------------------------------------------------------ actions

    root.addEventListener("click", e => {
      const b = (e.target as HTMLElement).closest("button");
      if (!menu.hidden && !menu.contains(e.target as Node) && b?.dataset.act !== "add") closeMenu();
      if (!b) return;
      if (b.dataset.tool) {
        tool = b.dataset.tool as typeof tool;
        attachGizmo();
        draw();
      } else if (b.dataset.view) setView(b.dataset.view);
      switch (b.dataset.act) {
        case "add": if (menu.hidden) void openMenu(); else closeMenu(); break;
        case "upload": closeMenu(); fileInput.click(); break;
        case "fit": fitView(); commit(); break;
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
      } else if (e.key === "Escape") {
        if (!menu.hidden) closeMenu();
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
        const picture = await renderPicture(out, opts.store, opts.width, opts.height, opts.scale);
        close({ scene: out, picture });
      } catch (e) {
        status(e instanceof Error && e.message ? `The picture couldn't be drawn: ${e.message}` : "The picture couldn't be drawn.", true, true);
        btn.disabled = false;
        busy = false;
      }
    }

    // ------------------------------------------------------------ start

    syncHistory();
    renderList();
    renderProps();
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
