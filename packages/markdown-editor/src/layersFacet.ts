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

export type LayersOpener = {
  /** Opens the picture whose Markdown starts at `pos` in Layers, in the page or full screen. */
  open(view: EditorView, pos: number, mode?: "inline" | "full"): void;
};

export const layersOpener = Facet.define<LayersOpener, LayersOpener | null>({
  combine: (values) => values[0] ?? null,
});
