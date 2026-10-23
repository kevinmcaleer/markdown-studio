import { Presentation, type Slide as KeynoteSlide } from "@kevsmac/keynotejs";
import templateUrl from "@keynote-templates/basic-white-16x9.key?url";
import { plainText, type Block, type Deck, type Run, type Slide } from "./deck";
import type { ImageLoader } from "./images";

// Keynote export, done in the browser with keynotejs (Kev's TypeScript port
// of pykeynote). Each slide is copied from the theme's slide for its layout,
// so the deck keeps Keynote's own look and stays editable there.
//
// keynotejs 0.1.0 fills a layout's title, body and notes. Later releases add
// images, tables and text boxes; those are used when the library has them,
// and until then code and tables go into the body as text.

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

// Features from keynotejs releases after 0.1.0, used when present.
type Extras = {
  addImage?: (bytes: Uint8Array, options?: { description?: string }) => unknown;
  addTable?: (rows: (string | number | boolean | null)[][], options?: { headerRows?: number }) => unknown;
};

export async function deckToKeynote(deck: Deck, { loadImage, template }: { loadImage: ImageLoader; template?: Uint8Array }): Promise<Blob> {
  template ??= new Uint8Array(await (await fetch(templateUrl)).arrayBuffer());
  const pres = Presentation.fromBytes(template);
  // The theme file has one slide per layout to copy from; they're removed at the end.
  const models = pres.length;
  const layouts = new Set(pres.slides.map((s) => s.layout));

  for (const slide of deck.slides) {
    const out = pres.addSlide(pickLayout(slide, layouts));
    await fill(out, slide, loadImage);
  }
  if (deck.slides.length === 0) pres.addSlide(layouts.has("Blank") ? "Blank" : pres.slide(0).layout);
  for (let i = 0; i < models; i++) pres.deleteSlide(0);
  return new Blob([pres.toBytes() as Uint8Array<ArrayBuffer>], { type: "application/x-iwork-keynote-sffkey" });
}

function pickLayout(slide: Slide, available: Set<string>): string {
  const images = slide.blocks.some((b) => b.type === "image");
  const wanted = [
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

async function fill(out: KeynoteSlide, slide: Slide, loadImage: ImageLoader): Promise<void> {
  const extras = out as unknown as Extras;
  const paragraphs: Paragraph[] = [];
  for (const block of slide.blocks) {
    if (block.type === "image") {
      const image = extras.addImage ? await loadImage(block.src) : null;
      if (image) extras.addImage!(image.bytes, { description: block.alt });
      continue;
    }
    if (block.type === "table" && extras.addTable) {
      extras.addTable([block.header, ...block.rows].map((row) => row.map(plainText)), { headerRows: 1 });
      continue;
    }
    paragraphs.push(...asParagraphs(block));
  }

  let title = slide.title;
  // Slides with no body placeholder (Section, say) take extra text as a second title line.
  if (out.body === null && paragraphs.length && title !== null && out.title !== null) {
    title = [title, ...paragraphs.map((p) => p.text)].join("\n");
    paragraphs.length = 0;
  }
  if (title !== null) {
    if (out.title !== null) out.title = title;
    else paragraphs.unshift({ text: title, level: 0 });
  }
  if (paragraphs.length && out.body !== null) out.body = paragraphs;
  else if (out.body !== null) out.body = "";
  if (out.title !== null && title === null) out.title = "";
  if (slide.notes) out.notes = slide.notes;
  if (slide.transition) out.setTransition(slide.transition.effect, slide.transition.duration ? { duration: slide.transition.duration } : {});
  if (slide.skipped) out.skipped = true;
}

function asParagraphs(block: Block): Paragraph[] {
  switch (block.type) {
    case "paragraph":
    case "quote":
      return text(block.runs)
        .split("\n")
        .map((line) => ({ text: line, level: 0 }));
    case "bullets":
      return block.items.map((item) => ({ text: text(item.runs), level: item.level }));
    case "code":
      return block.code.split("\n").map((line) => ({ text: line || " ", level: 0 }));
    case "table":
      return [block.header, ...block.rows].map((row) => ({ text: row.map(text).join("  |  "), level: 0 }));
    case "image":
      return [];
  }
}

function text(runs: Run[]): string {
  return plainText(runs);
}
