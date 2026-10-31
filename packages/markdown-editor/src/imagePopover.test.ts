// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { cardPicturePicker } from "./cardsWidget";
import { imageAt, imageMarkdown, imagePopoverAt, imageRemoval, openImagePopover } from "./imagePopover";
import { livePreview } from "./livePreview";

function stateOf(doc: string) {
  const state = EditorState.create({ doc, extensions: markdown({ base: markdownLanguage }) });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
}

function viewOf(doc: string, extensions: Extension[] = []) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ parent, state: EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage }), livePreview(), ...extensions] }) });
  ensureSyntaxTree(view.state, view.state.doc.length, 5000);
  return view;
}

const popover = () => document.querySelector<HTMLFormElement>(".cm-image-popover");
const buttonNamed = (name: string) => [...popover()!.querySelectorAll("button")].find((b) => b.textContent === name)!;

describe("image popover", () => {
  it("reads a picture, its title and its size", () => {
    const state = stateOf('Text\n![Duck \\[mini\\]](/duck.jpg "Side"){half} after');
    const at = state.doc.line(2).from;
    expect(imageAt(state, at)).toMatchObject({ alt: "Duck [mini]", url: "/duck.jpg", title: "Side", size: "half", end: state.doc.line(2).to - " after".length });
    expect(imageAt(state, 0)).toBeNull();
  });

  it("writes plain Markdown", () => {
    expect(imageMarkdown({ alt: " Duck [mini] ", url: "/my duck.jpg" })).toBe("![Duck \\[mini\\]](/my%20duck.jpg)");
    expect(imageMarkdown({ alt: "A", url: "/a.jpg", title: "Side" })).toBe('![A](/a.jpg "Side")');
  });

  it("removes the whole line when it's just the picture", () => {
    const state = stateOf("One\n![A](/a.jpg){small}\nTwo");
    const image = imageAt(state, 4)!;
    const cut = imageRemoval(state, image);
    expect(state.sliceDoc(0, cut.from) + state.sliceDoc(cut.to)).toBe("One\nTwo");
    const inline = stateOf("See ![A](/a.jpg) here");
    const range = imageRemoval(inline, imageAt(inline, 4)!);
    expect(inline.sliceDoc(0, range.from) + inline.sliceDoc(range.to)).toBe("See  here");
  });

  it("opens on a picture, saves the title and URL, and sets the size", () => {
    const view = viewOf("Intro\n\n![hero](https://example.com/a.jpg){half}\n\nEnd");
    const at = view.state.doc.line(3).from;
    expect(openImagePopover(view, at)).toBe(true);
    expect(imagePopoverAt(view.state)).toBe(at);
    const [alt, url] = [...popover()!.querySelectorAll("input")];
    expect(alt.value).toBe("hero");
    expect(url.value).toBe("https://example.com/a.jpg");
    buttonNamed("Small").click();
    expect(view.state.doc.line(3).text).toBe("![hero](https://example.com/a.jpg){small}");
    alt.value = "Open Duck Mini";
    url.value = "https://example.com/b.jpg";
    buttonNamed("Done").click();
    expect(view.state.doc.line(3).text).toBe("![Open Duck Mini](https://example.com/b.jpg){small}");
    expect(imagePopoverAt(view.state)).toBeNull();
    view.destroy();
  });

  it("chooses another picture with the host's picker", () => {
    const view = viewOf("![](https://example.com/a.jpg)", [cardPicturePicker.of((_anchor, done) => done({ src: "https://example.com/robot-arm.png", alt: "" }))]);
    openImagePopover(view, 0);
    buttonNamed("Choose image").click();
    expect(view.state.doc.toString()).toBe("![robot-arm](https://example.com/robot-arm.png)");
    expect(popover()!.querySelectorAll("input")[1].value).toBe("https://example.com/robot-arm.png");
    buttonNamed("Remove image").click();
    expect(view.state.doc.toString()).toBe("");
    view.destroy();
  });

  it("Edit markdown puts the caret in the picture's Markdown", () => {
    const view = viewOf("Intro\n![A](/a.jpg)");
    openImagePopover(view, 6);
    // happy-dom's selection events can't follow a focus; the caret is what's checked.
    view.focus = () => {};
    buttonNamed("Edit markdown").click();
    expect(imagePopoverAt(view.state)).toBeNull();
    expect(view.state.selection.main.head).toBe(9);
    view.destroy();
  });

  it("doesn't open in a read-only editor", () => {
    const view = viewOf("![A](/a.jpg)", [EditorState.readOnly.of(true)]);
    expect(openImagePopover(view, 0)).toBe(false);
    view.destroy();
  });
});
