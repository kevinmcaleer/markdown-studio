import { describe, expect, it } from "vitest";
import { filterTargets, findLinkTargets, headingSlug, targetFor, targetQuery } from "./linkTargets";

describe("headingSlug", () => {
  it("makes ids the way kevsrobots' project pages do", () => {
    expect(headingSlug("Bill of Materials")).toBe("bill-of-materials");
    expect(headingSlug("Step 2: Wire the Pico!")).toBe("step-2-wire-the-pico");
    expect(headingSlug("  -- Odd -- spacing --  ")).toBe("odd-spacing");
  });
});

describe("findLinkTargets", () => {
  const doc = [
    "# Overview",
    "Text with `code`.",
    "## The **wiring**",
    "```",
    "# not a heading",
    "```",
    "> ## quoted",
    "# Overview",
    "<!-- page -->",
    "",
    "# Assembly",
    "::: cards",
    "## Card title",
    ":::",
  ].join("\n");

  it("lists top-level headings in order, with plain text and numbered repeats", () => {
    const found = findLinkTargets(doc);
    expect(found.map((t) => [t.id, t.text, t.level])).toEqual([
      ["overview", "Overview", 1],
      ["the-wiring", "The wiring", 2],
      ["overview-2", "Overview", 1],
      ["assembly", "Assembly", 1],
    ]);
    expect(found[0].from).toBe(0);
  });

  it("puts each page before its headings when pages are on", () => {
    const found = findLinkTargets(doc, true);
    expect(found.map((t) => t.id)).toEqual(["page-1", "overview", "the-wiring", "overview-2", "page-2", "assembly"]);
    expect(found[4]).toMatchObject({ kind: "page", text: "Page 2", title: "Assembly", page: 2, from: doc.indexOf("<!--") });
    expect(found[5].page).toBe(2);
  });

  it("has no pages without page breaks", () => {
    expect(findLinkTargets("# One\n## Two", true).map((t) => t.kind)).toEqual(["heading", "heading"]);
  });
});

describe("targetQuery", () => {
  it("shows everything for an empty field or a bare #", () => {
    expect(targetQuery("")).toBe("");
    expect(targetQuery("#")).toBe("");
  });
  it("searches the words after # or plain words", () => {
    expect(targetQuery("#wir")).toBe("wir");
    expect(targetQuery("bill of")).toBe("bill of");
  });
  it("stays out of the way of URLs and paths", () => {
    for (const url of ["https://x.org", "/projects", "./notes.md", "www.kevsrobots", "kevsrobots.com", "me@x.org", "mailto:a"]) expect(targetQuery(url)).toBeNull();
  });
});

describe("filterTargets", () => {
  const targets = findLinkTargets("# Bill of Materials\n# Wiring the board\n# Code\n## Board bring-up");
  it("matches word starts, best match first", () => {
    expect(filterTargets(targets, "board").map((t) => t.text)).toEqual(["Board bring-up", "Wiring the board"]);
    expect(filterTargets(targets, "bill mat").map((t) => t.text)).toEqual(["Bill of Materials"]);
    expect(filterTargets(targets, "xyz")).toEqual([]);
    expect(filterTargets(targets, "")).toHaveLength(4);
  });
});

describe("targetFor", () => {
  const targets = findLinkTargets("# Parts\n<!-- page -->\n# Café", true);
  it("finds the heading or page a #link goes to", () => {
    expect(targetFor(targets, "#parts")?.text).toBe("Parts");
    expect(targetFor(targets, "#page-2")?.kind).toBe("page");
    expect(targetFor(targets, "#nope")).toBeNull();
    expect(targetFor(targets, "https://x.org#parts")).toBeNull();
  });
});
