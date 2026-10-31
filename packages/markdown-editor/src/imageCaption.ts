import type { MarkdownItInstance } from "./markdown";
import type { ImageSize } from "./imageSize";

// Image captions: a picture on a line of its own shows its title (the alt
// text, what the image popover's Title field edits) as a caption beneath it,
// in the live view (livePreview.ts), the preview (imageCaptionPlugin) and on
// pages that render the Markdown themselves (kevsrobots'
// project-image-captions.js; keep its rule in step with imageCaption below).
// A title that looks made up from a file name ("IMG_2041", "robot-arm",
// "chassis.jpg", "hero") isn't shown, so only titles someone wrote appear.

const PLACEHOLDERS = /^(image|img|picture|pic|photo|screenshot|hero|banner|alt|untitled)$/i;

/** The caption for a picture with alt text `alt`, or null when it has none worth showing. */
export function imageCaption(alt: string): string | null {
  const text = alt.trim();
  if (!text || PLACEHOLDERS.test(text)) return null;
  // A file name, with its extension.
  if (/\.(png|jpe?g|gif|webp|svg|avif|heic|bmp|tiff?)$/i.test(text)) return null;
  // One word that reads like a file name: dashes, underscores or digits, or all lower case.
  if (!/\s/.test(text) && (/[-_\d]/.test(text) || text === text.toLowerCase())) return null;
  return text;
}

/** The class a captioned picture's figure carries for its size. */
export function imageFigureClass(size: ImageSize | null): string {
  return size ? `image-figure image-figure-${size}` : "image-figure";
}

/**
 * markdown-it: a paragraph that is only a picture becomes a figure, with the
 * picture's caption under it. Runs after imageSizePlugin, which has already
 * turned the picture's `{size}` into its class.
 */
export function imageCaptionPlugin(md: MarkdownItInstance): void {
  md.core.ruler.after("image_sizes", "image_captions", (state) => {
    const tokens = state.tokens;
    for (let i = 0; i + 2 < tokens.length; i++) {
      const open = tokens[i];
      const inline = tokens[i + 1];
      const close = tokens[i + 2];
      if (open.type !== "paragraph_open" || open.hidden || inline.type !== "inline" || close.type !== "paragraph_close") continue;
      const children = (inline.children ?? []).filter((t) => !(t.type === "text" && !t.content.trim()));
      if (children.length !== 1 || children[0].type !== "image") continue;
      const image = children[0];
      const caption = imageCaption(image.children?.length ? state.md.renderer.renderInlineAsText(image.children, state.md.options, state.env) : image.content);
      if (!caption) continue;
      const size = (/(?:^|\s)image-(full|half|cover|small)(?:\s|$)/.exec(String(image.attrGet("class") ?? ""))?.[1] ?? null) as ImageSize | null;
      open.tag = close.tag = "figure";
      open.attrSet("class", imageFigureClass(size));
      const figcaption = new state.Token("html_inline", "", 0);
      figcaption.content = `<figcaption>${state.md.utils.escapeHtml(caption)}</figcaption>`;
      inline.children = [image, figcaption];
    }
  });
}
