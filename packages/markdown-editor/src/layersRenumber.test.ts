// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { renumberAfter, type LayersApi, type LayersHost } from "./layersBlock";

// Graphics whose "layers" are just a step badge: url → { badge, pinned }.
function setup(text: string, docs: Record<string, { badge: number; pinned?: boolean }>, prefix = "") {
  const saved: string[] = [];
  let n = 0;
  const badgeOf = (u: string) => docs[u.replace(/#layers$/, "")];
  const api: LayersApi = {
    readDoc: async (url) => ({ ...badgeOf(url) }),
    stepBadge: (d) => {
      const b = d as { badge: number; pinned?: boolean } | null;
      return b ? { last: b.badge, auto: b.pinned ? null : b.badge } : null;
    },
    hasScene: () => true,
    mount: (_el, opts) => ({
      setMode() {},
      mode: () => "inline",
      destroy() {},
      focus() {},
      ready: async () => {},
      getDoc: () => opts.doc,
      exportResult: async () => {
        const d = opts.doc as { pinned?: boolean; badge: number };
        const badge = d.pinned ? d.badge : (opts.stepNumber as number);
        const url = `/${prefix}new${++n}.png`;
        docs[url] = { badge, pinned: d.pinned };
        saved.push(`${url}=${badge}`);
        return { png: new Blob([]), title: `Step ${badge}`, width: 1, height: 1 };
      },
    }),
  };
  const host: LayersHost = {
    load: async () => api,
    fetchImage: async () => new Blob([]),
    uploadImage: async () => `/${prefix}new${n}.png`,
  };
  const view = new EditorView({ state: EditorState.create({ doc: text, extensions: [markdown({ base: markdownLanguage })] }) });
  return { view, host, saved };
}

describe("renumberAfter", () => {
  it("numbers the steps after a duplicated one on, leaving those before alone", async () => {
    // Steps 1, 2, then the copy of 2 (numbered 3), then the old 3 and 4.
    const text = ["![Step 1](/a.png#layers)", "![Step 2](/b.png#layers)", "![Step 3](/c.png#layers)", "![Step 3](/d.png#layers)", "![Step 4](/e.png#layers)"].join("\n\n");
    const { view, host, saved } = setup(text, { "/a.png": { badge: 1 }, "/b.png": { badge: 2 }, "/c.png": { badge: 3 }, "/d.png": { badge: 3 }, "/e.png": { badge: 4 } });
    const done = await renumberAfter(view, host, "/c.png#layers");
    expect(done).toBe(2);
    expect(saved).toEqual(["/new1.png=4", "/new2.png=5"]);
    const out = view.state.doc.toString();
    expect(out).toContain("![Step 1](/a.png#layers)");
    expect(out).toContain("![Step 2](/b.png#layers)");
    expect(out).toContain("![Step 3](/c.png#layers)");
    expect(out).toContain("![Step 4](/new1.png#layers)");
    expect(out).toContain("![Step 5](/new2.png#layers)");
    view.destroy();
  });

  it("leaves a step numbered by hand as it is, and counts on from it", async () => {
    const text = ["![Step 1](/ha.png#layers)", "![Step 2](/hb.png#layers)", "![Step 10](/hc.png#layers)", "![Step 3](/hd.png#layers)"].join("\n\n");
    // (Links of their own: the editor keeps each graphic's layers by its link.)
    const { view, host, saved } = setup(text, { "/ha.png": { badge: 1 }, "/hb.png": { badge: 2 }, "/hc.png": { badge: 10, pinned: true }, "/hd.png": { badge: 3 } }, "h");
    await renumberAfter(view, host, "/hb.png#layers");
    expect(saved).toEqual(["/hnew1.png=11"]);
    view.destroy();
  });
});
