import { describe, expect, it } from "vitest";
import { applyChanges, downTarget, headingKeys, moveSection, parseOutline, sectionAt, shiftLevel, upTarget } from "./outline";

const doc = ["Intro words here", "# One", "one text", "## One A", "a b c", "# Two", "two", "```", "# not a heading", "```", "## Two A", "last"].join("\n");

describe("parseOutline", () => {
  it("finds top-level headings, not ones in code", () => {
    const h = parseOutline(doc);
    expect(h.map((x) => [x.level, x.text])).toEqual([
      [1, "One"],
      [2, "One A"],
      [1, "Two"],
      [2, "Two A"],
    ]);
  });

  it("gives each section its range and word count", () => {
    const h = parseOutline(doc);
    expect(doc.slice(h[0].from, h[0].to)).toBe("# One\none text\n## One A\na b c\n");
    expect(h[0].words).toBe(5);
    expect(h[1].words).toBe(3);
    expect(doc.slice(h[2].from, h[2].to)).toBe("# Two\ntwo\n```\n# not a heading\n```\n## Two A\nlast");
  });

  it("reads setext headings and inline markup", () => {
    const h = parseOutline("Title *here*\n===\n\ntext\n\n## `code` and [link](x)\n");
    expect(h.map((x) => [x.level, x.text])).toEqual([
      [1, "Title here"],
      [2, "code and link"],
    ]);
    expect(h[0].lineEnd).toBe("Title *here*\n===".length);
  });

  it("finds the section at a position", () => {
    const h = parseOutline(doc);
    expect(sectionAt(h, 0)).toBe(-1);
    expect(sectionAt(h, doc.indexOf("a b c"))).toBe(1);
    expect(sectionAt(h, doc.length)).toBe(3);
  });
});

describe("moveSection", () => {
  it("moves a section with its under-sections", () => {
    const h = parseOutline(doc);
    const out = applyChanges(doc, moveSection(doc, h, 2, h[0].from)!);
    expect(out).toBe(["Intro words here", "# Two", "two", "```", "# not a heading", "```", "## Two A", "last", "# One", "one text", "## One A", "a b c", ""].join("\n"));
  });

  it("moves a section to the end of a note with no closing line break", () => {
    const h = parseOutline(doc);
    const out = applyChanges(doc, moveSection(doc, h, 0, doc.length)!);
    expect(out).toBe(["Intro words here", "# Two", "two", "```", "# not a heading", "```", "## Two A", "last", "# One", "one text", "## One A", "a b c"].join("\n"));
  });

  it("won't move a section into itself", () => {
    const h = parseOutline(doc);
    expect(moveSection(doc, h, 0, h[1].from)).toBeNull();
    expect(moveSection(doc, h, 0, h[0].from)).toBeNull();
  });

  it("has up and down targets among siblings", () => {
    const h = parseOutline(doc);
    expect(upTarget(h, 0)).toBeNull();
    expect(upTarget(h, 2)).toBe(h[0].from);
    expect(downTarget(h, 0)).toBe(doc.length);
    expect(downTarget(h, 2)).toBeNull();
    expect(downTarget(h, 1)).toBeNull();
    expect(upTarget(h, 3)).toBeNull();
  });
});

describe("shiftLevel", () => {
  it("demotes a section and its under-sections", () => {
    const h = parseOutline(doc);
    const out = applyChanges(doc, shiftLevel(doc, h, 0, 1)!);
    expect(parseOutline(out).map((x) => x.level)).toEqual([2, 3, 1, 2]);
  });

  it("won't promote past #", () => {
    const h = parseOutline(doc);
    expect(shiftLevel(doc, h, 0, -1)).toBeNull();
    const out = applyChanges(doc, shiftLevel(doc, h, 3, -1)!);
    expect(out).toContain("\n# Two A\n");
  });

  it("turns a setext heading into an ATX one", () => {
    const text = "Title\n---\nbody\n";
    expect(applyChanges(text, shiftLevel(text, parseOutline(text), 0, 1)!)).toBe("### Title\nbody\n");
  });
});

it("names repeated headings apart", () => {
  expect(headingKeys(parseOutline("# A\n# A\n## A\n"))).toEqual(["1:A", "1:A#1", "2:A"]);
});
