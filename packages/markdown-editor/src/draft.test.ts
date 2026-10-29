// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearDraft, DraftKeeper, readDraft, recoverableDraft, writeDraft } from "./draft";

beforeEach(() => localStorage.clear());
afterEach(() => vi.useRealTimers());

describe("drafts", () => {
  it("round-trips through localStorage", () => {
    expect(writeDraft("a", "hello", 5)).toBe(true);
    expect(readDraft("a")).toEqual({ text: "hello", savedAt: 5 });
    clearDraft("a");
    expect(readDraft("a")).toBeNull();
  });

  it("only offers a draft that differs from the document", () => {
    writeDraft("a", "same");
    expect(recoverableDraft("a", "same")).toBeNull();
    // ...and forgets the one that matched.
    expect(readDraft("a")).toBeNull();
    writeDraft("a", "edited");
    expect(recoverableDraft("a", "original")?.text).toBe("edited");
  });

  it("ignores junk in storage", () => {
    localStorage.setItem("markdown-editor.draft.a", "{not json");
    expect(readDraft("a")).toBeNull();
  });
});

describe("DraftKeeper", () => {
  it("writes once typing pauses", () => {
    vi.useFakeTimers();
    const states: string[] = [];
    const keeper = new DraftKeeper({ key: "k", delayMs: 500 }, (s) => states.push(s.status));
    keeper.changed("one");
    keeper.changed("one two");
    expect(readDraft("k")).toBeNull();
    vi.advanceTimersByTime(500);
    expect(readDraft("k")?.text).toBe("one two");
    expect(states).toEqual(["pending", "saved"]);
  });

  it("holds off while paused, and clear() forgets the draft", () => {
    vi.useFakeTimers();
    const keeper = new DraftKeeper({ key: "k" });
    keeper.paused = true;
    keeper.changed("typed over");
    vi.advanceTimersByTime(5000);
    expect(readDraft("k")).toBeNull();
    keeper.paused = false;
    keeper.changed("now");
    keeper.flush();
    expect(readDraft("k")?.text).toBe("now");
    keeper.clear();
    expect(readDraft("k")).toBeNull();
    expect(keeper.current.status).toBe("clean");
  });
});
