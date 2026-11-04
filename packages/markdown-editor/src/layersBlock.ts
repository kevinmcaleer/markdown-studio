import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { imageAt, imageMarkdown } from "./imagePopover";
import { isLayersUrl, LAYERS_MODEL_EVENT, layersOpener, layersUrl, type LayersOpenHow } from "./layersFacet";
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
  /** The next assembly step after a graphic (Layers 3D scenes). */
  nextStepDoc?(doc: unknown): unknown;
  staleScenes?(doc: unknown, stamp: number): number;
  hasScene?(doc: unknown): boolean;
  stepBadge?(doc: unknown): { last: number; auto: number | null } | null;
};

/** The project's 3D model, as Layers keeps it: `stamp` goes up with each change. */
export type LayersProjectModel = { version: 1; stamp: number; parts: unknown[] };
export type LayersEditor = {
  setMode(mode: "inline" | "full"): void;
  mode(): "inline" | "full";
  destroy(): void;
  focus(): void;
  /** Draws an assembly guide from the project's model, a page at a time (Layers 3D scenes). */
  assemblyGuide?(guide: { title?: string; each(result: LayersResult, index: number, total: number): void | Promise<void> }): Promise<number>;
};
export type LayersResult = { png: Blob; title: string; width: number; height: number };

export type LayersOptions = {
  /** Loads Layers: `() => import("…/layers.js")`. */
  load: () => Promise<LayersApi>;
  /** Fetches a picture's bytes (to read a graphic's layers or draw on a photo). Defaults to fetch with credentials. */
  fetchImage?: (url: string) => Promise<Blob>;
  /** The host's 3D models (STL files), offered in a graphic's 3D scenes. */
  listModels?: () => Promise<{ url: string; title?: string; thumbnail?: string | (() => Promise<Blob | string | null | undefined>) }[]>;
  /** Fetches a model's bytes for a 3D scene. Defaults to fetch with credentials. */
  fetchModel?: (url: string) => Promise<ArrayBuffer | Blob>;
  /**
   * The project's 3D model (null: none yet), which every 3D scene picks its
   * parts from. With both, graphics drawn from an older version say so and
   * offer to update, and graphics with a scene offer "Next step".
   */
  loadModel?: () => Promise<LayersProjectModel | null>;
  saveModel?: (model: LayersProjectModel) => Promise<void>;
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
// The project's model, asked for at most every few seconds, and each
// graphic's layers by its link (a saved graphic gets a new link).
const modelCache = new WeakMap<LayersHost, { at: number; model: Promise<LayersProjectModel | null> }>();
function projectModel(host: LayersHost): Promise<LayersProjectModel | null> {
  const got = modelCache.get(host);
  if (got && Date.now() - got.at < 5000) return got.model;
  const model = host.loadModel ? host.loadModel().catch(() => null) : Promise.resolve(null);
  modelCache.set(host, { at: Date.now(), model });
  return model;
}
const docCache = new Map<string, Promise<unknown | null>>();
function graphicDoc(api: LayersApi, url: string, fetchImage: (url: string) => Promise<Blob>): Promise<unknown | null> {
  let doc = docCache.get(url);
  if (!doc) {
    doc = api.readDoc(url, fetchImage).catch(() => null);
    docCache.set(url, doc);
    if (docCache.size > 200) docCache.delete(docCache.keys().next().value!);
  }
  return doc;
}

/** Whether the graphic at `url` has 3D scenes, and how many are behind the project's model. */
/** The Layers graphics in the text, in order: each one's link and where its Markdown starts. */
export function graphicsIn(text: string): { url: string; at: number }[] {
  const out: { url: string; at: number }[] = [];
  for (const m of text.matchAll(/!\[[^\]\n]*\]\(\s*<?([^)\s>]+)/g)) if (isLayersUrl(m[1])) out.push({ url: m[1], at: m.index! });
  return out;
}

/**
 * The step number for a graphic starting at `pos`: the graphics before it,
 * top to bottom, each count on from the last (one that follows its place
 * takes the step before plus one; one numbered by hand keeps its number).
 */
async function stepAt(api: LayersApi, host: LayersHost, text: string, pos: number): Promise<number> {
  let prev = 0;
  if (!api.stepBadge) return 1;
  for (const g of graphicsIn(text)) {
    if (g.at >= pos) break;
    const step = api.stepBadge(await graphicDoc(api, g.url, host.fetchImage ?? defaultFetch));
    if (step) prev = step.auto !== null ? prev + 1 : step.last;
  }
  return prev + 1;
}

/** What a graphic's mark says: its 3D scenes behind the project's model, or its step number out of place. */
async function graphicStatus(host: LayersHost, url: string, text = ""): Promise<{ scene: boolean; stale: number; step?: number } | null> {
  if (!isLayersUrl(url)) return null;
  const api = await loadLayers(host.load);
  const doc = await graphicDoc(api, url, host.fetchImage ?? defaultFetch);
  if (!doc) return null;
  const scene = !!api.hasScene?.(doc);
  const model = scene && host.loadModel && host.saveModel ? await projectModel(host) : null;
  const stale = model && api.staleScenes ? api.staleScenes(doc, model.stamp) : 0;
  const badge = api.stepBadge?.(doc);
  const at = graphicsIn(text).find(g => g.url === url);
  let step: number | undefined;
  if (badge && badge.auto !== null && at) {
    const want = await stepAt(api, host, text, at.at);
    if (want !== badge.auto) step = want;
  }
  return { scene: scene && !!(host.loadModel && host.saveModel), stale, ...(step ? { step } : {}) };
}

export function openLayers(view: EditorView, host: LayersHost, pos: number, mode: "inline" | "full" = "inline", how: LayersOpenHow = {}): void {
  if (view.state.readOnly) return;
  if (sessions.has(view)) closeSession(view);
  const at = imageAt(view.state, pos);
  // "Next step" starts a new graphic after this one, from a copy of it.
  const image = how.nextStep ? null : at;
  const from = how.nextStep ? at : image;
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
      let doc = from && isLayersUrl(from.url) ? await api.readDoc(from.url, fetchImage) : null;
      if (how.nextStep && doc && api.nextStepDoc) doc = api.nextStepDoc(doc);
      // Its step number from its place: after the graphic it's the next step of, or where it is.
      const text = view.state.doc.toString();
      const stepNumber = await stepAt(api, host, text, how.nextStep && from ? from.to : image ? image.from : pos).catch(() => undefined);
      if (session.closed) return;
      container.innerHTML = "";
      session.editor = api.mount(container, {
        doc,
        picture: image && !doc ? image.url : null,
        title: image?.alt && !/\.(png|jpe?g|gif|webp|svg)$/i.test(image.alt) ? image.alt : "",
        mode,
        fetchImage,
        listImages: host.listImages,
        listModels: host.listModels,
        fetchModel: host.fetchModel ?? (async (url: string) => (await defaultFetch(url)).arrayBuffer()),
        ...(host.loadModel && host.saveModel
          ? {
              loadModel: () => projectModel(host),
              saveModel: async (model: LayersProjectModel) => {
                await host.saveModel!(model);
                modelCache.set(host, { at: Date.now(), model: Promise.resolve(model) });
                // Other graphics on the page check whether they're now behind.
                dispatchEvent(new CustomEvent(LAYERS_MODEL_EVENT));
              },
            }
          : {}),
        updateScenes: !!(how.update || how.nextStep),
        stepNumber,
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

// ------------------------------------------------------------ the assembly guide

export const GUIDE_HEADING = "## Assembly guide";
const GUIDE_MARK = /^\*Making the assembly guide[^\n]*\*$/m;

/**
 * Where the assembly guide goes in `text`: the body of its "## Assembly
 * guide" section (up to the next heading of that level or higher), or, with
 * no such section, the end of the text with the heading to insert first.
 * The guide follows the last step, so a printed page carries it too.
 */
export function guideSection(text: string): { from: number; to: number; heading: boolean } {
  const re = /^## Assembly guide[ \t]*$/m;
  const m = re.exec(text);
  if (!m) return { from: text.length, to: text.length, heading: true };
  let from = m.index + m[0].length;
  if (text[from] === "\n") from++;
  const rest = text.slice(from);
  const next = /^#{1,2}[ \t]/m.exec(rest);
  const to = next ? from + next.index : text.length;
  return { from, to, heading: false };
}

/** The text's first heading-one, as the project's name, or "". */
function titleOf(text: string): string {
  return /^# (.+)$/m.exec(text)?.[1].trim() ?? "";
}

/**
 * Draws an assembly guide from the project's model (a cover, Before you
 * start, the parts list and a step per part), uploads each page and puts
 * them under "## Assembly guide" at the end of the text (or in that section,
 * replacing what it held). Layers draws the pages out of sight; a line in
 * the text says how far it has got.
 */
export async function makeAssemblyGuide(view: EditorView, host: LayersHost): Promise<void> {
  if (view.state.readOnly || !host.loadModel || !host.saveModel) return;
  const text = view.state.doc.toString();
  const section = guideSection(text);
  const lead = section.heading ? `${text.length && !text.endsWith("\n\n") ? (text.endsWith("\n") ? "\n" : "\n\n") : ""}${GUIDE_HEADING}\n\n` : section.from === section.to || text.slice(section.from, section.to).startsWith("\n") ? "" : "\n";
  const mark = (s: string) => `*Making the assembly guide: ${s}…*`;
  view.dispatch({ changes: { from: section.from, to: section.to, insert: `${lead}${mark("opening the project's model")}\n\n` }, userEvent: "input.layers" });
  const setMark = (replacement: string) => {
    const now = view.state.doc.toString();
    const m = GUIDE_MARK.exec(now);
    if (!m) return false;
    view.dispatch({ changes: { from: m.index, to: m.index + m[0].length, insert: replacement }, userEvent: "input.layers" });
    return true;
  };
  const box = document.createElement("div");
  box.className = "cm-layers-hidden";
  box.style.cssText = "position:fixed;left:-40000px;top:0;width:1200px;height:800px;overflow:hidden;pointer-events:none";
  document.body.appendChild(box);
  let editor: LayersEditor | null = null;
  const lines: string[] = [];
  try {
    const api = await loadLayers(host.load);
    editor = api.mount(box, {
      doc: null,
      mode: "inline",
      allowInline: true,
      fetchImage: host.fetchImage ?? defaultFetch,
      listImages: host.listImages,
      listModels: host.listModels,
      fetchModel: host.fetchModel ?? (async (url: string) => (await defaultFetch(url)).arrayBuffer()),
      loadModel: () => projectModel(host),
      saveModel: async (model: LayersProjectModel) => {
        await host.saveModel!(model);
        modelCache.set(host, { at: Date.now(), model: Promise.resolve(model) });
      },
      onDone: () => {},
      onCancel: () => {},
    });
    if (!editor.assemblyGuide) throw new Error("this version of Layers can't draw one");
    await editor.assemblyGuide({
      title: titleOf(text),
      each: async (result, index, total) => {
        setMark(mark(`page ${index + 1} of ${total}, ${result.title || "a page"}`));
        const file = new File([result.png], graphicFileName(result.title), { type: "image/png" });
        const url = layersUrl(await host.uploadImage(file));
        lines.push(imageMarkdown({ alt: result.title || `Page ${index + 1}`, url }));
      },
    });
    setMark(lines.join("\n\n"));
  } catch (e) {
    const msg = e instanceof Error && e.message ? e.message : String(e);
    // The pages made so far stay; the line says what stopped it.
    setMark([...lines, `*The assembly guide couldn't be finished: ${msg.replace(/\*/g, "")}*`].join("\n\n"));
  } finally {
    editor?.destroy();
    box.remove();
  }
}

/** "/Assembly guide": a booklet of pages drawn from the project's model, under "## Assembly guide" at the end. */
export function assemblyGuideCommand(host: LayersHost): SlashCommand {
  return {
    id: "assembly-guide",
    label: "Assembly guide",
    keywords: ["assembly", "guide", "booklet", "instructions", "steps", "flat-pack", "ikea", "manual", "3d"],
    group: "inline",
    icon: "M2.5 2.5h11v11h-11zM2.5 6.5h11M6.5 6.5v7M8.5 9.5h3M8.5 11.5h3",
    block: true,
    run: (view) => void makeAssemblyGuide(view, host),
  };
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
  ".cm-md-image-layers-bar": { position: "absolute", top: "6px", right: "6px", display: "inline-flex", gap: "6px" },
  ".cm-md-image-layers": {
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
  ".cm-md-image-stale": {
    position: "absolute",
    bottom: "6px",
    left: "6px",
    padding: "5px 10px",
    border: "0",
    borderRadius: "8px",
    background: "#d97706",
    color: "#fff",
    font: "600 13px/1.2 var(--font-sans, system-ui)",
    cursor: "pointer",
    boxShadow: "0 2px 8px rgb(0 0 0 / 0.2)",
  },
  ".cm-md-image-stale:hover": { background: "#b45309" },
  ".cm-md-image-layers:hover": { background: "rgb(109 40 217)" },
});

/** Layers graphics in the live view: the "/Graphic" editor and "Edit graphic" on pictures. */
export function layersBlocks(host: LayersHost): Extension {
  return [
    field,
    decorations,
    theme,
    layersOpener.of({
      open: (view, pos, mode, how) => openLayers(view, host, pos, mode ?? "inline", how),
      status: (url: string, text?: string) => graphicStatus(host, url, text),
    }),
    ViewPlugin.define((view) => ({
      // Graphics moved, added or saved: each checks its step number again.
      order: graphicsIn(view.state.doc.toString()).map(g => g.url).join(" "),
      timer: 0,
      update(u: ViewUpdate) {
        if (!u.docChanged) return;
        const order = graphicsIn(u.state.doc.toString()).map(g => g.url).join(" ");
        if (order === this.order) return;
        this.order = order;
        clearTimeout(this.timer);
        this.timer = window.setTimeout(() => dispatchEvent(new CustomEvent(LAYERS_MODEL_EVENT)), 400);
      },
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
