// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { modelCommand, openModel, type LayersHost, type LayersProjectModel } from "./layersBlock";

const viewOf = (doc: string, at = doc.length) => new EditorView({ state: EditorState.create({ doc, selection: EditorSelection.cursor(at), extensions: [markdown({ base: markdownLanguage })] }) });
const model: LayersProjectModel = { version: 1, stamp: 5, parts: [{ id: "a" }] };

/** A host whose Layers "opens" the model and, with `save`, saves it as Done would. */
function hostWith(opened: { n: number; saved: number }, { save = false, can = true } = {}): LayersHost {
  return {
    load: async () => ({
      mount: (_el: HTMLElement, o: Record<string, unknown>) => ({
        setMode() {},
        mode: () => "inline" as const,
        destroy() {},
        focus() {},
        ...(can
          ? {
              editModel: async () => {
                opened.n++;
                if (save) await (o.saveModel as (m: LayersProjectModel) => Promise<void>)({ ...model, stamp: 6 });
                return save;
              },
            }
          : {}),
      }),
      readDoc: async () => null,
    }),
    loadModel: async () => model,
    saveModel: async () => {
      opened.saved++;
    },
    uploadImage: async () => "/x",
  };
}

describe("/Model", () => {
  it("is offered as Model", () => {
    const cmd = modelCommand(hostWith({ n: 0, saved: 0 }));
    expect(cmd.id).toBe("model");
    expect(cmd.label).toBe("Model");
    expect(cmd.block).toBe(true);
  });

  it("opens the project's model and puts nothing in the page", async () => {
    const seen = { n: 0, saved: 0 };
    const view = viewOf("# Robot\n\n");
    await openModel(view, hostWith(seen, { save: true }));
    expect(seen).toEqual({ n: 1, saved: 1 });
    expect(view.state.doc.toString()).toBe("# Robot\n\n");
  });

  it("says so in the page when Layers can't open the model", async () => {
    const view = viewOf("# Robot\n\n");
    await openModel(view, hostWith({ n: 0, saved: 0 }, { can: false }));
    expect(view.state.doc.toString()).toContain("*The model couldn't be opened:");
  });

  it("does nothing in a page without a project model", async () => {
    const seen = { n: 0, saved: 0 };
    const view = viewOf("x");
    await openModel(view, { ...hostWith(seen), saveModel: undefined });
    expect(seen.n).toBe(0);
  });
});
