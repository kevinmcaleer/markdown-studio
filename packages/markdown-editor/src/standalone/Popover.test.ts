import { describe, expect, it } from "vitest";
import { placePopover } from "./Popover";

// A 1000 × 800 window; the popover is 400 wide.
const place = (top: number, bottom: number, height: number) => placePopover({ left: 100, top, bottom }, 400, height, 1000, 800);

describe("placePopover", () => {
  it("opens below the button when it fits", () => {
    expect(place(100, 130, 300)).toEqual({ left: 100, top: 136, maxHeight: 656 });
  });

  it("flips above the button when it doesn't fit below", () => {
    expect(place(600, 630, 400)).toEqual({ left: 100, top: 194, maxHeight: 586 });
  });

  it("caps its height to the roomier side when it fits on neither, so its bottom stays on screen", () => {
    // The image picker under "Add a picture" low on the page (the bug).
    const at = place(620, 650, 900);
    expect(at.top).toBe(8);
    expect(at.top + at.maxHeight).toBe(614);
    const below = place(150, 180, 900);
    expect(below.top).toBe(186);
    expect(below.top + below.maxHeight).toBe(792);
  });

  it("never runs past the window's bottom edge", () => {
    for (const anchorTop of [0, 200, 400, 700, 780]) {
      for (const height of [50, 300, 700, 1200]) {
        const at = place(anchorTop, anchorTop + 30, height);
        expect(at.top).toBeGreaterThanOrEqual(8);
        expect(at.top + Math.min(height, at.maxHeight)).toBeLessThanOrEqual(792);
      }
    }
  });

  it("keeps it inside the window's right edge", () => {
    expect(placePopover({ left: 800, top: 100, bottom: 130 }, 400, 200, 1000, 800).left).toBe(592);
  });
});
