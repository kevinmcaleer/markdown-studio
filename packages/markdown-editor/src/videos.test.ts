// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMarkdown } from "./markdown";
import { findVideoBlocks, videoFromLine, videoItems, videoLine, videosHtml, youTubeId } from "./videos";
import { videoRenderers, videosField } from "./videosWidget";

const A = "dQw4w9WgXcQ";
const B = "abcdefghijk";
const doc = `Intro\n\n::: videos\nhttps://www.youtube.com/watch?v=${A}\n[Wiring it up](https://youtu.be/${B})\n:::\n\nAfter`;

describe("video blocks", () => {
  it("reads YouTube ids from every kind of address", () => {
    expect(youTubeId(`https://www.youtube.com/watch?v=${A}&t=3`)).toBe(A);
    expect(youTubeId(`youtu.be/${A}`)).toBe(A);
    expect(youTubeId(`https://m.youtube.com/shorts/${A}`)).toBe(A);
    expect(youTubeId(`https://www.youtube.com/embed/${A}`)).toBe(A);
    expect(youTubeId(A)).toBe(A);
    expect(youTubeId("https://vimeo.com/123")).toBeNull();
    expect(youTubeId("hello")).toBeNull();
  });

  it("takes a title from the link text or the words after the address", () => {
    expect(videoFromLine(`https://youtu.be/${A}`)).toEqual({ id: A, title: "" });
    expect(videoFromLine(`[Part *one*](https://youtu.be/${A})`)).toEqual({ id: A, title: "Part one" });
    expect(videoFromLine(`https://youtu.be/${A} Part one`)).toEqual({ id: A, title: "Part one" });
    expect(videoFromLine(`- <https://youtu.be/${A}> — Part one`)).toEqual({ id: A, title: "Part one" });
    expect(videoFromLine(`[https://youtu.be/${A}](https://youtu.be/${A})`)).toEqual({ id: A, title: "" });
    expect(videoFromLine("Just words")).toBeNull();
    expect(videoFromLine("https://example.com/watch")).toBeNull();
  });

  it("keeps the videos in their written order", () => {
    expect(videoItems(`https://youtu.be/${B} Second\nnot a video\nhttps://youtu.be/${A}`)).toEqual([
      { id: B, title: "Second" },
      { id: A, title: "" },
    ]);
  });

  it("writes a line for a video", () => {
    expect(videoLine({ id: A })).toBe(`https://www.youtube.com/watch?v=${A}`);
    expect(videoLine({ id: A, title: " Part\none " })).toBe(`https://www.youtube.com/watch?v=${A} Part one`);
    expect(videoFromLine(videoLine({ id: A, title: "Part one" }))).toEqual({ id: A, title: "Part one" });
  });

  it("finds closed blocks outside code", () => {
    const lines = ["```", "::: videos", `https://youtu.be/${A}`, ":::", "```", "::: videos", `https://youtu.be/${B}`, ":::", "::: videos", `https://youtu.be/${A}`];
    expect(findVideoBlocks(lines)).toEqual([{ open: 5, close: 7, videos: [{ id: B, title: "" }] }]);
  });

  it("draws a card per video, escaped", () => {
    const html = videosHtml([
      { id: A, title: "<b>Bold</b>" },
      { id: B, title: "" },
    ]);
    expect(html).toContain('data-video-count="2"');
    expect(html).toContain(`href="https://www.youtube.com/watch?v=${A}"`);
    expect(html).toContain(`https://img.youtube.com/vi/${A}/mqdefault.jpg`);
    expect(html).toContain("&lt;b&gt;Bold&lt;/b&gt;");
    expect(html).toContain(`data-video-id="${B}" data-video-untitled`);
    expect(html).toContain('<span class="md-video-title">YouTube video</span>');
  });

  it("is a block in the preview", () => {
    const html = renderMarkdown(doc);
    expect(html).toContain('<p>Intro</p>\n<div class="md-videos" data-video-count="2">');
    expect(html).toContain('<span class="md-video-title">Wiring it up</span>');
    expect(html).not.toContain(":::");
    expect(html).toContain("<p>After</p>");
    // An unclosed one is just text.
    expect(renderMarkdown(`::: videos\nhttps://youtu.be/${A}\n`)).toContain("<p>::: videos");
  });
});

describe("video blocks in the live view", () => {
  afterEach(() => vi.unstubAllGlobals());

  function setup(cursor: number, extra: Extension = []) {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false })));
    const state = EditorState.create({ doc, selection: { anchor: cursor }, extensions: [markdown({ base: markdownLanguage }), videosField, extra] });
    const parent = document.createElement("div");
    document.body.append(parent);
    return new EditorView({ state, parent });
  }

  it("draws the cards while the cursor is outside the block", () => {
    const view = setup(0);
    expect(view.dom.querySelectorAll(".cm-md-videos .md-video")).toHaveLength(2);
    view.destroy();
  });

  it("shows its lines with the cursor in it", () => {
    const view = setup(doc.indexOf("[Wiring"));
    expect(view.dom.querySelector(".cm-md-videos")).toBeNull();
    expect(view.dom.querySelectorAll(".cm-md-videos-line")).toHaveLength(4);
    view.destroy();
  });

  it("lets the host draw the cards", () => {
    const seen: unknown[] = [];
    const view = setup(
      0,
      videoRenderers.of((videos) => {
        seen.push(videos);
        const el = document.createElement("div");
        el.className = "host-cards";
        return el;
      }),
    );
    expect(view.dom.querySelector(".cm-md-videos .host-cards")).not.toBeNull();
    expect(view.dom.querySelector(".md-video")).toBeNull();
    expect(seen).toEqual([[{ id: A, title: "" }, { id: B, title: "Wiring it up" }]]);
    view.destroy();
  });
});
