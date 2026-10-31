import { describe, expect, it } from "vitest";
import { lint, maskCode, readability, sentences, proseBlocks, syllables, type LintRule } from "./rules";

const rules = (text: string) => lint(text).map((h) => h.rule);
const applyAll = (text: string, rule: LintRule) =>
  lint(text)
    .filter((h) => h.rule === rule)
    .flatMap((h) => h.fixes ?? [])
    .map((f) => text.slice(0, f.from) + f.insert + text.slice(f.to));
const found = (text: string, rule: LintRule) => lint(text).filter((h) => h.rule === rule).map((h) => text.slice(h.from, h.to));

describe("maskCode", () => {
  it("blanks fences, inline code and comments but keeps every offset", () => {
    const text = "Hi `the the` there.\n```\nthe the\n```\n<!-- the the -->\nend";
    const masked = maskCode(text);
    expect(masked).toHaveLength(text.length);
    expect(masked).not.toContain("the the");
    expect(masked.startsWith("Hi ")).toBe(true);
    expect(rules("Hi the `x` the.")).not.toContain("repeated-word");
    expect(rules("# `code`\n- `item`")).toEqual([]);
    expect(masked.endsWith("end")).toBe(true);
  });

  it("blanks indented code after a blank line, and front matter", () => {
    const masked = maskCode("---\ntitle: the the\n---\nText\n\n    code code\n\nAfter");
    expect(masked).not.toContain("the the");
    expect(masked).not.toContain("code");
    expect(masked).toContain("After");
  });
});

describe("sentences", () => {
  it("doesn't split at abbreviations or initials", () => {
    const [block] = proseBlocks("Dr. Smith met J. Bloggs, e.g. at work. Then left!");
    expect(sentences(block).map((s) => s.words)).toEqual([8, 2]);
  });
});

describe("readability", () => {
  it("scores simple text as easy", () => {
    const r = readability("The cat sat on the mat. The dog ran.")!;
    expect(r.sentences).toBe(2);
    expect(r.avgSentence).toBe(4.5);
    expect(r.grade).toBeLessThan(3);
  });

  it("scores long, wordy text higher", () => {
    const r = readability("Notwithstanding considerable organisational complexity, the institutionalisation of comprehensive interdisciplinary methodologies necessitates extraordinary administrative coordination.")!;
    expect(r.grade).toBeGreaterThan(14);
  });

  it("only counts the selection when given one, and ignores code and headings", () => {
    const text = "# A heading here\n\nOne two three. Four five six seven.\n\n```\nnot counted at all.\n```";
    expect(readability(text)!.words).toBe(7);
    const from = text.indexOf("Four");
    expect(readability(text, { from, to: text.length })!.words).toBe(4);
    expect(readability("```\ncode.\n```")).toBeNull();
  });

  it("counts syllables roughly", () => {
    expect(syllables("cat")).toBe(1);
    expect(syllables("make")).toBe(1);
    expect(syllables("table")).toBe(2);
    expect(syllables("elephant")).toBe(3);
  });
});

describe("lint", () => {
  it("finds long sentences and paragraphs", () => {
    const long = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ") + ".";
    expect(rules(long)).toContain("long-sentence");
    expect(rules("A short one.")).not.toContain("long-sentence");
    const para = Array.from({ length: 20 }, () => "This sentence has eight words in it here.").join(" ");
    expect(rules(para)).toContain("long-paragraph");
  });

  it("finds passive voice, but not adjectives", () => {
    expect(found("The letter was written by Sam.", "passive")).toEqual(["was written"]);
    expect(found("The bug is quickly fixed.", "passive")).toEqual(["is quickly fixed"]);
    expect(found("I am tired. She is interested.", "passive")).toEqual([]);
  });

  it("finds adverbs but not -ly nouns", () => {
    expect(found("He ran quickly to the family reunion, only slightly late.", "adverb")).toEqual(["quickly", "slightly"]);
  });

  it("suggests a stronger verb for an adverb beside a verb it knows, and always offers to remove it", () => {
    expect(applyAll("She ran quickly to the bench.", "adverb")).toEqual(["She sprinted to the bench.", "She ran to the bench."]);
    expect(applyAll("Quickly look at the board.", "adverb")).toEqual(["Glance at the board.", "Look at the board."]);
    expect(applyAll("He said loudly that it works.", "adverb")[0]).toBe("He shouted that it works.");
    expect(applyAll("The command enables you to quickly add text.", "adverb")).toEqual(["The command enables you to add text."]);
    expect(applyAll("It works. Basically, it reads the pin.", "adverb")).toEqual(["It works. It reads the pin."]);
    expect(applyAll("It reads the pin quickly.", "adverb")).toEqual(["It reads the pin."]);
    const [hint] = lint("This is actually fine.").filter((h) => h.rule === "adverb");
    expect(hint.message).toContain("rarely adds anything");
  });

  it("finds wordy phrases and offers the short form, keeping the capital", () => {
    expect(found("Solder it in order to make it strong.", "wordy")).toEqual(["in order to"]);
    expect(applyAll("Solder it in order to make it strong.", "wordy")).toEqual(["Solder it to make it strong."]);
    expect(applyAll("Due to the fact that it\nrained, we stopped.", "wordy")).toEqual(["Because it\nrained, we stopped."]);
    expect(applyAll("A very big motor.", "wordy")).toEqual(["A huge motor."]);
    expect(rules("Every one of us, inorder to.")).not.toContain("wordy");
  });

  it("checks a callout's title apart from its body", () => {
    const text = "> [!note] Open Duck Mini vs Microduck\n> Microduck is a small robot.";
    expect(rules(text)).not.toContain("repeated-word");
    expect(rules("> [!tip]\n> Use the the pin.")).toContain("repeated-word");
    const long = Array.from({ length: 20 }, (_, i) => `w${i}`).join(" ");
    expect(rules(`> [!note] ${long}\n> ${long}.`)).not.toContain("long-sentence");
  });

  it("finds repeated words with a fix that removes the second", () => {
    const text = "Go to the the shop.";
    const [hint] = lint(text).filter((h) => h.rule === "repeated-word");
    expect(text.slice(hint.from, hint.to)).toBe("the the");
    const fixed = text.slice(0, hint.fixes![0].from) + hint.fixes![0].insert + text.slice(hint.fixes![0].to);
    expect(fixed).toBe("Go to the shop.");
    expect(rules("We had had enough.")).not.toContain("repeated-word");
  });

  it("finds doubled spaces but not indentation, hard breaks or tables", () => {
    expect(found("One  two.", "double-space")).toEqual(["  "]);
    expect(rules("  - indented item\nline break  \nnext")).not.toContain("double-space");
    expect(rules("| a  | b |\n|---|---|\n| 1  | 2 |")).not.toContain("double-space");
  });

  it("skips everything inside code", () => {
    expect(lint("```\nthe the  was written quickly\n```\n\n`is  done`")).toEqual([]);
  });

  it("checks heading structure", () => {
    const text = "# One\n\n### Three\n\n# Again\n\n##\n";
    expect(rules(text)).toEqual(["heading-skip", "multiple-h1", "empty-heading"]);
    const skip = lint(text).find((h) => h.rule === "heading-skip")!;
    expect(text.slice(skip.fixes![0].from, skip.fixes![0].to)).toBe("###");
    expect(skip.fixes![0].insert).toBe("##");
    expect(rules("# A\n## B\n### C\n## D")).toEqual([]);
  });

  it("finds empty list items", () => {
    expect(rules("- one\n- \n1.\n- [ ] ")).toEqual(["empty-list-item", "empty-list-item", "empty-list-item"]);
    expect(rules("---")).toEqual([]);
  });

  it("checks images and links", () => {
    expect(rules("![](cat.png) and ![A cat](cat.png)")).toEqual(["image-alt"]);
    expect(rules("[](https://x.com) and [https://x.com](https://x.com) and [Home](https://x.com)")).toEqual(["link-text", "link-text"]);
  });

  it("doesn't count link addresses or images as words", () => {
    const words = (t: string) => readability(t)!.words;
    expect(words("See [the site](https://example.com/a/b/c) now.")).toBe(4);
    expect(words("Look ![a cat](x.png) here.")).toBe(2);
  });
});
