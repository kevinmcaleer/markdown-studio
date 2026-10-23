/* Markdown Studio's service worker: makes the apps installable and lets them
   open offline. The build (vite.config.ts) replaces __PRECACHE__ with every
   file it produced, and __VERSION__ with a hash of that list.

   - App files: precached at install, then served from the cache (their names
     change whenever their contents do).
   - Pages: network first, falling back to the cached app shell.
   - A few read-only API calls (who is signed in, the file list, a file's
     details): network first, falling back to the last answer, so the file
     browser works offline. Notes themselves are kept by the editor (IndexedDB).
   - Everything else goes straight to the network. */

const VERSION = "__VERSION__";
const PRECACHE = __PRECACHE__;
const APP_CACHE = `studio-app-${VERSION}`;
const API_CACHE = "studio-api";
const SHELL = "/index.html";
const CACHED_API = [/^\/api\/auth\/session$/, /^\/api\/files$/, /^\/api\/files\/\d+$/, /^\/api\/powertools$/];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(APP_CACHE)
      .then((cache) => cache.addAll([SHELL, ...PRECACHE]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("studio-app-") && k !== APP_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Signing out (or in as someone else) must not leave the last user's list behind.
self.addEventListener("message", (event) => {
  if (event.data === "clear-api-cache") event.waitUntil(caches.delete(API_CACHE));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    if (url.pathname.startsWith("/api/")) return;
    event.respondWith(networkFirst(request, APP_CACHE, SHELL));
    return;
  }
  if (CACHED_API.some((pattern) => pattern.test(url.pathname)) && !url.search && !request.headers.has("X-Share-Token")) {
    event.respondWith(networkFirst(request, API_CACHE));
    return;
  }
  if (url.pathname.startsWith("/api/") || url.pathname === "/health") return;
  event.respondWith(cacheFirst(request));
});

async function networkFirst(request, cacheName, fallbackKey) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    const html = response.headers.get("content-type")?.includes("text/html");
    if (response.ok && (!fallbackKey || html)) cache.put(fallbackKey ?? request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(fallbackKey ?? request);
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && new URL(request.url).pathname.startsWith("/assets/")) {
    const cache = await caches.open(APP_CACHE);
    cache.put(request, response.clone());
  }
  return response;
}
