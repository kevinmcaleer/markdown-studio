// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { cardsField, cardsTheme } from "./cardsWidget";
import { galleryField, galleryTheme } from "./galleryWidget";
import { videosField, videosTheme } from "./videosWidget";

// CodeMirror measures a block widget by its border box. A margin on the
// widget isn't counted, so every line below it is drawn lower than CodeMirror
// thinks and a click on a line lands on the one underneath. The space around
// these blocks has to be padding on the widget's own (outermost) element.
const blocks = {
  cards: { doc: "::: cards\n### A\nx\n\n### B\ny\n:::", inner: ".cm-md-cards", extensions: [cardsField, cardsTheme] },
  gallery: { doc: "::: gallery\n![a](https://example.com/a.png)\n:::", inner: ".cm-md-gallery", extensions: [galleryField, galleryTheme] },
  videos: { doc: "::: videos\nhttps://www.youtube.com/watch?v=dQw4w9WgXcQ\n:::", inner: ".cm-md-videos", extensions: [videosField, videosTheme] },
};

describe("block widgets' spacing", () => {
  for (const [name, block] of Object.entries(blocks)) {
    it(`spaces a ${name} block with padding CodeMirror counts, not a margin`, () => {
      const doc = `Start\n\n${block.doc}\n\nAfter`;
      const state = EditorState.create({ doc, selection: { anchor: 0 }, extensions: [markdown({ base: markdownLanguage }), ...block.extensions] });
      const view = new EditorView({ state, parent: document.body });
      const inner = view.contentDOM.querySelector<HTMLElement>(block.inner);
      expect(inner).not.toBeNull();
      const outer = inner!.parentElement!;
      // The widget's own element is the spacer, straight inside the content.
      expect(outer.classList.contains("cm-md-block-space")).toBe(true);
      expect(outer.parentElement).toBe(view.contentDOM);
      expect(outer.style.padding).toBe("0.5rem 0px");
      for (const side of ["marginTop", "marginBottom"] as const) {
        expect(["", "0px"]).toContain(getComputedStyle(inner!)[side]);
      }
      view.destroy();
    });
  }
});
