// Made-up parts for eval cases, described in a few words of JSON instead
// of an STL file, so a case is easy to read and to write by hand.
//
// Every shape sits on the floor (z = 0) and is centred on x and y:
//
//   { "box": [w, d, h] }                         a block
//   { "plate": [w, d, t], "holes": [ … ] }       a plate with round holes;
//       each hole is { "at": [x, y], "r": 1.6 } (right through)
//       or { "at": [x, y], "r": 2, "depth": 5 } (blind, from the top)
//   { "cylinder": [r, h] }                       a disc or rod, its axis up (Z)
//   { "stl": "meshes/leg.stl" }                  a real part (path from evals/)
//
// Any shape can add "at": [x, y, z] to move it, as a part sits off-centre
// in its file.

import { BoxGeometry, type BufferGeometry, CylinderGeometry, Path, Shape, ShapeGeometry, Vector2 } from "three";
import { parseStl } from "../../src/scene/stl";

export interface Hole {
  at: [number, number];
  r: number;
  /** Mm deep from the top; left out for a hole right through. */
  depth?: number;
}

export type ShapeSpec = { at?: [number, number, number] } & (
  | { box: [number, number, number] }
  | { plate: [number, number, number]; holes?: Hole[] }
  | { cylinder: [number, number] }
  | { stl: string }
);

type P3 = [number, number, number];
const ROUND = 32;

/** Reads an STL file for a `{ "stl": … }` shape. Set by the runner (Node reads files, a browser fetches them). */
export type ReadFile = (path: string) => ArrayBuffer;

/** The shape's triangles, three corners of x, y, z each. */
export function shapeTriangles(spec: ShapeSpec, read?: ReadFile): Float32Array {
  let pos: Float32Array;
  if ("box" in spec) pos = soup(new BoxGeometry(...spec.box).translate(0, 0, spec.box[2] / 2));
  else if ("cylinder" in spec) pos = soup(new CylinderGeometry(spec.cylinder[0], spec.cylinder[0], spec.cylinder[1], ROUND * 2).rotateX(Math.PI / 2).translate(0, 0, spec.cylinder[1] / 2));
  else if ("plate" in spec) pos = plate(spec.plate, spec.holes || []);
  else if ("stl" in spec) {
    if (!read) throw new Error(`No way to read ${spec.stl} here.`);
    pos = parseStl(read(spec.stl));
  } else throw new Error(`Unknown shape: ${JSON.stringify(spec)}`);
  if (spec.at) for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) pos[i + k] += spec.at[k];
  return pos;
}

/** The triangles moved so their middle is at 0, 0, 0, as a part's model is in a scene. */
export function centred(pos: Float32Array): Float32Array {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) {
    lo[k] = Math.min(lo[k], pos[i + k]);
    hi[k] = Math.max(hi[k], pos[i + k]);
  }
  const out = pos.slice();
  for (let i = 0; i < out.length; i += 3) for (let k = 0; k < 3; k++) out[i + k] -= (lo[k] + hi[k]) / 2;
  return out;
}

function soup(g: BufferGeometry): Float32Array {
  const flat = g.index ? g.toNonIndexed() : g;
  return Float32Array.from(flat.getAttribute("position").array as ArrayLike<number>);
}

/**
 * A plate with holes, built face by face so a blind hole has a real
 * bottom (three's ExtrudeGeometry only makes holes right through).
 */
function plate([w, d, t]: [number, number, number], holes: Hole[]): Float32Array {
  const out: number[] = [];
  /** A triangle facing `facing` (its corners turned round if they face the other way). */
  const tri = (a: P3, b: P3, c: P3, facing: P3) => {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const same = n[0] * facing[0] + n[1] * facing[1] + n[2] * facing[2] >= 0;
    out.push(...a, ...(same ? b : c), ...(same ? c : b));
  };
  const quad = (a: P3, b: P3, c: P3, e: P3, facing: P3) => {
    tri(a, b, c, facing);
    tri(a, c, e, facing);
  };
  const rect = () => new Shape().moveTo(-w / 2, -d / 2).lineTo(w / 2, -d / 2).lineTo(w / 2, d / 2).lineTo(-w / 2, d / 2).lineTo(-w / 2, -d / 2);
  const ring = (h: Hole) => new Path().absarc(h.at[0], h.at[1], h.r, 0, Math.PI * 2, true);
  const rings = holes.map(h => ring(h).getPoints(ROUND));
  // Top: every hole; bottom: only the holes right through.
  const face = (z: number, which: Hole[], facing: P3) => {
    const s = rect();
    which.forEach(h => s.holes.push(ring(h)));
    const p = soup(new ShapeGeometry(s, ROUND));
    for (let i = 0; i < p.length; i += 9) tri([p[i], p[i + 1], z], [p[i + 3], p[i + 4], z], [p[i + 6], p[i + 7], z], facing);
  };
  face(t, holes, [0, 0, 1]);
  face(0, holes.filter(h => h.depth === undefined || h.depth >= t), [0, 0, -1]);
  // The four sides.
  const c: [number, number][] = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]];
  for (let i = 0; i < 4; i++) {
    const [a, b] = [c[i], c[(i + 1) % 4]];
    const facing: P3 = [b[1] - a[1], a[0] - b[0], 0];
    quad([a[0], a[1], 0], [b[0], b[1], 0], [b[0], b[1], t], [a[0], a[1], t], facing);
  }
  // Each hole's wall (facing in, to its middle) and a blind hole's floor.
  holes.forEach((h, k) => {
    const pts = rings[k];
    const bottom = h.depth === undefined || h.depth >= t ? 0 : t - h.depth;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      const mid = new Vector2((a.x + b.x) / 2, (a.y + b.y) / 2);
      const facing: P3 = [h.at[0] - mid.x, h.at[1] - mid.y, 0];
      quad([a.x, a.y, bottom], [b.x, b.y, bottom], [b.x, b.y, t], [a.x, a.y, t], facing);
      if (bottom > 0) tri([h.at[0], h.at[1], bottom], [a.x, a.y, bottom], [b.x, b.y, bottom], [0, 0, 1]);
    }
  });
  return Float32Array.from(out);
}
