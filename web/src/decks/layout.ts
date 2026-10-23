import { plainText, type Block, type Slide } from "./deck";

// Slide geometry shared by the preview and PowerPoint export, so a slide
// looks the same in both. Sizes are in inches on a 13.333 x 7.5 in (16:9)
// slide, and type sizes in points.

export const SLIDE_W = 13.333;
export const SLIDE_H = 7.5;
export const MARGIN = 0.7;
export const TITLE_Y = 0.45;
export const TITLE_H = 1.0;
export const BODY_Y = 1.65;
export const BODY_H = SLIDE_H - BODY_Y - 0.55;
export const GAP = 0.18;

export const TITLE_PT = 32;
export const BIG_TITLE_PT = 44;
const BODY_SIZES = [24, 22, 20, 18, 16, 14, 12];

export const THEME = {
  background: "FAF9F5",
  text: "141413",
  muted: "6B6A63",
  accent: "C96442",
  codeBackground: "F0EEE6",
  codeText: "3D3929",
  highlight: "FBE7A1",
  border: "E3E0D6",
  titleFont: "Georgia",
  bodyFont: "Helvetica Neue",
  monoFont: "Menlo",
};

/** Whether the slide's images go in a column beside its text. */
export function imageColumn(slide: Slide): boolean {
  const images = slide.blocks.some((b) => b.type === "image");
  return images && slide.blocks.some((b) => b.type !== "image");
}

/** The width of the column the slide's text goes in. */
export function textWidth(slide: Slide): number {
  const full = SLIDE_W - 2 * MARGIN;
  return imageColumn(slide) ? full * 0.56 : full;
}

/** Roughly how many lines `text` wraps to in a box `width` inches wide at `pt` points. */
function wrappedLines(text: string, width: number, pt: number, charWidth = 0.5): number {
  const perLine = Math.max(8, Math.floor((width * 72) / (pt * charWidth)));
  return text.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(line.length / perLine)), 0);
}

/** The estimated height of a block, in inches, at body size `pt`. */
export function blockHeight(block: Block, width: number, pt: number): number {
  const line = (pt * 1.3) / 72;
  switch (block.type) {
    case "paragraph":
    case "quote":
      return wrappedLines(plainText(block.runs), width, pt) * line;
    case "bullets":
      return block.items.reduce((h, item) => h + wrappedLines(plainText(item.runs), width - 0.4 - item.level * 0.4, pt) * line + (pt * 0.25) / 72, 0);
    case "code":
      return wrappedLines(block.code, width - 0.3, codePt(pt), 0.6) * ((codePt(pt) * 1.25) / 72) + 0.3;
    case "table":
      return (block.rows.length + 1) * ((pt * 0.85 * 1.9) / 72);
    case "image":
      return 0;
  }
}

export function codePt(pt: number): number {
  return Math.round(pt * 0.75);
}

/**
 * The largest body type size at which everything on the slide fits, so a
 * crowded slide shrinks its text rather than running off the bottom.
 */
export function bodySize(slide: Slide): number {
  const width = textWidth(slide);
  const blocks = slide.blocks.filter((b) => b.type !== "image");
  for (const pt of BODY_SIZES) {
    const total = blocks.reduce((h, b) => h + blockHeight(b, width, pt), 0) + GAP * Math.max(0, blocks.length - 1);
    if (total <= BODY_H) return pt;
  }
  return BODY_SIZES[BODY_SIZES.length - 1];
}

/** Type size for a slide's title, smaller for long titles. */
export function titleSize(slide: Slide, big: boolean): number {
  const base = big ? BIG_TITLE_PT : TITLE_PT;
  const lines = wrappedLines(slide.title ?? "", SLIDE_W - 2 * MARGIN, base, 0.55);
  return lines > 1 ? Math.round(base * (big ? 0.8 : 0.85)) : base;
}
