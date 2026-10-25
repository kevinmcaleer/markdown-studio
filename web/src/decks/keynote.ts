import { Presentation, setTemplateLoader, type Slide as KeynoteSlide } from "@kevsmac/keynotejs";
import partsUrl from "@keynote-templates/parts/basic-white-parts.key?url";
import themeUrl from "@keynote-templates/basic-white-16x9.key?url";
import { plainText, type Block, type Deck, type Slide } from "./deck";
import type { ImageLoader } from "./images";
import { blockHeight, BODY_H, BODY_Y, bodySize, GAP, MARGIN, SLIDE_W } from "./layout";

// Keynote export, done in the browser with keynotejs (Kev's TypeScript port
// of pykeynote). Each slide is copied from the theme's slide for its layout,
// so the deck keeps Keynote's own look and stays editable there.
//
// Text-only slides fill the layout's title and body. Images go in the
// layout's photo placeholder. Slides with code or tables use "Title Only" and
// get text boxes and real Keynote tables, stacked with the same geometry as
// the preview (layout.ts).

type Paragraph = { text: string; level: number };

/** Our layouts, as Keynote layout names (the same in every Keynote theme). */
const KEYNOTE_LAYOUT: Record<Slide["layout"], string> = {
  title: "Title",
  section: "Section",
  content: "Title & Bullets",
  quote: "Quote",
  statement: "Statement",
  blank: "Blank",
};

// keynotejs fetches its bundled theme files next to its own module; Vite
// moves modules around, so hand it the URLs Vite gives those files instead.
const TEMPLATE_URLS: Record<string, string> = {
  "basic-white-16x9.key": themeUrl,
  "parts/basic-white-parts.key": partsUrl,
};

setTemplateLoader(async (file) => {
  const url = TEMPLATE_URLS[file];
  if (!url) throw new Error(`No bundled Keynote file ${file}`);
  return new Uint8Array(await (await fetch(url)).arrayBuffer());
});

export async function deckToKeynote(deck: Deck, { loadImage, template }: { loadImage: ImageLoader; template?: Uint8Array }): Promise<Blob> {
  const pres = await Presentation.create(template ? { template } : { theme: "Basic White", aspect: "16:9" });
  const layouts = new Set(pres.layouts);
  const scale = pres.size.width / SLIDE_W; // points per inch

  for (const slide of deck.slides) {
    const out = pres.addSlide(pickLayout(slide, layouts));
    await fill(out, slide, loadImage, scale);
  }
  if (deck.slides.length === 0) pres.addSlide(layouts.has("Blank") ? "Blank" : pres.layouts[0]);
  return new Blob([pres.toBytes() as Uint8Array<ArrayBuffer>], { type: "application/x-iwork-keynote-sffkey" });
}

/** Code and tables need their own boxes, so those slides are laid out by hand. */
function freeform(slide: Slide): boolean {
  return slide.blocks.some((b) => b.type === "code" || b.type === "table");
}

function pickLayout(slide: Slide, available: Set<string>): string {
  const images = slide.blocks.some((b) => b.type === "image");
  const wanted = [
    freeform(slide) ? (slide.title !== null ? "Title Only" : "Blank") : "",
    // A Keynote layout name written in the deck wins.
    slide.layoutName ?? "",
    images && slide.layout === "content" ? (slide.title ? "Title, Bullets & Photo" : "Photo") : "",
    KEYNOTE_LAYOUT[slide.layout],
    slide.title ? "Title & Bullets" : "Bullets",
    "Title & Bullets",
  ];
  const lower = new Map([...available].map((name) => [name.toLowerCase(), name]));
  for (const name of wanted) {
    const found = lower.get(name.toLowerCase());
    if (found) return found;
  }
  return [...available][0];
}

async function fill(out: KeynoteSlide, slide: Slide, loadImage: ImageLoader, scale: number): Promise<void> {
  const images = slide.blocks.filter((b) => b.type === "image");
  const text = slide.blocks.filter((b) => b.type !== "image");

  if (freeform(slide)) await stack(out, slide, text, scale);
  else fillPlaceholders(out, slide, text.flatMap(asParagraphs));

  // The first image fills the layout's photo placeholder; more images, or a
  // layout without one, go in a column on the right.
  const column = images.length > 1 || out.placeholders.length === 0;
  const x = (text.length ? MARGIN + (SLIDE_W - 2 * MARGIN) * 0.56 + 0.4 : MARGIN) * scale;
  const w = SLIDE_W * scale - MARGIN * scale - x;
  const h = (BODY_H * scale - GAP * scale * (images.length - 1)) / images.length;
  for (const [i, block] of images.entries()) {
    const image = await loadImage(block.src);
    if (!image) continue;
    const fit = Math.min(w / image.width, h / image.height);
    out.addImage(
      image.bytes,
      column
        ? { description: block.alt, placeholder: false, position: [x, (BODY_Y + i * GAP) * scale + i * h], size: [image.width * fit, image.height * fit] }
        : { description: block.alt },
    );
  }

  if (slide.notes) out.notes = slide.notes;
  if (slide.transition) out.setTransition(slide.transition.effect, slide.transition.duration ? { duration: slide.transition.duration } : {});
  if (slide.skipped) out.skipped = true;
}

function fillPlaceholders(out: KeynoteSlide, slide: Slide, paragraphs: Paragraph[]): void {
  let title = slide.title;
  // Slides with no body placeholder (Section, say) take extra text as a second title line.
  if (out.body === null && paragraphs.length && title !== null && out.title !== null) {
    title = [title, ...paragraphs.map((p) => p.text)].join("\n");
    paragraphs = [];
  }
  if (title !== null) {
    if (out.title !== null) out.title = title;
    else paragraphs = [{ text: title, level: 0 }, ...paragraphs];
  }
  if (out.body !== null) out.body = paragraphs.length ? paragraphs : "";
  if (out.title !== null && title === null) out.title = "";
}

/** Title in its placeholder, then each block in its own box, top to bottom. */
async function stack(out: KeynoteSlide, slide: Slide, blocks: Block[], scale: number): Promise<void> {
  if (out.title !== null) out.title = slide.title ?? "";
  const pt = bodySize(slide);
  const columns = slide.blocks.some((b) => b.type === "image") ? 0.56 : 1;
  const width = (SLIDE_W - 2 * MARGIN) * columns;
  let y = slide.title !== null ? BODY_Y : MARGIN;
  for (const group of groupText(blocks)) {
    const h = group.reduce((sum, b) => sum + blockHeight(b, width, pt), 0) + (group.length - 1) * GAP * 0.5;
    const frame = { x: MARGIN * scale, y: y * scale, width: width * scale, height: Math.max(h, 0.4) * scale };
    const first = group[0];
    if (first.type === "table") {
      const rows = [first.header, ...first.rows].map((row) => row.map(plainText));
      out.addTable(rows, { ...frame, height: undefined, headerRows: 1 });
    } else {
      out.addTextBox(group.flatMap(asParagraphs), frame);
    }
    y += h + GAP;
  }
}

/** Neighbouring text blocks share one box; code and tables get their own. */
function groupText(blocks: Block[]): Block[][] {
  const groups: Block[][] = [];
  const textual = (b: Block) => b.type === "paragraph" || b.type === "bullets" || b.type === "quote";
  for (const block of blocks) {
    const last = groups[groups.length - 1];
    if (last && textual(block) && textual(last[0])) last.push(block);
    else groups.push([block]);
  }
  return groups;
}

function asParagraphs(block: Block): Paragraph[] {
  switch (block.type) {
    case "paragraph":
    case "quote":
      return plainText(block.runs)
        .split("\n")
        .map((line) => ({ text: line, level: 0 }));
    case "bullets":
      return block.items.map((item) => ({ text: plainText(item.runs), level: item.level }));
    case "code":
      return block.code.split("\n").map((line) => ({ text: line || " ", level: 0 }));
    case "table":
      return [block.header, ...block.rows].map((row) => ({ text: row.map(plainText).join("  |  "), level: 0 }));
    case "image":
      return [];
  }
}
