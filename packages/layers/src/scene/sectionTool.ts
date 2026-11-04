// The 3D workspace's section view, as Fusion 360's section analysis: click
// a face, and a plane parallel to it cuts the parts; drag its arrow (or type
// a distance) to slide the cut through them. The cut faces are filled and
// hatched (render.ts). The section is part of the scene, so the picture Done
// draws is cut the same way.

import { BufferGeometry, DoubleSide, LineBasicMaterial, LineLoop, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry, Quaternion, Raycaster, Vector2, Vector3, type OrthographicCamera } from "three";
import { icon } from "../icons";
import { sectionOrigin, type SectionPlane, type Vec3 } from "./model";
import type { LineArt } from "./render";

export interface SectionHost {
  frame: HTMLElement;
  canvas: HTMLCanvasElement;
  camera: OrthographicCamera;
  art: LineArt;
  /** The view's size in CSS pixels. */
  size(): { w: number; h: number };
  get(): SectionPlane | undefined;
  /** Sets the scene's section (undefined: none) and draws it. */
  set(s: SectionPlane | undefined): void;
  /** Saves the step for undo. */
  commit(): void;
  status(text: string, bad?: boolean, sticky?: boolean): void;
  draw(): void;
  /** The face a triangle of a part belongs to: its triangles (part's frame) and, when flat, its normal. */
  face?(partId: string, triangle: number): { geometry: BufferGeometry; normal: Vec3 | null } | null;
  /** Called as picking starts and stops. */
  onPicking?(on: boolean): void;
}

export interface SectionTool {
  picking(): boolean;
  /** Starts picking a face for the plane. */
  start(): void;
  stop(message?: string): void;
  /** A click on the view while picking. */
  click(e: { clientX: number; clientY: number }): void;
  hover(e: { clientX: number; clientY: number }): void;
  /** Puts the plane, its arrow and its box where the section is, as drawn now. */
  place(): void;
  dispose(): void;
}

const round = (n: number, places = 2) => {
  const f = 10 ** places;
  const r = Math.round(n * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

export function createSectionTool(host: SectionHost): SectionTool {
  const { art, camera, canvas } = host;
  let picking = false;
  const raycaster = new Raycaster();

  // The plane, drawn faint over the view with its edge (not in the picture).
  const planeFill = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ color: 0x1f6fe0, transparent: true, opacity: 0.07, depthTest: false, depthWrite: false, side: DoubleSide }));
  const edgeGeometry = new BufferGeometry().setFromPoints([new Vector3(-0.5, -0.5, 0), new Vector3(0.5, -0.5, 0), new Vector3(0.5, 0.5, 0), new Vector3(-0.5, 0.5, 0)]);
  const planeEdge = new LineLoop(edgeGeometry, new LineBasicMaterial({ color: 0x1f6fe0, transparent: true, opacity: 0.55, depthTest: false }));
  // The face under the pointer while picking.
  const tint = new Mesh(new BufferGeometry(), new MeshBasicMaterial({ color: 0x4ea1ff, transparent: true, opacity: 0.32, depthTest: false, depthWrite: false, side: DoubleSide }));
  for (const o of [planeFill, planeEdge, tint]) {
    o.matrixAutoUpdate = false;
    o.visible = false;
    o.raycast = () => {};
    art.overlay.add(o);
  }

  // The arrow (drag it to slide the cut), its distance box, and the section's bar.
  const el = document.createElement("div");
  el.className = "lyr-scene-sect";
  el.hidden = true;
  el.innerHTML = `<svg>
      <line class="lyr-sect-shaft"></line>
      <line class="lyr-sect-hit"></line>
      <path class="lyr-sect-head"></path>
      <circle class="lyr-sect-base" r="5"></circle>
    </svg>
    <label class="lyr-sect-field" title="How far the cut is from the face picked. Drag the arrow (Shift for whole mm) or type it.">
      <input type="number" step="0.5" aria-label="Section distance, mm"><em>mm</em>
    </label>`;
  host.frame.appendChild(el);
  const shaft = el.querySelector(".lyr-sect-shaft")!;
  const hitLine = el.querySelector(".lyr-sect-hit")!;
  const head = el.querySelector(".lyr-sect-head")!;
  const base = el.querySelector(".lyr-sect-base")!;
  const field = el.querySelector<HTMLElement>(".lyr-sect-field")!;
  const input = field.querySelector("input")!;

  const bar = document.createElement("div");
  bar.className = "lyr-scene-sect-bar";
  bar.hidden = true;
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Section view");
  bar.innerHTML = `
    <span class="lyr-sect-title">${icon("section", 16)}<span>Section</span></span>
    <button type="button" class="lyr-btn" data-sect="flip" title="Cut away the other side">${icon("flipV", 16)}<span>Flip</span></button>
    <label class="lyr-scene-check" title="Hatch the cut faces, a different pattern for each part"><input type="checkbox" data-sect-hatch checked> Hatch</label>
    <button type="button" class="lyr-btn" data-sect="pick" title="Pick another face to cut parallel to">Pick a face</button>
    <button type="button" class="lyr-btn lyr-icon-btn" data-sect="off" title="Remove the section view" aria-label="Remove the section view">${icon("close", 16)}</button>`;
  host.frame.appendChild(bar);
  const hatchBox = bar.querySelector<HTMLInputElement>("[data-sect-hatch]")!;

  const toScreen = (v: Vector3) => {
    const { w, h } = host.size();
    const q = v.clone().project(camera);
    return { x: ((q.x + 1) / 2) * w, y: ((1 - q.y) / 2) * h };
  };
  /** Pixels per mm across the view. */
  const pxPerMm = () => host.size().h / (2 * (camera.top / camera.zoom));

  /** The arrow as drawn now: its base, unit direction on screen, and pixels per mm of slide. */
  let arrow: { x: number; y: number; dx: number; dy: number; px: number } | null = null;

  function place(): void {
    const s = host.get();
    bar.hidden = !s && !picking;
    bar.classList.toggle("lyr-picking", picking && !s);
    if (!s) {
      el.hidden = true;
      planeFill.visible = planeEdge.visible = false;
      arrow = null;
      return;
    }
    hatchBox.checked = !s.plain;
    const n = new Vector3(...s.normal).normalize();
    const c = new Vector3(...sectionOrigin(s));
    // The plane: a square on it round the parts, a little bigger than them.
    const box = art.bounds();
    const centre = box.isEmpty() ? c.clone() : box.getCenter(new Vector3());
    const onPlane = centre.clone().addScaledVector(n, c.clone().sub(centre).dot(n));
    const size = Math.max(10, (box.isEmpty() ? 50 : box.getSize(new Vector3()).length()) * 1.1);
    const m = new Matrix4().compose(onPlane, new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), n), new Vector3(size, size, 1));
    for (const o of [planeFill, planeEdge]) {
      o.matrix.copy(m);
      o.matrixWorldNeedsUpdate = true;
      o.visible = true;
    }
    // The arrow: from the plane's point along its normal, about 64 px long.
    const a0 = toScreen(c);
    const a1 = toScreen(c.clone().add(n));
    let dx = a1.x - a0.x, dy = a1.y - a0.y;
    let px = Math.hypot(dx, dy);
    const flat = px < pxPerMm() * 0.2;
    if (flat) {
      // Looking straight along the normal: the arrow points up the screen, a mm a view mm.
      const toward = n.dot(new Vector3().subVectors(camera.position, c)) > 0;
      dx = 0;
      dy = toward ? -1 : 1;
      px = pxPerMm();
    } else {
      dx /= px;
      dy /= px;
    }
    const len = 64;
    const tip = { x: a0.x + dx * len, y: a0.y + dy * len };
    arrow = { x: a0.x, y: a0.y, dx, dy, px };
    for (const l of [shaft, hitLine]) {
      l.setAttribute("x1", a0.x.toFixed(1));
      l.setAttribute("y1", a0.y.toFixed(1));
      l.setAttribute("x2", tip.x.toFixed(1));
      l.setAttribute("y2", tip.y.toFixed(1));
    }
    el.classList.toggle("lyr-flat", flat);
    const hw = 7, hl = 14;
    const bx = tip.x - dx * hl, by = tip.y - dy * hl;
    head.setAttribute("d", `M${tip.x.toFixed(1)},${tip.y.toFixed(1)}L${(bx - dy * hw).toFixed(1)},${(by + dx * hw).toFixed(1)}L${(bx + dy * hw).toFixed(1)},${(by - dx * hw).toFixed(1)}Z`);
    base.setAttribute("cx", a0.x.toFixed(1));
    base.setAttribute("cy", a0.y.toFixed(1));
    // The box beyond the tip, clear of it whichever way it points.
    const fw = field.offsetWidth || 90, fh = field.offsetHeight || 24;
    const gap = 10 + Math.min(Math.abs(dx) > 1e-3 ? fw / 2 / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-3 ? fh / 2 / Math.abs(dy) : Infinity);
    field.style.left = `${Math.round(tip.x + dx * gap)}px`;
    field.style.top = `${Math.round(tip.y + dy * gap)}px`;
    if (document.activeElement !== input) input.value = String(round(s.offset, 2));
    el.hidden = false;
  }

  function setOffset(mm: number): void {
    const s = host.get();
    if (!s || !Number.isFinite(mm)) return;
    host.set({ ...s, offset: round(mm, 2) });
  }

  el.addEventListener("pointerdown", e => {
    const t = e.target as Element;
    if (e.button !== 0 || !arrow || !(t.matches(".lyr-sect-hit") || t.matches(".lyr-sect-head") || t.matches(".lyr-sect-base"))) return;
    const s = host.get();
    if (!s) return;
    e.preventDefault();
    e.stopPropagation();
    const target = t as SVGElement;
    target.setPointerCapture(e.pointerId);
    el.classList.add("lyr-dragging");
    const from = { x: e.clientX, y: e.clientY };
    const start = s.offset;
    const a = { ...arrow };
    const move = (m: PointerEvent) => {
      const along = (m.clientX - from.x) * a.dx + (m.clientY - from.y) * a.dy;
      let mm = start + along / a.px;
      mm = m.shiftKey ? Math.round(mm) : Math.round(mm * 10) / 10;
      setOffset(mm);
    };
    const up = () => {
      el.classList.remove("lyr-dragging");
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      host.commit();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  });
  input.addEventListener("input", () => {
    if (input.value !== "") setOffset(Number(input.value));
  });
  input.addEventListener("change", () => {
    const s = host.get();
    if (s) input.value = String(round(s.offset, 2));
    host.commit();
  });
  // Keys typed in the box stay out of the scene's shortcuts (Enter and Esc leave it).
  input.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Enter" || e.key === "Escape") input.blur();
  });

  bar.addEventListener("click", e => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-sect]");
    if (!b) return;
    const s = host.get();
    switch (b.dataset.sect) {
      case "flip":
        // The plane stays put; the other side is cut away.
        if (s) {
          host.set({ ...s, normal: s.normal.map(v => (v === 0 ? 0 : -v)) as Vec3, offset: s.offset === 0 ? 0 : -s.offset });
          host.commit();
        }
        break;
      case "pick":
        start();
        break;
      case "off":
        stop();
        host.set(undefined);
        host.commit();
        host.status("Section view removed.");
        break;
    }
  });
  bar.addEventListener("change", e => {
    const t = e.target as HTMLInputElement;
    const s = host.get();
    if (t.dataset.sectHatch === undefined || !s) return;
    const next: SectionPlane = { ...s };
    if (t.checked) delete next.plain;
    else next.plain = true;
    host.set(next);
    host.commit();
  });

  // ------------------------------------------------------------ picking a face

  /** The part's face under the pointer, kept by the section (a cut-away face can't be had). */
  function hitAt(e: { clientX: number; clientY: number }) {
    const r = canvas.getBoundingClientRect();
    raycaster.setFromCamera(new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    art.scene.updateMatrixWorld(true);
    return raycaster.intersectObjects(art.meshes(), false).find(h => h.face && h.faceIndex !== undefined && art.keeps(h.point)) || null;
  }

  function hover(e: { clientX: number; clientY: number }): void {
    if (!picking) return;
    const hit = hitAt(e);
    const f = hit && host.face ? host.face(String(hit.object.userData.partId || ""), hit.faceIndex!) : null;
    if (hit && f) {
      tint.geometry = f.geometry;
      tint.matrix.copy(hit.object.matrixWorld);
      tint.matrixWorldNeedsUpdate = true;
      tint.visible = true;
    } else tint.visible = false;
    host.draw();
  }

  function click(e: { clientX: number; clientY: number }): void {
    if (!picking) return;
    const hit = hitAt(e);
    if (!hit) {
      host.status("Click a face on a part. Esc to stop.", true, true);
      return;
    }
    const f = host.face ? host.face(String(hit.object.userData.partId || ""), hit.faceIndex!) : null;
    // A flat face's own normal (one triangle's can lean on a finely cut model); the triangle's on a curved face.
    const local = f?.normal ? new Vector3(...f.normal) : hit.face!.normal.clone();
    const n = local.transformDirection(hit.object.matrixWorld).normalize();
    const p = hit.point;
    stop();
    host.set({ point: [round(p.x, 3), round(p.y, 3), round(p.z, 3)], normal: [round(n.x, 5), round(n.y, 5), round(n.z, 5)], offset: 0 });
    host.commit();
    host.status("Drag the arrow into the parts, or type a distance, to slide the cut through them.", false, true);
  }

  function start(): void {
    picking = true;
    canvas.classList.add("lyr-scene-picking");
    host.onPicking?.(true);
    host.status("Section: click a face to cut parallel to it. Esc to stop.", false, true);
    place();
    host.draw();
  }

  function stop(message?: string): void {
    if (!picking) return;
    picking = false;
    tint.visible = false;
    canvas.classList.remove("lyr-scene-picking");
    host.onPicking?.(false);
    if (message !== undefined) host.status(message);
    place();
    host.draw();
  }

  return {
    picking: () => picking,
    start,
    stop,
    click,
    hover,
    place,
    dispose(): void {
      for (const o of [planeFill, planeEdge, tint]) art.overlay.remove(o);
      planeFill.geometry.dispose();
      edgeGeometry.dispose();
      (planeFill.material as MeshBasicMaterial).dispose();
      (planeEdge.material as LineBasicMaterial).dispose();
      (tint.material as MeshBasicMaterial).dispose();
      el.remove();
      bar.remove();
    },
  };
}
