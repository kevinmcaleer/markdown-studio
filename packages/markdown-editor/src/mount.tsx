import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { openLinkPopover } from "./format/linkPopover";
import { configureLanguageApi, fetchLanguageApi } from "./proofing/languageApi";
import { setDictionaryBase } from "./proofing/dictionaryUrls";
import type { EditorEvents, MarkdownEditor, MountOptions } from "./standalone/options";
import { StandaloneEditor, type Bridge } from "./standalone/StandaloneEditor";

export type { BuiltInTool, EditorEvents, ImageInfo, MarkdownEditor, MountOptions, Pane, Stats, StatusItem, ToolbarButton, ToolbarItem } from "./standalone/options";
export { DEFAULT_STATUS, DEFAULT_TOOLBAR } from "./standalone/options";

// The framework-free way in: `mount(element, options)` puts the whole editor
// in an element (or over a <textarea>, kept in sync so a plain form submits
// the Markdown) and hands back a small API. React is inside; the host never
// sees it.

const cssLength = (v: string | number | undefined) => (typeof v === "number" ? `${v}px` : v);

export function mount(target: HTMLElement | string, options: MountOptions = {}): MarkdownEditor {
  const found = typeof target === "string" ? document.querySelector<HTMLElement>(target) : target;
  if (!found) throw new Error(`MarkdownEditor.mount: no element matches ${String(target)}`);

  // On a <textarea>, the editor goes after it and the textarea is hidden but kept up to date.
  const textarea = found instanceof HTMLTextAreaElement ? found : null;
  const root = textarea ? document.createElement("div") : found;
  if (textarea) {
    textarea.insertAdjacentElement("afterend", root);
    textarea.dataset.mdeDisplay = textarea.style.display;
    textarea.style.display = "none";
  }
  const doc = options.doc ?? textarea?.value ?? "";
  const hadClass = root.classList.contains("mde");
  root.classList.add("mde");
  root.dataset.theme = options.theme ?? "auto";
  if (options.direction && options.direction !== "auto") root.dir = options.direction;
  if (options.minHeight !== undefined) root.style.setProperty("--mde-min-height", cssLength(options.minHeight)!);
  if (options.maxHeight !== undefined) root.style.setProperty("--mde-max-height", cssLength(options.maxHeight)!);

  if (options.proofing?.languageApi) configureLanguageApi(options.proofing.languageApi);
  else if (options.proofing?.languageApiBase !== undefined) configureLanguageApi(options.proofing.languageApiBase ? fetchLanguageApi(options.proofing.languageApiBase) : null);
  if (options.proofing?.dictionaryBase !== undefined) setDictionaryBase(options.proofing.dictionaryBase);

  const listeners = new Map<string, Set<(value: unknown) => void>>();
  const bridge: Bridge = {
    view: null,
    api: null,
    actions: null,
    emit(event, value) {
      for (const listener of listeners.get(event) ?? []) {
        try {
          listener(value);
        } catch (err) {
          console.error(err);
        }
      }
    },
  };

  const onChange = (value: string) => {
    if (textarea) textarea.value = value;
    options.onChange?.(value);
  };
  const form = textarea?.form ?? null;
  // A form that submits has saved the Markdown, so the draft can go.
  const submitted = () => bridge.actions?.clearDraft();
  form?.addEventListener("submit", submitted);

  const react = createRoot(root);
  flushSync(() => react.render(<StandaloneEditor options={{ ...options, doc, onChange }} host={root} bridge={bridge} />));
  const view = bridge.view!;
  let destroyed = false;

  const api: MarkdownEditor = {
    element: root,
    view,
    getDoc: () => view.state.doc.toString(),
    setDoc(next) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next }, selection: { anchor: 0 }, userEvent: "input" });
    },
    getSelection: () => view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to),
    replaceSelection(text) {
      view.dispatch(view.state.replaceSelection(text));
      view.focus();
    },
    focus: () => view.focus(),
    setReadOnly: (on) => bridge.actions?.setReadOnly(on),
    setPane: (pane) => bridge.actions?.setPane(pane),
    setFullscreen: (on) => bridge.actions?.setFullscreen(on),
    clearDraft: () => bridge.actions?.clearDraft(),
    openLinkPopover: () => void openLinkPopover(view),
    openImagePicker: (anchor) => bridge.actions?.openImagePicker(anchor),
    refreshPreview: () => bridge.actions?.refreshPreview(),
    on<K extends keyof EditorEvents>(event: K, listener: (value: EditorEvents[K]) => void) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(listener as (value: unknown) => void);
      return () => api.off(event, listener);
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener as (value: unknown) => void);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      form?.removeEventListener("submit", submitted);
      react.unmount();
      listeners.clear();
      if (textarea) {
        textarea.value = view.state.doc.toString();
        root.remove();
        textarea.style.display = textarea.dataset.mdeDisplay ?? "";
        delete textarea.dataset.mdeDisplay;
      } else {
        if (!hadClass) root.classList.remove("mde", "mde-fullscreen");
        delete root.dataset.theme;
        root.style.removeProperty("--mde-min-height");
        root.style.removeProperty("--mde-max-height");
      }
    },
  };
  bridge.api = api;
  return api;
}
