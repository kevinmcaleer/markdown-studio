import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { applyCommand, filterCommands } from "../notes/slashMenu";
import { parseDeck } from "./deck";
import { deckCommands } from "./slashCommands";

function run(id: string, doc: string) {
  const head = doc.indexOf("|");
  const text = doc.slice(0, head) + doc.slice(head + 1);
  const state = EditorState.create({ doc: text });
  const command = deckCommands.find((c) => c.id === id)!;
  const next = state.update(applyCommand(state, command, text.lastIndexOf("/", head), head)).state;
  return { doc: next.doc.toString(), selected: next.sliceDoc(next.selection.main.from, next.selection.main.to) };
}

describe("deck slash commands", () => {
  it("leaves out commands that would break a slide", () => {
    const ids = deckCommands.map((c) => c.id);
    expect(ids).not.toContain("divider");
    expect(ids).toContain("table");
  });

  it("finds slide commands", () => {
    expect(filterCommands("new", deckCommands)[0].id).toBe("slide");
    expect(filterCommands("notes", deckCommands)[0].id).toBe("notes");
    expect(filterCommands("section", deckCommands)[0].id).toBe("layout-section");
  });

  it("starts a new slide with its title selected", () => {
    const result = run("slide", "# One\n\n- a\n/new|");
    expect(result.selected).toBe("Slide title");
    expect(parseDeck(result.doc).slides.map((s) => s.title)).toEqual(["One", "Slide title"]);
  });

  it("adds speaker notes", () => {
    const deck = parseDeck(run("notes", "# One\n\n/notes|Say hi").doc);
    expect(deck.slides[0].notes).toBe("Say hi");
  });

  it("sets the layout, transition and hidden flag", () => {
    const doc = run("layout-section", "# One\n/lay|");
    expect(parseDeck(doc.doc).slides[0].layout).toBe("section");
    const t = run("transition", "# One\n/tra|");
    expect(t.selected).toBe("dissolve 1s");
    expect(parseDeck(t.doc).slides[0].transition).toEqual({ effect: "dissolve", duration: 1 });
    expect(parseDeck(run("hide", "# One\n/hide|").doc).slides[0].skipped).toBe(true);
  });
});
