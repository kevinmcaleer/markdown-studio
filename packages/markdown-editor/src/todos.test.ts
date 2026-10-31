import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { completeTodo, findTodos } from "./todos";

/** The document after marking the todo at `index` done. */
function done(doc: string, index = 0): string {
  const state = EditorState.create({ doc });
  const todo = findTodos(doc)[index];
  const change = completeTodo(state, todo);
  return change ? state.update(change).state.doc.toString() : doc;
}

describe("findTodos", () => {
  it("finds a #todo and its note, under its heading", () => {
    const doc = "# Wiring\n\nSome text.\n\n#todo add the wiring photo\n";
    const [todo] = findTodos(doc);
    expect(todo.text).toBe("add the wiring photo");
    expect(todo.section).toBe("Wiring");
    expect(todo.line).toBe(5);
    expect(doc.slice(todo.from, todo.to)).toBe("#todo add the wiring photo");
  });

  it("finds one in the middle of a line, and several on a line", () => {
    const todos = findTodos("The arm uses 3 servos #todo check the count #todo: and the torque");
    expect(todos.map((t) => t.text)).toEqual(["check the count", "and the torque"]);
  });

  it("is happy with no note, and any case", () => {
    expect(findTodos("#TODO\n< to be updated >").map((t) => [t.text, t.line])).toEqual([["", 1]]);
  });

  it("ends the note at the cell in a table row", () => {
    const [todo] = findTodos("| Part | Link |\n| --- | --- |\n| Servo | #todo find a link | 2 |");
    expect(todo.text).toBe("find a link");
  });

  it("ignores code, hashtags that only start with todo, and links", () => {
    const doc = ["```", "#todo in a fence", "```", "Inline `#todo code` here", "#todos and #todo-list", "[x](https://a.b/#todo)", "~~~", "#todo", "~~~"].join("\n");
    expect(findTodos(doc)).toEqual([]);
  });

  it("doesn't take a #todo line as a heading", () => {
    const [, second] = findTodos("## Build\n#todo one\n#todo two");
    expect(second.section).toBe("Build");
  });
});

describe("completeTodo", () => {
  it("removes a line that was only the todo", () => {
    expect(done("Intro\n#todo add a photo\nMore")).toBe("Intro\nMore");
    expect(done("Intro\n#todo\n< to be updated >")).toBe("Intro\n< to be updated >");
  });

  it("removes the tag and note from the end of a line", () => {
    expect(done("Three servos #todo check the count")).toBe("Three servos");
  });

  it("leaves the text before the next todo", () => {
    expect(done("A #todo one #todo two", 0)).toBe("A #todo two");
    expect(done("A #todo one #todo two", 1)).toBe("A #todo one");
  });

  it("removes a list item that held only the todo", () => {
    expect(done("- one\n- #todo two\n- three")).toBe("- one\n- three");
  });

  it("empties a table cell, keeping the table", () => {
    expect(done("| a | b |\n| --- | --- |\n| x | #todo y |")).toBe("| a | b |\n| --- | --- |\n| x | |");
  });

  it("removes the last line cleanly", () => {
    expect(done("Text\n#todo last")).toBe("Text");
    expect(done("#todo only")).toBe("");
  });

  it("finds the todo again after the text moved", () => {
    const doc = "Intro\n#todo fix";
    const todo = findTodos(doc)[0];
    const state = EditorState.create({ doc: "New line\n" + doc });
    const change = completeTodo(state, todo)!;
    expect(state.update(change).state.doc.toString()).toBe("New line\nIntro");
  });
});
