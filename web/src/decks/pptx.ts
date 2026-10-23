import PptxGenJS from "pptxgenjs";
import type { Block, Deck, Run, Slide } from "./deck";
import { contain, dataUrl, type ImageLoader } from "./images";
import {
  BODY_H,
  BODY_Y,
  blockHeight,
  bodySize,
  codePt,
  GAP,
  imageColumn,
  MARGIN,
  SLIDE_H,
  SLIDE_W,
  textWidth,
  THEME,
  TITLE_H,
  TITLE_Y,
  titleSize,
} from "./layout";

// PowerPoint export, done in the browser with pptxgenjs. Each slide is laid
// out with the same geometry as the preview (see layout.ts), with real text
// boxes, bullets, tables and notes, so the deck stays editable in PowerPoint.

type PSlide = ReturnType<PptxGenJS["addSlide"]>;
type TextRun = PptxGenJS.TextProps;

export async function deckToPptx(deck: Deck, { title, author, loadImage }: { title: string; author?: string; loadImage: ImageLoader }): Promise<Blob> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = title;
  if (author) pptx.author = author;
  pptx.theme = { headFontFace: THEME.titleFont, bodyFontFace: THEME.bodyFont };

  for (const slide of deck.slides) {
    const out = pptx.addSlide();
    out.background = { color: THEME.background };
    if (slide.skipped) out.hidden = true;
    if (slide.notes) out.addNotes(slide.notes);
    await drawSlide(out, slide, loadImage);
  }
  if (deck.slides.length === 0) pptx.addSlide().background = { color: THEME.background };
  return (await pptx.write({ outputType: "blob" })) as Blob;
}

async function drawSlide(out: PSlide, slide: Slide, loadImage: ImageLoader): Promise<void> {
  const width = SLIDE_W - 2 * MARGIN;
  const paragraphs = slide.blocks.filter((b) => b.type === "paragraph" || b.type === "quote");
  switch (slide.layout) {
    case "title":
      out.addText(titleRuns(slide), {
        x: MARGIN,
        y: 2.2,
        w: width,
        h: 1.7,
        fontFace: THEME.titleFont,
        fontSize: titleSize(slide, true),
        color: THEME.text,
        align: "center",
        valign: "bottom",
      });
      if (paragraphs.length)
        out.addText(paragraphRuns(paragraphs, 22, { color: THEME.muted }), { x: MARGIN, y: 4.1, w: width, h: 1.4, align: "center", valign: "top", fontFace: THEME.bodyFont });
      return;
    case "section":
      out.addShape("rect", { x: MARGIN, y: 3.0, w: 0.12, h: 1.5, fill: { color: THEME.accent }, line: { color: THEME.accent, width: 0 } });
      out.addText(titleRuns(slide), { x: MARGIN + 0.45, y: 2.75, w: width - 0.45, h: 2.0, fontFace: THEME.titleFont, fontSize: titleSize(slide, true), color: THEME.text, valign: "middle" });
      if (paragraphs.length)
        out.addText(paragraphRuns(paragraphs, 20, { color: THEME.muted }), { x: MARGIN + 0.45, y: 4.75, w: width - 0.45, h: 1.2, valign: "top", fontFace: THEME.bodyFont });
      return;
    case "quote":
    case "statement": {
      const quote = slide.layout === "quote";
      const text = slide.title ? [{ type: "paragraph", runs: slide.titleRuns } as Block, ...paragraphs] : paragraphs;
      out.addText(paragraphRuns(text, quote ? 32 : 36, { italic: quote, fontFace: THEME.titleFont }), {
        x: 1.4,
        y: 1.2,
        w: SLIDE_W - 2.8,
        h: SLIDE_H - 2.4,
        align: "center",
        valign: "middle",
        color: THEME.text,
      });
      if (quote) out.addShape("rect", { x: SLIDE_W / 2 - 0.5, y: 1.0, w: 1.0, h: 0.06, fill: { color: THEME.accent }, line: { color: THEME.accent, width: 0 } });
      return;
    }
    case "blank":
    case "content":
      await drawContent(out, slide, loadImage);
  }
}

async function drawContent(out: PSlide, slide: Slide, loadImage: ImageLoader): Promise<void> {
  const hasTitle = slide.title !== null;
  if (hasTitle)
    out.addText(titleRuns(slide), { x: MARGIN, y: TITLE_Y, w: SLIDE_W - 2 * MARGIN, h: TITLE_H, fontFace: THEME.titleFont, fontSize: titleSize(slide, false), color: THEME.text, valign: "bottom" });

  const top = hasTitle ? BODY_Y : TITLE_Y + 0.2;
  const height = hasTitle ? BODY_H : SLIDE_H - top - 0.55;
  const pt = bodySize(slide);
  const width = textWidth(slide);
  const images = slide.blocks.filter((b) => b.type === "image");
  const text = slide.blocks.filter((b) => b.type !== "image");

  // Images: in a column on the right beside text, or filling the body on their own.
  if (images.length) {
    const column = imageColumn(slide);
    const x = column ? MARGIN + width + 0.4 : MARGIN;
    const w = column ? SLIDE_W - MARGIN - x : SLIDE_W - 2 * MARGIN;
    const each = column ? (height - GAP * (images.length - 1)) / images.length : w;
    let offset = 0;
    for (const block of images) {
      const image = await loadImage(block.src);
      const box = column ? { x, y: top + offset, w, h: each } : { x: x + offset, y: top, w: (w - GAP * (images.length - 1)) / images.length, h: height };
      offset += (column ? box.h : box.w) + GAP;
      if (!image) {
        out.addText(block.alt ? `[${block.alt}]` : "[image]", { ...box, align: "center", valign: "middle", color: THEME.muted, fontSize: 14, fontFace: THEME.bodyFont });
        continue;
      }
      out.addImage({ data: dataUrl(image), ...contain(image, box.x, box.y, box.w, box.h), altText: block.alt });
    }
  }

  let y = top;
  for (const group of groupText(text)) {
    const h = group.reduce((sum, b) => sum + blockHeight(b, width, pt), 0) + (group.length - 1) * GAP * 0.5;
    const first = group[0];
    if (first.type === "code") {
      out.addText(first.code, {
        x: MARGIN,
        y,
        w: width,
        h,
        fontFace: THEME.monoFont,
        fontSize: codePt(pt),
        color: THEME.codeText,
        fill: { color: THEME.codeBackground },
        valign: "top",
        margin: 10,
        lineSpacingMultiple: 1.1,
      });
    } else if (first.type === "table") {
      drawTable(out, first, MARGIN, y, width, pt);
    } else {
      out.addText(paragraphRuns(group, pt), { x: MARGIN, y, w: width, h: h + 0.1, valign: "top", color: THEME.text, fontFace: THEME.bodyFont, paraSpaceAfter: 6 });
    }
    y += h + GAP;
  }
}

/** Neighbouring text blocks share one text box; code and tables get their own. */
function groupText(blocks: Block[]): Block[][] {
  const groups: Block[][] = [];
  for (const block of blocks) {
    const last = groups[groups.length - 1];
    const textual = block.type === "paragraph" || block.type === "bullets" || block.type === "quote";
    const lastTextual = last && (last[0].type === "paragraph" || last[0].type === "bullets" || last[0].type === "quote");
    if (textual && lastTextual) last.push(block);
    else groups.push([block]);
  }
  return groups;
}

function drawTable(out: PSlide, table: Extract<Block, { type: "table" }>, x: number, y: number, w: number, pt: number): void {
  const size = Math.round(pt * 0.85);
  const cell = (runs: Run[], header: boolean, col: number): PptxGenJS.TableCell => ({
    text: runsToText(runs, size, header ? { bold: true } : {}),
    options: { align: table.align[col] ?? "left", fill: { color: header ? THEME.codeBackground : "FFFFFF" } },
  });
  const rows = [table.header.map((c, i) => cell(c, true, i)), ...table.rows.map((r) => r.map((c, i) => cell(c, false, i)))];
  out.addTable(rows, { x, y, w, fontFace: THEME.bodyFont, fontSize: size, color: THEME.text, border: { type: "solid", pt: 0.75, color: THEME.border }, margin: 4 });
}

// ---------------------------------------------------------------- text runs

type Style = { bold?: boolean; italic?: boolean; color?: string; fontFace?: string };

function titleRuns(slide: Slide): TextRun[] {
  return runsToText(slide.titleRuns, undefined, {});
}

function runsToText(runs: Run[], fontSize: number | undefined, style: Style): TextRun[] {
  return runs.map((run) => ({
    text: run.text,
    options: {
      ...(fontSize ? { fontSize } : {}),
      bold: run.bold || style.bold || undefined,
      italic: run.italic || style.italic || undefined,
      strike: run.strike ? "sngStrike" : undefined,
      highlight: run.mark ? THEME.highlight : undefined,
      fontFace: run.code ? THEME.monoFont : style.fontFace,
      color: run.code ? THEME.codeText : style.color,
      hyperlink: run.link ? { url: run.link } : undefined,
    },
  }));
}

/** Paragraphs, bullets and quotes as one run list, one paragraph per line. */
function paragraphRuns(blocks: Block[], pt: number, style: Style = {}): TextRun[] {
  const out: TextRun[] = [];
  // pptxgenjs starts a new paragraph at a run with bullet settings, so those go on the first run only.
  const paragraph = (runs: Run[], options: PptxGenJS.TextPropsOptions, runStyle: Style = style) => {
    const list = runsToText(runs.length ? runs : [{ text: " " }], pt, runStyle);
    Object.assign(list[0].options!, options);
    list[list.length - 1].options!.breakLine = true;
    out.push(...list);
  };
  for (const block of blocks) {
    if (block.type === "paragraph") paragraph(block.runs, {});
    else if (block.type === "quote") paragraph(block.runs, {}, { ...style, italic: true, color: THEME.muted });
    else if (block.type === "bullets")
      for (const item of block.items) paragraph(item.runs, { bullet: item.ordered ? { type: "number" } : { indent: 18 }, indentLevel: item.level });
  }
  if (out.length) delete out[out.length - 1].options!.breakLine;
  return out;
}
