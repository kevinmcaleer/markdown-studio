import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { applyCommand, filterCommands, slashCommands, withInsertTexts, type SlashCommand } from "./slashMenu";

const command = (id: string) => slashCommands.find((c) => c.id === id)!;

/** Runs the command on a doc where "|" marks the cursor, just after "/query". */
function run(id: string, doc: string) {
  const head = doc.indexOf("|");
  const text = doc.slice(0, head) + doc.slice(head + 1);
  const state = EditorState.create({ doc: text });
  const from = text.lastIndexOf("/", head);
  const next = state.update(applyCommand(state, command(id), from, head)).state;
  const { anchor, head: end } = next.selection.main;
  return { doc: next.doc.toString(), selected: next.sliceDoc(anchor, end), cursor: end };
}

describe("callout commands", () => {
  it("insert a titled callout with the cursor on its title", () => {
    const out = run("callout-tip", "Intro\n/tip|");
    expect(out.doc).toBe("Intro\n\n> [!tip] Tip\n> ");
    expect(out.selected).toBe("Tip");
  });
});

describe("filterCommands", () => {
  it("lists everything for an empty query", () => {
    expect(filterCommands("")).toHaveLength(slashCommands.length);
  });

  it("puts label prefixes first", () => {
    expect(filterCommands("head").map((c) => c.id)).toEqual(["h1", "h2", "h3"]);
  });

  it("finds commands by keyword", () => {
    expect(filterCommands("h2")[0].id).toBe("h2");
    expect(filterCommands("todo")[0].id).toBe("checklist");
    expect(filterCommands("hr")[0].id).toBe("divider");
  });

  it("matches later words in a label", () => {
    expect(filterCommands("list").map((c) => c.id)).toEqual(["bullet", "numbered", "checklist"]);
  });

  it("finds callouts by type, alias and 'callout'", () => {
    expect(filterCommands("warn")[0].id).toBe("callout-warning");
    expect(filterCommands("caution")[0].id).toBe("callout-warning");
    expect(filterCommands("callout").map((c) => c.id)).toEqual(slashCommands.filter((c) => c.group === "callouts").map((c) => c.id));
  });

  it("returns nothing for nonsense", () => {
    expect(filterCommands("zzz")).toEqual([]);
  });
});

describe("applyCommand", () => {
  it("turns an empty line into a heading", () => {
    expect(run("h1", "/he|")).toMatchObject({ doc: "# ", cursor: 2 });
  });

  it("keeps text after the cursor on the line", () => {
    expect(run("bullet", "/|Milk").doc).toBe("- Milk");
  });

  it("starts block commands on a new line after text", () => {
    expect(run("checklist", "Shopping /check|").doc).toBe("Shopping \n- [ ] ");
  });

  it("selects the first table header", () => {
    const result = run("table", "/table|");
    expect(result.doc).toBe("| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n|  |  |  |\n");
    expect(result.selected).toBe("Column 1");
  });

  it("adds a blank line so a divider isn't read as a heading underline", () => {
    expect(run("divider", "Some text\n/div|").doc).toBe("Some text\n\n---\n\n");
  });

  it("puts the cursor inside a new code block", () => {
    const result = run("code", "/code|");
    expect(result.doc).toBe("```\n\n```\n");
    expect(result.cursor).toBe(4);
  });

  it("inserts inline commands in place", () => {
    const result = run("highlight", "This is /high| important");
    expect(result.doc).toBe("This is ==highlighted== important");
    expect(result.selected).toBe("highlighted");
  });

  it("selects an image's description", () => {
    expect(run("image", "/img|")).toMatchObject({ doc: "![Description](https://)", selected: "Description" });
  });
});

describe("withInsertTexts", () => {
  it("swaps in a host's templates, EasyMDE style", () => {
    const commands = withInsertTexts(slashCommands, { horizontalRule: ["", "\n\n***\n\n"], link: ["[", "](https://kevsrobots.com)"] });
    const state = EditorState.create({ doc: "" });
    const divider = commands.find((c) => c.id === "divider")!;
    expect(state.update(applyCommand(state, divider, 0, 0)).state.doc.toString()).toBe("\n\n***\n\n");
    expect(commands.find((c) => c.id === "link")!.insert!()).toEqual({ before: "[", after: "](https://kevsrobots.com)" });
    // The rest are untouched.
    expect(commands.find((c) => c.id === "table")).toBe(slashCommands.find((c) => c.id === "table"));
  });
});

describe("a command that runs", () => {
  it("only takes out the /query; run() does the rest", () => {
    const command: SlashCommand = { id: "pick", label: "Pick", keywords: [], group: "host", icon: "", run: () => {} };
    const state = EditorState.create({ doc: "Text /pi" });
    expect(state.update(applyCommand(state, command, 5, 8)).state.doc.toString()).toBe("Text ");
  });
});
