// @vitest-environment happy-dom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { sizePicture, steadyScroll } from "./steadyScroll";

function loaded(img: HTMLImageElement, width: number, height: number) {
  Object.defineProperty(img, "naturalWidth", { value: width });
  Object.defineProperty(img, "naturalHeight", { value: height });
  img.dispatchEvent(new Event("load"));
}

describe("steadyScroll pictures", () => {
  it("gives a picture drawn again the size it loaded at, by its Markdown URL", () => {
    const view = new EditorView({ state: EditorState.create({ doc: "text", extensions: [steadyScroll] }), parent: document.body });
    const first = document.createElement("img");
    first.setAttribute("src", "https://example.com/a.png");
    sizePicture(first);
    expect(first.hasAttribute("width")).toBe(false);
    view.contentDOM.append(first);
    // A host swapped the src for a blob: URL before it loaded.
    first.src = "blob:https://example.com/1234";
    loaded(first, 800, 600);

    const again = document.createElement("img");
    again.setAttribute("src", "https://example.com/a.png");
    sizePicture(again);
    expect(again.getAttribute("width")).toBe("800");
    expect(again.getAttribute("height")).toBe("600");
    view.destroy();
  });

  it("leaves a size the Markdown or the host gave alone", () => {
    const img = document.createElement("img");
    img.setAttribute("src", "https://example.com/a.png");
    img.setAttribute("width", "120");
    sizePicture(img);
    expect(img.getAttribute("width")).toBe("120");
    expect(img.hasAttribute("height")).toBe(false);
  });
});
