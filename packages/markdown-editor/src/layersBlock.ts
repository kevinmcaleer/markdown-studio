import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from "@codemirror/view";
import { imageAt, imageMarkdown } from "./imagePopover";
import { isLayersUrl, layersOpener, layersUrl } from "./layersFacet";
import type { SlashCommand } from "./slashMenu";

// Layers graphics in the text (the `layers` option). A graphic is an ordinary
// picture line, `![Title](url#layers)`: the PNG carries its own layers, and
// the #layers mark says so. It's drawn and edited like any picture (size,
// caption, gallery). "/Graphic" starts one where the cursor is, and "Edit
// graphic" on the picture opens it again, in the page in place of the
// picture or full screen; the editor's own button switches between the two.
// Done uploads the new PNG through the host's uploadImage and points the
// picture at it.
//
// Layers itself (Fabric.js) isn't bundled: the host's `load()` supplies it,
// the first time a graphic is opened.

/** What Layers' module gives the editor (see packages/layers). */
export type LayersApi = {
  mount(el: HTMLElement, options: Record<string, unknown>): LayersEditor;
  readDoc(url: string, fetchImage?: (url: string) => Promise<Blob>): Promise<unknown | null>;
};
export type LayersEditor = {
  setMode(mode: "inline" | "full"): void;
  mode(): "inline" | "full";
  destroy(): void;
  focus(): void;
};
export type LayersResult = { png: Blob; title: string; width: number; height: number };

export type LayersOptions = {
  /** Loads Layers: `() => import("…/layers.js")`. */
  load: () => Promise<LayersApi>;
  /** Fetches a picture's bytes (to read a graphic's layers or draw on a photo). Defaults to fetch with credentials. */
  fetchImage?: (url: string) => Promise<Blob>;
  /** Where "/Graphic" opens a new one: in the page (the default) or full screen. */
  mode?: "inline" | "full";
  /** After a graphic is saved: its old picture's link (to tidy up, say) and the new one. */
  onReplace?: (oldUrl: string, newUrl: string) => void;
};

export type LayersHost = LayersOptions & {
  uploadImage: (file: File) => Promise<string>;
  listImages?: () => Promise<{ url: string; title?: string }[]>;
};

/** A short file name for a graphic titled `title`. */
export function graphicFileName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${slug || "graphic"}.layers.png`;
}

/** Where a new graphic's picture line goes, for the editor opened at `pos`: on its own line, as its own paragraph. */
export function newGraphicInsert(doc: string, pos: number, markdown: string): { from: number; to: number; insert: string } {
  const lineStart = doc.lastIndexOf("\n", pos - 1) + 1;
  let lineEnd = doc.indexOf("\n", pos);
  if (lineEnd < 0) lineEnd = doc.length;
  const text = doc.slice(lineStart, lineEnd);
  const next = lineEnd < doc.length ? doc.slice(lineEnd + 1, (doc.indexOf("\n", lineEnd + 1) + 1 || doc.length + 1) - 1) : "";
  // A line after it, so the cursor can rest below the picture (and a paragraph after stays its own).
  const after = next.trim() || lineEnd >= doc.length ? "\n" : "";
  if (!text.trim()) return { from: lineStart, to: lineEnd, insert: markdown + after };
  return { from: lineEnd, to: lineEnd, insert: `\n\n${markdown}${after}` };
}

// ------------------------------------------------------------ the open graphic

type Open = { id: number; pos: number; isNew: boolean };
const openEffect = StateEffect.define<Open>();
const closeEffect = StateEffect.define<number>();

type Session = {
  id: number;
  container: HTMLElement;
  editor: LayersEditor | null;
  closed: boolean;
};
const sessions = new WeakMap<EditorView, Session>();
let nextId = 1;

class LayersWidget extends WidgetType {
  constructor(readonly id: number) {
    super();
  }
  eq(other: LayersWidget) {
    return other.id === this.id;
  }
  toDOM(view: EditorView) {
    const s = sessions.get(view);
    if (s && s.id === this.id) return s.container;
    return document.createElement("div");
  }
  get estimatedHeight() {
    return 520;
  }
  ignoreEvent() {
    return true;
  }
  destroy() {
    // The session outlives a redraw; closing it is what ends it.
  }
}

const field = StateField.define<Open | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(openEffect)) return e.value;
      if (e.is(closeEffect) && value?.id === e.value) return null;
    }
    if (!value || !tr.docChanged) return value;
    const pos = tr.changes.mapPos(value.pos, value.isNew ? 1 : -1);
    return pos === value.pos ? value : { ...value, pos };
  },
});

function decorationsFor(state: EditorState, open: Open): DecorationSet {
  const widget = new LayersWidget(open.id);
  const line = state.doc.lineAt(Math.min(open.pos, state.doc.length));
  // On a picture: in its place. A new graphic: after the cursor's line.
  if (!open.isNew && imageAt(state, open.pos)) return Decoration.set([Decoration.replace({ widget, block: true }).range(line.from, line.to)]);
  return Decoration.set([Decoration.widget({ widget, block: true, side: 1 }).range(line.to)]);
}

// Block decorations have to come straight from the state, not a view plugin.
const decorations = EditorView.decorations.compute([field, "doc"], (state) => {
  const open = state.field(field);
  return open ? decorationsFor(state, open) : Decoration.none;
});

const loaded = new WeakMap<LayersOptions["load"], Promise<LayersApi>>();
function loadLayers(load: LayersOptions["load"]): Promise<LayersApi> {
  let p = loaded.get(load);
  if (!p) {
    p = load().catch((e) => {
      loaded.delete(load);
      throw e;
    });
    loaded.set(load, p);
  }
  return p;
}

const defaultFetch = async (url: string) => {
  const resp = await fetch(url, { credentials: "include" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.blob();
};

function closeSession(view: EditorView, extra: Parameters<EditorView["dispatch"]>[0] = {}): void {
  const s = sessions.get(view);
  if (!s) return;
  s.closed = true;
  sessions.delete(view);
  view.dispatch({ ...extra, effects: closeEffect.of(s.id) });
  s.editor?.destroy();
  s.container.remove();
}

/**
 * Opens Layers in the text: on the picture whose Markdown starts at `pos`
 * (its graphic, or a new graphic drawn over the photo), or, with `pos` on a
 * line that isn't a picture, a new graphic there.
 */
export function openLayers(view: EditorView, host: LayersHost, pos: number, mode: "inline" | "full" = "inline"): void {
  if (view.state.readOnly) return;
  if (sessions.has(view)) closeSession(view);
  const image = imageAt(view.state, pos);
  const id = nextId++;
  const container = document.createElement("div");
  container.className = "cm-layers-block";
  container.innerHTML = '<div class="cm-layers-loading">Opening Layers…</div>';
  const session: Session = { id, container, editor: null, closed: false };
  sessions.set(view, session);
  view.dispatch({ effects: openEffect.of({ id, pos, isNew: !image }), scrollIntoView: false });

  const fetchImage = host.fetchImage ?? defaultFetch;
  const oldUrl = image?.url ?? "";
  void (async () => {
    try {
      const api = await loadLayers(host.load);
      const doc = image && isLayersUrl(image.url) ? await api.readDoc(image.url, fetchImage) : null;
      if (session.closed) return;
      container.innerHTML = "";
      session.editor = api.mount(container, {
        doc,
        picture: image && !doc ? image.url : null,
        title: image?.alt && !/\.(png|jpe?g|gif|webp|svg)$/i.test(image.alt) ? image.alt : "",
        mode,
        fetchImage,
        listImages: host.listImages,
        doneLabel: "Save",
        onDone: async (result: LayersResult) => {
          const file = new File([result.png], graphicFileName(result.title), { type: "image/png" });
          const url = layersUrl(await host.uploadImage(file));
          if (session.closed) return;
          const open = view.state.field(field, false);
          const at = open && open.id === id ? open.pos : pos;
          const current = !open?.isNew ? imageAt(view.state, at) : null;
          const alt = result.title || current?.alt || "Graphic";
          if (current) {
            const insert = imageMarkdown({ alt, url, title: current.title });
            closeSession(view, { changes: { from: current.from, to: current.to, insert }, userEvent: "input.layers" });
          } else {
            const markdown = imageMarkdown({ alt, url });
            const change = newGraphicInsert(view.state.doc.toString(), Math.min(at, view.state.doc.length), markdown);
            closeSession(view, { changes: change, userEvent: "input.layers", selection: { anchor: change.from + change.insert.length } });
          }
          view.focus();
          if (oldUrl && oldUrl !== url) host.onReplace?.(oldUrl, url);
        },
        onCancel: () => {
          closeSession(view);
          view.focus();
        },
      });
    } catch (e) {
      if (session.closed) return;
      container.innerHTML = "";
      const msg = document.createElement("div");
      msg.className = "cm-layers-loading cm-layers-error";
      msg.textContent = `Layers couldn't open: ${e instanceof Error ? e.message : String(e)}`;
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "Close";
      close.addEventListener("click", () => closeSession(view));
      msg.append(" ", close);
      container.append(msg);
    }
  })();
}

/** Whether Layers is open in this editor. */
export function layersOpen(view: EditorView): boolean {
  return sessions.has(view);
}

/** "/Graphic": a new Layers graphic where the cursor is. */
export function layersCommand(host: LayersHost): SlashCommand {
  return {
    id: "layers",
    label: "Graphic",
    keywords: ["layers", "graphic", "canvas", "draw", "design", "annotate", "label", "shapes", "arrows", "canva", "picture"],
    group: "inline",
    icon: "M8 1.8 14.5 5 8 8.2 1.5 5zM1.5 8 8 11.2 14.5 8M1.5 11 8 14.2 14.5 11",
    block: true,
    run: (view) => openLayers(view, host, view.state.selection.main.head, host.mode ?? "inline"),
  };
}

const theme = EditorView.theme({
  ".cm-layers-block": { margin: "0.5rem 0 1rem", whiteSpace: "normal", cursor: "default", fontFamily: "var(--font-sans, system-ui)" },
  ".cm-layers-loading": {
    padding: "2.5rem 1rem",
    border: "1px dashed var(--border)",
    borderRadius: "12px",
    textAlign: "center",
    color: "var(--muted)",
    fontSize: "14px",
  },
  ".cm-layers-error": { color: "var(--danger, #b42318)" },
  ".cm-md-image-layers": {
    position: "absolute",
    top: "6px",
    right: "6px",
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    padding: "5px 10px",
    border: "0",
    borderRadius: "8px",
    background: "rgb(124 58 237 / 0.92)",
    color: "#fff",
    font: "600 13px/1.2 var(--font-sans, system-ui)",
    cursor: "pointer",
    opacity: "0",
    transition: "opacity 0.15s",
    boxShadow: "0 2px 8px rgb(0 0 0 / 0.2)",
  },
  ".cm-md-image-wrap:hover .cm-md-image-layers, .cm-md-image-layers:focus-visible": { opacity: "1" },
  ".cm-md-image-layers:hover": { background: "rgb(109 40 217)" },
});

/** Layers graphics in the live view: the "/Graphic" editor and "Edit graphic" on pictures. */
export function layersBlocks(host: LayersHost): Extension {
  return [
    field,
    decorations,
    theme,
    layersOpener.of({ open: (view, pos, mode) => openLayers(view, host, pos, mode ?? "inline") }),
    ViewPlugin.define((view) => ({
      destroy() {
        const s = sessions.get(view);
        if (s) {
          s.closed = true;
          s.editor?.destroy();
          sessions.delete(view);
        }
      },
    })),
  ];
}
