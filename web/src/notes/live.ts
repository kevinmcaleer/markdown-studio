import { IndexeddbPersistence } from "y-indexeddb";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { getShareToken } from "../api";

// A note open for live editing: a Yjs document synced with the server over
// a WebSocket, and kept in IndexedDB so it opens (and can be edited) offline.
// Offline edits merge with everyone else's when the connection comes back.

export type LiveStatus = "connecting" | "live" | "offline" | "closed";

export type Peer = { clientId: number; name: string; color: string; self: boolean };

const COLORS = ["#c96442", "#3f7d6e", "#6a5acd", "#b4572e", "#2f6fb0", "#a3367a", "#5f7f1f", "#8a5a00"];

export function colorFor(key: string): string {
  let hash = 0;
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return COLORS[Math.abs(hash) % COLORS.length];
}

export class LiveNote {
  readonly doc = new Y.Doc();
  readonly text = this.doc.getText("content");
  readonly undo = new Y.UndoManager(this.text);
  readonly provider: WebsocketProvider;
  readonly local: IndexeddbPersistence;
  status: LiveStatus = "connecting";
  /** Set once there's text to show: synced with the server, or loaded from this device. */
  ready: Promise<void>;
  private listeners = new Set<() => void>();

  constructor(fileId: number, user: { name: string; key: string }) {
    this.local = new IndexeddbPersistence(`notes-file-${fileId}`, this.doc);
    const share = getShareToken();
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    this.provider = new WebsocketProvider(`${scheme}://${window.location.host}/api/files`, `${fileId}/live`, this.doc, {
      params: share ? { share } : {},
      maxBackoffTime: 10_000,
    });
    this.provider.awareness.setLocalStateField("user", { name: user.name, color: colorFor(user.key) });

    this.provider.on("status", ({ status }) => {
      this.setStatus(status === "connected" ? (this.provider.synced ? "live" : "connecting") : this.status === "closed" ? "closed" : "offline");
    });
    this.provider.on("sync", (synced) => synced && this.setStatus("live"));
    this.provider.on("closed", () => this.setStatus("closed"));
    this.provider.awareness.on("change", () => this.emit());

    const synced = new Promise<void>((resolve) => this.provider.once("sync", () => resolve()));
    // Offline: open the copy on this device, if there is one, after a moment
    // to connect. A note never opened here waits for the server.
    const offline = this.local.whenSynced.then(
      () =>
        new Promise<void>((resolve) => {
          window.setTimeout(() => {
            if (this.text.length > 0) resolve();
          }, 1500);
        }),
    );
    this.ready = Promise.race([synced, offline]);
  }

  peers(): Peer[] {
    const self = this.doc.clientID;
    const peers: Peer[] = [];
    this.provider.awareness.getStates().forEach((state, clientId) => {
      if (state.user) peers.push({ clientId, name: String(state.user.name), color: String(state.user.color), self: clientId === self });
    });
    return peers.sort((a, b) => Number(b.self) - Number(a.self) || a.name.localeCompare(b.name));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  destroy(): void {
    this.listeners.clear();
    this.provider.destroy();
    this.local.destroy();
    this.undo.destroy();
    this.doc.destroy();
  }

  private setStatus(status: LiveStatus) {
    if (this.status === status) return;
    this.status = status;
    this.emit();
  }

  private emit() {
    this.listeners.forEach((l) => l());
  }
}
