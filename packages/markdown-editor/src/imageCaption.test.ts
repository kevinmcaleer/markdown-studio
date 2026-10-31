import { describe, expect, it } from "vitest";
import { imageCaption } from "./imageCaption";
import { renderMarkdown } from "./markdown";

describe("image captions", () => {
  it("shows titles someone wrote, not ones made from file names", () => {
    expect(imageCaption("BDX Droids at Disney")).toBe("BDX Droids at Disney");
    expect(imageCaption(" Chassis ")).toBe("Chassis");
    for (const made of ["", "hero", "Image", "IMG_2041", "robot-arm", "chassis", "photo1", "duck.JPG", "my duck.png"]) expect(imageCaption(made)).toBeNull();
  });

  it("renders a picture on its own as a figure with its caption", () => {
    expect(renderMarkdown("![BDX Droids at Disney](/bdx.jpg)")).toBe(
      '<figure class="image-figure"><img src="/bdx.jpg" alt="BDX Droids at Disney"><figcaption>BDX Droids at Disney</figcaption></figure>\n',
    );
    expect(renderMarkdown("![A <b>duck</b>](/d.jpg){half}")).toBe(
      '<figure class="image-figure image-figure-half"><img src="/d.jpg" alt="A &lt;b&gt;duck&lt;/b&gt;" class="image-half"><figcaption>A &lt;b&gt;duck&lt;/b&gt;</figcaption></figure>\n',
    );
  });

  it("leaves pictures beside text, pairs, and file-name titles alone", () => {
    expect(renderMarkdown("![hero](/h.jpg)")).toBe('<p><img src="/h.jpg" alt="hero"></p>\n');
    expect(renderMarkdown("See ![A duck](/d.jpg) here")).toBe('<p>See <img src="/d.jpg" alt="A duck"> here</p>\n');
    expect(renderMarkdown("![A duck](/a.jpg){half} ![B duck](/b.jpg){half}")).toContain("<p>");
    expect(renderMarkdown("| ![A duck](/a.jpg) |\n| --- |\n| x |")).not.toContain("figcaption");
  });

  it("captions a picture in a callout", () => {
    expect(renderMarkdown("> ![A duck](/a.jpg)")).toContain("<figcaption>A duck</figcaption>");
  });
});
