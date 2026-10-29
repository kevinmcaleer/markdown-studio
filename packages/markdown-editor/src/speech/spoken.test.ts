import { describe, expect, it } from "vitest";
import { isUndoCommand, segmentsToRead, speakable, speechSegments, spokenToText } from "./spoken";

describe("dictation", () => {
  const say = (transcript: string, before = "") => spokenToText(transcript, { before });

  it("turns spoken punctuation into marks", () => {
    expect(say("hello there comma how are you question mark")).toBe("Hello there, how are you?");
    expect(say("it works full stop", "Testing.")).toBe(" It works.");
  });

  it("spaces and capitalises from what's before the cursor", () => {
    expect(say("and more", "Some words")).toBe(" and more");
    expect(say("next one", "Done. ")).toBe("Next one");
    expect(say("full stop", "The end")).toBe(".");
  });

  it("breaks lines and paragraphs", () => {
    expect(say("first new line second new paragraph third")).toBe("First\nSecond\n\nThird");
  });

  it("starts headings, bullets and numbered lists", () => {
    expect(say("heading two plans")).toBe("## Plans");
    expect(say("bullet milk new line bullet eggs")).toBe("- Milk\n- Eggs");
    expect(say("numbered list first step", "Intro")).toBe("\n1. First step");
  });

  it("leaves block words alone mid-sentence", () => {
    expect(say("dodge the bullet", "")).toBe("Dodge the bullet");
  });

  it("knows undo that", () => {
    expect(isUndoCommand("undo that")).toBe(true);
    expect(isUndoCommand("Undo that.")).toBe(true);
    expect(isUndoCommand("please undo that later")).toBe(false);
  });
});

describe("read-aloud", () => {
  const texts = (doc: string) => speechSegments(doc).map((s) => s.text);

  it("splits prose into sentences, mapped back to the Markdown", () => {
    const doc = "One thing. Another, e.g. this! Last";
    const segs = speechSegments(doc);
    expect(segs.map((s) => s.text)).toEqual(["One thing.", "Another, e.g. this!", "Last"]);
    expect(doc.slice(segs[1].from, segs[1].to)).toBe("Another, e.g. this!");
  });

  it("reads the rendered words, not the syntax", () => {
    expect(speakable("**Bold** and ==marked== [a link](https://x.io/a.b) with `code` and snake_case")).toBe(
      "Bold and marked a link with code and snake_case",
    );
    expect(speakable("![A cat](cat.png)")).toBe("image: A cat.");
    expect(speakable("- [x] Done thing")).toBe("Done thing");
  });

  it("says code block, and reads tables cell by cell", () => {
    const doc = "# Title\n\n```js\nconst a = 1.5; b. c\n```\n\n| Name | Age |\n|---|---|\n| Ann | 3 |\n\n<!-- hidden. -->Tail.";
    expect(texts(doc)).toEqual(["Title", "Code block.", "Name, Age", "Ann, 3", "Tail."]);
  });

  it("keeps list items apart", () => {
    expect(texts("- one\n- two\n  more")).toEqual(["one", "two more"]);
  });

  it("starts at the cursor's sentence, or reads just the selection", () => {
    const doc = "A. B. C.";
    const all = speechSegments(doc);
    expect(segmentsToRead(all, 3).map((s) => s.text)).toEqual(["B.", "C."]);
    expect(segmentsToRead(all, 0, 4).map((s) => s.text)).toEqual(["A.", "B."]);
    expect(segmentsToRead(all, doc.length + 5)).toEqual([]);
  });
});
