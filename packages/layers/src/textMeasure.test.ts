import { cache } from "fabric";
import { describe, expect, it } from "vitest";
import { measureTextAtRealSize, sizedFamily } from "./textMeasure";

describe("measuring text at its real size", () => {
  it("keys the width cache by font size as well as family", () => {
    expect(sizedFamily({ fontFamily: "system-ui", fontSize: 28 })).toBe("system-ui@28");
    expect(sizedFamily({ fontFamily: "system-ui" })).toBe("system-ui");
    measureTextAtRealSize();
    measureTextAtRealSize();
    const style = { fontFamily: "system-ui", fontStyle: "normal", fontWeight: "700" };
    const small = cache.getFontCache({ ...style, fontSize: 28 } as typeof style);
    const big = cache.getFontCache({ ...style, fontSize: 400 } as typeof style);
    expect(small).not.toBe(big);
    expect(cache.getFontCache({ ...style, fontSize: 28 } as typeof style)).toBe(small);
  });

  it("clears every size of a family", () => {
    measureTextAtRealSize();
    const style = { fontFamily: "Serif", fontStyle: "normal", fontWeight: "400" };
    cache.getFontCache({ ...style, fontSize: 12 } as typeof style).set("a", 1);
    cache.getFontCache({ ...style, fontSize: 40 } as typeof style).set("a", 2);
    cache.clearFontCache("Serif");
    expect(cache.getFontCache({ ...style, fontSize: 12 } as typeof style).has("a")).toBe(false);
    expect(cache.getFontCache({ ...style, fontSize: 40 } as typeof style).has("a")).toBe(false);
  });
});
