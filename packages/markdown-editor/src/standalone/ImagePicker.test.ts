import { describe, expect, it } from "vitest";
import { isImageUsed } from "./ImagePicker";

describe("isImageUsed", () => {
  const image = { url: "https://example.com/images/2/view", alt: "Chassis" };

  it("finds an image whose URL is in the text", () => {
    expect(isImageUsed(image, "# Build\n\n![Chassis](https://example.com/images/2/view)\n")).toBe(true);
  });

  it("is false when the text doesn't use it", () => {
    expect(isImageUsed(image, "![Wheels](https://example.com/images/3/view)")).toBe(false);
  });

  it("lets the host's used flag win", () => {
    expect(isImageUsed({ ...image, used: false }, image.url)).toBe(false);
    expect(isImageUsed({ ...image, used: true }, "")).toBe(true);
  });
});
