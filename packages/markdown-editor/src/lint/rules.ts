import { adverbFixes, wordyPhrases, type Fix } from "./suggest";

// Writing lint: gentle hints in the spirit of Hemingway, worked out from the
// Markdown text alone. Everything here is pure so it can be tested and run
// anywhere; `writingLint.ts` puts the results in the editor.

export type LintRule =
  | "long-sentence"
  | "long-paragraph"
  | "passive"
  | "adverb"
  | "wordy"
  | "repeated-word"
  | "double-space"
  | "heading-skip"
  | "multiple-h1"
  | "empty-heading"
  | "empty-list-item"
  | "image-alt"
  | "link-text";

export type LintHint = {
  rule: LintRule;
  from: number;
  to: number;
  message: string;
  /** One-click changes, best first. */
  fixes?: Fix[];
};

/** A before-and-after line that shows what a rule means. */
export type RuleExample = { before: string; after: string };

export type RuleInfo = {
  rule: LintRule;
  title: string;
  looksFor: string;
  group: "Style" | "Tidiness" | "Structure" | "Links and images";
  example?: RuleExample;
};

export const LONG_SENTENCE = 25;
export const LONG_PARAGRAPH = 150;

/** What each rule looks for, in the order the panel lists them. */
export const RULES: RuleInfo[] = [
  { rule: "long-sentence", group: "Style", title: "Long sentence", looksFor: `Sentences over ${LONG_SENTENCE} words.`, example: { before: "The robot reads the sensor and then it turns the motor so that the wheels move forward.", after: "The robot reads the sensor. Then it turns the motor to drive forward." } },
  { rule: "long-paragraph", group: "Style", title: "Long paragraph", looksFor: `Paragraphs over ${LONG_PARAGRAPH} words.` },
  { rule: "passive", group: "Style", title: "Passive voice", looksFor: "A form of “to be” followed by a past participle, like “was written”.", example: { before: "The code was written by Kev.", after: "Kev wrote the code." } },
  { rule: "adverb", group: "Style", title: "Adverb", looksFor: "Words ending in “-ly” that usually prop up a weaker verb.", example: { before: "She ran quickly to the bench.", after: "She sprinted to the bench." } },
  { rule: "wordy", group: "Style", title: "Wordy phrase", looksFor: "Phrases with a shorter way to say them, like “in order to” or “very big”.", example: { before: "Solder it in order to make it stronger.", after: "Solder it to make it stronger." } },
  { rule: "repeated-word", group: "Tidiness", title: "Repeated word", looksFor: "The same word twice in a row, like “the the”.", example: { before: "Connect the the battery.", after: "Connect the battery." } },
  { rule: "double-space", group: "Tidiness", title: "Double space", looksFor: "Two or more spaces between words." },
  { rule: "heading-skip", group: "Structure", title: "Skipped heading level", looksFor: "A heading more than one level below the one before it, like # then ###.", example: { before: "# Build, then ### Wiring", after: "# Build, then ## Wiring" } },
  { rule: "multiple-h1", group: "Structure", title: "More than one H1", looksFor: "A second top-level (#) heading.", example: { before: "# Wiring", after: "## Wiring" } },
  { rule: "empty-heading", group: "Structure", title: "Empty heading", looksFor: "A heading with no text." },
  { rule: "empty-list-item", group: "Structure", title: "Empty list item", looksFor: "A bullet or number with nothing after it." },
  { rule: "image-alt", group: "Links and images", title: "Image without alt text", looksFor: "Images written as ![](…), which screen readers can't describe.", example: { before: "![](arm.jpg)", after: "![The robot arm on my desk](arm.jpg)" } },
  { rule: "link-text", group: "Links and images", title: "Unclear link text", looksFor: "Links with no text, or with the bare address as their text.", example: { before: "[https://github.com/…](https://github.com/…)", after: "[the code on GitHub](https://github.com/…)" } },
];

export const RULE_INFO = Object.fromEntries(RULES.map((r) => [r.rule, r])) as Record<LintRule, RuleInfo>;

// ------------------------------------------------------------------ masking

const blank = (s: string) => s.replace(/[^\n]/g, " ");
// Inline things (code spans, link targets) become a filler that is neither a
// word nor a space, so "the `x` the" isn't a repeated word and "# `code`"
// isn't an empty heading.
const FILL = "\u2063";
const fill = (s: string) => s.replace(/[^\n]/g, FILL);

/**
 * The text with code (fences, indented blocks, inline spans), HTML comments
 * and front matter blanked out. It keeps every offset, so a hint found in the
 * masked text points at the same place in the real one.
 */
export function maskCode(text: string): string {
  let out = text.replace(/^---\n[\s\S]*?\n(?:---|\.\.\.)(?=\n|$)/, blank);
  out = out.replace(/<!--[\s\S]*?(?:-->|$)/g, fill);
  const lines = out.split("\n");
  let fence: { char: string; len: number } | null = null;
  let prevBlank = true;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence.char === "`" ? "`" : "~"}{${fence.len},}\\s*$`);
      if (close.test(line)) fence = null;
      lines[i] = blank(line);
    } else if (open) {
      fence = { char: open[1][0], len: open[1].length };
      lines[i] = blank(line);
    } else if (prevBlank && /^( {4}|\t)/.test(line) && line.trim()) {
      // An indented code block starts after a blank line and runs while it stays indented.
      let j = i;
      while (j < lines.length && (/^( {4}|\t)/.test(lines[j]) || !lines[j].trim())) lines[j] = blank(lines[j++]);
      i = j - 1;
    }
    prevBlank = !lines[i].trim();
  }
  out = lines.join("\n");
  // Inline code: a run of backticks closed by a run of the same length.
  return out.replace(/(`+)(?!`)[\s\S]*?[^`]\1(?!`)|``/g, (m) => (m.includes("\n\n") ? m : fill(m)));
}

// ------------------------------------------------------------------ blocks

type Prose = { from: number; to: number; text: string };

const HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+(?:\[[ xX]\]\s*)?|$)/;
const RULE_LINE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const TABLE_LINE = /^\s*\|.*\|\s*$|^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

/**
 * Paragraphs of running text (list items and quotes count; headings, tables
 * and rules don't), with Markdown syntax blanked so only the words are left.
 */
export function proseBlocks(masked: string): Prose[] {
  const blocks: Prose[] = [];
  let start = -1;
  let parts: string[] = [];
  let end = 0;
  const flush = () => {
    if (start >= 0) blocks.push({ from: start, to: end, text: parts.join("\n") });
    start = -1;
    parts = [];
  };
  let pos = 0;
  for (const raw of masked.split("\n")) {
    const lineFrom = pos;
    pos += raw.length + 1;
    let line = raw;
    // Quote markers and list bullets become spaces; a new item is a new paragraph.
    line = line.replace(/^(\s*>)+\s?/, blank);
    const item = LIST_ITEM.exec(line);
    if (item) {
      flush();
      line = blank(item[0]) + line.slice(item[0].length);
    }
    if (!line.trim() || HEADING.test(line) || RULE_LINE.test(line) || TABLE_LINE.test(line) || /^ {0,3}(=+|-+)\s*$/.test(line)) {
      flush();
      continue;
    }
    if (start < 0) start = lineFrom;
    parts.push(line);
    end = lineFrom + raw.length;
  }
  flush();
  return blocks.map((b) => ({ ...b, text: stripInline(b.text) }));
}

/** Blanks inline syntax that isn't words: images, link targets, HTML tags, bare emphasis marks. */
function stripInline(text: string): string {
  return text
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, fill)
    .replace(/\[([^\]\n]*)(\]\([^)\n]*\)|\]\[[^\]\n]*\])/g, (_, t: string, b: string) => " " + t + fill(b))
    .replace(/<\/?[a-zA-Z][^>\n]*>/g, fill)
    .replace(/https?:\/\/\S+/g, fill)
    .replace(/(\*\*|__|==|~~|[*_~])/g, blank);
}

// ------------------------------------------------------------------ sentences

const ABBREVIATIONS = new Set(["mr", "mrs", "ms", "dr", "prof", "st", "vs", "etc", "e.g", "i.e", "eg", "ie", "jr", "sr", "inc", "ltd", "no", "fig", "approx", "cf"]);
const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}]+|[.\-][\p{L}\p{N}]+)*/gu;

export type Sentence = { from: number; to: number; words: number };

/** Splits a paragraph into sentences at . ! ? (and line breaks that end a line without a full stop are kept together). */
export function sentences(block: Prose): Sentence[] {
  const out: Sentence[] = [];
  const text = block.text;
  let start = 0;
  const push = (end: number) => {
    const slice = text.slice(start, end);
    const lead = slice.length - slice.trimStart().length;
    const trimmed = slice.trim();
    if (trimmed) {
      const words = trimmed.match(WORD)?.length ?? 0;
      if (words) out.push({ from: block.from + start + lead, to: block.from + start + lead + trimmed.length, words });
    }
    start = end;
  };
  const re = /[.!?…]+["'”’)\]]*(?=\s|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const before = /([\p{L}.]+)$/u.exec(text.slice(start, m.index))?.[1]?.toLowerCase() ?? "";
    // "Dr. Smith", "e.g. this", and single initials like "J. Smith" don't end a sentence.
    if (m[0] === "." && (ABBREVIATIONS.has(before) || /^\p{L}$/u.test(before))) continue;
    push(m.index + m[0].length);
  }
  push(text.length);
  return out;
}

// ------------------------------------------------------------------ readability

export function syllables(word: string): number {
  let w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (w.length <= 3) return 1;
  w = w.replace(/(?:[^laeiouy]es|[^laeiouy]ed|[^laeiouy]e)$/, "").replace(/^y/, "");
  return Math.max(1, w.match(/[aeiouy]{1,2}/g)?.length ?? 1);
}

export type Readability = { words: number; sentences: number; avgSentence: number; grade: number };

/** Flesch-Kincaid grade level and average sentence length, for the prose between `from` and `to`. */
export function readability(text: string, range?: { from: number; to: number }): Readability | null {
  const masked = maskCode(text);
  let words = 0;
  let count = 0;
  let syll = 0;
  for (const block of proseBlocks(masked))
    for (const s of sentences(block)) {
      if (range && (s.to <= range.from || s.from >= range.to)) continue;
      const from = range ? Math.max(s.from, range.from) : s.from;
      const to = range ? Math.min(s.to, range.to) : s.to;
      const found = (block.text.slice(from - block.from, to - block.from).match(WORD) ?? []) as string[];
      if (!found.length) continue;
      count++;
      words += found.length;
      for (const w of found) syll += syllables(w);
    }
  if (!words) return null;
  const avgSentence = words / count;
  const grade = 0.39 * avgSentence + 11.8 * (syll / words) - 15.59;
  return { words, sentences: count, avgSentence, grade: Math.max(0, grade) };
}

// ------------------------------------------------------------------ rules

const BE = "am|is|are|was|were|be|been|being|isn't|aren't|wasn't|weren't";
const IRREGULAR =
  "awoken|been|born|beaten|become|begun|bent|bitten|blown|broken|brought|built|burnt|bought|caught|chosen|come|cut|dealt|done|drawn|driven|eaten|fallen|fed|felt|fought|found|forbidden|forgotten|forgiven|frozen|given|gone|grown|hung|heard|hidden|hit|held|hurt|kept|known|laid|led|left|lent|let|lost|made|meant|met|paid|put|read|ridden|rung|risen|run|said|seen|sold|sent|set|shaken|shot|shown|shut|sung|sunk|sat|slept|spoken|spent|spun|spread|stood|stolen|struck|sworn|swept|swum|taken|taught|torn|told|thought|thrown|understood|woken|worn|won|written|wound";
const PASSIVE = new RegExp(`\\b(?:${BE})\\s+(?:(?:not|never|also|often|always|being)\\s+)?(?:\\p{L}+ly\\s+)?(?:\\p{L}+ed|${IRREGULAR})\\b`, "giu");
// -ed words that are usually adjectives after "is", so "is tired" isn't passive.
const NOT_PASSIVE = /\b(?:tired|interested|excited|bored|worried|scared|pleased|surprised|married|used|supposed|need|indeed|red|bed|shed|seed|feed|speed|weed|naked|wicked|sacred|beloved|aged|ragged|rugged|crooked|learned|wretched|hundred|kindred|embed)$/i;

const ADVERB = /\b\p{L}{2,}ly\b/giu;
const NOT_ADVERB = new Set(
  "only reply apply supply imply comply rely ally belly bully jelly fly family early daily weekly monthly yearly hourly holy ugly silly lily july italy anomaly assembly butterfly rally folly friendly lonely lovely likely lively ugly elderly costly deadly curly chilly hilly oily wily woolly melancholy monopoly homily dolly gully sully tally jolly fully reply".split(" "),
);

const REPEATED = /\b(\p{L}+)(\s+)(\1)\b/giu;
// Doubles that are often right: "had had", "that that".
const OK_REPEATED = new Set(["had", "that", "is", "do", "very", "bye", "no", "ha", "so", "really", "many", "far"]);

export function lint(text: string): LintHint[] {
  const masked = maskCode(text);
  const hints: LintHint[] = [];
  const blocks = proseBlocks(masked);

  for (const block of blocks) {
    let blockWords = 0;
    for (const s of sentences(block)) {
      blockWords += s.words;
      if (s.words > LONG_SENTENCE)
        hints.push({ rule: "long-sentence", from: s.from, to: s.to, message: `${s.words} words. Splitting it in two would make it easier to follow.` });
    }
    if (blockWords > LONG_PARAGRAPH)
      hints.push({ rule: "long-paragraph", from: block.from, to: block.to, message: `${blockWords} words. A break would give readers a moment to breathe.` });

    for (const m of block.text.matchAll(PASSIVE)) {
      const last = /\p{L}+$/u.exec(m[0])![0];
      if (NOT_PASSIVE.test(last)) continue;
      const from = block.from + m.index!;
      hints.push({ rule: "passive", from, to: from + m[0].length, message: "Saying who did it is often clearer: “we wrote it” rather than “it was written”." });
    }
    for (const m of block.text.matchAll(ADVERB)) {
      if (NOT_ADVERB.has(m[0].toLowerCase())) continue;
      const from = block.from + m.index!;
      const to = from + m[0].length;
      const { fixes, message } = adverbFixes(block.text, block.from, from, to);
      hints.push({ rule: "adverb", from, to, message: message ?? "A stronger verb often says it better, or the sentence works without it.", fixes });
    }
    for (const w of wordyPhrases(block.text, block.from))
      hints.push({ rule: "wordy", from: w.from, to: w.to, message: w.short ? `“${w.short}” says the same in fewer words.` : "The sentence works without this.", fixes: [w.fix] });
    for (const m of block.text.matchAll(REPEATED)) {
      if (m[1].toLowerCase() !== m[3].toLowerCase() || OK_REPEATED.has(m[1].toLowerCase())) continue;
      const from = block.from + m.index!;
      const to = from + m[0].length;
      const second = from + m[1].length;
      hints.push({ rule: "repeated-word", from, to, message: `“${m[1]}” twice in a row.`, fixes: [{ label: `Remove the second “${m[3]}”`, from: second, to, insert: "" }] });
    }
  }

  // Doubled spaces, between words on one line, outside tables and code. Two at the end of a line are a line break.
  let pos = 0;
  for (const line of masked.split("\n")) {
    if (line.trim() && !TABLE_LINE.test(line) && !/^\s*\|/.test(line))
      for (const m of line.matchAll(/(?<=\S) {2,}(?=\S)/g)) {
        const from = pos + m.index!;
        hints.push({ rule: "double-space", from, to: from + m[0].length, message: `${m[0].length} spaces where one will do.`, fixes: [{ label: "Use one space", from, to: from + m[0].length, insert: " " }] });
      }
    pos += line.length + 1;
  }

  hints.push(...structure(masked));
  hints.push(...linksAndImages(masked));
  return hints.sort((a, b) => a.from - b.from || a.to - b.to);
}

function structure(masked: string): LintHint[] {
  const hints: LintHint[] = [];
  let prevLevel = 0;
  let h1s = 0;
  let pos = 0;
  for (const line of masked.split("\n")) {
    const from = pos;
    pos += line.length + 1;
    const h = HEADING.exec(line);
    if (h) {
      const level = h[1].length;
      const to = from + line.length;
      const text = h[2].replace(/\s#+\s*$/, "").trim();
      if (!text) hints.push({ rule: "empty-heading", from, to, message: "This heading has no text, so it won't help anyone find their way." });
      if (level === 1 && ++h1s > 1)
        hints.push({
          rule: "multiple-h1",
          from,
          to,
          message: "There's already a top-level heading. Most notes read best with one # and the rest below it.",
          fixes: [{ label: "Make it H2", from: from + line.indexOf("#"), to: from + line.indexOf("#") + 1, insert: "##" }],
        });
      if (prevLevel && level > prevLevel + 1)
        hints.push({
          rule: "heading-skip",
          from,
          to,
          message: `Jumps from H${prevLevel} to H${level}. Readers and screen readers expect one level at a time.`,
          fixes: [{ label: `Make it H${prevLevel + 1}`, from: from + line.indexOf("#"), to: from + line.indexOf("#") + level, insert: "#".repeat(prevLevel + 1) }],
        });
      prevLevel = level;
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item && !line.slice(item[0].length).trim() && !RULE_LINE.test(line))
      hints.push({ rule: "empty-list-item", from: from + item[1].length, to: from + line.length, message: "A list item with nothing in it." });
  }
  return hints;
}

function linksAndImages(masked: string): LintHint[] {
  const hints: LintHint[] = [];
  for (const m of masked.matchAll(/(!?)\[([^\]\n]*)\]\([^)\n]*\)/g)) {
    const from = m.index!;
    const to = from + m[0].length;
    const [, bang, label] = m;
    if (bang) {
      if (!label.trim()) hints.push({ rule: "image-alt", from, to, message: "This image has no alt text. Describe it between the brackets, for people who can't see it." });
    } else if (!label.trim()) {
      hints.push({ rule: "link-text", from, to, message: "This link has no text, so there's nothing to click." });
    } else if (/^(?:https?:\/\/|www\.)\S+$/i.test(label.trim())) {
      hints.push({ rule: "link-text", from, to, message: "The link's text is its address. A few words about where it goes read better." });
    }
  }
  return hints;
}

