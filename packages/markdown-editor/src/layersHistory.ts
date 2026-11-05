import { EditorView } from "@codemirror/view";
import type { LayersHistoryEntry } from "./layersFacet";

// A graphic's History button (the host's `layers.history`): a list of its
// earlier versions over the picture, each opening full size in a new tab.

const CLOCK =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9"/><path d="M2.5 2.5v2.6h2.6"/><path d="M8 5v3.2l2.2 1.4"/></svg>';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

/** The History button for a graphic shown in `wrap`, listing `entries`. */
export function historyButton(wrap: HTMLElement, entries: LayersHistoryEntry[]): HTMLButtonElement {
  const button = el("button", "cm-md-image-layers cm-md-image-history-button");
  button.type = "button";
  button.dataset.history = "";
  button.innerHTML = CLOCK;
  button.append(document.createTextNode("History"));
  const n = entries.length;
  button.title = `${n} earlier ${n === 1 ? "version" : "versions"} of this graphic`;
  button.setAttribute("aria-haspopup", "dialog");
  button.addEventListener("mousedown", (e) => e.preventDefault());
  button.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const open = wrap.querySelector(".cm-md-image-history");
    if (open) close(wrap);
    else show(wrap, entries, button);
  });
  return button;
}

function close(wrap: HTMLElement) {
  wrap.querySelector(".cm-md-image-history")?.remove();
  wrap.classList.remove("cm-md-image-history-open");
}

function show(wrap: HTMLElement, entries: LayersHistoryEntry[], button: HTMLButtonElement) {
  const panel = el("div", "cm-md-image-history");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Earlier versions of this graphic");
  const head = el("div", "cm-md-image-history-head");
  head.append(el("strong", "", "Earlier versions"));
  const x = el("button", "cm-md-image-history-close", "×");
  x.type = "button";
  x.title = "Close";
  x.setAttribute("aria-label", "Close");
  x.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    close(wrap);
    button.focus();
  });
  head.append(x);
  panel.append(head);
  const list = el("ul", "cm-md-image-history-list");
  for (const entry of entries) {
    const li = el("li", "cm-md-image-history-item");
    const a = el("a", "cm-md-image-history-thumb");
    a.href = entry.url.replace(/#.*$/, "");
    a.target = "_blank";
    a.rel = "noopener";
    a.title = "Open full size";
    const img = el("img", "");
    img.src = a.href;
    img.alt = entry.label;
    img.loading = "lazy";
    a.append(img);
    const text = el("span", "cm-md-image-history-text");
    text.append(el("span", "cm-md-image-history-label", entry.label));
    if (entry.detail) text.append(el("span", "cm-md-image-history-detail", entry.detail));
    li.append(a, text);
    list.append(li);
  }
  panel.append(list);
  panel.addEventListener("mousedown", (e) => e.stopPropagation());
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close(wrap);
      button.focus();
    }
  });
  wrap.append(panel);
  wrap.classList.add("cm-md-image-history-open");
  // A click anywhere else closes it.
  const away = (e: MouseEvent) => {
    if (!panel.isConnected) return document.removeEventListener("mousedown", away, true);
    if (panel.contains(e.target as Node) || button.contains(e.target as Node)) return;
    close(wrap);
    document.removeEventListener("mousedown", away, true);
  };
  document.addEventListener("mousedown", away, true);
  // Focus goes in (for Escape) without ringing the close button.
  panel.tabIndex = -1;
  panel.focus({ preventScroll: true });
}

export const historyTheme = EditorView.theme({
  ".cm-md-image-history-button svg": { flex: "none", width: "14px", height: "14px" },
  ".cm-md-image-history-open .cm-md-image-layers": { opacity: "1" },
  ".cm-md-image-history": {
    position: "absolute",
    top: "40px",
    right: "6px",
    zIndex: "6",
    width: "min(280px, calc(100% - 12px))",
    maxHeight: "340px",
    display: "flex",
    flexDirection: "column",
    background: "var(--card, #fff)",
    color: "var(--text, #1f2328)",
    border: "1px solid var(--border, #d0d7de)",
    borderRadius: "10px",
    boxShadow: "0 8px 24px rgb(0 0 0 / 0.18)",
    font: "13px/1.35 var(--font-sans, system-ui)",
    whiteSpace: "normal",
    cursor: "default",
    outline: "none",
  },
  ".cm-md-image-history-head": {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 8px 6px 12px",
    borderBottom: "1px solid var(--border, #d0d7de)",
  },
  ".cm-md-image-history-close": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "26px",
    height: "26px",
    padding: "0",
    border: "0",
    background: "none",
    color: "inherit",
    fontSize: "18px",
    lineHeight: "1",
    cursor: "pointer",
    borderRadius: "6px",
  },
  ".cm-md-image-history-close:hover": { background: "rgb(0 0 0 / 0.06)" },
  ".cm-md-image-history-list": { listStyle: "none", margin: "0", padding: "6px", overflowY: "auto" },
  ".cm-md-image-history-item": { display: "flex", alignItems: "center", gap: "10px", padding: "6px", borderRadius: "8px" },
  ".cm-md-image-history-item:hover": { background: "rgb(0 0 0 / 0.04)" },
  ".cm-md-image-history-thumb": {
    flex: "none",
    display: "block",
    width: "88px",
    height: "62px",
    border: "1px solid var(--border, #d0d7de)",
    borderRadius: "6px",
    overflow: "hidden",
    background: "#fff",
  },
  ".cm-md-image-history-thumb img": { width: "100%", height: "100%", objectFit: "contain", display: "block", margin: "0", maxWidth: "none" },
  ".cm-md-image-history-text": { display: "flex", flexDirection: "column", gap: "2px", minWidth: "0" },
  ".cm-md-image-history-label": { fontWeight: "600" },
  ".cm-md-image-history-detail": { color: "var(--muted, #656d76)", fontSize: "12px" },
});
