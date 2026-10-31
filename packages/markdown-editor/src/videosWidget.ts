import { Facet, StateField, type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { fillVideoTitles, findVideoBlocks, videosHtml, type Video } from "./videos";
import "./videos.css";
import { rememberedHeight, spacedBlock } from "./steadyScroll";

// In the live view a `::: videos` block (see videos.ts) shows as its cards
// while the cursor is outside it, and as its lines once the cursor moves in,
// so videos are added, removed and reordered as lines. Clicking the cards
// puts the cursor on the first line.

/** Draws a block's videos some other way (the host's own video cards), or returns null for the editor's. */
export type VideoRenderer = (videos: Video[]) => HTMLElement | null;

/** The video renderers; the first to draw a block wins. */
export const videoRenderers = Facet.define<VideoRenderer>();

class VideosWidget extends WidgetType {
  constructor(readonly videos: readonly Video[]) {
    super();
  }
  get key() {
    return `videos\n${this.videos.map((v) => `${v.id} ${v.title}`).join("\n")}`;
  }
  eq(other: VideosWidget) {
    return other.key === this.key;
  }
  get estimatedHeight() {
    return rememberedHeight(this.key) ?? -1;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-videos";
    let drawn: HTMLElement | null = null;
    if (this.videos.length) {
      for (const render of view.state.facet(videoRenderers)) {
        try {
          drawn = render(this.videos.map((v) => ({ ...v })));
        } catch {
          drawn = null;
        }
        if (drawn) break;
      }
    }
    if (drawn) wrap.append(drawn);
    else {
      wrap.innerHTML = videosHtml(this.videos);
      fillVideoTitles(wrap);
    }
    if (!this.videos.length) {
      const note = document.createElement("p");
      note.className = "cm-md-videos-note";
      note.textContent = "No videos yet: click here and add YouTube links between ::: videos and :::";
      wrap.append(note);
    }
    // The cards link to YouTube: in the editor they open the lines instead.
    wrap.addEventListener("click", (event) => {
      if ((event.target as Element).closest("a")) event.preventDefault();
    });
    wrap.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const { doc } = view.state;
      const open = doc.lineAt(view.posAtDOM(wrap));
      const first = open.number < doc.lines ? doc.line(open.number + 1) : open;
      view.focus();
      view.dispatch({ selection: { anchor: first.from }, scrollIntoView: true });
    });
    return spacedBlock(wrap, this.key);
  }
  ignoreEvent() {
    return true;
  }
}

/** The video blocks to draw: closed, and without the cursor in them. */
export function findVideoWidgets(state: EditorState): DecorationSet {
  const { doc, selection } = state;
  const text = doc.toString();
  if (!text.includes(":::")) return Decoration.none;
  const blocks: Range<Decoration>[] = [];
  for (const block of findVideoBlocks(text.split("\n"))) {
    const open = doc.line(block.open + 1);
    const close = doc.line(block.close + 1);
    const touched = selection.ranges.some((r) => r.from <= close.to && r.to >= open.from);
    if (touched) {
      for (let n = open.number; n <= close.number; n++) {
        const edge = n === open.number ? " cm-md-videos-first" : n === close.number ? " cm-md-videos-last" : "";
        blocks.push(Decoration.line({ class: `cm-md-videos-line${edge}` }).range(doc.line(n).from));
      }
      continue;
    }
    blocks.push(Decoration.replace({ widget: new VideosWidget(block.videos), block: true }).range(open.from, close.to));
  }
  return Decoration.set(blocks, true);
}

export const videosField = StateField.define<DecorationSet>({
  create: findVideoWidgets,
  update(blocks, tr) {
    if (tr.docChanged || tr.selection || tr.reconfigured) return findVideoWidgets(tr.state);
    return blocks;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export const videosTheme = EditorView.theme({
  ".cm-md-videos": {
    margin: "0",
    padding: "0.5rem",
    borderRadius: "12px",
    // A faint dotted outline so the author can see where the block ends; only
    // the editor draws it, never the published page.
    border: "1.5px dotted color-mix(in srgb, var(--muted) 45%, transparent)",
    cursor: "pointer",
    whiteSpace: "normal",
  },
  ".cm-md-videos:hover": { borderColor: "var(--muted)" },
  ".cm-md-videos .md-videos": { margin: "0" },
  ".cm-line.cm-md-videos-line": { backgroundColor: "rgb(var(--gallery-tint, 120 120 120) / 0.07)", paddingLeft: "0.75rem", paddingRight: "0.75rem" },
  ".cm-line.cm-md-videos-first": { borderTopLeftRadius: "8px", borderTopRightRadius: "8px", paddingTop: "0.3em", color: "var(--muted)" },
  ".cm-line.cm-md-videos-last": { borderBottomLeftRadius: "8px", borderBottomRightRadius: "8px", paddingBottom: "0.3em", color: "var(--muted)" },
  ".cm-md-videos-note": { margin: "0", padding: "1rem", textAlign: "center", color: "var(--muted)", fontSize: "0.9em" },
});
