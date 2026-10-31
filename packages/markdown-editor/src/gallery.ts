import { imageCaption } from "./imageCaption";
import type { MarkdownItInstance } from "./markdown";

// Galleries: a block of image lines shown as one gallery, in the order the
// lines are written. In the live view its buttons add, remove and reorder
// pictures (galleryWidget.ts), and all they do is write those lines, so all
// of it lives in the Markdown.
//
//   ::: gallery filmstrip
//   ![Front](/front.jpg)
//   ![Wiring](/wiring.jpg "The wiring, before the lid went on")
//   :::
//
// The word after `gallery` is its layout: filmstrip (the first picture large,
// the rest in a strip under it), bento (a grid of tiles, the first one big) or
// lightbox (even thumbnails that open full size) or carousel (one picture at
// a time that moves on by itself, with countdown dots and a pause button).
// Text that isn't an image is
// left out. The preview (galleryPlugin) and the live view (galleryWidget.ts)
// both draw galleryHtml; gallery.css styles it, for pages that render the
// Markdown themselves too (kevsrobots' project pages mirror this file).

export type GalleryLayout = "filmstrip" | "bento" | "lightbox" | "carousel";

export const galleryLayouts: { layout: GalleryLayout; label: string; title: string }[] = [
  { layout: "filmstrip", label: "Filmstrip", title: "One large picture, with the rest in a strip under it" },
  { layout: "bento", label: "Bento", title: "A grid of tiles, the first one big" },
  { layout: "lightbox", label: "Lightbox", title: "Even thumbnails that open full size" },
  { layout: "carousel", label: "Carousel", title: "One picture at a time, moving on to the next by itself" },
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

/**
 * Each picture's own Markdown in a gallery's lines, in order, with its
 * `{size}` if it has one: what the live view's buttons move and remove.
 */
export function galleryImageMarkdown(body: string): string[] {
  const out: string[] = [];
  for (const match of body.matchAll(IMAGE)) {
    const src = match[2].replace(/^<|>$/g, "").trim();
    if (!src) continue;
    const end = (match.index ?? 0) + match[0].length;
    const size = /^\{[\w-]+\}/.exec(body.slice(end));
    out.push(match[0] + (size ? size[0] : ""));
  }
  return out;
}

/** A gallery block: its opening line, a picture per line, and `:::`. */
export function galleryBlockMarkdown(layout: GalleryLayout, pictures: readonly string[]): string {
  return [galleryOpenLine(layout), ...pictures, ":::"].join("\n");
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
  // Its title, or alt text someone wrote (not one made from a file name, see imageCaption.ts).
  const caption = (image: GalleryImage) => image.title || imageCaption(image.alt) || "";
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
  if (layout === "carousel") return carouselHtml(safe, caption, empty);
  return `<div class="md-gallery md-gallery-${layout}${empty}" data-gallery-layout="${layout}" data-gallery-count="${safe.length}">${hero}<div class="md-gallery-items">${items}</div></div>`;
}

const PAUSE_ICON = `<svg class="md-gallery-icon-pause" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="4.5" width="4" height="15" rx="1.2"/><rect x="14" y="4.5" width="4" height="15" rx="1.2"/></svg>`;
const PLAY_ICON = `<svg class="md-gallery-icon-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4.8v14.4a1 1 0 0 0 1.5.86l11.6-7.2a1 1 0 0 0 0-1.72L9.5 3.94A1 1 0 0 0 8 4.8z"/></svg>`;

/**
 * A carousel: one picture at a time in a track that scrolls sideways (so
 * it can be swiped, and works with no script), each with its caption under
 * it, then a tray of dots and a pause button:
 *
 *   <div class="md-gallery md-gallery-carousel" data-gallery-layout="carousel">
 *     <div class="md-gallery-items">
 *       <a class="md-gallery-item is-active" …><img …><span class="md-gallery-caption">…</span></a> …
 *     </div>
 *     <div class="md-gallery-controls">
 *       <div class="md-gallery-dots"><button class="md-gallery-dot is-active"><span class="md-gallery-dot-fill"></span></button> …</div>
 *       <button class="md-gallery-play">…</button>
 *     </div>
 *   </div>
 *
 * wireGallery makes it go: the active dot's fill is a CSS animation (as long
 * as --md-gallery-interval) and the next picture comes when it ends.
 */
function carouselHtml(images: readonly GalleryImage[], caption: (image: GalleryImage) => string, empty: string): string {
  const items = images
    .map((image, i) => {
      const title = caption(image);
      return (
        `<a class="md-gallery-item${i === 0 ? " is-active" : ""}" href="${escapeHtml(image.src)}" target="_blank" rel="noopener noreferrer" data-gallery-index="${i}"${title ? ` title="${escapeHtml(title)}"` : ""}>` +
        `<img src="${escapeHtml(image.src)}" alt="${escapeHtml(image.alt)}" loading="${i === 0 ? "eager" : "lazy"}">` +
        (title ? `<span class="md-gallery-caption">${escapeHtml(title)}</span>` : "") +
        `</a>`
      );
    })
    .join("");
  const dots = images
    .map(
      (_, i) =>
        `<button type="button" class="md-gallery-dot${i === 0 ? " is-active" : ""}" data-gallery-index="${i}" aria-label="Show picture ${i + 1} of ${images.length}"${i === 0 ? ' aria-current="true"' : ""}><span class="md-gallery-dot-fill"></span></button>`,
    )
    .join("");
  const controls =
    images.length > 1
      ? `<div class="md-gallery-controls"><div class="md-gallery-dots">${dots}</div>` +
        `<button type="button" class="md-gallery-play" aria-label="Pause the slideshow">${PAUSE_ICON}${PLAY_ICON}</button></div>`
      : "";
  return `<div class="md-gallery md-gallery-carousel${empty}" data-gallery-layout="carousel" data-gallery-count="${images.length}"><div class="md-gallery-items">${items}</div>${controls}</div>`;
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Makes a carousel go (see carouselHtml): each picture shows for the length
 * of its dot's countdown, then the next slides in, round and round. The
 * button pauses and plays; a dot, or a swipe, shows that picture. It plays
 * only while it's on screen, and starts paused for people who ask for less
 * motion (it then also changes pictures without sliding).
 */
function wireCarousel(gallery: HTMLElement, links: HTMLAnchorElement[], openAt?: (index: number) => void): void {
  const track = gallery.querySelector<HTMLElement>(".md-gallery-items");
  const dots = Array.from(gallery.querySelectorAll<HTMLButtonElement>(".md-gallery-dot"));
  const play = gallery.querySelector<HTMLButtonElement>(".md-gallery-play");
  if (!track || links.length < 2 || !play) return;
  gallery.dataset.galleryWired = "1";
  const reduced = prefersReducedMotion();
  let current = 0;
  let paused = reduced;

  const setPaused = (value: boolean) => {
    paused = value;
    gallery.classList.toggle("is-paused", paused);
    play.setAttribute("aria-label", paused ? "Play the slideshow" : "Pause the slideshow");
    play.title = paused ? "Play" : "Pause";
    // Playing again starts the countdown afresh once it was stopped (a dot picked while paused).
    if (!paused && !dots[current]?.classList.contains("is-counting")) count(current);
  };
  /** Starts the countdown on a dot (restarting its animation). */
  const count = (index: number) => {
    dots.forEach((dot) => dot.classList.remove("is-counting"));
    const dot = dots[index];
    if (!dot) return;
    void dot.offsetWidth; // so the animation starts over
    dot.classList.add("is-counting");
  };
  const show = (index: number, { scroll = true, countdown = !paused } = {}) => {
    current = (index + links.length) % links.length;
    links.forEach((a, i) => a.classList.toggle("is-active", i === current));
    dots.forEach((dot, i) => {
      dot.classList.toggle("is-active", i === current);
      if (i === current) dot.setAttribute("aria-current", "true");
      else dot.removeAttribute("aria-current");
    });
    if (countdown) count(current);
    else dots.forEach((dot) => dot.classList.remove("is-counting"));
    if (scroll) {
      const left = links[current].offsetLeft - links[0].offsetLeft;
      if (typeof track.scrollTo === "function") track.scrollTo({ left, behavior: reduced ? "auto" : "smooth" });
      else track.scrollLeft = left;
    }
  };

  // The countdown's end moves it on.
  gallery.addEventListener("animationend", (event) => {
    const target = event.target as Element;
    if (!target.classList?.contains("md-gallery-dot-fill") || paused) return;
    if (target.parentElement === dots[current]) show(current + 1);
  });
  dots.forEach((dot, i) =>
    dot.addEventListener("click", (event) => {
      event.preventDefault();
      show(i);
    }),
  );
  play.addEventListener("click", (event) => {
    event.preventDefault();
    setPaused(!paused);
  });
  // A swipe (or scrolling the track) shows the picture it settles on.
  let settle: ReturnType<typeof setTimeout> | undefined;
  track.addEventListener(
    "scroll",
    () => {
      clearTimeout(settle);
      settle = setTimeout(() => {
        const at = track.scrollLeft + links[0].offsetLeft;
        let nearest = 0;
        links.forEach((a, i) => {
          if (Math.abs(a.offsetLeft - at) < Math.abs(links[nearest].offsetLeft - at)) nearest = i;
        });
        if (nearest !== current) show(nearest, { scroll: false });
      }, 120);
    },
    { passive: true },
  );
  // A picture opens in the page's viewer (pausing the slideshow behind it), or as a link.
  if (openAt)
    links.forEach((a, i) =>
      a.addEventListener("click", (event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        setPaused(true);
        openAt(i);
      }),
    );
  // Only counting down while someone can see it.
  if (typeof IntersectionObserver === "function") {
    new IntersectionObserver((entries) => {
      for (const entry of entries) gallery.classList.toggle("is-offscreen", !entry.isIntersecting);
    }).observe(gallery);
  }
  setPaused(paused);
}

/**
 * A filmstrip's thumbnails swap the large picture when clicked, and a
 * carousel moves on by itself (wireCarousel). `open`, when
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
  if (gallery.dataset.galleryLayout === "carousel") {
    wireCarousel(gallery, links, open && ((i) => open(images, i)));
    return;
  }
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
