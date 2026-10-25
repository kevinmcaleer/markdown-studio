import { api } from "../api";
import type { Thread } from "../comments/api";
import type { Role } from "../sharing/api";

export type SuggestionStatus = "open" | "accepted" | "rejected";

export type Suggestion = {
  id: number;
  file_id: number;
  anchor_from: number;
  anchor_to: number;
  /** The text being replaced; empty for an insertion. */
  quote: string;
  anchor: string | null;
  /** What it becomes; empty for a deletion. */
  replacement: string;
  author: { name: string; user_id: number | null; anonymous: boolean };
  status: SuggestionStatus;
  decided_at: string | null;
  decided_by: string | null;
  /** The comment thread replies go into, once there is one. */
  thread_id: number | null;
  created_at: string;
  updated_at: string;
  mine: boolean;
  can_edit: boolean;
  can_decide: boolean;
  can_delete: boolean;
};

export type SuggestionBody = {
  anchor_from: number;
  anchor_to: number;
  quote: string;
  anchor: string | null;
  replacement: string;
  author_name?: string;
};

type One = { suggestion: Suggestion };

export const suggestions = {
  list: (fileId: number) =>
    api<{ suggestions: Suggestion[]; role: Role; can_suggest: boolean; can_decide: boolean }>(`/api/files/${fileId}/suggestions`),
  create: (fileId: number, body: SuggestionBody) => api<One>(`/api/files/${fileId}/suggestions`, { body }),
  update: (id: number, body: SuggestionBody) => api<One>(`/api/suggestions/${id}`, { method: "PATCH", body }),
  remove: (id: number) => api<{ deleted_id: number }>(`/api/suggestions/${id}`, { method: "DELETE" }),
  accept: (id: number) => api<One>(`/api/suggestions/${id}/accept`, { method: "POST" }),
  reject: (id: number) => api<One>(`/api/suggestions/${id}/reject`, { method: "POST" }),
  reply: (id: number, body: string, author_name = "") =>
    api<One & { thread: Thread }>(`/api/suggestions/${id}/replies`, { body: { body, author_name } }),
};
