// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { cardPicturePicker } from "./cardsWidget";
import { closeImagePopover, imageAt, imageMarkdown, imagePopoverAt, imageRemoval, openImagePopover, placePopover } from "./imagePopover";
import { DOUBLE_CLICK_MS, livePreview } from "./livePreview";

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

  it("a double-click on the picture closes the popover its first click opened", () => {
    const view = viewOf("Intro\n\n![Wiring](https://example.com/wiring.png)\n\nEnd");
    const img = view.dom.querySelector<HTMLImageElement>("img.cm-md-image")!;
    img.click();
    expect(imagePopoverAt(view.state)).toBe(view.state.doc.line(3).from);
    img.click();
    img.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(imagePopoverAt(view.state)).toBeNull();
    expect(popover()).toBeNull();
    view.destroy();
  });

  it("waits out a double-click on a picture the host marks as having its own editor", () => {
    vi.useFakeTimers();
    try {
      const view = viewOf("![Wiring](https://example.com/wiring.png)\n\nEnd");
      const img = () => view.dom.querySelector<HTMLImageElement>("img.cm-md-image")!;
      img().dataset.mdDoubleClick = "";
      let edited = 0;
      img().addEventListener("dblclick", () => edited++);
      // One click: the popover opens once a double-click can't come.
      img().click();
      expect(imagePopoverAt(view.state)).toBeNull();
      vi.advanceTimersByTime(DOUBLE_CLICK_MS);
      expect(imagePopoverAt(view.state)).toBe(0);
      closeImagePopover(view);
      // A double-click: the host's editor opens and the popover never does.
      img().dataset.mdDoubleClick = "";
      img().addEventListener("dblclick", () => edited++);
      img().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      img().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
      img().dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));
      vi.advanceTimersByTime(DOUBLE_CLICK_MS * 2);
      expect(edited).toBe(1);
      expect(imagePopoverAt(view.state)).toBeNull();
      view.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't open in a read-only editor", () => {
    const view = viewOf("![A](/a.jpg)", [EditorState.readOnly.of(true)]);
    expect(openImagePopover(view, 0)).toBe(false);
    view.destroy();
  });
});

describe("image popover placement", () => {
  const room = { top: 100, bottom: 800 };

  it("goes under the picture when it fits there", () => {
    expect(placePopover({ top: 150, bottom: 400 }, 180, room)).toEqual({ top: 400, side: "below" });
  });

  it("goes above the picture when only that side has room", () => {
    expect(placePopover({ top: 500, bottom: 750 }, 180, room)).toEqual({ top: 500 - 12 - 180, side: "above" });
  });

  it("sits over the top of a picture too tall for either side", () => {
    expect(placePopover({ top: 150, bottom: 1400 }, 180, room)).toEqual({ top: 150, side: "over" });
  });

  it("stays below the toolbar while a tall picture scrolls up under it", () => {
    expect(placePopover({ top: -300, bottom: 600 }, 180, room, "over")).toEqual({ top: 100, side: "over" });
    expect(placePopover({ top: -600, bottom: 150 }, 180, room, "over")).toEqual({ top: 100, side: "over" });
  });

  it("keeps its side while that still fits", () => {
    expect(placePopover({ top: 20, bottom: 300 }, 180, room, "below")).toEqual({ top: 300, side: "below" });
    expect(placePopover({ top: 700, bottom: 1000 }, 180, room, "above")?.side).toBe("above");
  });

  it("hides once the picture has scrolled out of view", () => {
    expect(placePopover({ top: -600, bottom: 90 }, 180, room, "over")).toBeNull();
    expect(placePopover({ top: 820, bottom: 1200 }, 180, room)).toBeNull();
  });
});
