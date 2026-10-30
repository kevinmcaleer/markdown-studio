import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { calloutKinds, parseCalloutHeader } from "./callouts";
import { renderMarkdown } from "./markdown";

describe("parseCalloutHeader", () => {
  it("reads the type, fold and title", () => {
    expect(parseCalloutHeader("[!warning]- Mind the mains")).toEqual({
      type: "warning",
      name: "warning",
      fold: "-",
      title: "Mind the mains",
      titled: true,
    });
  });

  it("titles an untitled callout after its type, and maps aliases", () => {
    expect(parseCalloutHeader("[!TIP]")).toMatchObject({ type: "tip", title: "Tip", titled: false, fold: "" });
    expect(parseCalloutHeader("[!faq]+")).toMatchObject({ type: "question", name: "faq", title: "Question", fold: "+" });
  });

  it("styles an unknown type as a note, titled with its name", () => {
    expect(parseCalloutHeader("[!wiring-tip]")).toMatchObject({ type: "note", name: "wiring-tip", title: "Wiring tip" });
  });

  it("ignores anything else", () => {
    expect(parseCalloutHeader("just a quote")).toBeNull();
    expect(parseCalloutHeader("[note]")).toBeNull();
    expect(parseCalloutHeader("text [!note]")).toBeNull();
  });
});

describe("callouts in the preview", () => {
  it("renders a titled callout with its body", () => {
    const html = renderMarkdown("> [!info] Before you start\n> Charge the **battery**.");
    expect(html).toBe(
      '<div class="callout callout-info" data-callout="info">\n' +
        '<div class="callout-title"><span class="callout-icon" aria-hidden="true"></span><span class="callout-title-text">Before you start</span></div>\n' +
        '<div class="callout-content">\n<p>Charge the <strong>battery</strong>.</p>\n</div>\n</div>\n',
    );
  });

  it("renders the title's inline Markdown and a default title", () => {
    expect(renderMarkdown("> [!note] Use `pip`")).toContain('<span class="callout-title-text">Use <code>pip</code></span>');
    expect(renderMarkdown("> [!danger]\n> Hot.")).toContain('<span class="callout-title-text">Danger</span>');
  });

  it("folds with + and - as <details>", () => {
    const closed = renderMarkdown("> [!example]- Code\n> ```py\n> print(1)\n> ```");
    expect(closed).toMatch(/^<details class="callout callout-example" data-callout="example" data-callout-fold="-">\n<summary class="callout-title">/);
    expect(closed).toContain("</summary>\n<div class=\"callout-content\">\n<pre");
    expect(closed.trim().endsWith("</div>\n</details>")).toBe(true);
    expect(renderMarkdown("> [!tip]+ Open\n> body")).toContain('data-callout-fold="+" open="">');
  });

  it("keeps later blocks inside, and nests", () => {
    const html = renderMarkdown("> [!warning]\n> one\n>\n> - two\n>\n> > [!bug] inner\n\nafter");
    expect(html).toContain("<ul>\n<li>two</li>\n</ul>");
    expect(html).toContain('<div class="callout callout-bug" data-callout="bug">');
    expect(html.match(/<\/div>\n<\/div>\n<\/div>\n<\/div>\n<p>after<\/p>/)).not.toBeNull();
  });

  it("escapes the title and leaves plain quotes alone", () => {
    const html = renderMarkdown("> [!note] <img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img");
    expect(renderMarkdown("> just a quote")).toBe("<blockquote>\n<p>just a quote</p>\n</blockquote>\n");
  });
});

describe("callouts.css", () => {
  it("has each type's colour and icon", () => {
    const css = readFileSync(new URL("./callouts.css", import.meta.url), "utf8");
    for (const kind of calloutKinds) {
      const rule = new RegExp(`\\.callout-${kind.type} \\{\\n  --callout-color: ${kind.color};\\n  --callout-icon: url\\("[^"]*d='([^']*)'`).exec(css);
      expect(rule?.[1], kind.type).toBe(kind.icon);
    }
  });
});

describe("tables in callouts", () => {
  it("renders an image-grid table with cell headings inside the callout", () => {
    const html = renderMarkdown("> [!info] Ducks\n> Two robots\n>\n> | ## A | ## B |\n> | --- | --- |\n> | ![a](/a.jpg) | ![b](/b.jpg) |\n");
    const content = html.slice(html.indexOf('class="callout-content"'));
    expect(content).toContain('<table class="image-grid">');
    expect(content).toContain('<h2 class="cell-heading">A</h2>');
    expect(html).not.toContain("&gt;");
  });
});
