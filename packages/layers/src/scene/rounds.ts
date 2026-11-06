// Rounded edges in line art.
//
// A fillet or a rounded end is made of many thin facets, each turning only a
// few degrees, so none of its folds reaches the crease angle and the round is
// drawn as blank white. Illustrators (and CAD drawings) show a round with its
// tangent lines: a thin line where a flat face turns into the round, and
// another where the round meets the next flat face. Two lines make a narrow
// band, which reads as a rounded edge without shading.
//
// Finding them on a triangle mesh:
//
// 1. Triangles joined by an edge that doesn't fold (under FLAT degrees) make a
//    patch: a flat face, or one facet strip of a curved surface.
// 2. Each patch's width is its area over half the length of its soft edges
//    (folds under the crease angle). A facet strip is long and narrow; a flat
//    face next to it is much wider.
// 3. A soft edge between a wide patch and a patch at least WIDER times narrower
//    is where a flat face meets a curved surface: a tangent line.
// 4. The curved surface (the narrow patches joined by the other soft edges)
//    must turn at least MIN_TURN degrees away from the flat face, so a slight
//    draft or a nearly flat bulge gets no line.
//
// A cylinder all of facets (a peg, a hole's wall) has no flat face along it,
// so it gets no tangent lines: its outline already shows it.

/** Folds under this many degrees are no fold at all (the two triangles are one face). */
const FLAT = 0.5;
/** A flat face is at least this many times wider than the round's facets next to it. */
const WIDER = 3;
/** A round must turn at least this far from its flat face to be worth a line. */
const MIN_TURN = 20;
/** The most patches looked at when measuring how far one round turns. */
const MAX_FLOOD = 5000;

const DEG = Math.PI / 180;

class Sets {
  private up: Int32Array;
  constructor(n: number) {
    this.up = new Int32Array(n);
    for (let i = 0; i < n; i++) this.up[i] = i;
  }
  find(i: number): number {
    const up = this.up;
    while (up[i] !== i) {
      up[i] = up[up[i]];
      i = up[i];
    }
    return i;
  }
  join(a: number, b: number): void {
    a = this.find(a);
    b = this.find(b);
    if (a !== b) this.up[a] = b;
  }
}

/**
 * The tangent lines of the rounded edges in a model's triangles (9 numbers a
 * triangle), as line segments (6 numbers a segment). Folds of `crease`
 * degrees or more are left out: they get fold lines already.
 */
export function roundEdges(pos: ArrayLike<number>, crease: number): Float32Array {
  const tris = Math.floor(pos.length / 9);
  if (!tris || crease <= FLAT) return new Float32Array(0);

  // Weld the corners, as STL files repeat them for every triangle.
  const ids = new Map<string, number>();
  const corner = new Int32Array(tris * 3);
  const q = (v: number) => Math.round(v * 1e4);
  for (let c = 0; c < tris * 3; c++) {
    const k = `${q(pos[c * 3])},${q(pos[c * 3 + 1])},${q(pos[c * 3 + 2])}`;
    let id = ids.get(k);
    if (id === undefined) ids.set(k, (id = ids.size));
    corner[c] = id;
  }

  // Each triangle's normal and area.
  const normal = new Float32Array(tris * 3);
  const area = new Float32Array(tris);
  for (let t = 0; t < tris; t++) {
    const o = t * 9;
    const ux = pos[o + 3] - pos[o], uy = pos[o + 4] - pos[o + 1], uz = pos[o + 5] - pos[o + 2];
    const vx = pos[o + 6] - pos[o], vy = pos[o + 7] - pos[o + 1], vz = pos[o + 8] - pos[o + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    area[t] = len / 2;
    if (len > 0) {
      normal[t * 3] = nx / len;
      normal[t * 3 + 1] = ny / len;
      normal[t * 3 + 2] = nz / len;
    }
  }

  // Edges shared by exactly two triangles, with their fold in degrees.
  interface Edge { a: number; b: number; t1: number; t2: number; c: number; fold: number }
  const byKey = new Map<number, Edge | null>();
  const nIds = ids.size;
  for (let t = 0; t < tris; t++) {
    for (let k = 0; k < 3; k++) {
      const a = corner[t * 3 + k], b = corner[t * 3 + ((k + 1) % 3)];
      if (a === b) continue;
      const key = a < b ? a * nIds + b : b * nIds + a;
      const e = byKey.get(key);
      if (e === undefined) byKey.set(key, { a: t * 3 + k, b: t * 3 + ((k + 1) % 3), t1: t, t2: -1, c: 1, fold: 0 });
      else if (e) {
        e.c++;
        if (e.c > 2) byKey.set(key, null);
        else e.t2 = t;
      }
    }
  }
  const edges: Edge[] = [];
  for (const e of byKey.values()) {
    if (!e || e.c !== 2) continue;
    const { t1, t2 } = e;
    if (!area[t1] || !area[t2]) e.fold = 0;
    else {
      const d = normal[t1 * 3] * normal[t2 * 3] + normal[t1 * 3 + 1] * normal[t2 * 3 + 1] + normal[t1 * 3 + 2] * normal[t2 * 3 + 2];
      e.fold = Math.acos(Math.max(-1, Math.min(1, d))) / DEG;
    }
    edges.push(e);
  }

  // 1. Patches.
  const patchSets = new Sets(tris);
  for (const e of edges) if (e.fold < FLAT) patchSets.join(e.t1, e.t2);
  const patchOf = new Int32Array(tris);
  const patchIds = new Map<number, number>();
  for (let t = 0; t < tris; t++) {
    const r = patchSets.find(t);
    let p = patchIds.get(r);
    if (p === undefined) patchIds.set(r, (p = patchIds.size));
    patchOf[t] = p;
  }
  const nPatches = patchIds.size;
  const pArea = new Float64Array(nPatches);
  const pNormal = new Float64Array(nPatches * 3);
  for (let t = 0; t < tris; t++) {
    const p = patchOf[t];
    pArea[p] += area[t];
    for (let i = 0; i < 3; i++) pNormal[p * 3 + i] += normal[t * 3 + i] * area[t];
  }
  for (let p = 0; p < nPatches; p++) {
    const l = Math.hypot(pNormal[p * 3], pNormal[p * 3 + 1], pNormal[p * 3 + 2]) || 1;
    for (let i = 0; i < 3; i++) pNormal[p * 3 + i] /= l;
  }

  // 2. Widths, from the soft edges round each patch.
  const corners = (e: Edge) => [e.a, e.b];
  const lengthOf = (e: Edge) => {
    const [a, b] = corners(e);
    return Math.hypot(pos[a * 3] - pos[b * 3], pos[a * 3 + 1] - pos[b * 3 + 1], pos[a * 3 + 2] - pos[b * 3 + 2]);
  };
  const soft = edges.filter(e => e.fold >= FLAT && e.fold < crease && patchOf[e.t1] !== patchOf[e.t2]);
  const softLength = new Float64Array(nPatches);
  for (const e of soft) {
    const l = lengthOf(e);
    softLength[patchOf[e.t1]] += l;
    softLength[patchOf[e.t2]] += l;
  }
  const width = (p: number) => (softLength[p] > 0 ? (2 * pArea[p]) / softLength[p] : Infinity);

  // 3. Tangent edges: a wide patch beside a narrow one.
  const tangent: { e: Edge; flat: number; round: number }[] = [];
  const isTangent = new Set<Edge>();
  for (const e of soft) {
    const p1 = patchOf[e.t1], p2 = patchOf[e.t2];
    const w1 = width(p1), w2 = width(p2);
    if (w1 >= WIDER * w2) tangent.push({ e, flat: p1, round: p2 });
    else if (w2 >= WIDER * w1) tangent.push({ e, flat: p2, round: p1 });
    else continue;
    isTangent.add(e);
  }
  if (!tangent.length) return new Float32Array(0);

  // 4. The rounds: narrow patches joined by soft edges that aren't tangent lines.
  const next: number[][] = Array.from({ length: nPatches }, () => []);
  for (const e of soft) {
    if (isTangent.has(e)) continue;
    const p1 = patchOf[e.t1], p2 = patchOf[e.t2];
    next[p1].push(p2);
    next[p2].push(p1);
  }
  const turned = new Map<string, number>();
  const turn = (flat: number, round: number): number => {
    const key = `${flat}:${round}`;
    const known = turned.get(key);
    if (known !== undefined) return known;
    const fx = pNormal[flat * 3], fy = pNormal[flat * 3 + 1], fz = pNormal[flat * 3 + 2];
    let least = 1;
    const seen = new Set<number>([flat, round]);
    const todo = [round];
    while (todo.length && seen.size < MAX_FLOOD) {
      const p = todo.pop()!;
      least = Math.min(least, fx * pNormal[p * 3] + fy * pNormal[p * 3 + 1] + fz * pNormal[p * 3 + 2]);
      for (const n of next[p]) if (!seen.has(n)) {
        seen.add(n);
        todo.push(n);
      }
    }
    const deg = Math.acos(Math.max(-1, Math.min(1, least))) / DEG;
    for (const p of seen) if (p !== flat) turned.set(`${flat}:${p}`, deg);
    return deg;
  };

  const out: number[] = [];
  for (const { e, flat, round } of tangent) {
    if (turn(flat, round) < MIN_TURN) continue;
    for (const c of corners(e)) out.push(pos[c * 3], pos[c * 3 + 1], pos[c * 3 + 2]);
  }
  return new Float32Array(out);
}
