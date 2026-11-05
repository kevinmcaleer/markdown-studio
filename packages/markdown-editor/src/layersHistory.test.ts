// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { historyButton } from "./layersHistory";

describe("historyButton", () => {
  it("lists a graphic's earlier versions, each opening full size", () => {
    const wrap = document.createElement("span");
    document.body.append(wrap);
    const b = historyButton(wrap, [
      { url: "/images/3/view#layers", label: "Version 2 · live", detail: "Published 3 Nov 2026" },
      { url: "/images/1/view#layers", label: "Version 1" },
    ]);
    wrap.append(b);
    expect(b.textContent).toBe("History");
    expect(b.title).toBe("2 earlier versions of this graphic");
    b.click();
    const items = wrap.querySelectorAll(".cm-md-image-history-item");
    expect(items.length).toBe(2);
    expect(items[0].querySelector("a")!.getAttribute("href")).toBe("/images/3/view");
    expect(items[0].textContent).toContain("Published 3 Nov 2026");
    b.click();
    expect(wrap.querySelector(".cm-md-image-history")).toBeNull();
    wrap.remove();
  });
});
