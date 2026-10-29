import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { markdownExtensions } from "../Editor";
import { basicGrammar } from "./grammarRules";
import { segments, wordAt, words } from "./prose";
import { checkable, createSpeller, distance, isCorrect, suggestions } from "./spellCore";

function state(doc: string) {
  const s = EditorState.create({ doc, extensions: markdownExtensions() });
  ensureSyntaxTree(s, s.doc.length, 5000);
  return s;
}

const list = (doc: string) => words(state(doc), 0, doc.length).map((w) => w.word);

describe("prose words", () => {
  it("skips code, links, HTML and Markdown marks", () => {
    expect(list("# Teh title\n\nSome `codee` and [linkk text](https://exampel.com/pathh) <span class=\"x\">ok</span>")).toEqual([
      "Teh",
      "title",
      "Some",
      "and",
      "linkk",
      "text",
      "ok",
    ]);
    expect(list("```js\nconst wrnog = 1\n```\n\nafter")).toEqual(["after"]);
  });

  it("skips acronyms, numbers, handles, paths and file names", () => {
    expect(list("NASA 3rd iPhone @kevsmac #todo src/main notes.md kev@example.com don’t")).toEqual(["don’t"]);
  });

  it("finds the word under the cursor, but not in code", () => {
    const s = state("Hello wrold `code`");
    expect(wordAt(s, 8)).toEqual({ from: 6, to: 11, word: "wrold" });
    expect(wordAt(s, 14)).toBeNull();
  });

  it("splits a paragraph into prose and markup with no gaps", () => {
    const doc = "Run `npm i` **now**";
    const segs = segments(state(doc), 0, doc.length);
    expect(segs.map((s) => [doc.slice(s.from, s.to), s.markup, s.interpretAs])).toEqual([
      ["Run ", false, undefined],
      ["`npm i`", true, "code"],
      [" ", false, undefined],
      ["**", true, undefined],
      ["now", false, undefined],
      ["**", true, undefined],
    ]);
  });
});

describe("spelling", () => {
  const dir = (pkg: string) => dirname(createRequire(import.meta.url).resolve(pkg));
  const load = (pkg: string) => createSpeller(readFileSync(join(dir(pkg), "index.aff")), readFileSync(join(dir(pkg), "index.dic")));
  const gb = load("dictionary-en-gb");
  const us = load("dictionary-en");

  it("knows UK and US spellings apart", () => {
    expect(isCorrect(gb, "colour") && isCorrect(gb, "organise")).toBe(true);
    expect(isCorrect(gb, "color")).toBe(false);
    expect(isCorrect(us, "color") && !isCorrect(us, "colour")).toBe(true);
  });

  it("accepts curly apostrophes, possessives and sentence capitals", () => {
    expect(isCorrect(gb, "don’t")).toBe(true);
    expect(isCorrect(gb, "Kev's")).toBe(false);
    expect(isCorrect(gb, "London's")).toBe(true);
    expect(isCorrect(gb, "Colour")).toBe(true);
    expect(isCorrect(gb, "london")).toBe(false);
  });

  it("ranks the closest suggestion first, in the word's case", () => {
    expect(suggestions(gb, "teh")[0]).toBe("the");
    expect(suggestions(gb, "Teh")[0]).toBe("The");
    expect(suggestions(gb, "recieve")[0]).toBe("receive");
    expect(suggestions(gb, "notez")[0]).toBe("notes");
    expect(suggestions(us, "colour")).toContain("color");
  });

  it("knows makers' words", () => {
    for (const word of ["Wifi", "Wi", "Fi", "Pico", "Pico's", "Dupont", "microcontrollers", "Neopixels"]) {
      expect(isCorrect(gb, word) && isCorrect(us, word)).toBe(true);
    }
    expect(checkable("WiFi")).toBe(false);
    expect(suggestions(gb, "Picco")).toContain("Pico");
  });

  it("leaves some words alone", () => {
    expect(checkable("NASA")).toBe(false);
    expect(checkable("iPhone")).toBe(false);
    expect(checkable("x")).toBe(false);
    expect(checkable("Hello")).toBe(true);
  });

  it("measures swaps as one edit", () => {
    expect(distance("teh", "the")).toBe(1);
    expect(distance("kitten", "sitting")).toBe(3);
  });
});

describe("basic grammar", () => {
  const rules = (text: string) => basicGrammar(text).map((i) => [i.rule, text.slice(i.from, i.to), i.replacements[0]]);

  it("finds repeated words", () => {
    expect(rules("I saw the the cat.")).toEqual([["REPEATED_WORD", " the", ""]]);
    expect(rules("We had had enough.")).toEqual([]);
    expect(rules("end of one\n\none more")).toEqual([]);
  });

  it("picks a or an by sound", () => {
    expect(rules("a apple, an banana, a hour, an university, an FBI agent, a unicorn, an uninformed view")).toEqual([
      ["A_AN", "a", "an"],
      ["A_AN", "an", "a"],
      ["A_AN", "a", "an"],
      ["A_AN", "an", "a"],
    ]);
    expect(rules("Plan A is good. A apple.")).toEqual([["A_AN", "A", "An"]]);
  });

  it("capitalises a lone i", () => {
    expect(rules("so i think i'm right, i.e. fine")).toEqual([
      ["LOWERCASE_I", "i", "I"],
      ["LOWERCASE_I", "i", "I"],
    ]);
  });
});
