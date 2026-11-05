import { Facet } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

// What the picture widget and its popover need from Layers (layersBlock.ts),
// kept apart so those can ask for it without importing the block.

/** A Layers graphic's link ends in #layers: the picture carries its own layers. */
export const LAYERS_MARK = "#layers";

export function isLayersUrl(url: string): boolean {
  return /#layers$/i.test(url.trim());
}

/** `url` marked as a Layers graphic (any other fragment replaced). */
export function layersUrl(url: string): string {
  return url.trim().replace(/#.*$/, "") + LAYERS_MARK;
}

/** Fired on window when the project's 3D model is saved, so graphics check whether they're out of date. */
export const LAYERS_MODEL_EVENT = "layers-model-changed";

/** Fired on window while "Update all" runs (detail: { done, total }, or null when it ends). */
export const LAYERS_UPDATE_EVENT = "layers-updating";
export type LayersUpdateProgress = { done: number; total: number } | null;

export type LayersOpenHow = {
  /** Draw its 3D pictures again from the project's model as it opens. */
  update?: boolean;
  /** Start a new graphic after this one, as its next assembly step. */
  nextStep?: boolean;
  /** Start a new graphic after this one as an exact copy of it, its step number one on. */
  duplicate?: boolean;
};

export type LayersOpener = {
  /** Opens the picture whose Markdown starts at `pos` in Layers, in the page or full screen. */
  open(view: EditorView, pos: number, mode?: "inline" | "full", how?: LayersOpenHow): void;
  /**
   * Whether the graphic at `url` offers Next step (it has 3D scenes and the
   * host keeps a model), how many scenes are behind the model, and the step
   * number it should have when its own is out of place in `text` (null: can't tell).
   */
  status?(url: string, text?: string): Promise<{ scene: boolean; stale: number; step?: number } | null>;
  /** Draws the graphic at `url` again (its 3D pictures, its step number) and saves it, without opening it. */
  update?(view: EditorView, url: string): Promise<void>;
  /** How many graphics in `text` are out of date. */
  pending?(text: string): Promise<number>;
  /** Draws and saves every out-of-date graphic in the text, one at a time. Says how many it saved. */
  updateAll?(view: EditorView): Promise<number>;
  /** "Update all"'s progress in `view` (null: not running). */
  progress?(view: EditorView): LayersUpdateProgress;
};

export const layersOpener = Facet.define<LayersOpener, LayersOpener | null>({
  combine: (values) => values[0] ?? null,
});
