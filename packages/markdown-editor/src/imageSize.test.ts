import { describe, expect, it } from "vitest";
import { imageSizeMarkdown, parseImageSize } from "./imageSize";
import { renderMarkdown } from "./markdown";

describe("image sizes", () => {
  it("reads the modifier after an image", () => {
    expect(parseImageSize("{small} and more")).toEqual({ size: "small", length: 7 });
    expect(parseImageSize("{cover}")).toEqual({ size: "cover", length: 7 });
    expect(parseImageSize(" {small}")).toBeNull();
    expect(parseImageSize("{tiny}")).toBeNull();
  });

  it("writes no modifier for full, the default", () => {
    expect(imageSizeMarkdown("full")).toBe("");
    expect(imageSizeMarkdown(null)).toBe("");
    expect(imageSizeMarkdown("half")).toBe("{half}");
  });

  it("renders the size as a class and drops the modifier", () => {
    expect(renderMarkdown("![Chassis](/c.jpg){small}")).toBe('<p><img src="/c.jpg" alt="Chassis" class="image-small"></p>\n');
    expect(renderMarkdown("![A](/a.jpg){half} ![B](/b.jpg){half}")).toBe(
      '<p><img src="/a.jpg" alt="A" class="image-half"> <img src="/b.jpg" alt="B" class="image-half"></p>\n',
    );
    expect(renderMarkdown("![Top](/t.jpg){cover} Caption")).toBe('<p><img src="/t.jpg" alt="Top" class="image-cover"> Caption</p>\n');
  });

  it("leaves other braces, and braces after text, alone", () => {
    expect(renderMarkdown("![A](/a.jpg){tiny}")).toBe('<p><img src="/a.jpg" alt="A">{tiny}</p>\n');
    expect(renderMarkdown("word{small}")).toBe("<p>word{small}</p>\n");
  });
});
