// "Sit on the part beneath": moves a part along a direction (the scene's
// up, so it drops as gravity would) until it rests on what's beneath it, so
// a battery sits on the chassis' floor instead of sinking into it (or
// floating over it).
//
// The part's and the parts beneath's triangles are drawn into a height map
// over the part's footprint, looking along the direction: the child's lowest point in each cell,
// and the parent's highest point that's still below the child's middle (so a
// well's floor counts, not the lid above it). The move is the most any cell
// needs to clear its parent point: the part ends touching, not inside.
//
// Like the track's "Sit on wheels" (track.ts insideReach), it works from the
// meshes, not from boxes, so hollow and stepped parts sit where they would.

import { Matrix4, Vector3 } from "three";
import type { Vec3 } from "./model";

/** How many cells across the child's footprint, on its longer side. */
const CELLS = 96;

/**
 * How far to move the child along `normal` (in the parent's frame) so it
 * rests on the parent: positive moves it out along the normal, negative in.
 * `childToParent` places the child's triangles in the parent's frame. Null
 * when nothing of the parent lies beneath the child.
 */
export function sitDelta(parent: ArrayLike<number>, child: ArrayLike<number>, childToParent: Matrix4, normal: Vec3): number | null {
  const n = new Vector3(...normal).normalize();
  if (!(n.lengthSq() > 0)) return null;
  // Two directions across the normal, for the map's columns.
  const u = Math.abs(n.x) < 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
  u.sub(n.clone().multiplyScalar(u.dot(n))).normalize();
  const v = n.clone().cross(u);

  // The child's corners in (u, v, height).
  const cc = new Float64Array(child.length);
  const p = new Vector3();
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity, h0 = Infinity, h1 = -Infinity;
  for (let i = 0; i + 2 < child.length; i += 3) {
    p.set(child[i], child[i + 1], child[i + 2]).applyMatrix4(childToParent);
    const a = p.dot(u), b = p.dot(v), h = p.dot(n);
    cc[i] = a;
    cc[i + 1] = b;
    cc[i + 2] = h;
    if (a < u0) u0 = a;
    if (a > u1) u1 = a;
    if (b < v0) v0 = b;
    if (b > v1) v1 = b;
    if (h < h0) h0 = h;
    if (h > h1) h1 = h;
  }
  if (!(u1 >= u0)) return null;
  const middle = (h0 + h1) / 2;
  const cell = Math.max((Math.max(u1 - u0, v1 - v0) || 1) / CELLS, 0.05);
  const nu = Math.max(1, Math.ceil((u1 - u0) / cell)), nv = Math.max(1, Math.ceil((v1 - v0) / cell));
  const low = new Float64Array(nu * nv).fill(Infinity);

  /** Calls `put` with each cell a triangle covers, and its height there. */
  const raster = (ax: number, ay: number, ah: number, bx: number, by: number, bh: number, cx: number, cy: number, ch: number, put: (k: number, h: number) => void) => {
    // Its corners count even when it's thinner than a cell.
    for (const [x, y, h] of [[ax, ay, ah], [bx, by, bh], [cx, cy, ch]]) {
      const i = Math.floor((x - u0) / cell), j = Math.floor((y - v0) / cell);
      if (i >= 0 && j >= 0 && i < nu && j < nv) put(j * nu + i, h);
    }
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    // Edge-on to the normal (a wall): its corners are enough.
    if (Math.abs(den) < 1e-9) return;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - u0) / cell));
    const i1 = Math.min(nu - 1, Math.floor((Math.max(ax, bx, cx) - u0) / cell));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by, cy) - v0) / cell));
    const j1 = Math.min(nv - 1, Math.floor((Math.max(ay, by, cy) - v0) / cell));
    for (let j = j0; j <= j1; j++) {
      const y = v0 + (j + 0.5) * cell;
      for (let i = i0; i <= i1; i++) {
        const x = u0 + (i + 0.5) * cell;
        const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / den;
        const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / den;
        const l3 = 1 - l1 - l2;
        if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
        put(j * nu + i, l1 * ah + l2 * bh + l3 * ch);
      }
    }
  };

  for (let i = 0; i + 8 < cc.length; i += 9) {
    raster(cc[i], cc[i + 1], cc[i + 2], cc[i + 3], cc[i + 4], cc[i + 5], cc[i + 6], cc[i + 7], cc[i + 8], (k, h) => {
      if (h < low[k]) low[k] = h;
    });
  }

  // Every parent height in each cell the child covers.
  const hits: number[][] = Array.from({ length: nu * nv }, () => []);
  const pu = new Float64Array(9);
  for (let i = 0; i + 8 < parent.length; i += 9) {
    let lu = Infinity, hu = -Infinity, lv = Infinity, hv = -Infinity;
    for (let c = 0; c < 3; c++) {
      p.set(parent[i + c * 3], parent[i + c * 3 + 1], parent[i + c * 3 + 2]);
      const a = p.dot(u), b = p.dot(v), h = p.dot(n);
      pu[c * 3] = a;
      pu[c * 3 + 1] = b;
      pu[c * 3 + 2] = h;
      lu = Math.min(lu, a);
      hu = Math.max(hu, a);
      lv = Math.min(lv, b);
      hv = Math.max(hv, b);
    }
    // Off its footprint: not beneath it.
    if (hu < u0 || lu > u1 || hv < v0 || lv > v1) continue;
    raster(pu[0], pu[1], pu[2], pu[3], pu[4], pu[5], pu[6], pu[7], pu[8], (k, h) => {
      if (low[k] !== Infinity) hits[k].push(h);
    });
  }

  // How far to move from `at`: the parent points below the child's middle
  // (moved by `at`) that it must clear. Rising can bring more of the parent
  // under the middle (the part was sunk in deep), so it's done again until
  // nothing is left to move: pressing twice moves it once.
  const step = (at: number): number | null => {
    const mid = middle + at;
    let move = -Infinity;
    for (let k = 0; k < low.length; k++) {
      let top = -Infinity;
      for (const h of hits[k]) if (h <= mid + 1e-6 && h > top) top = h;
      if (top === -Infinity) continue;
      const need = top - (low[k] + at);
      if (need > move) move = need;
    }
    return move === -Infinity ? null : move;
  };
  let total = 0;
  for (let i = 0; i < 20; i++) {
    const d = step(total);
    if (d === null) return i ? Math.round(total * 100) / 100 + 0 : null;
    total += d;
    if (Math.abs(d) < 1e-4) break;
  }
  return Math.round(total * 100) / 100 + 0;
}
