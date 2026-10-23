import { describe, expect, it } from "vitest";
import { parser } from "@lezer/markdown";
import { Highlight } from "./highlightSyntax";

const withHighlight = parser.configure([Highlight]);

function nodes(source: string): string[] {
  const names: string[] = [];
  withHighlight.parse(source).iterate({ enter: (n) => void names.push(n.name) });
  return names;
}

describe("Highlight syntax", () => {
  it("parses ==text== as a highlight", () => {
    expect(nodes("a ==b== c")).toEqual(expect.arrayContaining(["Highlight", "HighlightMark"]));
  });

  it("ignores lone or tripled equals signs", () => {
    expect(nodes("a == b")).not.toContain("Highlight");
    expect(nodes("===")).not.toContain("Highlight");
  });
});
