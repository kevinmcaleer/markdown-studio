import { SearchQuery } from "@codemirror/search";
import { EditorSelection, EditorState, Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { matchCount } from "./findReplace";
import { addWritten, today } from "./WritingBar";
import { countChars, countWords, paragraphAt, readingMinutes } from "./writingMode";

describe("word counts", () => {
  it("counts words, not Markdown marks", () => {
    expect(countWords("# A title\n\n- one **two** ==three==\n\n| a | b |\n|---|---|")).toBe(7);
  });

  it("keeps contractions and hyphenated words whole", () => {
    expect(countWords("It's a well-known fact, isn’t it?")).toBe(6);
  });

  it("leaves out link targets and HTML comments", () => {
    expect(countWords("See [the docs](https://example.com/a/b \"Docs\") <!-- hidden note -->")).toBe(3);
  });

  it("counts other scripts and numbers", () => {
    expect(countWords("Café 2026 naïve")).toBe(3);
    expect(countWords("")).toBe(0);
  });

  it("counts an emoji as one character", () => {
    expect(countChars("hi 👋")).toBe(4);
  });

  it("rounds reading time, with at least a minute", () => {
    expect(readingMinutes(0)).toBe(0);
    expect(readingMinutes(10)).toBe(1);
    expect(readingMinutes(1150)).toBe(5);
  });
});

describe("daily tally", () => {
  it("adds through the day and starts again the next", () => {
    const a = addWritten(null, 40, "2026-10-25");
    const b = addWritten(a, -5, "2026-10-25");
    expect(b).toEqual({ day: "2026-10-25", words: 35 });
    expect(addWritten(b, 3, "2026-10-26")).toEqual({ day: "2026-10-26", words: 3 });
  });

  it("uses the local date", () => {
    expect(today(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });
});

describe("focus paragraph", () => {
  const doc = Text.of(["# Title", "", "one", "two", "", "three"]);
  const at = (line: number) => paragraphAt(doc, doc.line(line).from);

  it("spans the run of non-blank lines around the cursor", () => {
    expect(at(3)).toEqual({ from: 3, to: 4 });
    expect(at(4)).toEqual({ from: 3, to: 4 });
    expect(at(6)).toEqual({ from: 6, to: 6 });
  });

  it("is just the line on a blank line", () => {
    expect(at(2)).toEqual({ from: 2, to: 2 });
  });
});

describe("find matches", () => {
  const state = (doc: string, from = 0, to = from) => EditorState.create({ doc, selection: EditorSelection.single(from, to) });

  it("counts every match and knows which is selected", () => {
    const s = state("cat Cat cat", 8, 11);
    expect(matchCount(s, new SearchQuery({ search: "cat" }))).toEqual({ total: 3, current: 3, capped: false });
    expect(matchCount(s, new SearchQuery({ search: "cat", caseSensitive: true }))).toEqual({ total: 2, current: 2, capped: false });
  });

  it("honours whole word and regex", () => {
    const s = state("cat category cat");
    expect(matchCount(s, new SearchQuery({ search: "cat", wholeWord: true })).total).toBe(2);
    expect(matchCount(s, new SearchQuery({ search: "cat\\w+", regexp: true })).total).toBe(1);
  });

  it("finds nothing for a bad pattern", () => {
    expect(matchCount(state("abc"), new SearchQuery({ search: "(", regexp: true })).total).toBe(0);
  });
});
