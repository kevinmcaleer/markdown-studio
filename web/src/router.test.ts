import { describe, expect, it } from "vitest";
import { safeNext } from "./router";

describe("safeNext", () => {
  it("keeps local paths", () => {
    expect(safeNext("/notes/42?x=1")).toBe("/notes/42?x=1");
  });

  it.each([null, "", "https://evil.example", "//evil.example", "/\\evil.example", "notes", "/login"])(
    "falls back for %s",
    (value) => {
      expect(safeNext(value)).toBe("/");
    },
  );
});
