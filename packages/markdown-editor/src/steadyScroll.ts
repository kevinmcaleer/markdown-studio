import { ViewPlugin, type EditorView } from "@codemirror/view";

// Keeping the page still while you scroll. CodeMirror only draws the part of
// the note on screen, and keeps what you're reading in place by scrolling when
// the text above it turns out taller or shorter than it guessed. Two things
// made that correction visible as a jerk:
//
// - It noticed a block changing height on its own (a picture loading in a
//   table, a diagram drawing) 50ms late, or, within 75ms of its own redraw,
//   not until the next scroll. So the page jumped, and jumped back.
// - It guessed a table or diagram it had drawn before from its line count. A
//   wrong guess moves where the screen's first line is, which can push the
//   block out of the drawn part and back in on the next frame; each time it's
//   drawn from scratch, its pictures load again and its height changes again.
// - A picture takes no room until it loads, and each redraw loads it again.
//   Once one has loaded, its size is kept by its Markdown URL, and every <img>
//   for it drawn after that gets width and height, so its room is kept.

/** Each drawn block's height, by its Markdown, so the next guess is right. */
const heights = new Map<string, number>();
const keys = new WeakMap<Element, string>();
const blocks =
  typeof ResizeObserver === "function"
    ? new ResizeObserver((entries) => {
        for (const entry of entries) {
          const key = keys.get(entry.target);
          const height = (entry.target as HTMLElement).offsetHeight;
          if (key !== undefined && entry.target.isConnected && height > 0) heights.set(key, height);
        }
      })
    : null;

/** Remember how tall a block widget's DOM is drawn, for `rememberedHeight`. */
export function rememberHeight(dom: HTMLElement, key: string) {
  keys.set(dom, key);
  blocks?.observe(dom);
}

/** The height a block with this key was last drawn at, if it has been. */
export function rememberedHeight(key: string): number | undefined {
  return heights.get(key);
}

/** Each picture's natural size, by the URL its Markdown gave (a host may swap the src for a blob: URL). */
const pictureSizes = new Map<string, { width: number; height: number }>();

function pictureKey(img: HTMLImageElement): string {
  return img.dataset.mdSrc ?? img.getAttribute("src") ?? "";
}

/** Note the URL a new picture was drawn with, and give it its size when it's known. */
export function sizePicture(img: HTMLImageElement) {
  if (img.dataset.mdSrc === undefined) img.dataset.mdSrc = img.getAttribute("src") ?? "";
  const size = pictureSizes.get(pictureKey(img));
  if (size && !img.hasAttribute("width") && !img.hasAttribute("height")) {
    img.setAttribute("width", String(size.width));
    img.setAttribute("height", String(size.height));
  }
}

/** sizePicture for every picture in `node`; call it before the editor measures (in toDOM). */
export function sizePictures(node: Node) {
  if (node instanceof HTMLImageElement) sizePicture(node);
  else if (node instanceof Element) node.querySelectorAll("img").forEach(sizePicture);
}

/**
 * Measure as soon as the text's size changes, so the correction happens
 * before the browser paints, and keep pictures' room (see above).
 */
export const steadyScroll = ViewPlugin.fromClass(
  class {
    resize: ResizeObserver | null = null;
    pictures: MutationObserver | null = null;
    onLoad = (event: Event) => {
      const img = event.target;
      if (img instanceof HTMLImageElement && img.naturalWidth && img.naturalHeight)
        pictureSizes.set(pictureKey(img), { width: img.naturalWidth, height: img.naturalHeight });
    };

    constructor(readonly view: EditorView) {
      const content = view.contentDOM;
      // Widgets size their pictures as they draw them; this catches any a host adds later.
      if (typeof MutationObserver === "function") {
        this.pictures = new MutationObserver((records) => {
          for (const record of records) record.addedNodes.forEach(sizePictures);
        });
        this.pictures.observe(content, { childList: true, subtree: true });
        sizePictures(content);
      }
      // `load` doesn't bubble, so it's caught on the way down.
      content.addEventListener("load", this.onLoad, true);
      if (typeof ResizeObserver === "function") {
        // `measure` isn't in CodeMirror's types, but it's what requestMeasure
        // runs on the next frame, and that frame would be painted with the jump.
        const measure = (view as unknown as { measure?: () => void }).measure;
        this.resize = new ResizeObserver(() => (measure ? measure.call(view) : view.requestMeasure()));
        this.resize.observe(content);
      }
    }

    destroy() {
      this.resize?.disconnect();
      this.pictures?.disconnect();
      this.view.contentDOM.removeEventListener("load", this.onLoad, true);
    }
  },
);
