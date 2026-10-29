import { describe, expect, it } from "vitest";
import { matchCase, synonymsOf } from "./contextMenu";
import type { Definition } from "./languageApi";

const quick: Definition = {
  word: "quick",
  lemma: "quick",
  entries: [
    {
      pos: "adjective",
      lemma: "quick",
      senses: [
        { definition: "accomplished rapidly", examples: [], synonyms: ["speedy", "fast"] },
        { definition: "hasty", examples: [], synonyms: ["Fast", "hasty", "quick"] },
      ],
    },
    { pos: "adverb", lemma: "quick", senses: [{ definition: "with speed", examples: [], synonyms: ["quickly", "rapidly"] }] },
  ],
};

describe("synonyms", () => {
  it("collects every sense's synonyms once, without the word itself", () => {
    expect(synonymsOf(quick, "Quick")).toEqual(["speedy", "fast", "hasty", "quickly", "rapidly"]);
  });

  it("stops at the limit, and has none for an unknown word", () => {
    expect(synonymsOf(quick, "quick", 2)).toEqual(["speedy", "fast"]);
    expect(synonymsOf(null, "zzz")).toEqual([]);
  });

  it("keeps the replaced word's capitals", () => {
    expect(matchCase("quick", "fast")).toBe("fast");
    expect(matchCase("Quick", "fast")).toBe("Fast");
    expect(matchCase("QUICK", "fast")).toBe("FAST");
    expect(matchCase("I", "me")).toBe("Me");
  });
});
