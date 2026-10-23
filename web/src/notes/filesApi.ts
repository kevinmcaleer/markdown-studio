import { api, ApiError, csrf, getShareToken } from "../api";

export type FileRole = "view" | "comment" | "edit" | "owner";

export type FileMeta = {
  id: number;
  owner_id: number;
  folder_id: number | null;
  name: string;
  mime_type: string;
  size: number;
  created_at: string;
  updated_at: string;
};

export type Folder = {
  id: number;
  owner_id: number;
  parent_id: number | null;
  name: string;
  created_at: string;
  updated_at: string;
};

export type Tree = { folders: Folder[]; files: FileMeta[] };

function rawHeaders(): Record<string, string> {
  const share = getShareToken();
  return share ? { "X-Share-Token": share } : {};
}

/** Sends raw bytes (uploads and saves), with the CSRF token like every write. */
async function sendBody<T>(method: string, path: string, body: BodyInit): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: { Accept: "application/json", "X-CSRF-Token": csrf(), ...rawHeaders() },
    body,
  });
  const data = response.headers.get("content-type")?.includes("json") ? await response.json() : null;
  if (!response.ok) throw new ApiError(response.status, data?.detail ?? response.statusText);
  return data as T;
}

export const files = {
  tree: () => api<Tree>("/api/files"),
  info: (id: number) => api<{ file: FileMeta; role: FileRole }>(`/api/files/${id}`),
  async text(id: number): Promise<string> {
    const response = await fetch(`/api/files/${id}/content`, { credentials: "same-origin", headers: rawHeaders() });
    if (!response.ok) throw new ApiError(response.status, response.statusText);
    return response.text();
  },
  createNote: (name: string, folderId: number | null, content = "") =>
    api<{ file: FileMeta }>("/api/files", { body: { name, folder_id: folderId, content } }),
  upload: (file: File, folderId: number | null) =>
    sendBody<{ file: FileMeta }>(
      "POST",
      `/api/files/upload?name=${encodeURIComponent(file.name)}${folderId === null ? "" : `&folder_id=${folderId}`}`,
      file,
    ),
  save: (id: number, text: string) => sendBody<{ file: FileMeta }>("PUT", `/api/files/${id}/content`, text),
  rename: (id: number, name: string) => api<{ file: FileMeta }>(`/api/files/${id}`, { method: "PATCH", body: { name } }),
  move: (id: number, folderId: number | null) =>
    api<{ file: FileMeta }>(`/api/files/${id}`, { method: "PATCH", body: { folder_id: folderId, move: true } }),
  remove: (id: number) => api<{ ok: true }>(`/api/files/${id}`, { method: "DELETE" }),
  downloadUrl: (id: number) => withShare(`/api/files/${id}/content?download=1`),
};

export const folders = {
  create: (name: string, parentId: number | null) =>
    api<{ folder: Folder }>("/api/folders", { body: { name, parent_id: parentId } }),
  rename: (id: number, name: string) => api<{ folder: Folder }>(`/api/folders/${id}`, { method: "PATCH", body: { name } }),
  move: (id: number, parentId: number | null) =>
    api<{ folder: Folder }>(`/api/folders/${id}`, { method: "PATCH", body: { parent_id: parentId, move: true } }),
  remove: (id: number) => api<{ ok: true }>(`/api/folders/${id}`, { method: "DELETE" }),
};

/** Plain links (downloads) can't send headers, so a share token goes in the URL. */
export function withShare(url: string): string {
  const share = getShareToken();
  return share ? `${url}${url.includes("?") ? "&" : "?"}share=${encodeURIComponent(share)}` : url;
}

export function isMarkdown(file: Pick<FileMeta, "mime_type">): boolean {
  return file.mime_type === "text/markdown";
}

export function isText(file: Pick<FileMeta, "mime_type">): boolean {
  return file.mime_type.startsWith("text/") || ["application/json", "application/xml", "image/svg+xml"].includes(file.mime_type);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
