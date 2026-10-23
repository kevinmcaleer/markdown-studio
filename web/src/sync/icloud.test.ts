import { describe, expect, it } from "vitest";
import { copyName } from "./icloud";

describe("copyName", () => {
  it("swaps the extension", () => {
    expect(copyName("Trip.md", "docx")).toBe("Trip.docx");
    expect(copyName("Trip.markdown", "pdf")).toBe("Trip.pdf");
    expect(copyName("Trip.md", "md")).toBe("Trip.md");
    expect(copyName("notes", "md")).toBe("notes.md");
  });
});
