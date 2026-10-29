// @vitest-environment happy-dom
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readDraft, writeDraft } from "./draft";
import { mount } from "./mount";

afterEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
});

function host() {
  const el = document.createElement("div");
  document.body.append(el);
  return el;
}

describe("mount", () => {
  it("puts the editor in the element and hands back the API", () => {
    const el = host();
    const changes: string[] = [];
    const editor = mount(el, { doc: "# Hello", onChange: (d) => changes.push(d), theme: "dark", minHeight: 200 });
    expect(el.classList.contains("mde")).toBe(true);
    expect(el.dataset.theme).toBe("dark");
    expect(el.style.getPropertyValue("--mde-min-height")).toBe("200px");
    expect(el.querySelector(".cm-editor")).not.toBeNull();
    expect(el.querySelector(".mde-toolbar")).not.toBeNull();
    expect(editor.getDoc()).toBe("# Hello");
    editor.setDoc("New text");
    expect(editor.getDoc()).toBe("New text");
    expect(changes).toEqual(["New text"]);
    editor.destroy();
    expect(el.classList.contains("mde")).toBe(false);
    expect(el.querySelector(".cm-editor")).toBeNull();
  });

  it("keeps a textarea in sync and gives it back on destroy", () => {
    const form = document.createElement("form");
    const area = document.createElement("textarea");
    area.value = "From the form";
    form.append(area);
    document.body.append(form);
    const editor = mount(area);
    expect(area.style.display).toBe("none");
    expect(editor.getDoc()).toBe("From the form");
    editor.replaceSelection("Typed. ");
    expect(area.value).toBe("Typed. From the form");
    editor.destroy();
    expect(area.style.display).toBe("");
    expect(form.querySelector(".mde")).toBeNull();
  });

  it("emits changes and lets listeners go", () => {
    const editor = mount(host(), { doc: "a" });
    const listener = vi.fn();
    const off = editor.on("change", listener);
    editor.setDoc("b");
    off();
    editor.setDoc("c");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith("b");
    editor.destroy();
  });

  it("builds the toolbar from the host's list, custom buttons included", () => {
    const run = vi.fn();
    const el = host();
    const editor = mount(el, { toolbar: ["bold", "|", { id: "diagram", label: "Diagram", icon: "M2 8h12", run }] });
    const buttons = [...el.querySelectorAll(".mde-toolbar button")].map((b) => b.getAttribute("aria-label"));
    expect(buttons).toEqual(["Bold", "Diagram"]);
    el.querySelector<HTMLButtonElement>(".mde-tool-diagram")!.click();
    expect(run).toHaveBeenCalledWith(editor, el.querySelector(".mde-tool-diagram"));
    editor.destroy();
  });

  it("turns line numbers on and off in the live view", () => {
    const el = host();
    const editor = mount(el, { doc: "one\ntwo", toolbar: ["line-numbers"] });
    expect(el.querySelector(".cm-lineNumbers")).toBeNull();
    const button = el.querySelector<HTMLButtonElement>(".mde-tool-line-numbers")!;
    flushSync(() => button.click());
    expect(el.querySelector(".cm-lineNumbers")).not.toBeNull();
    expect(button.getAttribute("aria-pressed")).toBe("true");
    flushSync(() => editor.setLineNumbers(false));
    expect(el.querySelector(".cm-lineNumbers")).toBeNull();
    editor.destroy();
    const numbered = mount(host(), { lineNumbers: true });
    expect(numbered.element.querySelector(".cm-lineNumbers")).not.toBeNull();
    numbered.destroy();
  });

  it("offers a stored draft back, and restores it", () => {
    writeDraft("post", "Unsaved words");
    const el = host();
    const editor = mount(el, { doc: "Saved words", draft: { key: "post" } });
    const bar = el.querySelector(".mde-draft-bar");
    expect(bar?.textContent).toContain("Restore it?");
    bar!.querySelector<HTMLButtonElement>("button.primary")!.click();
    expect(editor.getDoc()).toBe("Unsaved words");
    editor.clearDraft();
    expect(readDraft("post")).toBeNull();
    editor.destroy();
  });

  it("finds its element by selector, and says when there's none", () => {
    expect(() => mount("#nowhere")).toThrow(/no element/);
  });
});

describe("tableRenderer", () => {
  const doc = "# Videos\n\n| Video | Title |\n| --- | --- |\n| https://youtu.be/abc | Demo |\n\n# Other\n\n| A |\n| --- |\n| b |\n";

  it("draws the host's version of a table until it's edited", async () => {
    const el = host();
    const seen: (string | null)[] = [];
    const editor = mount(el, {
      doc,
      spellcheck: "off",
      tableRenderer: ({ rows, heading }) => {
        seen.push(heading);
        if (heading !== "Videos") return null;
        const gallery = document.createElement("div");
        gallery.className = "gallery";
        gallery.textContent = rows.slice(1).map((row) => row[1]).join(", ");
        return gallery;
      },
    });
    await new Promise((r) => setTimeout(r));
    const [videos, other] = Array.from(el.querySelectorAll<HTMLElement>(".cm-md-table"));
    expect(seen).toContain("Other");
    expect(videos.classList.contains("previewing")).toBe(true);
    expect(videos.querySelector(".gallery")?.textContent).toBe("Demo");
    expect(videos.querySelector("table")).toBeNull();
    expect(other.classList.contains("previewing")).toBe(false);
    expect(other.querySelector("table")).not.toBeNull();

    // Clicking the drawing edits the table in its grid.
    videos.querySelector<HTMLElement>(".cm-md-table-preview")!.click();
    expect(videos.classList.contains("previewing")).toBe(false);
    expect(videos.querySelector("table")).not.toBeNull();
    expect(document.activeElement?.textContent).toBe("https://youtu.be/abc");

    // Leaving it draws it again.
    const cell = document.activeElement as HTMLElement;
    cell.blur();
    cell.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await new Promise((r) => setTimeout(r));
    expect(videos.classList.contains("previewing")).toBe(true);
    editor.destroy();
  });
});
