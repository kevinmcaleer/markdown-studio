import { describe, expect, it } from "vitest";
import type { FileMeta } from "./filesApi";
import { firstPage, noteTitle, recentNotes } from "./NotesHome";

function file(id: number, name: string, updated_at: string, mime_type = "text/markdown"): FileMeta {
  return { id, owner_id: 1, folder_id: null, name, mime_type, size: 0, created_at: "2026-10-01T00:00:00Z", updated_at };
}

describe("recentNotes", () => {
  it("lists Markdown notes, newest change first, leaving out decks and other files", () => {
    const tree = {
      folders: [],
      files: [
        file(1, "old.md", "2026-10-01T09:00:00Z"),
        file(2, "Talk.deck.md", "2026-10-25T09:00:00Z"),
        file(3, "new.md", "2026-10-24T09:00:00Z"),
        file(4, "photo.png", "2026-10-25T09:00:00Z", "image/png"),
      ],
    };
    expect(recentNotes(tree).map((f) => f.id)).toEqual([3, 1]);
  });
});

describe("noteTitle", () => {
  it("drops the .md extension", () => {
    expect(noteTitle({ name: "first doc.md" })).toBe("first doc");
    expect(noteTitle({ name: "Plan.MARKDOWN" })).toBe("Plan");
    expect(noteTitle({ name: ".md" })).toBe(".md");
  });
});

describe("firstPage", () => {
  it("keeps only the start of a long note", () => {
    const long = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    expect(firstPage(long).split("\n")).toHaveLength(80);
    expect(firstPage("x".repeat(10000))).toHaveLength(4000);
  });
});
