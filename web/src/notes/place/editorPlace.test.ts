import { markdown } from "@codemirror/lang-markdown";
import { foldedRanges } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { bookmarkField, editorPlace, foldedLineStarts, foldsAt, nextBookmark, setBookmarks, toggledBookmarks } from "./editorPlace";

const handlers = { current: { onChange: () => {} } };

function state(doc: string, cursor = 0) {
  return EditorState.create({ doc, selection: { anchor: cursor }, extensions: [markdown(), editorPlace(handlers, true)] });
}

describe("bookmarks", () => {
  it("toggle on the cursor's line", () => {
    let s = state("one\ntwo\nthree", 6);
    s = s.update({ effects: setBookmarks.of(toggledBookmarks(s)) }).state;
    expect(s.field(bookmarkField).map((m) => m.pos)).toEqual([4]);
    s = s.update({ effects: setBookmarks.of(toggledBookmarks(s)) }).state;
    expect(s.field(bookmarkField)).toEqual([]);
  });

  it("follow their line through edits above and Enter at its start", () => {
    let s = state("one\ntwo\nthree", 5);
    s = s.update({ effects: setBookmarks.of(toggledBookmarks(s)) }).state;
    s = s.update({ changes: { from: 0, insert: "zero\n" } }).state;
    expect(s.doc.lineAt(s.field(bookmarkField)[0].pos).text).toBe("two");
    const start = s.field(bookmarkField)[0].pos;
    s = s.update({ changes: { from: start, insert: "\n" } }).state;
    expect(s.doc.lineAt(s.field(bookmarkField)[0].pos).text).toBe("two");
  });

  it("move to the next and previous one, wrapping round", () => {
    const marks = [0, 8].map((pos, i) => ({ id: String(i), pos, note: "", created_at: "" }));
    let s = state("one\ntwo\nthree\nfour", 5);
    s = s.update({ effects: setBookmarks.of(marks) }).state;
    expect(nextBookmark(s, 1)?.pos).toBe(8);
    expect(nextBookmark(s, -1)?.pos).toBe(0);
    s = s.update({ selection: { anchor: 15 } }).state;
    expect(nextBookmark(s, 1)?.pos).toBe(0);
  });
});

describe("folds", () => {
  it("fold a heading's section and report where it starts", () => {
    const doc = "# One\ntext\n\n## Two\nmore\n\n# Three\nend";
    let s = state(doc);
    const two = doc.indexOf("## Two");
    s = s.update({ effects: foldsAt(s, [two]) }).state;
    expect(foldedLineStarts(s)).toEqual([two]);
    let range: { from: number; to: number } | null = null;
    foldedRanges(s).between(0, s.doc.length, (from, to) => {
      range = { from, to };
    });
    expect(s.sliceDoc(range!.from, range!.to)).toBe("\nmore");
  });

  it("skip lines that can no longer be folded", () => {
    const s = state("just one line");
    expect(foldsAt(s, [0])).toEqual([]);
  });
});
