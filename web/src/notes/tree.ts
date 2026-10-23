import type { FileMeta, Folder, Tree } from "./filesApi";

// Helpers for turning the flat lists from the API into a tree.

export type FolderNode = { folder: Folder | null; folders: FolderNode[]; files: FileMeta[] };

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });

export function buildTree(tree: Tree): FolderNode {
  const nodes = new Map<number | null, FolderNode>([[null, { folder: null, folders: [], files: [] }]]);
  for (const folder of tree.folders) nodes.set(folder.id, { folder, folders: [], files: [] });
  for (const folder of [...tree.folders].sort(byName)) {
    (nodes.get(folder.parent_id) ?? nodes.get(null)!).folders.push(nodes.get(folder.id)!);
  }
  for (const file of [...tree.files].sort(byName)) {
    (nodes.get(file.folder_id) ?? nodes.get(null)!).files.push(file);
  }
  return nodes.get(null)!;
}

/** "Work / Plans" style paths for every folder, for pickers. Top level first, then alphabetical. */
export function folderPaths(folders: Folder[]): { id: number; path: string }[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const pathOf = (folder: Folder): string => {
    const parts = [folder.name];
    let parent = folder.parent_id === null ? undefined : byId.get(folder.parent_id);
    while (parent) {
      parts.unshift(parent.name);
      parent = parent.parent_id === null ? undefined : byId.get(parent.parent_id);
    }
    return parts.join(" / ");
  };
  return folders.map((f) => ({ id: f.id, path: pathOf(f) })).sort((a, b) => a.path.localeCompare(b.path));
}

/** The folder and all folders inside it (a folder can't move into any of these). */
export function descendants(folders: Folder[], id: number): Set<number> {
  const found = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) {
      if (f.parent_id !== null && found.has(f.parent_id) && !found.has(f.id)) {
        found.add(f.id);
        grew = true;
      }
    }
  }
  return found;
}

/** Ids of the folders that contain this one, so they can be opened to reveal it. */
export function ancestors(folders: Folder[], folderId: number | null): number[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const found: number[] = [];
  let current = folderId === null ? undefined : byId.get(folderId);
  while (current) {
    found.push(current.id);
    current = current.parent_id === null ? undefined : byId.get(current.parent_id);
  }
  return found;
}
