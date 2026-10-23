import { useSyncExternalStore } from "react";

// A very small router: the suite has a handful of top-level pages, and each
// app (Notes, Tables, Decks) will own everything under its own prefix.

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

export function navigate(to: string, { replace = false } = {}): void {
  if (replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  listeners.forEach((l) => l());
}

export function useLocation(): { path: string; search: URLSearchParams } {
  const href = useSyncExternalStore(subscribe, () => window.location.pathname + window.location.search);
  const url = new URL(href, "http://x");
  return { path: url.pathname, search: url.searchParams };
}

/** Only allow local redirects after sign-in (no open redirects). */
export function safeNext(next: string | null | undefined, fallback = "/"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return fallback;
  if (["/login", "/register", "/forgot-password", "/reset-password"].some((p) => next.startsWith(p))) return fallback;
  return next;
}
