import { api } from "../api";
import type { Role } from "../sharing/api";

export type CommentAuthor = { name: string; user_id: number | null; anonymous: boolean };

export type Comment = {
  id: number;
  author: CommentAuthor;
  body: string;
  created_at: string;
  edited_at: string | null;
  deleted: boolean;
  mine: boolean;
  can_edit: boolean;
  can_delete: boolean;
};

export type Thread = {
  id: number;
  file_id: number;
  anchor_from: number;
  anchor_to: number;
  quote: string;
  anchor: string | null;
  resolved: boolean;
  resolved_at: string | null;
  resolved_by: string | null;
  created_at: string;
  updated_at: string;
  comments: Comment[];
  can_reply: boolean;
  can_resolve: boolean;
};

export type NewThread = {
  body: string;
  anchor_from: number;
  anchor_to: number;
  quote: string;
  anchor?: string | null;
  author_name?: string;
};

type One = { thread: Thread };

export const comments = {
  list: (fileId: number) =>
    api<{ threads: Thread[]; role: Role; can_comment: boolean }>(`/api/files/${fileId}/comments`),
  start: (fileId: number, thread: NewThread) => api<One>(`/api/files/${fileId}/comments`, { body: thread }),
  reply: (threadId: number, body: string, author_name = "") =>
    api<One>(`/api/comment-threads/${threadId}/replies`, { body: { body, author_name } }),
  resolve: (threadId: number) => api<One>(`/api/comment-threads/${threadId}/resolve`, { method: "POST" }),
  reopen: (threadId: number) => api<One>(`/api/comment-threads/${threadId}/reopen`, { method: "POST" }),
  edit: (commentId: number, body: string) => api<One>(`/api/comments/${commentId}`, { method: "PATCH", body: { body } }),
  remove: (commentId: number) =>
    api<{ thread: Thread | null; deleted_thread_id?: number }>(`/api/comments/${commentId}`, { method: "DELETE" }),
};
