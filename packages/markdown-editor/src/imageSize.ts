import type { MarkdownItInstance } from "./markdown";

// Image sizes: a `{size}` straight after an image's Markdown says how big it
// shows, `![Chassis](/chassis.jpg){small}`. Without one an image shows at its
// own size, no wider than the text. The preview (imageSizePlugin), the live
// view (livePreview.ts) and the picker's size buttons all read this list;
// image-sizes.css styles the classes, for pages that render the Markdown
// themselves too (kevsrobots' project pages).

export const imageSizes = [
  { size: "full", label: "Full", title: "The width of the text" },
  { size: "half", label: "Half", title: "Half the size" },
  { size: "cover", label: "Cover", title: "A full-width banner, cropped to fit" },
  { size: "small", label: "Small", title: "A quarter of the size" },
] as const;

export type ImageSize = (typeof imageSizes)[number]["size"];

const SIZE_RE = /^\{(full|half|cover|small)\}/;

/** The `{size}` at the start of ``text`` (what follows an image), and how long it is; null when there isn't one. */
export function parseImageSize(text: string): { size: ImageSize; length: number } | null {
  const match = SIZE_RE.exec(text);
  return match ? { size: match[1] as ImageSize, length: match[0].length } : null;
}

/** The modifier to write after an image for ``size``: none for "full" when ``full`` is the default look. */
export function imageSizeMarkdown(size: ImageSize | null | undefined): string {
  return size && size !== "full" ? `{${size}}` : "";
}

/** The class an image of ``size`` carries in rendered HTML. */
export function imageSizeClass(size: ImageSize): string {
  return `image-${size}`;
}

/** markdown-it: drops the `{size}` after an image and gives the image its size's class. */
export function imageSizePlugin(md: MarkdownItInstance): void {
  md.core.ruler.after("inline", "image_sizes", (state) => {
    for (const token of state.tokens) {
      const children = token.type === "inline" ? token.children : null;
      if (!children) continue;
      for (let i = 0; i < children.length - 1; i++) {
        const next = children[i + 1];
        if (children[i].type !== "image" || next.type !== "text") continue;
        const found = parseImageSize(next.content);
        if (!found) continue;
        children[i].attrJoin("class", imageSizeClass(found.size));
        next.content = next.content.slice(found.length);
        if (!next.content) children.splice(i + 1, 1);
      }
    }
  });
}
