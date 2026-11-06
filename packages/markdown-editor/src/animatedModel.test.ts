// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { animatedModelCommand, animationKey, animationsIn, isAnimationUrl, makeAnimatedModel, refreshAnimatedModels, type LayersHost, type LayersProjectModel } from "./layersBlock";

const viewOf = (doc: string, at = doc.length) => new EditorView({ state: EditorState.create({ doc, selection: EditorSelection.cursor(at), extensions: [markdown({ base: markdownLanguage })] }) });

function hostWith(model: LayersProjectModel, made: { uploads: { name: string; type: string; replaces?: string }[]; drawn: number }): LayersHost {
  let n = 0;
  return {
    load: async () => ({
      mount: () => ({
        setMode() {},
        mode: () => "inline" as const,
        destroy() {},
        focus() {},
        animatedModel: async (o?: { progress?(d: number, t: number): void }) => {
          made.drawn++;
          o?.progress?.(1, 2);
          o?.progress?.(2, 2);
          return { gif: new Blob(["GIF89a"], { type: "image/gif" }), width: 800, height: 600, stamp: model.stamp };
        },
      }),
      readDoc: async () => null,
    }),
    loadModel: async () => model,
    saveModel: async () => {},
    uploadImage: async (file, options) => {
      made.uploads.push({ name: file.name, type: file.type, ...(options?.replaces ? { replaces: options.replaces } : {}) });
      return `/projects/1/images/${++n}/view`;
    },
  };
}

const model = (stamp: number): LayersProjectModel => ({ version: 1, stamp, parts: [{ id: "a" }] });

describe("animated model links", () => {
  it("are marked with what they were drawn from", () => {
    expect(isAnimationUrl("/i/3/view#animated-model=abc")).toBe(true);
    expect(isAnimationUrl("/i/3/view#layers")).toBe(false);
    const text = "# Robot\n\n![Animated model](/i/3/view#animated-model=k1)\n\n![Photo](/p.png)\n";
    expect(animationsIn(text)).toEqual([{ url: "/i/3/view#animated-model=k1", key: "k1", at: 9 }]);
  });

  it("change key with the model or the view it's seen from, not with steps", () => {
    const m = model(3);
    expect(animationKey(m)).toBe(animationKey({ ...m, steps: [{ id: "s", parts: ["a"] }] }));
    expect(animationKey(m)).not.toBe(animationKey(model(4)));
    const views = [{ id: "v", name: "Front", camera: { direction: [0, -1, 0], target: [0, 0, 0], size: 50 } }];
    expect(animationKey({ ...m, views })).toBe(animationKey(m));
    expect(animationKey({ ...m, views, defaultView: "v" })).not.toBe(animationKey(m));
  });
});

describe("/Animated model", () => {
  it("is a block command found by the words people use", () => {
    const cmd = animatedModelCommand(hostWith(model(1), { uploads: [], drawn: 0 }));
    expect(cmd.label).toBe("Animated model");
    expect(cmd.block).toBe(true);
    expect(cmd.keywords).toEqual(expect.arrayContaining(["animation", "explode", "rotate", "gif"]));
  });

  it("draws the model, uploads a GIF and puts it in where the cursor is", async () => {
    const made = { uploads: [] as { name: string; type: string }[], drawn: 0 };
    const host = hostWith(model(5), made);
    const v = viewOf("# Robot\n\nIntro.\n\n# Code\n", "# Robot\n\nIntro.".length);
    await makeAnimatedModel(v, host);
    expect(made.uploads).toEqual([{ name: "animated-model.gif", type: "image/gif" }]);
    expect(v.state.doc.toString()).toBe(`# Robot\n\nIntro.\n\n![Animated model](/projects/1/images/1/view#animated-model=${animationKey(model(5))})\n\n# Code\n`);
  });

  it("says why when there's no model", async () => {
    const host = { ...hostWith(model(1), { uploads: [], drawn: 0 }), loadModel: async () => null };
    const v = viewOf("");
    await makeAnimatedModel(v, host);
    expect(v.state.doc.toString()).toMatch(/^\*The animated model couldn't be made: the project has no 3D model yet/);
  });

  it("is drawn again, replacing the old picture, once the model moves on", async () => {
    const made = { uploads: [] as { name: string; type: string; replaces?: string }[], drawn: 0 };
    const now = model(7);
    const host = hostWith(now, made);
    const fresh = `/x/9/view#animated-model=${animationKey(now)}`;
    const v = viewOf(`![Animated model](/projects/1/images/4/view#animated-model=old)\n\nText.\n\n![Spin](/projects/1/images/4/view#animated-model=old "Turning")\n\n![Animated model](${fresh})\n`);
    expect(await refreshAnimatedModels(v, host)).toBe(1);
    expect(made.drawn).toBe(1);
    expect(made.uploads[0].replaces).toBe("/projects/1/images/4/view");
    const key = animationKey(now);
    expect(v.state.doc.toString()).toBe(`![Animated model](/projects/1/images/1/view#animated-model=${key})\n\nText.\n\n![Spin](/projects/1/images/1/view#animated-model=${key} "Turning")\n\n![Animated model](${fresh})\n`);
    // Up to date now: nothing more to draw.
    expect(await refreshAnimatedModels(v, host)).toBe(0);
    expect(made.drawn).toBe(1);
  });
});
