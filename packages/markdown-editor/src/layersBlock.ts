import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { imageAt, imageMarkdown } from "./imagePopover";
import { isLayersUrl, LAYERS_MODEL_EVENT, LAYERS_UPDATE_EVENT, layersOpener, layersUrl, type LayersHistoryEntry, type LayersOpenHow, type LayersUpdateProgress } from "./layersFacet";
import { historyTheme } from "./layersHistory";
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
  /** A copy of a step to go straight after it, its step number one on (Layers 3D scenes). */
  duplicateStepDoc?(doc: unknown): unknown;
  staleScenes?(doc: unknown, stamp: number): number;
  hasScene?(doc: unknown): boolean;
  /** Whether a graphic has a screw inventory, which follows the project's model as 3D scenes do. */
  hasInventory?(doc: unknown): boolean;
  stepBadge?(doc: unknown): { last: number; auto: number | null } | null;
};

/** The project's 3D model, as Layers keeps it: `stamp` goes up with each change. */
export type LayersProjectModel = { version: 1; stamp: number; parts: unknown[] };
/** The 2D wiring diagram as 3D scenes use it (Layers' WiringHost). */
export type LayersWiringHost = {
  load: () => Promise<unknown | null>;
  addConnections?: (connections: unknown[]) => Promise<unknown[]>;
  open?: (connection?: string) => void;
  saveSockets?: (slug: string, sockets: unknown) => Promise<void>;
};
export type LayersEditor = {
  setMode(mode: "inline" | "full"): void;
  mode(): "inline" | "full";
  destroy(): void;
  focus(): void;
  /** Resolves once it has opened (layers loaded, 3D pictures drawn again with `updateScenes`). */
  ready?(): Promise<void>;
  getDoc?(): unknown;
  exportResult?(): Promise<LayersResult>;
  /** Draws an assembly guide from the project's model, a page at a time (Layers 3D scenes). */
  assemblyGuide?(guide: { title?: string; each(result: LayersResult, index: number, total: number): void | Promise<void> }): Promise<number>;
  /** Draws the screw inventory from the project's model: false when it has no screws (Layers 3D scenes). */
  screwInventory?(): Promise<boolean>;
  /** The project's wire list as a Markdown table, "" with no wires (Layers 3D scenes). */
  wireList?(): Promise<string>;
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
  /**
   * The project's 2D wiring diagram, for 3D scenes' wires: { load(),
   * addConnections?(list), open?(connectionId), saveSockets?(slug, sockets) }
   * (see Layers' scene/wiring2d.ts). With it, a 3D wire takes its colours
   * from the diagram's connection, and "Add missing wires" routes the
   * diagram's cables between sockets.
   */
  wiring?: LayersWiringHost;
  /** Where "/Graphic" opens a new one: in the page (the default) or full screen. */
  mode?: "inline" | "full";
  /** After a graphic is saved: its old picture's link (to tidy up, say) and the new one. */
  onReplace?: (oldUrl: string, newUrl: string) => void;
  /**
   * A graphic's earlier versions the host keeps (published ones, say),
   * newest first. With any, the graphic shows a History button that lists them.
   */
  history?: (url: string) => Promise<LayersHistoryEntry[]>;
};

export type LayersHost = LayersOptions & {
  /** `replaces`: the graphic's old picture, when this is a new render of it (so the host can keep only the ones it needs). */
  uploadImage: (file: File, options?: { replaces?: string }) => Promise<string>;
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
  const follows = scene || !!api.hasInventory?.(doc);
  const model = follows && host.loadModel && host.saveModel ? await projectModel(host) : null;
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

// ------------------------------------------------------------ updating in one press

/** Where the graphic at `url` is in the text now, if it's still there. */
function graphicAt(view: EditorView, url: string) {
  const g = graphicsIn(view.state.doc.toString()).find(g => g.url === url);
  return g ? imageAt(view.state, g.at) : null;
}

const updating = new WeakMap<EditorView, Map<string, Promise<void>>>();

/**
 * "Update" on an out-of-date graphic: opens it out of sight with its 3D
 * pictures drawn again from the project's model and its step number put
 * right, saves the new picture and points the text at it, as Save would.
 */
export function updateGraphic(view: EditorView, host: LayersHost, url: string, stepOnly = false): Promise<void> {
  let runs = updating.get(view);
  if (!runs) updating.set(view, (runs = new Map()));
  const running = runs.get(url);
  if (running) return running;
  const run = redraw(view, host, url, stepOnly).finally(() => runs!.delete(url));
  runs.set(url, run);
  return run;
}

async function redraw(view: EditorView, host: LayersHost, url: string, stepOnly = false): Promise<void> {
  if (view.state.readOnly) return;
  const api = await loadLayers(host.load);
  const fetchImage = host.fetchImage ?? defaultFetch;
  const doc = await api.readDoc(url, fetchImage);
  if (!doc) throw new Error("its layers couldn't be read");
  const text = view.state.doc.toString();
  const st = await graphicStatus(host, url, text);
  // Step only: its number put right; a 3D picture behind the model stays marked so.
  const redrawScenes = !!st?.stale && !stepOnly;
  const g = graphicsIn(text).find(g => g.url === url);
  const stepNumber = g ? await stepAt(api, host, text, g.at).catch(() => undefined) : undefined;
  const box = document.createElement("div");
  box.className = "cm-layers-hidden";
  box.style.cssText = "position:fixed;left:-40000px;top:0;width:1200px;height:800px;overflow:hidden;pointer-events:none";
  document.body.appendChild(box);
  let editor: LayersEditor | null = null;
  try {
    editor = api.mount(box, {
      doc,
      mode: "inline",
      allowInline: true,
      fetchImage,
      listImages: host.listImages,
      listModels: host.listModels,
      wiring: host.wiring,
      fetchModel: host.fetchModel ?? (async (u: string) => (await defaultFetch(u)).arrayBuffer()),
      ...(host.loadModel && host.saveModel ? { loadModel: () => projectModel(host), saveModel: host.saveModel } : {}),
      updateScenes: redrawScenes,
      stepNumber,
      onDone: () => {},
      onCancel: () => {},
    });
    if (!editor.ready || !editor.exportResult) throw new Error("this version of Layers can't update a graphic without opening it");
    await editor.ready();
    // A picture that couldn't be drawn again stays out of date, rather than saved as if it were done.
    const model = redrawScenes ? await projectModel(host) : null;
    if (model && api.staleScenes && editor.getDoc && api.staleScenes(editor.getDoc(), model.stamp)) {
      throw new Error("its 3D picture couldn't be drawn again; open it with Edit graphic to see why");
    }
    const result = await editor.exportResult();
    const file = new File([result.png], graphicFileName(result.title), { type: "image/png" });
    const newUrl = layersUrl(await host.uploadImage(file, { replaces: url }));
    const current = graphicAt(view, url);
    if (!current) return;
    const insert = imageMarkdown({ alt: result.title || current.alt || "Graphic", url: newUrl, title: current.title });
    view.dispatch({ changes: { from: current.from, to: current.to, insert }, userEvent: "input.layers" });
    if (newUrl !== url) host.onReplace?.(url, newUrl);
  } finally {
    editor?.destroy();
    box.remove();
  }
}

/** The graphics in `text` that are out of date (behind the model, or numbered out of place). */
async function pendingGraphics(host: LayersHost, text: string): Promise<string[]> {
  const out: string[] = [];
  for (const { url } of graphicsIn(text)) {
    if (out.includes(url)) continue;
    const st = await graphicStatus(host, url, text).catch(() => null);
    if (st && (st.stale || st.step)) out.push(url);
  }
  return out;
}

/**
 * After a step is put in between (Next step, Duplicate step), the graphics
 * below the one at `url` that number themselves from their place get their
 * new numbers, top to bottom, one at a time. Only their numbers change.
 */
export async function renumberAfter(view: EditorView, host: LayersHost, url: string): Promise<number> {
  let done = 0;
  const failed: string[] = [];
  for (;;) {
    const text = view.state.doc.toString();
    const list = graphicsIn(text);
    const i = list.findIndex(g => g.url === url);
    if (i < 0) break;
    let next: string | null = null;
    for (const g of list.slice(i + 1)) {
      if (failed.includes(g.url)) continue;
      const st = await graphicStatus(host, g.url, text).catch(() => null);
      if (st?.step) {
        next = g.url;
        break;
      }
    }
    if (!next || view.state.readOnly) break;
    try {
      await updateGraphic(view, host, next, true);
      // Still there under its old link: it wasn't saved, so it isn't tried again.
      if (graphicsIn(view.state.doc.toString()).some(g => g.url === next)) failed.push(next);
      else done++;
    } catch {
      failed.push(next);
    }
  }
  return done;
}

const allRuns = new WeakMap<EditorView, LayersUpdateProgress>();
function sayProgress(view: EditorView, p: LayersUpdateProgress): void {
  if (p) allRuns.set(view, p);
  else allRuns.delete(view);
  dispatchEvent(new CustomEvent(LAYERS_UPDATE_EVENT, { detail: p }));
}

/**
 * "Update all": every out-of-date graphic, top to bottom, one at a time.
 * Each is checked again as its turn comes (an earlier one's new step
 * number can put a later one right). Says how many it saved.
 */
export async function updateAllGraphics(view: EditorView, host: LayersHost): Promise<number> {
  if (allRuns.get(view) || view.state.readOnly) return 0;
  const first = await pendingGraphics(host, view.state.doc.toString());
  let done = 0;
  const failed: string[] = [];
  sayProgress(view, { done, total: first.length });
  try {
    for (;;) {
      const text = view.state.doc.toString();
      const todo = (await pendingGraphics(host, text)).filter(u => !failed.includes(u));
      if (!todo.length) break;
      sayProgress(view, { done, total: done + todo.length });
      try {
        await updateGraphic(view, host, todo[0]);
        done++;
      } catch {
        failed.push(todo[0]);
      }
    }
  } finally {
    sayProgress(view, null);
  }
  if (failed.length) throw new Error(`${failed.length === 1 ? "One graphic" : `${failed.length} graphics`} couldn't be updated; open ${failed.length === 1 ? "it" : "them"} with Edit graphic to see why.`);
  return done;
}

export function openLayers(view: EditorView, host: LayersHost, pos: number, mode: "inline" | "full" = "inline", how: LayersOpenHow = {}): void {
  if (view.state.readOnly) return;
  if (sessions.has(view)) closeSession(view);
  const at = imageAt(view.state, pos);
  // "Next step" and "Duplicate step" start a new graphic after this one, from a copy of it.
  const after = !!(how.nextStep || how.duplicate);
  const image = after ? null : at;
  const from = after ? at : image;
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
      else if (how.duplicate && doc) {
        if (!api.duplicateStepDoc) throw new Error("this version of Layers can't duplicate a step");
        doc = api.duplicateStepDoc(doc);
      }
      // Its step number from its place: after the graphic it's the next step of, or where it is.
      const text = view.state.doc.toString();
      const stepNumber = await stepAt(api, host, text, after && from ? from.to : image ? image.from : pos).catch(() => undefined);
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
        wiring: host.wiring,
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
          // A new render of the graphic it was opened from (not of a photo drawn on).
          const url = layersUrl(await host.uploadImage(file, isLayersUrl(oldUrl) ? { replaces: oldUrl } : undefined));
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
          // A step put in between: the steps after it count on from it.
          if (after) void renumberAfter(view, host, url).catch(() => {});
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
      wiring: host.wiring,
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

// ------------------------------------------------------------ the screw inventory

const INVENTORY_MARK = /^\*Drawing the screw inventory[^\n]*\*$/m;

/**
 * Where the screw inventory goes for the cursor at `pos`: the end of the
 * section it's in, the one under the nearest heading-one above it (or the
 * nearest heading of any level, with no heading-one), up to the next
 * heading of that level or higher. With no heading above, the end of the text.
 */
export function inventorySpot(text: string, pos: number): number {
  const heads: { at: number; level: number }[] = [];
  let fence: string | null = null;
  let at = 0;
  for (const line of text.split("\n")) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
    } else if (fence === null) {
      const m = /^ {0,3}(#{1,6})[ \t]/.exec(line);
      if (m) heads.push({ at, level: m[1].length });
    }
    at += line.length + 1;
  }
  const above = heads.filter(h => h.at <= pos);
  const owner = [...above].reverse().find(h => h.level === 1) || above[above.length - 1];
  const next = owner && heads.find(h => h.at > owner.at && h.level <= owner.level);
  let end = next ? next.at : text.length;
  // Before the blank lines that end the section.
  while (end > (owner ? owner.at : 0) && /\s/.test(text[end - 1])) end--;
  return end;
}

/**
 * Draws the screw inventory (every screw and heat-set insert in the
 * project's model, by kind, with counts and a picture of each) out of
 * sight, uploads it and puts it at the end of the cursor's section: in a
 * project, the bottom of its Assembly instructions. A line says how it's going.
 */
export async function makeScrewInventory(view: EditorView, host: LayersHost): Promise<void> {
  if (view.state.readOnly || !host.loadModel || !host.saveModel) return;
  const text = view.state.doc.toString();
  const spot = inventorySpot(text, view.state.selection.main.head);
  const lead = spot === 0 ? "" : "\n\n";
  const mark = "*Drawing the screw inventory…*";
  view.dispatch({ changes: { from: spot, to: spot, insert: `${lead}${mark}` }, userEvent: "input.layers" });
  const setMark = (replacement: string) => {
    const now = view.state.doc.toString();
    const m = INVENTORY_MARK.exec(now);
    if (!m) return false;
    view.dispatch({ changes: { from: m.index, to: m.index + m[0].length, insert: replacement }, userEvent: "input.layers" });
    return true;
  };
  const box = document.createElement("div");
  box.className = "cm-layers-hidden";
  box.style.cssText = "position:fixed;left:-40000px;top:0;width:1200px;height:800px;overflow:hidden;pointer-events:none";
  document.body.appendChild(box);
  let editor: LayersEditor | null = null;
  try {
    const api = await loadLayers(host.load);
    editor = api.mount(box, {
      doc: null,
      mode: "inline",
      allowInline: true,
      title: "Screw inventory",
      fetchImage: host.fetchImage ?? defaultFetch,
      listImages: host.listImages,
      listModels: host.listModels,
      wiring: host.wiring,
      fetchModel: host.fetchModel ?? (async (url: string) => (await defaultFetch(url)).arrayBuffer()),
      loadModel: () => projectModel(host),
      saveModel: async (model: LayersProjectModel) => {
        await host.saveModel!(model);
        modelCache.set(host, { at: Date.now(), model: Promise.resolve(model) });
      },
      onDone: () => {},
      onCancel: () => {},
    });
    if (!editor.screwInventory || !editor.exportResult) throw new Error("this version of Layers can't draw one");
    if (!(await editor.screwInventory())) throw new Error("the project has no screws yet. Put them in with the Screw tool (S) in a 3D scene");
    const result = await editor.exportResult();
    const title = result.title && result.title !== "Untitled" ? result.title : "Screw inventory";
    const file = new File([result.png], graphicFileName(title), { type: "image/png" });
    const url = layersUrl(await host.uploadImage(file));
    setMark(imageMarkdown({ alt: title, url }));
  } catch (e) {
    const msg = e instanceof Error && e.message ? e.message : String(e);
    setMark(`*The screw inventory couldn't be drawn: ${msg.replace(/\*/g, "")}.*`);
  } finally {
    editor?.destroy();
    box.remove();
  }
}

/** "/Screw inventory": every screw and insert in the project, with counts, at the end of the cursor's section. */
export function screwInventoryCommand(host: LayersHost): SlashCommand {
  return {
    id: "screw-inventory",
    label: "Screw inventory",
    keywords: ["screws", "fixings", "fasteners", "hardware", "inserts", "heat-set", "bolts", "inventory", "ikea", "3d"],
    group: "inline",
    icon: "M5 2.5h6M6 2.5v2h4v-2M7 4.5v8.5l1 1 1-1V4.5M7 7h2M7 9h2M7 11h2",
    block: true,
    run: (view) => void makeScrewInventory(view, host),
  };
}

// ------------------------------------------------------------ the wire list

const WIRES_MARK = /^\*Measuring the wires[^\n]*\*$/m;

/**
 * Measures every wire in the project's model (its route in the 3D scenes,
 * plus a little at each end to strip and crimp) and puts the wire list, a
 * Markdown table, at the end of the cursor's section: in a project, the
 * bottom of its Bill of materials, say. Being text, it can be edited after.
 */
export async function makeWireList(view: EditorView, host: LayersHost): Promise<void> {
  if (view.state.readOnly || !host.loadModel) return;
  const text = view.state.doc.toString();
  const spot = inventorySpot(text, view.state.selection.main.head);
  const lead = spot === 0 ? "" : "\n\n";
  view.dispatch({ changes: { from: spot, to: spot, insert: `${lead}*Measuring the wires…*` }, userEvent: "input.layers" });
  const setMark = (replacement: string) => {
    const m = WIRES_MARK.exec(view.state.doc.toString());
    if (!m) return;
    view.dispatch({ changes: { from: m.index, to: m.index + m[0].length, insert: replacement }, userEvent: "input.layers" });
  };
  const box = document.createElement("div");
  box.className = "cm-layers-hidden";
  box.style.cssText = "position:fixed;left:-40000px;top:0;width:1200px;height:800px;overflow:hidden;pointer-events:none";
  document.body.appendChild(box);
  let editor: LayersEditor | null = null;
  try {
    const api = await loadLayers(host.load);
    editor = api.mount(box, {
      doc: null,
      mode: "inline",
      allowInline: true,
      fetchImage: host.fetchImage ?? defaultFetch,
      loadModel: () => projectModel(host),
      ...(host.saveModel ? { saveModel: host.saveModel } : {}),
      onDone: () => {},
      onCancel: () => {},
    });
    if (!editor.wireList) throw new Error("this version of Layers can't measure wires");
    const table = await editor.wireList();
    if (!table) throw new Error("the project has no wires yet. Add them with the Wire tool (W) in a 3D scene");
    setMark(table);
  } catch (e) {
    const msg = e instanceof Error && e.message ? e.message : String(e);
    setMark(`*The wire list couldn't be made: ${msg.replace(/\*/g, "")}.*`);
  } finally {
    editor?.destroy();
    box.remove();
  }
}

/** "/Wire list": every wire in the project, with its ends, colours and cut length, as a table at the end of the cursor's section. */
export function wireListCommand(host: LayersHost): SlashCommand {
  return {
    id: "wire-list",
    label: "Wire list",
    keywords: ["wires", "wiring", "cables", "leads", "harness", "lengths", "cut list", "bom", "3d"],
    group: "inline",
    icon: "M2 12c3 0 3-4 6-4s3-4 6-4M2 10.5v3M14 2.5v3",
    block: true,
    run: (view) => void makeWireList(view, host),
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
  ".cm-md-image-stale-bar": { position: "absolute", bottom: "6px", left: "6px", display: "inline-flex", flexWrap: "wrap", gap: "6px" },
  ".cm-md-image-stale": {
    padding: "5px 10px",
    border: "0",
    borderRadius: "8px",
    background: "#d97706",
    color: "#fff",
    font: "600 13px/1.2 var(--font-sans, system-ui)",
    cursor: "pointer",
    boxShadow: "0 2px 8px rgb(0 0 0 / 0.2)",
  },
  ".cm-md-image-stale:hover:not(:disabled)": { background: "#b45309" },
  ".cm-md-image-stale:disabled": { cursor: "progress", opacity: "0.85" },
  ".cm-md-image-layers:hover": { background: "rgb(109 40 217)" },
});

/** Layers graphics in the live view: the "/Graphic" editor and "Edit graphic" on pictures. */
export function layersBlocks(host: LayersHost): Extension {
  return [
    field,
    decorations,
    theme,
    historyTheme,
    layersOpener.of({
      open: (view, pos, mode, how) => openLayers(view, host, pos, mode ?? "inline", how),
      status: (url: string, text?: string) => graphicStatus(host, url, text),
      update: (view, url) => updateGraphic(view, host, url),
      pending: async (text) => (await pendingGraphics(host, text)).length,
      updateAll: (view) => updateAllGraphics(view, host),
      progress: (view) => allRuns.get(view) ?? null,
      ...(host.history ? { history: host.history } : {}),
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
