import { describe, expect, it } from "vitest";
import { alignBoxes, distributeBoxes, type Box } from "./align";

const a: Box = { left: 0, top: 0, width: 10, height: 10 };
const b: Box = { left: 30, top: 20, width: 20, height: 40 };

describe("alignBoxes", () => {
  it("lines up left, centre and right edges", () => {
    expect(alignBoxes([a, b], "left")).toEqual([{ dx: 0, dy: 0 }, { dx: -30, dy: 0 }]);
    expect(alignBoxes([a, b], "right")).toEqual([{ dx: 40, dy: 0 }, { dx: 0, dy: 0 }]);
    expect(alignBoxes([a, b], "center")).toEqual([{ dx: 20, dy: 0 }, { dx: -15, dy: 0 }]);
  });
  it("lines up top, middle and bottom edges", () => {
    expect(alignBoxes([a, b], "top")).toEqual([{ dx: 0, dy: 0 }, { dx: 0, dy: -20 }]);
    expect(alignBoxes([a, b], "bottom")).toEqual([{ dx: 0, dy: 50 }, { dx: 0, dy: 0 }]);
    expect(alignBoxes([a, b], "middle")).toEqual([{ dx: 0, dy: 25 }, { dx: 0, dy: -10 }]);
  });
});

describe("distributeBoxes", () => {
  it("makes the gaps equal, keeping the end boxes still", () => {
    const boxes: Box[] = [
      { left: 100, top: 0, width: 10, height: 10 },
      { left: 0, top: 0, width: 20, height: 10 },
      { left: 30, top: 0, width: 10, height: 10 },
    ];
    // Span 0..110, sizes 40, so gaps of 35: 0-20, 55-65, 100-110.
    expect(distributeBoxes(boxes, "horizontal")).toEqual([{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }, { dx: 25, dy: 0 }]);
  });
  it("works up and down too", () => {
    const boxes: Box[] = [
      { left: 0, top: 0, width: 10, height: 10 },
      { left: 0, top: 15, width: 10, height: 10 },
      { left: 0, top: 90, width: 10, height: 10 },
    ];
    expect(distributeBoxes(boxes, "vertical")).toEqual([{ dx: 0, dy: 0 }, { dx: 0, dy: 30 }, { dx: 0, dy: 0 }]);
  });
  it("leaves two boxes alone", () => {
    expect(distributeBoxes([a, b], "horizontal")).toEqual([{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }]);
  });
});
