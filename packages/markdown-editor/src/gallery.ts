import type { MarkdownItInstance } from "./markdown";

// Galleries: a block of image lines shown as one gallery, in the order the
// lines are written. Choosing the pictures is adding or deleting lines, and
// reordering them is moving lines, so all of it lives in the Markdown.
//
//   ::: gallery filmstrip
//   ![Front](/front.jpg)
//   ![Wiring](/wiring.jpg "The wiring, before the lid went on")
//   :::
//
// The word after `gallery` is its layout: filmstrip (the first picture large,
// the rest in a strip under it), bento (a grid of tiles, the first one big) or
// lightbox (even thumbnails that open full size). Text that isn't an image is
// left out. The preview (galleryPlugin) and the live view (galleryWidget.ts)
// both draw galleryHtml; gallery.css styles it, for pages that render the
// Markdown themselves too (kevsrobots' project pages mirror this file).

export type GalleryLayout = "filmstrip" | "bento" | "lightbox";

export const galleryLayouts: { layout: GalleryLayout; label: string; title: string }[] = [
  { layout: "filmstrip", label: "Filmstrip", title: "One large picture, with the rest in a strip under it" },
  { layout: "bento", label: "Bento", title: "A grid of tiles, the first one big" },
  { layout: "lightbox", label: "Lightbox", title: "Even thumbnails that open full size" },
];

export type GalleryImage = { src: string; alt: string; title: string };

/** `::: gallery` and its layout, alone on a line. */
export const GALLERY_OPEN = /^[ \t]{0,3}:::[ \t]*gallery\b[ \t]*([\w-]*)[ \t]*$/i;
/** The `:::` that closes a block. */
export const GALLERY_CLOSE = /^[ \t]{0,3}:::[ \t]*$/;

/** The layout an opening line asks for (filmstrip when it names none, or one we don't know); null when it isn't one. */
export function parseGalleryOpen(line: string): GalleryLayout | null {
  const match = GALLERY_OPEN.exec(line);
  if (!match) return null;
  const word = match[1].toLowerCase();
  return galleryLayouts.some((l) => l.layout === word) ? (word as GalleryLayout) : "filmstrip";
}

/** The opening line for a layout. */
export function galleryOpenLine(layout: GalleryLayout): string {
  return `::: gallery ${layout}`;
}

const IMAGE = /!\[((?:\\.|[^\]\\])*)\]\(\s*(<[^>\n]*>|[^\s)]+)(?:\s+(?:"([^"]*)"|'([^']*)'))?\s*\)/g;

function unescapeMarkdown(text: string): string {
  return text.replace(/\\([\\`*_{}[\]()#+\-.!|"'<>~])/g, "$1");
}

/** The images in a gallery's lines, in order. */
export function galleryImages(body: string): GalleryImage[] {
  const images: GalleryImage[] = [];
  for (const match of body.matchAll(IMAGE)) {
    const src = match[2].replace(/^<|>$/g, "").trim();
    if (src) images.push({ src, alt: unescapeMarkdown(match[1]).trim(), title: (match[3] ?? match[4] ?? "").trim() });
  }
  return images;
}

export type GalleryBlock = {
  layout: GalleryLayout;
  /** Line numbers (0-based) of the `::: gallery` line and its `:::`. */
  open: number;
  close: number;
  images: GalleryImage[];
};

/**
 * The closed gallery blocks in some lines of Markdown, skipping fenced code.
 * One that is never closed isn't a gallery (yet).
 */
export function findGalleries(lines: readonly string[]): GalleryBlock[] {
  const blocks: GalleryBlock[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !line.slice(marker[0].length).trim()) fence = null;
      continue;
    }
    if (marker) {
      fence = marker[1];
      continue;
    }
    const layout = parseGalleryOpen(line);
    if (!layout) continue;
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (GALLERY_CLOSE.test(lines[j])) {
        close = j;
        break;
      }
      if (GALLERY_OPEN.test(lines[j])) break;
    }
    if (close < 0) continue;
    blocks.push({ layout, open: i, close, images: galleryImages(lines.slice(i + 1, close).join("\n")) });
    i = close;
  }
  return blocks;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A picture's address, or null for one that could run script. */
export function safeImageUrl(src: string): string | null {
  const url = src.trim();
  if (/^(javascript|vbscript|file):/i.test(url.replace(/[\s\u0000-\u001f]/g, ""))) return null;
  if (/^data:/i.test(url) && !/^data:image\/(png|gif|jpe?g|webp|avif);/i.test(url)) return null;
  return url;
}

/**
 * A gallery as HTML:
 *
 *   <div class="md-gallery md-gallery-filmstrip" data-gallery-layout="filmstrip">
 *     <figure class="md-gallery-hero"><img …><figcaption>…</figcaption></figure>   (filmstrip only)
 *     <div class="md-gallery-items">
 *       <a class="md-gallery-item" href="…" data-gallery-index="0"><img …></a> …
 *     </div>
 *   </div>
 *
 * Each picture is a link to itself, so it opens full size with no script; a
 * page can open its own viewer instead (and a filmstrip's thumbnails can swap
 * the large picture, see wireGallery).
 */
export function galleryHtml(layout: GalleryLayout, images: readonly GalleryImage[]): string {
  const safe = images.flatMap((image) => {
    const src = safeImageUrl(image.src);
    return src ? [{ ...image, src }] : [];
  });
  const caption = (image: GalleryImage) => image.title || image.alt;
  const items = safe
    .map((image, i) => {
      const title = caption(image);
      return (
        `<a class="md-gallery-item${layout === "filmstrip" && i === 0 ? " is-active" : ""}" href="${escapeHtml(image.src)}" target="_blank" rel="noopener noreferrer" data-gallery-index="${i}"${title ? ` title="${escapeHtml(title)}"` : ""}>` +
        `<img src="${escapeHtml(image.src)}" alt="${escapeHtml(image.alt)}" loading="lazy"></a>`
      );
    })
    .join("");
  let hero = "";
  if (layout === "filmstrip" && safe.length) {
    const first = safe[0];
    const title = caption(first);
    hero =
      `<figure class="md-gallery-hero"><img src="${escapeHtml(first.src)}" alt="${escapeHtml(first.alt)}">` +
      `<figcaption${title ? "" : " hidden"}>${escapeHtml(title)}</figcaption></figure>`;
  }
  const empty = safe.length ? "" : " md-gallery-empty";
  return `<div class="md-gallery md-gallery-${layout}${empty}" data-gallery-layout="${layout}" data-gallery-count="${safe.length}">${hero}<div class="md-gallery-items">${items}</div></div>`;
}

/**
 * A filmstrip's thumbnails swap the large picture when clicked. `open`, when
 * given, is called for a click on the large picture (or any picture in the
 * other layouts) with the gallery's pictures and the one clicked, to show
 * them in a viewer; without it the link opens the picture.
 */
export function wireGallery(gallery: HTMLElement, open?: (images: { src: string; alt: string }[], index: number) => void): void {
  const links = Array.from(gallery.querySelectorAll<HTMLAnchorElement>(".md-gallery-item"));
  const images = links.map((a) => {
    const img = a.querySelector("img");
    return { src: img?.getAttribute("src") ?? a.getAttribute("href") ?? "", alt: img?.getAttribute("alt") ?? "" };
  });
  const hero = gallery.querySelector<HTMLElement>(".md-gallery-hero");
  let current = 0;
  links.forEach((a, i) => {
    a.addEventListener("click", (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
      if (hero) {
        event.preventDefault();
        current = i;
        const img = hero.querySelector("img");
        const caption = hero.querySelector("figcaption");
        if (img) {
          img.src = images[i].src;
          img.alt = images[i].alt;
        }
        if (caption) {
          const text = a.getAttribute("title") ?? "";
          caption.textContent = text;
          caption.hidden = !text;
        }
        links.forEach((other) => other.classList.toggle("is-active", other === a));
      } else if (open) {
        event.preventDefault();
        open(images, i);
      }
    });
  });
  if (hero && open) {
    hero.classList.add("md-gallery-zoomable");
    hero.addEventListener("click", () => open(images, current));
  }
}

/** markdown-it: `::: gallery <layout>` … `:::` as a gallery (galleryHtml). */
export function galleryPlugin(md: MarkdownItInstance): void {
  md.block.ruler.before(
    "fence",
    "gallery",
    (state, startLine, endLine, silent) => {
      const lineText = (n: number) => state.src.slice(state.bMarks[n] + state.tShift[n], state.eMarks[n]);
      if (state.sCount[startLine] - state.blkIndent >= 4) return false;
      const layout = parseGalleryOpen(lineText(startLine));
      if (!layout) return false;
      let close = -1;
      for (let n = startLine + 1; n < endLine; n++) {
        if (state.sCount[n] < state.blkIndent) break;
        const text = lineText(n);
        if (GALLERY_CLOSE.test(text)) {
          close = n;
          break;
        }
        if (GALLERY_OPEN.test(text)) break;
      }
      if (close < 0) return false;
      if (silent) return true;
      const body: string[] = [];
      for (let n = startLine + 1; n < close; n++) body.push(state.src.slice(state.bMarks[n], state.eMarks[n]));
      const token = state.push("gallery", "div", 0);
      token.block = true;
      token.info = layout;
      token.content = body.join("\n");
      token.map = [startLine, close + 1];
      state.line = close + 1;
      return true;
    },
    { alt: ["paragraph", "reference", "blockquote", "list"] },
  );
  md.renderer.rules.gallery = (tokens, i) => galleryHtml(tokens[i].info as GalleryLayout, galleryImages(tokens[i].content)) + "\n";
}
