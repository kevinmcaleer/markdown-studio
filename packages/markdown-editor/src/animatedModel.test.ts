// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { isAnimationVideoUrl } from "./layersFacet";
import { animatedModelCommand, animationKey, animationStyleOf, droppingModelCommand, animationsIn, isAnimationUrl, makeAnimatedModel, refreshAnimatedModels, type LayersHost, type LayersProjectModel } from "./layersBlock";

const viewOf = (doc: string, at = doc.length) => new EditorView({ state: EditorState.create({ doc, selection: EditorSelection.cursor(at), extensions: [markdown({ base: markdownLanguage })] }) });

type Made = { uploads: { name: string; type: string; replaces?: string }[]; drawn: number; styles?: string[] };

/** A host whose Layers draws a GIF, or an MP4 when `video` (where the browser could encode one); `refuseVideo` is a server that won't take one. */
function hostWith(model: LayersProjectModel, made: Made, { video = false, refuseVideo = false } = {}): LayersHost {
  let n = 0;
  return {
    load: async () => ({
      mount: () => ({
        setMode() {},
        mode: () => "inline" as const,
        destroy() {},
        focus() {},
        animatedModel: async (o?: { progress?(d: number, t: number): void; format?: "auto" | "gif"; style?: "explode" | "drop" }) => {
          made.drawn++;
          made.styles?.push(o?.style ?? "explode");
          o?.progress?.(1, 2);
          o?.progress?.(2, 2);
          const mp4 = video && o?.format !== "gif";
          return mp4
            ? { blob: new Blob(["ftyp"], { type: "video/mp4" }), type: "video/mp4" as const, width: 800, height: 600, stamp: model.stamp }
            : { blob: new Blob(["GIF89a"], { type: "image/gif" }), type: "image/gif" as const, width: 800, height: 600, stamp: model.stamp };
        },
      }),
      readDoc: async () => null,
    }),
    loadModel: async () => model,
    saveModel: async () => {},
    uploadImage: async (file, options) => {
      if (refuseVideo && file.type === "video/mp4") throw new Error("Image type .mp4 not allowed");
      made.uploads.push({ name: file.name, type: file.type, ...(options?.replaces ? { replaces: options.replaces } : {}) });
      return `/projects/1/images/${++n}/view`;
    },
  };
}

const model = (stamp: number): LayersProjectModel => ({ version: 1, stamp, parts: [{ id: "a" }] });

describe("animated model links", () => {
  it("are marked with what they were drawn from", () => {
    expect(isAnimationUrl("/i/3/view#animated-model=abc")).toBe(true);
    expect(isAnimationUrl("/i/3/view#animated-video=abc")).toBe(true);
    expect(isAnimationUrl("/i/3/view#layers")).toBe(false);
    expect(isAnimationVideoUrl("/i/3/view#animated-video=abc")).toBe(true);
    expect(isAnimationVideoUrl("/i/3/view#animated-model=abc")).toBe(false);
    const text = "# Robot\n\n![Animated model](/i/3/view#animated-model=k1)\n\n![Photo](/p.png)\n";
    expect(animationsIn(text)).toEqual([{ url: "/i/3/view#animated-model=k1", key: "k1", at: 9 }]);
    expect(animationsIn("![Animated model](/i/4/view#animated-video=k2)")).toEqual([{ url: "/i/4/view#animated-video=k2", key: "k2", at: 0 }]);
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

  it("uploads an MP4 where the browser made one, marked as a video", async () => {
    const made: Made = { uploads: [], drawn: 0 };
    const v = viewOf("");
    await makeAnimatedModel(v, hostWith(model(5), made, { video: true }));
    expect(made.uploads).toEqual([{ name: "animated-model.mp4", type: "video/mp4" }]);
    expect(v.state.doc.toString()).toBe(`![Animated model](/projects/1/images/1/view#animated-video=${animationKey(model(5))})\n`);
  });

  it("falls back to a GIF when the server won't take the MP4", async () => {
    const made: Made = { uploads: [], drawn: 0 };
    const v = viewOf("");
    await makeAnimatedModel(v, hostWith(model(5), made, { video: true, refuseVideo: true }));
    expect(made.drawn).toBe(2);
    expect(made.uploads).toEqual([{ name: "animated-model.gif", type: "image/gif" }]);
    expect(v.state.doc.toString()).toBe(`![Animated model](/projects/1/images/1/view#animated-model=${animationKey(model(5))})\n`);
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

describe("/Dropping model", () => {
  it("is its own block command, found by the words people use", () => {
    const cmd = droppingModelCommand(hostWith(model(1), { uploads: [], drawn: 0 }));
    expect(cmd.label).toBe("Dropping model");
    expect(cmd.block).toBe(true);
    expect(cmd.keywords).toEqual(expect.arrayContaining(["drop", "bounce", "animation"]));
  });

  it("has its own key, which follows the build steps too", () => {
    const m = model(3);
    const key = animationKey(m, "drop");
    expect(animationStyleOf(key)).toBe("drop");
    expect(animationStyleOf(animationKey(m))).toBe("explode");
    expect(key).not.toBe(animationKey(m));
    expect(animationKey({ ...m, steps: [{ id: "s", parts: ["a"] }] }, "drop")).not.toBe(key);
    expect(isAnimationUrl(`/i/3/view#animated-video=${key}`)).toBe(true);
    expect(isAnimationVideoUrl(`/i/3/view#animated-video=${key}`)).toBe(true);
  });

  it("draws the drop style and puts it in where the cursor is", async () => {
    const made: Made = { uploads: [], drawn: 0, styles: [] };
    const v = viewOf("");
    await makeAnimatedModel(v, hostWith(model(5), made, { video: true }), "drop");
    expect(made.styles).toEqual(["drop"]);
    expect(made.uploads).toEqual([{ name: "dropping-model.mp4", type: "video/mp4" }]);
    expect(v.state.doc.toString()).toBe(`![Dropping model](/projects/1/images/1/view#animated-video=${animationKey(model(5), "drop")})\n`);
  });

  it("is redrawn in its own style when the model moves on, beside an animated model", async () => {
    const made: Made = { uploads: [], drawn: 0, styles: [] };
    const now = model(7);
    const host = hostWith(now, made);
    const v = viewOf("![Animated model](/projects/1/images/4/view#animated-model=old)\n\n![Dropping model](/projects/1/images/5/view#animated-model=dropold)\n");
    expect(await refreshAnimatedModels(v, host)).toBe(2);
    expect(made.styles).toEqual(["explode", "drop"]);
    expect(made.uploads.map(u => u.replaces)).toEqual(["/projects/1/images/4/view", "/projects/1/images/5/view"]);
    expect(v.state.doc.toString()).toBe(`![Animated model](/projects/1/images/1/view#animated-model=${animationKey(now)})\n\n![Dropping model](/projects/1/images/2/view#animated-model=${animationKey(now, "drop")})\n`);
    expect(await refreshAnimatedModels(v, host)).toBe(0);
  });
});
