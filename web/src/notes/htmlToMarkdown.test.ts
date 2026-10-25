// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "./htmlToMarkdown";

describe("htmlToMarkdown", () => {
  it("converts headings, emphasis and links", () => {
    const html = `<h2>Plan</h2><p>Some <strong>bold</strong>, <em>italic</em>, <s>gone</s> and <a href="https://example.com/a">a link</a>.</p>`;
    expect(htmlToMarkdown(html)).toBe("## Plan\n\nSome **bold**, *italic*, ~~gone~~ and [a link](https://example.com/a).");
  });

  it("keeps spaces outside emphasis markers", () => {
    expect(htmlToMarkdown("<p>a<b> bold </b>word</p>")).toBe("a **bold** word");
  });

  it("converts nested and ordered lists", () => {
    const html = "<ul><li>One<ul><li>Inner</li></ul></li><li>Two</li></ul><ol start=3><li>Three</li><li>Four</li></ol>";
    expect(htmlToMarkdown(html)).toBe("- One\n  - Inner\n- Two\n\n3. Three\n4. Four");
  });

  it("reads Google Docs styling, not its wrapper", () => {
    const html = `<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="ltr"><span style="font-weight:700;">Bold</span><span style="font-weight:400;"> and </span><span style="font-style:italic;">italic</span></p><ul><li dir="ltr"><p dir="ltr"><span>Item</span></p></li></ul></b>`;
    expect(htmlToMarkdown(html)).toBe("**Bold** and *italic*\n\n- Item");
  });

  it("turns Word's list paragraphs into lists", () => {
    const html = `<p class=MsoListParagraphCxSpFirst style='mso-list:l0 level1 lfo1'><span style='mso-list:Ignore'>·<span>&nbsp;&nbsp;</span></span>First</p>
<p class=MsoListParagraphCxSpLast style='mso-list:l0 level2 lfo1'><span style='mso-list:Ignore'>o<span>&nbsp;</span></span>Second</p>
<p class=MsoNormal>After</p>`;
    expect(htmlToMarkdown(html)).toBe("- First\n  - Second\n\nAfter");
  });

  it("converts tables, escaping pipes", () => {
    const html = "<table><tr><th>Name</th><th>Note</th></tr><tr><td>A</td><td>x | y</td></tr><tr><td colspan=2>wide</td></tr></table>";
    expect(htmlToMarkdown(html)).toBe("| Name | Note |\n| --- | --- |\n| A | x \\| y |\n| wide |  |");
  });

  it("treats a one-column layout table as its content", () => {
    expect(htmlToMarkdown("<table><tr><td><p>Hello</p></td></tr></table>")).toBe("Hello");
  });

  it("fences code with the language from its class", () => {
    const html = `<div class="highlight highlight-source-python"><pre><span>def f():</span>\n    <span>return 1</span></pre></div>`;
    expect(htmlToMarkdown(html)).toBe("```python\ndef f():\n    return 1\n```");
    expect(htmlToMarkdown('<pre><code class="language-ts">let a = 1;</code></pre>')).toBe("```ts\nlet a = 1;\n```");
  });

  it("fences VS Code's copied lines", () => {
    const html = `<div style="color: #d4d4d4;font-family: Menlo, Monaco, monospace;white-space: pre;"><div><span>const a = 1;</span></div><div><span>  return a;</span></div></div>`;
    expect(htmlToMarkdown(html)).toBe("```\nconst a = 1;\n  return a;\n```");
  });

  it("makes inline code and quotes", () => {
    expect(htmlToMarkdown("<blockquote><p>Run <code>npm test</code></p></blockquote>")).toBe("> Run `npm test`");
  });

  it("escapes text that would read as Markdown", () => {
    expect(htmlToMarkdown("<p># not a heading</p><p>2 * 3 and snake_case</p>")).toBe("\\# not a heading\n\n2 \\* 3 and snake_case");
  });

  it("keeps web images and drops local ones", () => {
    expect(htmlToMarkdown('<p><img src="https://x.test/a.png" alt="A"> <img src="file:///C:/b.png" alt="B"></p>')).toBe("![A](https://x.test/a.png) B");
  });

  it("drops links that aren't web links", () => {
    expect(htmlToMarkdown('<p><a href="javascript:alert(1)">click</a></p>')).toBe("click");
  });

  it("makes task items from checkboxes", () => {
    expect(htmlToMarkdown('<ul><li><input type="checkbox" checked> Done</li><li><input type="checkbox"> Todo</li></ul>')).toBe("- [x] Done\n- [ ] Todo");
  });
});
