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

  it("shows every Markdown topic in the guide, with the host's own after them", () => {
    const el = host();
    const editor = mount(el, {
      toolbar: ["guide"],
      guide: [{ title: "Bill of Materials", rows: [["| Qty | Price |", "Totals added up for you"]], note: "Under a ## Bill of Materials heading." }],
    });
    flushSync(() => el.querySelector<HTMLButtonElement>(".mde-tool-guide")!.click());
    const guide = document.querySelector(".mde-guide")!;
    const titles = [...guide.querySelectorAll("summary")].map((s) => s.textContent);
    expect(titles).toEqual(["Text", "Pictures", "Videos", "Callouts", "Tables", "Checking your writing", "Bill of Materials", "Shortcuts", "Type / for"]);
    expect(guide.querySelector("details")!.open).toBe(true);
    const text = guide.textContent!;
    for (const bit of ["{cover}", "> [!warning]-", "| :--- | :---: | ---: |", "| ## Title |", "<br>", "Split table here", "::: videos", "F7", "Totals added up for you"]) expect(text).toContain(bit);
    editor.destroy();
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

  it("lists the host's hints in the hints panel, even with writing hints off", () => {
    const el = host();
    const run = vi.fn();
    const editor = mount(el, { doc: "Text" });
    const button = () => el.querySelector<HTMLButtonElement>(".writing-lint .writing-toggle")!;
    expect(button().textContent).toBe("Hints");
    flushSync(() => editor.setHints([{ id: "bom", title: "2 parts aren't linked", detail: "In the Bill of Materials", actions: [{ label: "Show the bar", run }] }]));
    expect(button().textContent).toBe("1 hint");
    flushSync(() => button().click());
    expect(el.querySelector(".lint-host-title")?.textContent).toBe("2 parts aren't linked");
    flushSync(() => el.querySelector<HTMLButtonElement>(".lint-host-actions button")!.click());
    expect(run).toHaveBeenCalledOnce();
    expect(el.querySelector(".lint-panel")).toBeNull();
    flushSync(() => editor.setHints([]));
    expect(button().textContent).toBe("Hints");
    editor.destroy();
  });

  it("shows the host's save state as a cloud at the toolbar's end", () => {
    const el = host();
    const editor = mount(el, { doc: "Text", saveStatus: "saved" });
    const status = () => el.querySelector<HTMLElement>(".mde-toolbar .mde-save-status");
    expect(status()?.classList.contains("mde-save-saved")).toBe(true);
    expect(status()?.textContent).toBe("Saved");
    expect(status()?.title).toBe("All changes saved");
    flushSync(() => editor.setSaveStatus("saving"));
    expect(status()?.textContent).toBe("Saving…");
    expect(status()?.querySelector(".mde-save-turn")).not.toBeNull();
    flushSync(() => editor.setSaveStatus("error", "Couldn't save: you're offline"));
    expect(status()?.classList.contains("mde-save-error")).toBe(true);
    expect(status()?.title).toBe("Couldn't save: you're offline");
    expect(status()?.textContent).toContain("Not saved");
    flushSync(() => editor.setSaveStatus(null));
    expect(status()).toBeNull();
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

describe("tableNote", () => {
  const doc = "# BOM\n\n| Part | Qty |\n| --- | --- |\n| Cell | 2 |\n\n# Other\n\n| A |\n| --- |\n| b |\n";

  it("shows the host's note above the tables it picks", async () => {
    const el = host();
    let clicked = 0;
    const editor = mount(el, {
      doc,
      spellcheck: "off",
      tableNote: ({ rows, heading }) => {
        if (heading !== "BOM") return null;
        const note = document.createElement("div");
        note.className = "tip";
        note.textContent = "Columns: " + rows[0].join(", ");
        note.addEventListener("click", () => clicked++);
        return note;
      },
    });
    await new Promise((r) => setTimeout(r));
    const notes = Array.from(el.querySelectorAll<HTMLElement>(".cm-md-table-note"));
    expect(notes).toHaveLength(1);
    expect(notes[0].textContent).toBe("Columns: Part, Qty");
    expect(notes[0].nextElementSibling?.classList.contains("cm-md-table")).toBe(true);
    notes[0].querySelector<HTMLElement>(".tip")!.click();
    expect(clicked).toBe(1);
    editor.destroy();
  });
});
