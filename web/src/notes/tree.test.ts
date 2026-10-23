import { describe, expect, it } from "vitest";
import type { FileMeta, Folder } from "./filesApi";
import { ancestors, buildTree, descendants, folderPaths } from "./tree";

const folder = (id: number, name: string, parent_id: number | null = null) =>
  ({ id, name, parent_id, owner_id: 1, created_at: "", updated_at: "" }) as Folder;
const file = (id: number, name: string, folder_id: number | null = null) =>
  ({ id, name, folder_id, owner_id: 1, mime_type: "text/markdown", size: 0, created_at: "", updated_at: "" }) as FileMeta;

const folders = [folder(1, "Work"), folder(2, "plans", 1), folder(3, "Archive"), folder(4, "Q3", 2)];

describe("tree helpers", () => {
  it("nests folders and files, sorted by name", () => {
    const root = buildTree({ folders, files: [file(1, "b.md", 2), file(2, "A.md")] });
    expect(root.folders.map((n) => n.folder!.name)).toEqual(["Archive", "Work"]);
    expect(root.files.map((f) => f.name)).toEqual(["A.md"]);
    expect(root.folders[1].folders[0].files.map((f) => f.name)).toEqual(["b.md"]);
  });

  it("builds folder paths", () => {
    expect(folderPaths(folders).map((f) => f.path)).toEqual(["Archive", "Work", "Work / plans", "Work / plans / Q3"]);
  });

  it("finds descendants and ancestors", () => {
    expect([...descendants(folders, 1)].sort()).toEqual([1, 2, 4]);
    expect(ancestors(folders, 4)).toEqual([4, 2, 1]);
    expect(ancestors(folders, null)).toEqual([]);
  });
});
