// Thin JSON client for the Studio API. The server hands out a CSRF token with
// every auth response; we keep the latest one and send it on each write.

export type User = {
  id: number;
  username: string;
  email: string | null;
  created_at: string;
};

export type SessionInfo = {
  user: User | null;
  csrf_token: string;
  registration_open: boolean;
  first_user: boolean;
  /** The server can email password reset links. */
  password_reset: boolean;
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

let csrfToken = "";

export function setCsrfToken(token: string | undefined): void {
  if (token) csrfToken = token;
}

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = options.method ?? (options.body === undefined ? "GET" : "POST");
  const headers: Record<string, string> = { Accept: "application/json" };
  if (method !== "GET") headers["X-CSRF-Token"] = csrfToken;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = response.headers.get("content-type")?.includes("json") ? await response.json() : null;
  if (!response.ok) {
    throw new ApiError(response.status, (data && typeof data.detail === "string" && data.detail) || response.statusText);
  }
  if (data && typeof data.csrf_token === "string") setCsrfToken(data.csrf_token);
  return data as T;
}

export const auth = {
  session: () => api<SessionInfo>("/api/auth/session"),
  register: (username: string, email: string, password: string) =>
    api<{ user: User }>("/api/auth/register", { body: { username, email, password } }),
  login: (username: string, password: string, remember: boolean) =>
    api<{ user: User }>("/api/auth/login", { body: { username, password, remember } }),
  logout: () => api<{ user: null }>("/api/auth/logout", { method: "POST" }),
  changePassword: (current_password: string, new_password: string) =>
    api<{ user: User }>("/api/auth/password", { body: { current_password, new_password } }),
  changeEmail: (email: string, current_password: string) =>
    api<{ user: User }>("/api/auth/email", { body: { email, current_password } }),
  forgotPassword: (login: string) => api<{ ok: true }>("/api/auth/forgot-password", { body: { login } }),
  resetPassword: (token: string, password: string) =>
    api<{ user: User }>("/api/auth/reset-password", { body: { token, password } }),
  deleteAccount: (confirm_username: string) =>
    api<{ user: null }>("/api/auth/delete-account", { body: { confirm_username } }),
};

export type PowerToolApp = { id: string; name: string; url: string; description: string; status: "live" | "soon" };

export const powertools = () => api<{ current: string; home: string; apps: PowerToolApp[] }>("/api/powertools");
