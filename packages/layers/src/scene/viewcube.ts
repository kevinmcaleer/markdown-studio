/**
 * The view cube in the corner of the 3D scene, ported from Snakie's build
 * workspace (robot-viewcube.ts, Snakie #309): it turns with the camera.
 * Click a face, edge or corner (26 places) to look from there; drag it to
 * look around. The place under the pointer lights up.
 *
 * It has its own small canvas and WebGL context, so its pointer handling
 * can't fight the view's OrbitControls. Layers is Z up with the front
 * looking from −Y, so Snakie's Y-up cube sits in a frame turned a quarter
 * about X: its TOP is +Z, FRONT is −Y, RIGHT is +X.
 */
import {
  BoxGeometry, BufferGeometry, CanvasTexture, DirectionalLight, EdgesGeometry, Group, HemisphereLight, Line, LineBasicMaterial,
  LineSegments, Mesh, MeshBasicMaterial, MeshLambertMaterial, PerspectiveCamera, Quaternion, Raycaster, Scene, Sprite,
  SpriteMaterial, SRGBColorSpace, Vector2, Vector3, WebGLRenderer,
} from "three";

export interface ViewCube {
  /** The cube's canvas: put it where the widget goes. */
  readonly dom: HTMLCanvasElement;
  /** Turns the cube to match the view's camera. */
  sync(cameraQuaternion: Quaternion): void;
  render(): void;
  dispose(): void;
}

// BoxGeometry's material order: +X, −X, +Y, −Y, +Z, −Z (in Snakie's Y-up frame).
const FACE_LABELS = ["RIGHT", "LEFT", "TOP", "BOTTOM", "FRONT", "BACK"];

function faceTexture(text: string): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  const g = ctx.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0, "#ffffff");
  g.addColorStop(1, "#eceef2");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = "#b9bec8";
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, 122, 122);
  ctx.fillStyle = "#3a3f47";
  ctx.font = `bold ${text.length > 5 ? 20 : 22}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 64, 66);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function axisLabelTexture(text: string, colour: number): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = `#${colour.toString(16).padStart(6, "0")}`;
  ctx.font = "bold 46px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 32, 34);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * Which face, edge or corner a point on the unit cube is (`raw`: −1, 0 or 1
 * on each axis), and the direction to look from (`dir`).
 */
export function classify(p: { x: number; y: number; z: number }): { dir: Vector3; raw: Vector3 } {
  const thr = 0.32; // within 0.18 of an edge counts as the edge or corner
  const raw = new Vector3();
  [p.x, p.y, p.z].forEach((v, ax) => {
    if (Math.abs(v) >= thr) raw.setComponent(ax, v >= 0 ? 1 : -1);
  });
  if (raw.lengthSq() === 0) raw.set(0, 0, 1);
  return { dir: raw.clone().normalize(), raw };
}

export function createViewCube(opts: { size: number; onPick: (dir: Vector3) => void; onOrbit: (dxPx: number, dyPx: number) => void; onOrbitEnd?: () => void }): ViewCube {
  const { size, onPick, onOrbit, onOrbitEnd } = opts;
  const canvas = document.createElement("canvas");
  canvas.className = "lyr-viewcube";
  canvas.title = "Click a face, edge or corner to look from there. Drag to look around.";
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(size, size);

  const scene = new Scene();
  // A perspective camera of its own, so the cube always looks solid.
  const camera = new PerspectiveCamera(32, 1, 0.1, 20);
  camera.position.set(0, 0, 4.6);
  camera.lookAt(0, 0, 0);
  scene.add(new HemisphereLight(0xffffff, 0xb0b4bc, 2.6));
  const key = new DirectionalLight(0xffffff, 1.1);
  key.position.set(-0.4, -0.9, 1.4);
  scene.add(key);

  // `world` turns with the view's camera and is in Layers' frame (Z up);
  // `box` is Snakie's Y-up cube inside it, turned a quarter about X.
  const world = new Group();
  scene.add(world);
  const materials = FACE_LABELS.map(label => new MeshLambertMaterial({ map: faceTexture(label) }));
  const geometry = new BoxGeometry(1, 1, 1);
  const box = new Mesh(geometry, materials);
  box.rotation.x = Math.PI / 2;
  world.add(box);
  const edgeGeo = new EdgesGeometry(geometry);
  const edgeMat = new LineBasicMaterial({ color: 0x8a909b });
  box.add(new LineSegments(edgeGeo, edgeMat));

  // X, Y and Z (red, green, blue) along the edges from the bottom-front-left corner.
  const disposables: { dispose(): void }[] = [];
  const corner = new Vector3(-0.5, -0.5, -0.5);
  const AXES = [
    { dir: new Vector3(1, 0, 0), colour: 0xe0483a, label: "X" },
    { dir: new Vector3(0, 1, 0), colour: 0x40b04a, label: "Y" },
    { dir: new Vector3(0, 0, 1), colour: 0x4a78e0, label: "Z" },
  ];
  for (const a of AXES) {
    const tip = corner.clone().addScaledVector(a.dir, 1.32);
    const lg = new BufferGeometry().setFromPoints([corner, tip]);
    const lm = new LineBasicMaterial({ color: a.colour });
    world.add(new Line(lg, lm));
    const lt = axisLabelTexture(a.label, a.colour);
    const sm = new SpriteMaterial({ map: lt, transparent: true });
    const sprite = new Sprite(sm);
    sprite.position.copy(corner.clone().addScaledVector(a.dir, 1.52));
    sprite.scale.set(0.34, 0.34, 1);
    world.add(sprite);
    disposables.push(lg, lm, lt, sm);
  }

  // A light plate on the face, a bar on the edge, or a block on the corner under the pointer.
  const hlGeo = new BoxGeometry(1, 1, 1);
  const hlMat = new MeshBasicMaterial({ color: 0x7c5cff, transparent: true, opacity: 0.35, depthTest: false });
  const highlight = new Mesh(hlGeo, hlMat);
  highlight.visible = false;
  highlight.renderOrder = 3;
  world.add(highlight);
  const setHighlight = (raw: Vector3 | null): void => {
    highlight.visible = !!raw;
    if (!raw) return;
    highlight.position.set(raw.x * 0.5, raw.y * 0.5, raw.z * 0.5);
    const t = 0.12;
    highlight.scale.set(raw.x ? t : 0.98, raw.y ? t : 0.98, raw.z ? t : 0.98);
  };

  const raycaster = new Raycaster();
  const ndc = new Vector2();
  const pick = (e: PointerEvent): { dir: Vector3; raw: Vector3 } | null => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObject(box, false)[0];
    return hit ? classify(world.worldToLocal(hit.point.clone())) : null;
  };

  // A press that hardly moves is a click; otherwise it's a drag, by the move since the last one.
  let down: { x: number; y: number; lastX: number; lastY: number; moved: boolean } | null = null;
  const redraw = () => renderer.render(scene, camera);
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || down) return;
    e.stopPropagation();
    down = { x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false };
    canvas.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    if (down) {
      if (down.moved || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 3) {
        down.moved = true;
        onOrbit(e.clientX - down.lastX, e.clientY - down.lastY);
        setHighlight(null);
      }
      down.lastX = e.clientX;
      down.lastY = e.clientY;
      return;
    }
    const r = pick(e);
    setHighlight(r ? r.raw : null);
    redraw();
  };
  const onUp = (e: PointerEvent) => {
    canvas.releasePointerCapture?.(e.pointerId);
    const was = down;
    down = null;
    if (was && !was.moved) {
      const r = pick(e);
      if (r) onPick(r.dir);
    } else if (was) onOrbitEnd?.();
  };
  const onLeave = () => {
    if (down) return;
    setHighlight(null);
    redraw();
  };
  const onCancel = (e: PointerEvent) => {
    canvas.releasePointerCapture?.(e.pointerId);
    if (down?.moved) onOrbitEnd?.();
    down = null;
    setHighlight(null);
    redraw();
  };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onCancel);
  canvas.addEventListener("lostpointercapture", onCancel);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("contextmenu", e => e.preventDefault());

  const inv = new Quaternion();
  return {
    dom: canvas,
    sync(q) {
      inv.copy(q).invert();
      world.quaternion.copy(inv);
    },
    render: redraw,
    dispose() {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onCancel);
      canvas.removeEventListener("lostpointercapture", onCancel);
      canvas.removeEventListener("pointerleave", onLeave);
      geometry.dispose();
      edgeGeo.dispose();
      edgeMat.dispose();
      hlGeo.dispose();
      hlMat.dispose();
      disposables.forEach(d => d.dispose());
      materials.forEach(m => {
        m.map?.dispose();
        m.dispose();
      });
      renderer.dispose();
    },
  };
}
