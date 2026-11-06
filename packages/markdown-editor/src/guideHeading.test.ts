// @vitest-environment happy-dom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { upgradeGuideHeading } from "./layersBlock";

const viewOf = (doc: string) => new EditorView({ state: EditorState.create({ doc }) });

describe("upgradeGuideHeading", () => {
  it("makes a drawn guide under a heading two its own heading-one section", () => {
    const v = viewOf("# Robot\n\n# Bill of Materials\n\n| a |\n\n## Assembly guide\n\n![Cover](/c.png#layers)\n");
    expect(upgradeGuideHeading(v)).toBe(true);
    expect(v.state.doc.toString()).toBe("# Robot\n\n# Bill of Materials\n\n| a |\n\n# Assembly guide\n\n![Cover](/c.png#layers)\n");
    expect(upgradeGuideHeading(v)).toBe(false);
  });
  it("leaves a heading with words under it alone", () => {
    const v = viewOf("## Assembly guide\n\nWritten by hand.\n");
    expect(upgradeGuideHeading(v)).toBe(false);
  });
});
