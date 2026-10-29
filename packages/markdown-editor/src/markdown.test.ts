import { describe, expect, it } from "vitest";
import { renderMarkdown, titleOf } from "./markdown";

describe("renderMarkdown", () => {
  it("renders ==highlights== as <mark>", () => {
    expect(renderMarkdown("some ==test== text")).toContain("<mark>test</mark>");
  });

  it("renders GFM tables", () => {
    const html = renderMarkdown("| a | b |\n| --- | :-: |\n| 1 | 2 |");
    expect(html).toContain("<table>");
    expect(html).toContain('<td style="text-align:center">2</td>');
  });

  it("highlights fenced code by language", () => {
    const html = renderMarkdown("```python\ndef f():\n    return 1\n```");
    expect(html).toContain('class="language-python"');
    expect(html).toContain('<span class="hljs-keyword">def</span>');
  });

  it("escapes code in unknown languages", () => {
    expect(renderMarkdown("```nope\n<b>\n```")).toContain("&lt;b&gt;");
  });

  it("renders task lists and footnotes", () => {
    const html = renderMarkdown("- [x] done\n- [ ] todo\n\nText[^1]\n\n[^1]: The note.");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("checked");
    expect(html).toContain('class="footnotes"');
  });

  it("never runs raw HTML or javascript: links", () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n[x](javascript:alert(1)) <img src=x onerror="alert(1)">');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('href="javascript:');
  });

  it("opens links in a new tab", () => {
    expect(renderMarkdown("[site](https://example.com)")).toContain('target="_blank" rel="noopener noreferrer"');
  });
});

describe("titleOf", () => {
  it("uses the first heading, or the first line", () => {
    expect(titleOf("intro\n\n## Plans ##\n")).toBe("Plans");
    expect(titleOf("\n  just text\nmore")).toBe("just text");
  });
});
