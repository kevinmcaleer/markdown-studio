import type { MarkdownItInstance } from "./markdown";
import { safeImageUrl } from "./gallery";

// Cards: a layout block of cards side by side, each a picture, a title and
// some words. It's all Markdown, so it reads fine anywhere; the live view lets
// you build it by pointing and clicking too (cardsWidget.ts).
//
//   ::: cards
//   ![Open Duck Mini](/odm.jpg)
//   ## Open Duck Mini
//   Created by Antoine Pirrone. A 42 cm DIY build.
//
//   ---
//
//   ![Microduck](/md.jpg)
//   ## Microduck
//   By Pollen Robotics and Hugging Face.
//   :::
//
// A line of `---` starts the next card. A card's first picture line is its
// picture and the rest is any Markdown (its first heading is its title). The
// word after `cards` can set how many across (`::: cards 3`); without it the
// cards fill the width, and they stack on a phone. Same shape as
// `::: gallery` (gallery.ts). The preview (cardsPlugin) and the live view both
// draw cardsHtml; cards.css styles it, for pages that render the Markdown
// themselves too (kevsrobots' project pages mirror this file).

/** `::: cards` and how many across, alone on a line. */
export const CARDS_OPEN = /^[ \t]{0,3}:::[ \t]*cards\b[ \t]*(\d*)[ \t]*$/i;
/** The `:::` that closes a block. */
export const CARDS_CLOSE = /^[ \t]{0,3}:::[ \t]*$/;
/** The line between two cards. */
export const CARD_BREAK = /^[ \t]{0,3}---[ \t]*$/;
const PICTURE_LINE = /^[ \t]*!\[((?:\\.|[^\]\\])*)\]\(\s*(<[^>\n]*>|[^\s)]+)(?:\s+(?:"([^"]*)"|'([^']*)'))?\s*\)(?:\{([\w-]+)\})?[ \t]*$/;
const HEADING_LINE = /^[ \t]{0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;

/** The columns an opening line asks for: a number from 1 to 6, 0 to fill the width; null when it isn't one. */
export function parseCardsOpen(line: string): number | null {
  const match = CARDS_OPEN.exec(line);
  if (!match) return null;
  const n = Number(match[1] || 0);
  return Math.max(0, Math.min(6, n));
}

/** The opening line for some columns (0 fills the width). */
export function cardsOpenLine(columns: number): string {
  return columns ? `::: cards ${columns}` : "::: cards";
}

export type CardPicture = { src: string; alt: string; title: string; size: string };

export type Card = {
  picture: CardPicture | null;
  /** The title's heading level (2 when it has none). */
  level: number;
  title: string;
  /** The rest of the card's Markdown. */
  text: string;
};

function unescapeMarkdown(text: string): string {
  return text.replace(/\\([\\`*_{}[\]()#+\-.!|"'<>~])/g, "$1");
}

function escapeAlt(text: string): string {
  return text.replace(/([\\[\]])/g, "\\$1");
}

/** A block's lines split into its cards' Markdown, at `---` lines outside code. */
export function splitCards(body: string): string[] {
  const cards: string[][] = [[]];
  let fence: string | null = null;
  for (const line of body.split("\n")) {
    const marker = FENCE.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
    } else if (marker) fence = marker[1];
    else if (CARD_BREAK.test(line)) {
      cards.push([]);
      continue;
    }
    cards[cards.length - 1].push(line);
  }
  return cards.map((lines) => lines.join("\n").trim());
}

/** A card's picture, title and the rest of its Markdown. */
export function parseCard(markdown: string): Card {
  const lines = markdown.split("\n");
  let picture: CardPicture | null = null;
  let level = 2;
  let title = "";
  const rest: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const marker = FENCE.exec(line);
    if (fence || marker) {
      if (fence && marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      else if (!fence && marker) fence = marker[1];
      rest.push(line);
      continue;
    }
    const pic: RegExpExecArray | null = picture ? null : PICTURE_LINE.exec(line);
    if (pic) {
      picture = {
        src: pic[2].replace(/^<|>$/g, "").trim(),
        alt: unescapeMarkdown(pic[1]).trim(),
        title: (pic[3] ?? pic[4] ?? "").trim(),
        size: pic[5] ?? "",
      };
      continue;
    }
    const heading = title ? null : HEADING_LINE.exec(line);
    if (heading && heading[2].trim()) {
      level = heading[1].length;
      title = heading[2].trim();
      continue;
    }
    rest.push(line);
  }
  return { picture, level, title, text: rest.join("\n").trim() };
}

/** A card as Markdown: its picture line, its title as a heading, then its words. */
export function cardMarkdown(card: Card): string {
  const lines: string[] = [];
  const { picture } = card;
  if (picture?.src) {
    const src = /[\s()<>]/.test(picture.src) ? `<${picture.src.replace(/[<>]/g, "")}>` : picture.src;
    const title = picture.title ? ` "${picture.title.replace(/"/g, "'")}"` : "";
    lines.push(`![${escapeAlt(picture.alt)}](${src}${title})${picture.size ? `{${picture.size}}` : ""}`);
  }
  const title = card.title.replace(/\s*\n\s*/g, " ").trim();
  if (title) lines.push(`${"#".repeat(Math.max(1, Math.min(6, card.level || 2)))} ${title}`);
  // A line of --- or ::: in the words would end the card or the block.
  const text = card.text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => (CARD_BREAK.test(line) || CARDS_CLOSE.test(line) ? `\\${line.trim()}` : line))
    .join("\n")
    .trim();
  if (text) lines.push(text);
  return lines.join("\n");
}

/** A whole cards block, from its cards' Markdown. */
export function cardsBlockMarkdown(columns: number, cards: readonly string[]): string {
  const lines = [cardsOpenLine(columns)];
  cards.forEach((card, i) => {
    if (i) lines.push("", "---", "");
    if (card.trim()) lines.push(card.trim());
  });
  lines.push(":::");
  return lines.join("\n");
}

/** A whole cards block. */
export function cardsMarkdown(columns: number, cards: readonly Card[]): string {
  return cardsBlockMarkdown(columns, cards.map(cardMarkdown));
}

export type CardsBlock = {
  columns: number;
  /** Line numbers (0-based) of the `::: cards` line and its `:::`. */
  open: number;
  close: number;
  /** Each card's Markdown. */
  cards: string[];
};

/** The closed cards blocks in some lines of Markdown, skipping fenced code. */
export function findCardBlocks(lines: readonly string[]): CardsBlock[] {
  const blocks: CardsBlock[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = FENCE.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !line.slice(marker[0].length).trim()) fence = null;
      continue;
    }
    if (marker) {
      fence = marker[1];
      continue;
    }
    const columns = parseCardsOpen(line);
    if (columns === null) continue;
    const close = closeOf(lines, i);
    if (close < 0) continue;
    blocks.push({ columns, open: i, close, cards: splitCards(lines.slice(i + 1, close).join("\n")) });
    i = close;
  }
  return blocks;
}

/** The line of the `:::` closing a block opened at `open`, past any code in it; -1 when it isn't closed. */
function closeOf(lines: readonly string[], open: number): number {
  let fence: string | null = null;
  for (let j = open + 1; j < lines.length; j++) {
    const line = lines[j];
    const marker = FENCE.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (marker) {
      fence = marker[1];
      continue;
    }
    if (CARDS_CLOSE.test(line)) return j;
    if (CARDS_OPEN.test(line)) return -1;
  }
  return -1;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A card's picture as HTML, or "" when it has none (or an unsafe one). */
export function cardPictureHtml(picture: CardPicture | null): string {
  const src = picture ? safeImageUrl(picture.src) : null;
  if (!picture || !src) return "";
  const title = picture.title ? ` title="${escapeHtml(picture.title)}"` : "";
  const cover = picture.size === "cover" ? " md-card-cover" : "";
  return `<div class="md-card-media${cover}"><img src="${escapeHtml(src)}" alt="${escapeHtml(picture.alt)}"${title} loading="lazy"></div>`;
}

/**
 * Cards as HTML; `render` turns a card's words (its title heading and the
 * rest) into HTML:
 *
 *   <div class="md-cards" data-cards-columns="3" style="--md-cards-columns: 3">
 *     <div class="md-card"><div class="md-card-media"><img …></div><div class="md-card-body"><h2>…</h2><p>…</p></div></div>
 *   </div>
 */
export function cardsHtml(columns: number, cards: readonly string[], render: (markdown: string) => string): string {
  const items = cards.map((markdown) => cardHtml(parseCard(markdown), render)).join("");
  const style = columns ? ` style="--md-cards-columns: ${columns}"` : "";
  return `<div class="md-cards${columns ? " md-cards-fixed" : ""}" data-cards-columns="${columns}"${style}>${items}</div>`;
}

/** One card as HTML. */
export function cardHtml(card: Card, render: (markdown: string) => string): string {
  const words = [card.title ? `${"#".repeat(card.level)} ${card.title}` : "", card.text].filter(Boolean).join("\n\n");
  const body = words ? `<div class="md-card-body">${render(words)}</div>` : "";
  const empty = !body && !cardPictureHtml(card.picture) ? " md-card-empty" : "";
  return `<div class="md-card${empty}">${cardPictureHtml(card.picture)}${body}</div>`;
}

/** markdown-it: `::: cards` … `:::` as cards (cardsHtml), each card's words rendered by the same markdown-it. */
export function cardsPlugin(md: MarkdownItInstance): void {
  md.block.ruler.before(
    "fence",
    "cards",
    (state, startLine, endLine, silent) => {
      const lineText = (n: number) => state.src.slice(state.bMarks[n] + state.tShift[n], state.eMarks[n]);
      if (state.sCount[startLine] - state.blkIndent >= 4) return false;
      const columns = parseCardsOpen(lineText(startLine));
      if (columns === null) return false;
      const lines: string[] = [];
      for (let n = startLine; n < endLine; n++) {
        if (n > startLine && state.sCount[n] < state.blkIndent && lineText(n)) break;
        lines.push(state.src.slice(state.bMarks[n] + Math.min(state.tShift[n], state.blkIndent), state.eMarks[n]));
      }
      const close = closeOf(lines, 0);
      if (close < 0) return false;
      if (silent) return true;
      const token = state.push("cards", "div", 0);
      token.block = true;
      token.info = String(columns);
      token.content = lines.slice(1, close).join("\n");
      token.map = [startLine, startLine + close + 1];
      state.line = startLine + close + 1;
      return true;
    },
    { alt: ["paragraph", "reference", "blockquote", "list"] },
  );
  md.renderer.rules.cards = (tokens, i, _options, env) =>
    cardsHtml(Number(tokens[i].info) || 0, splitCards(tokens[i].content), (words) => md.render(words, env)) + "\n";
}
