import { useSyncExternalStore } from "react";
import { SUITE_APPS, type SuiteApp } from "./suite";

// Installing the apps: the service worker, each app's manifest, and the
// browser's install prompt (Chrome, Edge, Android). Safari has no prompt, so
// there we explain "Add to Home Screen" instead.

type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function startPwa(): void {
  if ("serviceWorker" in navigator && import.meta.env.PROD) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* no offline support, everything else still works */
      });
    });
  }
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferred = event as InstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    notify();
  });
}

/** Forget cached answers about the signed-in user (call on sign in and out). */
export function clearApiCache(): void {
  navigator.serviceWorker?.controller?.postMessage("clear-api-cache");
}

/** Point the page at the current app's manifest, so "Install" installs that app. */
export function setManifestFor(app: SuiteApp | undefined): void {
  const manifest = app ? `/${app.id}.webmanifest` : "/manifest.webmanifest";
  const icon = `/icons/${app?.id ?? "studio"}-apple-180.png`;
  document.querySelector<HTMLLinkElement>('link[rel="manifest"]')?.setAttribute("href", manifest);
  document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]')?.setAttribute("href", icon);
  document.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-title"]')?.setAttribute("content", app?.name ?? "Markdown Studio");
}

export function isStandalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
}

export function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function useInstallPrompt(): { available: boolean; install: () => Promise<void> } {
  const available = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => deferred !== null,
  );
  return {
    available,
    install: async () => {
      if (!deferred) return;
      const event = deferred;
      deferred = null;
      notify();
      await event.prompt();
    },
  };
}

export const INSTALLABLE = SUITE_APPS.filter((a) => a.ready).map((a) => a.id);
