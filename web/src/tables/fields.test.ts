import { describe, expect, it } from "vitest";
import { copyText, formatDate, formatValue, opsFor } from "./fields";

describe("showing values", () => {
  it("writes numbers and money in the locale", () => {
    expect(formatValue(1234.5, { type: "number", options: {} }, undefined, "en-GB")).toBe("1,234.5");
    expect(formatValue(1234.5, { type: "number", options: { decimals: 0 } }, undefined, "en-GB")).toBe("1,235");
    expect(formatValue(-3, { type: "currency", options: { symbol: "$", decimals: 2 } }, undefined, "en-US")).toBe("-$3.00");
    expect(formatValue(1234.5, { type: "number", options: {} }, undefined, "de-DE")).toBe("1.234,5");
  });

  it("writes dates the locale's way without moving them", () => {
    expect(formatDate("2026-12-31", false, "en-GB")).toBe("31/12/2026");
    expect(formatDate("2026-12-31", false, "en-US")).toBe("12/31/2026");
    expect(formatValue("2026-01-02T09:05", { type: "datetime", options: {} }, undefined, "en-GB")).toBe("02/01/2026, 09:05");
  });

  it("shows links by name and yes/no as words", () => {
    expect(formatValue(7, { type: "link", options: {} }, "Red")).toBe("Red");
    expect(formatValue(true, { type: "checkbox", options: {} })).toBe("Yes");
    expect(formatValue(null, { type: "text", options: {} })).toBe("");
  });

  it("copies values in a form that pastes back", () => {
    expect(copyText("2026-01-02T09:05", { type: "datetime", options: {} })).toBe("2026-01-02 09:05");
    expect(copyText(false, { type: "checkbox", options: {} })).toBe("No");
    expect(copyText(3, { type: "link", options: {} }, "Blue")).toBe("Blue");
  });

  it("offers criteria that fit the type", () => {
    expect(opsFor("number")).toContain(">");
    expect(opsFor("text")).toContain("contains");
    expect(opsFor("checkbox")).toEqual(["notEmpty", "empty"]);
  });
});
