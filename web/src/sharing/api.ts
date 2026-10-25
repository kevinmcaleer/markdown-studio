import { api } from "../api";

// Sharing a file: links (anyone with the link, or signed-in users only) and
// named users. Roles, lowest first: view < comment < edit; the owner is "owner".

export type ShareRole = "view" | "comment" | "edit";
export type Role = ShareRole | "owner";

export type ShareLink = {
  id: number;
  token: string;
  path: string;
  /** The full link when the server has PUBLIC_URL set; null otherwise. */
  url: string | null;
  role: ShareRole;
  anonymous: boolean;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  active: boolean;
};

export type Member = { user_id: number; username: string; role: ShareRole; created_at: string };

export type Shares = { links: ShareLink[]; members: Member[] };

export type SharedFile = {
  id: number;
  name: string;
  owner: string;
  role: ShareRole;
  updated_at: string;
  shared_at: string;
};

export type OpenedLink = {
  file: { id: number; name: string; owner: string; updated_at: string };
  role: Role;
  anonymous: boolean;
};

export const ROLE_LABELS: Record<Role, string> = {
  view: "Can view",
  comment: "Can comment",
  edit: "Can edit",
  owner: "Owner",
};

const ROLE_ORDER: Role[] = ["view", "comment", "edit", "owner"];

export function allows(role: Role | null | undefined, needed: Role): boolean {
  return role != null && ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(needed);
}

export function shareUrl(link: Pick<ShareLink, "path" | "url">, origin = window.location.origin): string {
  return link.url ?? origin + link.path;
}

/**
 * True when a link built from this origin only works on this machine, e.g. the
 * app was opened at http://0.0.0.0:8000 or localhost and PUBLIC_URL isn't set.
 */
export function isLocalOnly(link: Pick<ShareLink, "url">, hostname = window.location.hostname): boolean {
  if (link.url) return false;
  return (
    hostname === "0.0.0.0" ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    hostname === "[::]" ||
    /^127\./.test(hostname)
  );
}

export const sharing = {
  list: (fileId: number) => api<Shares>(`/api/files/${fileId}/shares`),
  createLink: (fileId: number, role: ShareRole, anonymous: boolean, expires_in_days?: number | null) =>
    api<{ link: ShareLink }>(`/api/files/${fileId}/shares`, {
      body: { role, anonymous, expires_in_days: expires_in_days ?? null },
    }),
  updateLink: (fileId: number, linkId: number, change: { role?: ShareRole; anonymous?: boolean }) =>
    api<{ link: ShareLink }>(`/api/files/${fileId}/shares/${linkId}`, { method: "PATCH", body: change }),
  revokeLink: (fileId: number, linkId: number) =>
    api<{ ok: true }>(`/api/files/${fileId}/shares/${linkId}`, { method: "DELETE" }),
  addMember: (fileId: number, username: string, role: ShareRole) =>
    api<Shares>(`/api/files/${fileId}/members`, { body: { username, role } }),
  removeMember: (fileId: number, userId: number) =>
    api<Shares>(`/api/files/${fileId}/members/${userId}`, { method: "DELETE" }),
  sharedWithMe: () => api<{ files: SharedFile[] }>("/api/shared-with-me"),
  open: (token: string) => api<OpenedLink>(`/api/s/${encodeURIComponent(token)}`),
};
