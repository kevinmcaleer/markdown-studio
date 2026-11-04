// Saved graphics and project models keep each part's model data once, in a
// `meshes` table, with the parts pointing at it by key (`mesh`). Copies of a
// part (nine of the same screw, say) and the same part in several 3D scenes
// of one graphic then cost one model, not one each. Read back, each part
// gets its `data` again, so nothing else needs to know about the table.

type Part = Record<string, unknown>;
export type Meshes = Record<string, string>;

/** Collects model data into a table as parts are written. */
export function meshTable(): { meshes: Meshes; size: () => number; parts: <T extends Part>(parts: T[]) => T[] } {
  const keys = new Map<string, string>();
  const meshes: Meshes = {};
  const ref = (data: string) => {
    let k = keys.get(data);
    if (!k) {
      k = `m${keys.size + 1}`;
      keys.set(data, k);
      meshes[k] = data;
    }
    return k;
  };
  return {
    meshes,
    size: () => keys.size,
    parts: parts =>
      parts.map(p => {
        if (!p || typeof p.data !== "string" || !p.data) return p;
        const { data, ...rest } = p;
        return { ...rest, mesh: ref(data) } as unknown as typeof p;
      }),
  };
}

/** Parts with their `data` taken back from the table (parts without a key, or with one it lacks, as they are). */
export function restoreParts<T extends Part>(parts: T[], meshes: unknown): T[] {
  if (!meshes || typeof meshes !== "object") return parts;
  const table = meshes as Record<string, unknown>;
  return parts.map(p => {
    if (!p || typeof p.mesh !== "string") return p;
    const { mesh, ...rest } = p;
    const data = Object.prototype.hasOwnProperty.call(table, mesh) ? table[mesh as string] : undefined;
    return (typeof data === "string" && data ? { ...rest, data } : rest) as unknown as T;
  });
}
