// A scene's parts as a URDF robot, in Snakie's conventions so it opens in
// Snakie's Build workspace: metres, meshes at meshes/<file>.stl scaled
// 0.001, each joined part's link frame at its joint point (its mesh placed
// by the visual origin), joints at their zero pose with axis and limits.
//
// Each part is a link. A part joined to another is a child link; parts on
// their own hang off one base link at their place in the scene. Picked
// joints are fixed, revolute (turning about the joined faces' normal; the
// joint's spin is its angle) or prismatic (sliding along it; its gap is
// how far). A joint with no picked faces is fixed where it is.

import { Euler, Quaternion, Vector3 } from "three";
import { jointPlace } from "./joint";
import type { ScenePart, Vec3 } from "./model";

const DEG = Math.PI / 180;
const m = (mm: number) => +(mm / 1000).toFixed(6) + 0;
const rad = (deg: number) => +(deg * DEG).toFixed(6) + 0;
const f = (n: number) => +n.toFixed(6) + 0;
const xyz = (v: Vec3 | Vector3) => (Array.isArray(v) ? v : [v.x, v.y, v.z]).map(m).join(" ");
const rpy = (deg: Vec3) => deg.map(rad).join(" ");
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** The model a part draws: its file (and which solid in it), or its own upload. */
const meshKey = (p: ScenePart) => (p.url ? `u:${p.url}#${p.body ?? ""}` : `p:${p.id}`);

/** A name safe for URDF links, joints and file names. */
export function urdfName(s: string): string {
  return s.toLowerCase().replace(/\.(stl|step|stp)$/i, "").replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "part";
}

const quat = (r: Vec3) => new Quaternion().setFromEuler(new Euler(r[0] * DEG, r[1] * DEG, r[2] * DEG, "ZYX"));

export interface UrdfResult {
  urdf: string;
  /** Each mesh file the URDF names, and the parts drawn from it (the first of them carries the model). */
  meshes: { path: string; partId: string }[];
}

export function toUrdf(robot: string, parts: ScenePart[]): UrdfResult {
  const byId = new Map(parts.map(p => [p.id, p]));
  const used = new Set<string>(["base_link"]);
  const unique = (base: string) => {
    let n = base;
    for (let i = 2; used.has(n); i++) n = `${base}_${i}`;
    used.add(n);
    return n;
  };
  const link = new Map(parts.map(p => [p.id, unique(urdfName(p.name))]));
  // One mesh file per model (two copies of a screw share one).
  const meshes: UrdfResult["meshes"] = [];
  const meshOf = new Map<string, string>();
  const files = new Set<string>();
  for (const p of parts) {
    const key = meshKey(p);
    if (meshOf.has(key)) continue;
    let name = urdfName(p.file || p.name);
    for (let i = 2; files.has(name); i++) name = `${urdfName(p.file || p.name)}_${i}`;
    files.add(name);
    const path = `meshes/${name}.stl`;
    meshOf.set(key, path);
    meshes.push({ path, partId: p.id });
  }
  const joined = (p: ScenePart) => !!(p.parent && byId.has(p.parent) && p.joint?.point && p.joint.childPoint && p.joint.childNormal);
  // A joined part's link frame sits at its joint point; others at their middle.
  const offset = (p: ScenePart): Vec3 => (joined(p) ? p.joint!.childPoint! : [0, 0, 0]);

  const out: string[] = [`<?xml version="1.0"?>`, `<!-- Made with Layers 3D scenes. Units: metres. -->`, `<robot name="${esc(urdfName(robot))}">`, `  <material name="part"><color rgba="1 1 1 1"/></material>`, `  <link name="base_link"/>`];
  for (const p of parts) {
    const o = offset(p);
    out.push(
      `  <link name="${link.get(p.id)}">`,
      `    <visual>`,
      `      <origin xyz="${xyz([-o[0], -o[1], -o[2]])}" rpy="0 0 0"/>`,
      `      <geometry><mesh filename="${meshOf.get(meshKey(p))}" scale="0.001 0.001 0.001"/></geometry>`,
      `      <material name="part"/>`,
      `    </visual>`,
      `  </link>`,
    );
  }
  for (const p of parts) {
    const child = link.get(p.id)!;
    const parent = p.parent && byId.has(p.parent) ? byId.get(p.parent)! : null;
    const po: Vec3 = parent ? offset(parent) : [0, 0, 0];
    const j = p.joint;
    const type = joined(p) && j?.type ? j.type : "fixed";
    let position: Vec3 = p.position;
    let rotation: Vec3 = p.rotation;
    if (joined(p)) {
      // The zero pose: a turning joint at no spin, a sliding one at no gap.
      const at = jointPlace({ point: j!.point!, normal: j!.normal, childPoint: j!.childPoint!, childNormal: j!.childNormal!, spin: type === "revolute" ? 0 : j!.spin || 0, gap: type === "prismatic" ? 0 : j!.gap || 0 });
      position = at.position;
      rotation = at.rotation;
    }
    const q = quat(rotation);
    const o = offset(p);
    // The child's link frame, in the parent's link frame.
    const origin = new Vector3(...o).applyQuaternion(q).add(new Vector3(...position)).sub(new Vector3(...po));
    out.push(
      `  <joint name="${child}_joint" type="${type}">`,
      `    <parent link="${parent ? link.get(parent.id) : "base_link"}"/>`,
      `    <child link="${child}"/>`,
      `    <origin xyz="${xyz(origin)}" rpy="${rpy(rotation)}"/>`,
    );
    if (type !== "fixed") {
      const axis = new Vector3(...j!.normal).normalize().applyQuaternion(q.clone().invert());
      const lower = j!.lower ?? 0;
      const upper = j!.upper ?? 0;
      out.push(
        `    <axis xyz="${f(axis.x)} ${f(axis.y)} ${f(axis.z)}"/>`,
        type === "revolute"
          ? `    <limit lower="${rad(lower)}" upper="${rad(upper)}" effort="1" velocity="1"/>`
          : `    <limit lower="${m(lower)}" upper="${m(upper)}" effort="1" velocity="1"/>`,
      );
    }
    out.push(`  </joint>`);
  }
  out.push(`</robot>`, ``);
  return { urdf: out.join("\n"), meshes };
}

// ------------------------------------------------------------ a zip, stored

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A .zip of these files, uncompressed (STL and URDF are small enough, and it needs no library). */
export function zip(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  // The time stamp, in DOS form, so unzipped files aren't dated 1980.
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const file of files) {
    const name = enc.encode(file.name);
    const crc = crc32(file.data);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, 0x0800, true); // UTF-8 names
    head.setUint16(10, time, true);
    head.setUint16(12, date, true);
    head.setUint32(14, crc, true);
    head.setUint32(18, file.data.length, true);
    head.setUint32(22, file.data.length, true);
    head.setUint16(26, name.length, true);
    parts.push(new Uint8Array(head.buffer), name, file.data);
    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint16(8, 0x0800, true);
    dir.setUint16(12, time, true);
    dir.setUint16(14, date, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, file.data.length, true);
    dir.setUint32(24, file.data.length, true);
    dir.setUint16(28, name.length, true);
    dir.setUint32(42, offset, true);
    central.push(new Uint8Array(dir.buffer), name);
    offset += 30 + name.length + file.data.length;
  }
  const size = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
  let at = 0;
  for (const c of all) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
