import { describe, expect, it } from "vitest";
import { nameFromTitle, splitName } from "./NoteTitle";

describe("splitName", () => {
  it("splits off the last extension", () => {
    expect(splitName("Ideas.md")).toEqual(["Ideas", ".md"]);
    expect(splitName("v1.2 notes.md")).toEqual(["v1.2 notes", ".md"]);
  });

  it("leaves names without an extension whole", () => {
    expect(splitName("README")).toEqual(["README", ""]);
    expect(splitName(".env")).toEqual([".env", ""]);
  });
});

describe("nameFromTitle", () => {
  it("keeps the file's extension", () => {
    expect(nameFromTitle("Plans", "Ideas.md")).toBe("Plans.md");
    expect(nameFromTitle("Plans", "todo.txt")).toBe("Plans.txt");
  });

  it("doesn't double an extension typed into the title", () => {
    expect(nameFromTitle("Plans.md", "Ideas.md")).toBe("Plans.md");
    expect(nameFromTitle("Plans.MD", "Ideas.md")).toBe("Plans.md");
  });

  it("tidies spaces", () => {
    expect(nameFromTitle("  My   plans ", "Ideas.md")).toBe("My plans.md");
  });

  it("returns null when nothing changes or the title is empty", () => {
    expect(nameFromTitle("Ideas", "Ideas.md")).toBeNull();
    expect(nameFromTitle("   ", "Ideas.md")).toBeNull();
    expect(nameFromTitle(".md", "Ideas.md")).toBeNull();
  });
});
