// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { linkForm } from "./linkPopover";
import { findLinkTargets } from "./linkTargets";

const targets = findLinkTargets("# Overview\n## Wiring the board\n<!-- page -->\n# Code", true);

function form(draft = { text: "", url: "" }) {
  const save = vi.fn();
  const dom = linkForm(draft, save, () => {}, targets);
  document.body.append(dom);
  const [text, url] = Array.from(dom.querySelectorAll("input"));
  const list = dom.querySelector<HTMLElement>(".cm-link-targets")!;
  const options = () => Array.from(list.querySelectorAll<HTMLElement>("[role=option]"));
  const type = (value: string) => {
    url.value = value;
    url.dispatchEvent(new Event("input"));
  };
  const key = (k: string) => url.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  return { dom, save, text, url, list, options, type, key };
}

afterEach(() => document.body.replaceChildren());

describe("link form targets", () => {
  it("lists the pages and headings while the URL field is empty", () => {
    const f = form();
    f.url.focus();
    expect(f.list.hidden).toBe(false);
    expect(f.options().map((o) => o.querySelector(".cm-link-target-text")?.textContent)).toEqual(["Page 1", "Overview", "Wiring the board", "Page 2", "Code"]);
  });

  it("narrows as you type, and Enter links to the best match, naming the link after it", () => {
    const f = form();
    f.url.focus();
    f.type("#board");
    expect(f.options()).toHaveLength(1);
    f.key("Enter");
    expect(f.save).toHaveBeenCalledWith("[Wiring the board](#wiring-the-board)");
  });

  it("keeps the text already typed", () => {
    const f = form({ text: "see wiring", url: "" });
    f.url.focus();
    f.options()[2].click();
    expect(f.save).toHaveBeenCalledWith("[see wiring](#wiring-the-board)");
  });

  it("names a page link after the page's first heading", () => {
    const f = form();
    f.url.focus();
    f.options()[3].click();
    expect(f.save).toHaveBeenCalledWith("[Code](#page-2)");
  });

  it("hides for a URL, and Escape hides it first", () => {
    const f = form();
    f.url.focus();
    f.type("https://kevsrobots.com");
    expect(f.list.hidden).toBe(true);
    f.type("");
    expect(f.list.hidden).toBe(false);
    f.key("Escape");
    expect(f.list.hidden).toBe(true);
  });

  it("moves with the arrow keys", () => {
    const f = form();
    f.url.focus();
    f.key("ArrowDown");
    f.key("ArrowDown");
    expect(f.options()[1].getAttribute("aria-selected")).toBe("true");
    f.key("Enter");
    expect(f.save).toHaveBeenCalledWith("[Overview](#overview)");
  });

  it("has no list without targets", () => {
    const dom = linkForm({ text: "", url: "" }, () => {}, () => {});
    expect(dom.querySelector(".cm-link-targets")).toBeNull();
  });
});
