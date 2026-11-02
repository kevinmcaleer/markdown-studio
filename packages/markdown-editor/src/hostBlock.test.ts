// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { hostBlockRange, hostBlocks, openHostBlock } from "./hostBlock";
import { livePreview } from "./livePreview";

function viewOf(doc: string) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ parent, state: EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage }), livePreview(), hostBlocks()] }) });
  ensureSyntaxTree(view.state, view.state.doc.length, 5000);
  return view;
}

const DOC = "# Wiring\n\n![Wiring diagram](https://x.test/wiring.svg?v=1)\n\nAfter";
const PIC = DOC.indexOf("![");

describe("host blocks", () => {
  it("goes over a picture's line, or after any other line", () => {
    const view = viewOf(DOC);
    const line = view.state.doc.lineAt(PIC);
    expect(hostBlockRange(view.state, PIC)).toEqual({ from: line.from, to: line.to, replace: true });
    expect(hostBlockRange(view.state, 3)).toEqual({ from: 8, to: 8, replace: false });
    view.destroy();
  });

  it("shows the host's box in place of the picture, and keeps it while the text changes", () => {
    const view = viewOf(DOC);
    const block = openHostBlock(view, PIC);
    block.element.textContent = "workspace";
    expect(view.dom.querySelector(".cm-host-block")).toBe(block.element);
    expect(view.dom.querySelector("img.cm-md-image")).toBeNull();
    // Text before it moves it along; changing the picture's link keeps the same box.
    view.dispatch({ changes: { from: 0, insert: "Intro\n\n" } });
    expect(block.pos()).toBe(PIC + 7);
    const url = view.state.doc.toString().indexOf("?v=1");
    view.dispatch({ changes: { from: url, to: url + 4, insert: "?v=2" } });
    expect(view.dom.querySelector(".cm-host-block")).toBe(block.element);
    expect(block.element.textContent).toBe("workspace");
    view.destroy();
  });

  it("moves, closes once, and gives way to the next block", () => {
    const view = viewOf(DOC);
    const onClose = vi.fn();
    const first = openHostBlock(view, 3, { onClose });
    first.moveTo(PIC);
    expect(first.pos()).toBe(PIC);
    const second = openHostBlock(view, PIC);
    expect(first.isOpen()).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    first.close();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(view.dom.querySelector(".cm-host-block")).toBe(second.element);
    second.close();
    expect(view.dom.querySelector(".cm-host-block")).toBeNull();
    expect(view.dom.querySelector("img.cm-md-image")).not.toBeNull();
    view.destroy();
  });

  it("keeps blocks in different slots open together", () => {
    const view = viewOf(DOC);
    const wiring = openHostBlock(view, PIC);
    const files = openHostBlock(view, view.state.doc.length, { slot: "files" });
    files.element.textContent = "files";
    expect(wiring.isOpen()).toBe(true);
    expect(view.dom.querySelectorAll(".cm-host-block")).toHaveLength(2);
    // Text before both moves both along.
    view.dispatch({ changes: { from: 0, insert: "Intro\n\n" } });
    expect(wiring.pos()).toBe(PIC + 7);
    expect(files.pos()).toBe(view.state.doc.length);
    // A new block in the files slot replaces only that one.
    const again = openHostBlock(view, 3, { slot: "files" });
    expect(files.isOpen()).toBe(false);
    expect(wiring.isOpen()).toBe(true);
    again.close();
    expect(view.dom.querySelectorAll(".cm-host-block")).toHaveLength(1);
    view.destroy();
    expect(wiring.isOpen()).toBe(false);
  });

  it("closes when the editor goes", () => {
    const view = viewOf(DOC);
    const onClose = vi.fn();
    const block = openHostBlock(view, PIC, { onClose });
    view.destroy();
    expect(block.isOpen()).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
