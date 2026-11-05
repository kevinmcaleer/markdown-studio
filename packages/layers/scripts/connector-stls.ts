// Writes each connector's model (src/scene/connectors.ts) as a binary STL,
// for the connector parts in Snakie Standard's catalog, so the catalog's
// parts and the plugs drawn in 3D scenes are the same model.
//
//   node --experimental-strip-types scripts/connector-stls.ts <out dir> [id …]
//
// Each goes to <out dir>/<id>/model.stl, in mm, standing as the part sits on
// a board: the mating face down (-Z), the latch towards +Y.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allConnectors, connectorMesh } from "../src/scene/connectors.ts";

const [out, ...only] = process.argv.slice(2);
if (!out) {
  console.error("Usage: node --experimental-strip-types scripts/connector-stls.ts <out dir> [id …]");
  process.exit(1);
}

function stl(pos: Float32Array, name: string): Buffer {
  const n = pos.length / 9;
  const b = Buffer.alloc(84 + n * 50);
  b.write(`${name} (markdown-studio connectors.ts)`.slice(0, 80), 0, "ascii");
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) {
    const o = 84 + t * 50;
    const p = (k: number) => pos[t * 9 + k];
    const ux = p(3) - p(0), uy = p(4) - p(1), uz = p(5) - p(2);
    const vx = p(6) - p(0), vy = p(7) - p(1), vz = p(8) - p(2);
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    [nx, ny, nz].forEach((v, i) => b.writeFloatLE(v, o + i * 4));
    for (let k = 0; k < 9; k++) b.writeFloatLE(p(k), o + 12 + k * 4);
  }
  return b;
}

for (const c of allConnectors()) {
  if (only.length && !only.includes(c.id)) continue;
  const m = connectorMesh(c.id);
  mkdirSync(join(out, c.id), { recursive: true });
  writeFileSync(join(out, c.id, "model.stl"), stl(m.positions, c.name));
  console.log(`${c.id}/model.stl  ${m.size.join(" × ")} mm, ${m.positions.length / 9} triangles`);
}
