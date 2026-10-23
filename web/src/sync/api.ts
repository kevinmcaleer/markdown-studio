import { api, ApiError, csrf } from "../api";
import type { FileMeta } from "../notes/filesApi";

// Cloud sync: Google Docs (two-way) and iCloud Drive (save a copy, bring it back).

export type Provider = "google" | "icloud";
export type Outcome = "unchanged" | "pushed" | "pulled" | "merged" | "conflict";
export type Choice = "mine" | "theirs" | "both" | "markers";

export type SyncLink = {
  id: number;
  file_id: number;
  provider: Provider;
  remote_url: string;
  status: "ok" | "conflict";
  last_error: string | null;
  synced_at: string | null;
  created_at: string;
};

export type CloudStatus = { google: { available: boolean; connected: boolean; email: string | null } };

type Links = { links: SyncLink[] };

export const PROVIDER_NAMES: Record<Provider, string> = { google: "Google Docs", icloud: "iCloud" };

async function sendText<T>(path: string, text: string): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { Accept: "application/json", "X-CSRF-Token": csrf(), "Content-Type": "text/markdown; charset=utf-8" },
    body: text,
  });
  const data = response.headers.get("content-type")?.includes("json") ? await response.json() : null;
  if (!response.ok) throw new ApiError(response.status, data?.detail ?? response.statusText);
  return data as T;
}

export const cloud = {
  status: () => api<CloudStatus>("/api/cloud"),
  /** A full-page visit: Google's consent screen, then back to `next`. */
  connectGoogleUrl: (next: string) => `/api/cloud/google/connect?next=${encodeURIComponent(next)}`,
  disconnectGoogle: () => api<{ ok: true }>("/api/cloud/google", { method: "DELETE" }),
};

export const sync = {
  links: (fileId: number) => api<Links>(`/api/files/${fileId}/sync`),
  linkGoogle: (fileId: number) => api<Links & { outcome: Outcome }>(`/api/files/${fileId}/sync/google`, { method: "POST" }),
  syncGoogle: (fileId: number) => api<Links & { outcome: Outcome }>(`/api/files/${fileId}/sync/google/run`, { method: "POST" }),
  unlink: (fileId: number, provider: Provider) => api<Links>(`/api/files/${fileId}/sync/${provider}`, { method: "DELETE" }),
  icloudSaved: (fileId: number, text: string) => sendText<Links>(`/api/files/${fileId}/sync/icloud/saved`, text),
  icloudImport: (fileId: number, text: string) => sendText<Links & { outcome: Outcome }>(`/api/files/${fileId}/sync/icloud/import`, text),
  resolve: (fileId: number, provider: Provider, choice: Choice) =>
    api<Links & { copy?: FileMeta; stale?: boolean }>(`/api/files/${fileId}/sync/${provider}/resolve`, { body: { choice } }),
};

/** One line saying what a sync did, for a status message. */
export function describe(outcome: Outcome, provider: Provider): string {
  const name = PROVIDER_NAMES[provider];
  switch (outcome) {
    case "unchanged":
      return provider === "icloud" ? "No changes in that copy." : `Already in step with ${name}.`;
    case "pushed":
      return provider === "icloud" ? "Nothing new in that copy. Your iCloud copy is older than this note." : `Sent your changes to ${name}.`;
    case "pulled":
      return `Brought in the changes from ${name}.`;
    case "merged":
      return provider === "icloud"
        ? "Merged the changes from iCloud with yours. Save to iCloud again to update the copy there."
        : `Merged the changes from ${name} with yours.`;
    case "conflict":
      return `This note and ${name} changed the same lines. Choose what to keep.`;
  }
}
