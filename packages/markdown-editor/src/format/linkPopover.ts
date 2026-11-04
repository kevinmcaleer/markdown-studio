import { syntaxTree } from "@codemirror/language";
import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, showTooltip, type Tooltip } from "@codemirror/view";
import { linkPrompt } from "./formatting";
import { filterTargets, linkTargets, targetFor, targetQuery, type LinkTarget } from "./linkTargets";

// The link popover: Mod-K or the Link button asks for the URL and the text in
// a small form at the cursor, the way EasyMDE's promptURLs does, instead of
// leaving "https://" to type over. With the cursor in a link, it edits that link.
//
// With the caret on a link, or on a bare URL pasted in from a spreadsheet, a
// card shows under it as in Google Docs: the link, and buttons to copy it,
// edit it (give a bare URL a name) or remove it, keeping its text.
//
// When the host turns on link targets (linkTargets.ts), the URL field offers
// the text's own headings, and its pages, in a short list under it: shown
// while the field is empty or starts with "#", and narrowed as the writer
// types a heading's words. A pasted URL hides it. A `#heading` link's card
// takes the caret to that heading.

export type LinkDraft = { from: number; to: number; text: string; url: string };

/** A link in the text: its range, its text and URL, its text's Markdown, and whether it's a bare URL. */
export type LinkAt = LinkDraft & { label: string; bare: boolean };

const open = StateEffect.define<LinkDraft>();
const close = StateEffect.define<null>();
const dismiss = StateEffect.define<null>();
const focused = StateEffect.define<boolean>();

const URL_LIKE = /^(?:https?:\/\/|mailto:|\.{0,2}\/|#)\S*$/i;

const unescape = (text: string) => text.replace(/\\([[\]])/g, "$1");

/** The link, autolink or bare URL the selection is in, or null. */
export function linkAtCursor(state: EditorState): LinkAt | null {
  const { from, to } = state.selection.main;
  for (let node: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(from, -1); node; node = node.parent) {
    if (node.from > from || node.to < to) continue;
    if (node.name === "Link") {
      const marks = node.getChildren("LinkMark");
      const url = node.getChild("URL");
      if (marks.length < 2) return null;
      const label = state.sliceDoc(marks[0].to, marks[1].from);
      // A callout's `[!type]` reads as a shortcut link; it has its type picker instead.
      if (!url && /^![\w-]*$/.test(label)) return null;
      return { from: node.from, to: node.to, text: unescape(label), label, url: url ? state.sliceDoc(url.from, url.to) : "", bare: false };
    }
    if (node.name === "Autolink" || (node.name === "URL" && !/^(Link|Autolink|Image)$/.test(node.parent?.name ?? ""))) {
      const url = state.sliceDoc(node.from, node.to).replace(/^<|>$/g, "");
      return { from: node.from, to: node.to, text: "", label: url, url, bare: true };
    }
    if (node.name === "Image") return null;
  }
  return null;
}

/** The link in a line of plain Markdown (a table cell, say) that `offset` touches, or null. */
export function linkInText(text: string, offset: number): LinkAt | null {
  const found: LinkAt[] = [];
  const link = /(!?)\[((?:\\.|[^\\\]])*)\]\(\s*<?([^\s)>]*)>?(?:\s+"[^"]*")?\s*\)/g;
  const images: { from: number; to: number }[] = [];
  for (let m; (m = link.exec(text)); ) {
    if (m[1]) images.push({ from: m.index, to: m.index + m[0].length });
    else found.push({ from: m.index, to: m.index + m[0].length, text: unescape(m[2]), label: m[2], url: m[3], bare: false });
  }
  const taken = (at: number) => [...found, ...images].some((l) => at >= l.from && at < l.to);
  const auto = /<((?:https?:|mailto:)[^\s>]+)>|(?:https?:\/\/|www\.)[^\s<]+/gi;
  for (let m; (m = auto.exec(text)); ) {
    if (taken(m.index)) continue;
    let url = m[1] ?? trimUrl(m[0]);
    const to = m[1] ? m.index + m[0].length : m.index + url.length;
    if (!m[1] && url.startsWith("www.")) url = `https://${url}`;
    found.push({ from: m.index, to, text: "", label: text.slice(m.index, to), url, bare: true });
  }
  return found.find((l) => offset >= l.from && offset <= l.to) ?? null;
}

/** A bare URL without the punctuation after it, and without a ")" it didn't open. */
function trimUrl(url: string): string {
  for (;;) {
    const trimmed = url.replace(/[.,:;!?'"*_~]+$/, "");
    const unopened = trimmed.endsWith(")") && (trimmed.match(/\(/g) ?? []).length < (trimmed.match(/\)/g) ?? []).length;
    const next = unopened ? trimmed.slice(0, -1) : trimmed;
    if (next === url) return url;
    url = next;
  }
}

/** What the popover starts with: the link at the cursor, or the selected text (or URL). */
export function linkDraft(state: EditorState): LinkDraft {
  const { from, to } = state.selection.main;
  const link = linkAtCursor(state);
  if (link) return { from: link.from, to: link.to, text: link.text, url: link.url };
  const picked = state.sliceDoc(from, to);
  if (picked.includes("\n")) return { from: to, to, text: "", url: "" };
  const trimmed = picked.trim();
  return URL_LIKE.test(trimmed) && trimmed ? { from, to, text: "", url: trimmed } : { from, to, text: picked, url: "" };
}

/** The Markdown for a link; brackets in the text and spaces in the URL are escaped. */
export function linkMarkdown(text: string, url: string): string {
  const label = (text.trim() || url.trim()).replace(/([[\]])/g, "\\$1");
  const target = url.trim().replace(/[\s()]/g, encodeURIComponent);
  return `[${label}](${target})`;
}

/** "kevsrobots.com/projects/…" for showing a URL in a small space. */
export function shortUrl(url: string): string {
  const short = url.replace(/^(?:https?:\/\/)?(?:www\.)?/i, "").replace(/^mailto:/i, "");
  return short.length > 42 ? `${short.slice(0, 40)}…` : short;
}

const field = StateField.define<{ draft: LinkDraft; tooltip: Tooltip } | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(close)) return null;
      if (e.is(open)) return { draft: e.value, tooltip: { pos: e.value.from, above: false, create: (view) => formTooltip(view, e.value) } };
    }
    if (value && tr.docChanged) return null;
    return value;
  },
  provide: (f) => showTooltip.from(f, (v) => v?.tooltip ?? null),
});

type Card = { focused: boolean; dismissed: boolean; link: LinkAt | null; tooltip: Tooltip | null };

const sameLink = (a: LinkAt | null, b: LinkAt | null) =>
  a === b || (!!a && !!b && a.from === b.from && a.to === b.to && a.url === b.url && a.label === b.label);

/** The card for the link the caret is on, while the editor has the focus and the form isn't open. */
const cardField = StateField.define<Card>({
  create: () => ({ focused: false, dismissed: false, link: null, tooltip: null }),
  update(card, tr) {
    let { focused: hasFocus, dismissed } = card;
    for (const e of tr.effects) {
      if (e.is(focused)) hasFocus = e.value;
      if (e.is(dismiss)) dismissed = true;
    }
    const caret = tr.state.selection.main;
    const link = caret.empty && !tr.state.field(field) ? linkAtCursor(tr.state) : null;
    if (!sameLink(link, card.link)) dismissed = false;
    else if (hasFocus === card.focused && dismissed === card.dismissed) return card;
    const show = link && hasFocus && !dismissed;
    const tooltip = !show ? null : sameLink(link, card.link) && card.tooltip ? card.tooltip : cardTooltip(link);
    return { focused: hasFocus, dismissed, link, tooltip };
  },
  provide: (f) => showTooltip.from(f, (v) => v.tooltip),
});

function cardTooltip(link: LinkAt): Tooltip {
  return {
    pos: link.from,
    above: false,
    create: (view) => {
      const editable = !view.state.readOnly;
      const remove = () => {
        // Back to its text: the Markdown inside the brackets.
        view.dispatch({
          changes: { from: link.from, to: link.to, insert: link.label },
          selection: { anchor: link.from + link.label.length },
          userEvent: "delete.link",
        });
        view.focus();
      };
      const dom = linkCard(link, {
        edit: editable ? () => openLinkPopover(view) : undefined,
        remove: editable && !link.bare ? remove : undefined,
        ...internalLink(view, link.url),
      });
      return { dom };
    },
  };
}

const ICONS = {
  link: "M6.5 9.5l3-3M7.5 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M8.5 11.5l-1 1a2.5 2.5 0 0 1-3.5-3.5l1-1",
  copy: "M5.5 5.5h7v7h-7zM3.5 10.5v-7h7",
  check: "M3.5 8.5l3 3 6-7",
  edit: "M10.5 3l2.5 2.5-7 7-3 .5.5-3z",
  unlink: "M7.5 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M8.5 11.5l-1 1a2.5 2.5 0 0 1-3.5-3.5l1-1M2.5 2.5l11 11",
};

const icon = (path: string) =>
  `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function iconButton(label: string, path: string, run: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.innerHTML = icon(path);
  // Keep the caret where it is (in the note, or in a table cell).
  button.addEventListener("mousedown", (e) => e.preventDefault());
  button.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    run();
  });
  return button;
}

/** For a `#id` link, when the host has link targets: what it goes to, and a way there. */
export function internalLink(view: EditorView, url: string): { go?: () => void; goes?: string } {
  if (!url.startsWith("#")) return {};
  const targets = linkTargets(view.state);
  if (!targets.length) return {};
  const target = targetFor(targets, url);
  if (!target) return { goes: `No heading ${url} in this project` };
  return { go: () => goToTarget(view, url), goes: target.kind === "page" ? `Goes to page ${target.page}` : `Goes to “${target.text}”` };
}

/** The card for a link: where it goes, and copy, edit and remove buttons. `go` follows a link within the text. */
export function linkCard(link: LinkAt, actions: { edit?: () => void; remove?: () => void; go?: () => void; goes?: string }): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "cm-link-card";
  dom.setAttribute("role", "dialog");
  dom.setAttribute("aria-label", "Link");
  dom.addEventListener("mousedown", (e) => {
    if (!(e.target as HTMLElement).closest("a")) e.preventDefault();
  });
  const mark = document.createElement("span");
  mark.className = "cm-link-card-icon";
  mark.innerHTML = icon(ICONS.link);

  const main = document.createElement("div");
  main.className = "cm-link-card-main";
  const followable = /^(?:https?:|mailto:)/i.test(link.url);
  const title = document.createElement(followable ? "a" : actions.go ? "button" : "span");
  title.className = "cm-link-card-title";
  title.textContent = link.text.trim() || shortUrl(link.url) || "Empty link";
  if (title instanceof HTMLAnchorElement) {
    title.href = link.url;
    title.target = "_blank";
    title.rel = "noopener noreferrer";
    title.title = `Open ${link.url}`;
  }
  if (title instanceof HTMLButtonElement && actions.go) {
    const go = actions.go;
    title.type = "button";
    title.title = "Go to it";
    title.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      go();
    });
  }
  const where = document.createElement("span");
  where.className = "cm-link-card-url";
  where.textContent = actions.goes ?? (link.text.trim() ? shortUrl(link.url) : link.bare ? "No name yet" : "");
  if (actions.goes && !actions.go) where.classList.add("cm-link-card-missing");
  main.append(title, ...(where.textContent ? [where] : []));

  const tools = document.createElement("div");
  tools.className = "cm-link-card-tools";
  const copy = iconButton("Copy link", ICONS.copy, () => {
    void navigator.clipboard?.writeText(link.url);
    copy.innerHTML = icon(ICONS.check);
    copy.title = "Copied";
    window.setTimeout(() => {
      copy.innerHTML = icon(ICONS.copy);
      copy.title = "Copy link";
    }, 1200);
  });
  tools.append(copy);
  if (actions.edit) tools.append(iconButton(link.bare ? "Name this link" : "Edit link", ICONS.edit, actions.edit));
  if (actions.remove) tools.append(iconButton("Remove link", ICONS.unlink, actions.remove));
  dom.append(mark, main, tools);
  return dom;
}

/** The form for a link's text and URL. */
export function linkForm(
  draft: { text: string; url: string },
  save: (markdown: string) => void,
  cancel: () => void,
  targets: LinkTarget[] = [],
): HTMLFormElement {
  const dom = document.createElement("form");
  dom.className = "cm-link-popover";
  dom.setAttribute("aria-label", "Link");
  const row = (label: string, value: string, placeholder: string) => {
    const wrap = document.createElement("label");
    const name = document.createElement("span");
    name.textContent = label;
    const input = document.createElement("input");
    input.value = value;
    input.placeholder = placeholder;
    input.spellcheck = false;
    wrap.append(name, input);
    dom.append(wrap);
    return input;
  };
  const text = row("Text", draft.text, "Link text");
  // A text field rather than type="url", which turns away site-relative
  // links ("/projects", "./notes.md", "#parts"); inputMode keeps the URL keyboard.
  const url = row("URL", draft.url, targets.length ? "Paste a link, or find a heading" : "https://… or /page");
  url.inputMode = "url";
  url.autocapitalize = "off";
  const list = targets.length ? targetList(url, targets, (t) => {
    url.value = `#${t.id}`;
    if (!text.value.trim()) text.value = t.kind === "page" && t.title ? t.title : t.text;
    save(linkMarkdown(text.value, url.value));
  }) : null;
  if (list) dom.append(list);
  const actions = document.createElement("div");
  actions.className = "cm-link-actions";
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.textContent = "Cancel";
  const saveButton = document.createElement("button");
  saveButton.type = "submit";
  saveButton.className = "primary";
  saveButton.textContent = draft.url ? "Save" : "Insert";
  actions.append(cancelButton, saveButton);
  dom.append(actions);

  cancelButton.addEventListener("click", cancel);
  dom.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !e.defaultPrevented) {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  });
  dom.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!url.value.trim()) return url.focus();
    save(linkMarkdown(text.value, url.value));
  });
  // Start where there's something to type: the URL, unless it's already there.
  queueMicrotask(() => (draft.url && !draft.text ? text : url).focus());
  return dom;
}

const PAGE_ICON = "M4.5 2.5h5l2 2v9h-7zM9.5 2.5v2h2";

/**
 * The list of headings and pages under the URL field. It shows while the
 * field has the focus and holds nothing, a "#…" or plain words, and hides for
 * a URL. Up and Down move through it, Enter or a click picks, Escape hides it.
 */
function targetList(url: HTMLInputElement, targets: LinkTarget[], pick: (t: LinkTarget) => void): HTMLElement {
  const box = document.createElement("div");
  box.className = "cm-link-targets";
  box.hidden = true;
  const caption = document.createElement("div");
  caption.className = "cm-link-targets-caption";
  caption.textContent = "In this project";
  const ul = document.createElement("ul");
  ul.setAttribute("role", "listbox");
  ul.id = `cm-link-targets-${Math.random().toString(36).slice(2, 9)}`;
  ul.setAttribute("aria-label", "Headings in this project");
  box.append(caption, ul);
  url.setAttribute("role", "combobox");
  url.setAttribute("aria-autocomplete", "list");
  url.setAttribute("aria-controls", ul.id);
  url.setAttribute("aria-expanded", "false");
  // Keep the focus in the URL field when the list is clicked.
  box.addEventListener("mousedown", (e) => e.preventDefault());

  const paged = targets.some((t) => t.kind === "page");
  const top = Math.min(...targets.filter((t) => t.kind === "heading").map((t) => t.level), 6);
  let shown: LinkTarget[] = [];
  let active = -1;
  let hushed = false;

  const mark = () => {
    ul.querySelectorAll<HTMLElement>("[role=option]").forEach((li, i) => {
      li.setAttribute("aria-selected", String(i === active));
      if (i === active) {
        url.setAttribute("aria-activedescendant", li.id);
        li.scrollIntoView({ block: "nearest" });
      }
    });
    if (active < 0) url.removeAttribute("aria-activedescendant");
  };

  const render = () => {
    const query = targetQuery(url.value);
    const open = document.activeElement === url && !hushed && query !== null;
    shown = open ? filterTargets(targets, query) : [];
    box.hidden = !shown.length;
    url.setAttribute("aria-expanded", String(!box.hidden));
    ul.replaceChildren(
      ...shown.map((t, i) => {
        const li = document.createElement("li");
        li.id = `${ul.id}-${i}`;
        li.setAttribute("role", "option");
        li.className = `cm-link-target cm-link-target-${t.kind}`;
        // Headings sit under their page and under the heading above them.
        const depth = t.kind === "page" ? 0 : Math.max(0, t.level - top) + (paged ? 1 : 0);
        li.style.setProperty("--depth", String(query ? (t.kind === "page" ? 0 : Math.min(depth, 1)) : depth));
        const glyph = document.createElement("span");
        glyph.className = "cm-link-target-icon";
        if (t.kind === "page") glyph.innerHTML = icon(PAGE_ICON);
        else glyph.textContent = "#";
        const name = document.createElement("span");
        name.className = "cm-link-target-text";
        name.textContent = t.text;
        li.append(glyph, name);
        // While searching, a page names its first heading and a heading its page
        // (otherwise they sit together in the list already).
        const hint = !query ? "" : t.kind === "page" ? t.title : paged ? `Page ${t.page}` : "";
        if (hint) {
          const note = document.createElement("span");
          note.className = "cm-link-target-hint";
          note.textContent = hint;
          li.append(note);
        }
        li.title = `#${t.id}`;
        li.addEventListener("click", () => pick(t));
        li.addEventListener("mousemove", () => {
          if (active !== i) {
            active = i;
            mark();
          }
        });
        return li;
      }),
    );
    // Typing a heading's words picks the best match; an empty field picks nothing yet.
    active = query && shown.length ? 0 : -1;
    mark();
  };

  url.addEventListener("focus", render);
  url.addEventListener("blur", () => {
    box.hidden = true;
    url.setAttribute("aria-expanded", "false");
  });
  url.addEventListener("input", () => {
    hushed = false;
    render();
  });
  url.addEventListener("keydown", (e) => {
    if (box.hidden) {
      if (e.key === "ArrowDown" && hushed) {
        hushed = false;
        render();
        e.preventDefault();
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      active = active < 0 ? (step > 0 ? 0 : shown.length - 1) : (active + step + shown.length) % shown.length;
      mark();
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      pick(shown[active]);
    } else if (e.key === "Escape") {
      // First Escape hides the list; the next one closes the form.
      e.preventDefault();
      e.stopPropagation();
      hushed = true;
      render();
    }
  });
  return box;
}

function formTooltip(view: EditorView, draft: LinkDraft) {
  const dom = linkForm(
    draft,
    (insert) => {
      view.dispatch({
        changes: { from: draft.from, to: draft.to, insert },
        selection: { anchor: draft.from + insert.length },
        effects: close.of(null),
        userEvent: "input",
        scrollIntoView: true,
      });
      view.focus();
    },
    () => {
      view.dispatch({ effects: close.of(null) });
      view.focus();
    },
    linkTargets(view.state),
  );
  return { dom };
}

/** Takes the caret to the heading (or page) a `#id` link goes to; false if the text hasn't got it. */
export function goToTarget(view: EditorView, url: string): boolean {
  const target = targetFor(linkTargets(view.state), url);
  if (!target) return false;
  view.dispatch({ selection: { anchor: target.from }, effects: EditorView.scrollIntoView(target.from, { y: "start", yMargin: 80 }) });
  view.focus();
  return true;
}

/** Opens the popover for the selection. False in a read-only editor. */
export function openLinkPopover(view: EditorView): boolean {
  if (view.state.readOnly) return false;
  view.dispatch({ effects: open.of(linkDraft(view.state)) });
  return true;
}

/** Whether the editor has the link popover, so a table cell can offer it too. */
export function hasLinkPopover(state: EditorState): boolean {
  return state.field(field, false) !== undefined;
}

const theme = EditorView.theme({
  ".cm-tooltip.cm-link-popover": {
    display: "grid",
    gap: "0.45rem",
    width: "19rem",
    padding: "0.65rem",
    border: "1px solid var(--border)",
    borderRadius: "10px",
    background: "var(--surface)",
    boxShadow: "0 8px 28px rgb(0 0 0 / 0.14)",
    fontFamily: "var(--font-sans)",
    fontSize: "13px",
    color: "var(--text)",
  },
  ".cm-link-popover label": { display: "grid", gridTemplateColumns: "2.6rem 1fr", alignItems: "center", gap: "0.4rem" },
  ".cm-link-popover label > span": { color: "var(--muted)" },
  ".cm-link-popover input": {
    font: "inherit",
    padding: "0.3rem 0.45rem",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    background: "var(--bg)",
    color: "var(--text)",
    minWidth: "0",
  },
  ".cm-link-popover input:focus": { outline: "2px solid color-mix(in srgb, var(--accent) 45%, transparent)", outlineOffset: "0" },
  ".cm-link-actions": { display: "flex", justifyContent: "flex-end", gap: "0.35rem" },
  ".cm-link-actions button": {
    font: "inherit",
    padding: "0.25rem 0.7rem",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    background: "var(--surface)",
    color: "var(--text)",
    cursor: "pointer",
  },
  ".cm-link-actions button.primary": { background: "var(--accent)", borderColor: "var(--accent)", color: "var(--accent-text, #fff)" },
  ".cm-tooltip.cm-link-card": {
    display: "flex",
    alignItems: "center",
    gap: "0.55rem",
    maxWidth: "22rem",
    padding: "0.45rem 0.45rem 0.45rem 0.65rem",
    border: "1px solid var(--border)",
    borderRadius: "10px",
    background: "var(--surface)",
    boxShadow: "0 8px 28px rgb(0 0 0 / 0.14)",
    fontFamily: "var(--font-sans)",
    fontSize: "13px",
    color: "var(--text)",
  },
  ".cm-link-card-icon": { display: "flex", color: "var(--muted)", flex: "none" },
  ".cm-link-card-main": { display: "grid", minWidth: "0", flex: "1", lineHeight: "1.35" },
  ".cm-link-card-title": {
    color: "var(--accent)",
    fontWeight: "600",
    textDecoration: "none",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  "a.cm-link-card-title:hover, button.cm-link-card-title:hover": { textDecoration: "underline" },
  "button.cm-link-card-title": { font: "inherit", padding: "0", border: "0", background: "none", cursor: "pointer", textAlign: "left" },
  ".cm-link-card-missing": { color: "var(--danger, #b42318)" },
  ".cm-link-targets": { display: "grid", gap: "0.2rem", margin: "-0.1rem 0 0 3rem" },
  ".cm-link-targets[hidden]": { display: "none" },
  ".cm-link-targets-caption": { fontSize: "11px", fontWeight: "600", letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--muted)" },
  ".cm-link-targets ul": {
    listStyle: "none",
    margin: "0",
    padding: "0.2rem",
    maxHeight: "12.5rem",
    overflowY: "auto",
    border: "1px solid var(--border)",
    borderRadius: "8px",
    background: "var(--bg)",
  },
  ".cm-link-target": {
    display: "flex",
    alignItems: "center",
    gap: "0.4rem",
    padding: "0.28rem 0.45rem",
    paddingLeft: "calc(0.45rem + var(--depth, 0) * 0.85rem)",
    borderRadius: "6px",
    cursor: "pointer",
    lineHeight: "1.3",
  },
  ".cm-link-target[aria-selected=true]": { background: "color-mix(in srgb, var(--accent) 14%, transparent)" },
  ".cm-link-target-icon": {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "14px",
    flex: "none",
    color: "var(--muted)",
    fontFamily: "var(--font-mono, monospace)",
    fontSize: "12px",
  },
  ".cm-link-target-icon svg": { width: "14px", height: "14px" },
  ".cm-link-target-text": { flex: "1", minWidth: "0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  ".cm-link-target-page .cm-link-target-text": { fontWeight: "600" },
  ".cm-link-target-hint": { flex: "none", maxWidth: "45%", color: "var(--muted)", fontSize: "12px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  ".cm-link-card-url": { color: "var(--muted)", fontSize: "12px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  ".cm-link-card-tools": { display: "flex", gap: "2px", flex: "none" },
  ".cm-link-card-tools button": {
    display: "grid",
    placeItems: "center",
    width: "28px",
    height: "28px",
    padding: "0",
    border: "0",
    borderRadius: "50%",
    background: "transparent",
    color: "var(--text)",
    cursor: "pointer",
  },
  ".cm-link-card-tools button:hover": { background: "color-mix(in srgb, var(--text) 9%, transparent)" },
  // In a table cell, the card and the form sit in the table's own layer.
  // The table's own button styles (absolute, hidden until hover) are put back.
  ".cm-md-table-link": { position: "absolute", zIndex: "20" },
  ".cm-md-table .cm-md-table-link button": { position: "static", opacity: "1" },
  ".cm-md-table .cm-link-card-tools button": { border: "0", background: "transparent", color: "var(--text)" },
  ".cm-md-table .cm-link-card-tools button:hover": { background: "color-mix(in srgb, var(--text) 9%, transparent)" },
  ".cm-md-table .cm-link-actions button": { display: "inline-block", padding: "0.25rem 0.7rem", background: "var(--surface)", color: "var(--text)" },
  ".cm-md-table .cm-link-actions button.primary": { background: "var(--accent)", borderColor: "var(--accent)", color: "var(--accent-text, #fff)" },
});

/** Mod-K and the Link buttons open a popover for the URL and text; a link under the caret shows its card. */
export function linkPopover(): Extension {
  return [
    field,
    cardField,
    theme,
    linkPrompt.of(openLinkPopover),
    EditorView.focusChangeEffect.of((_state, focusing) => focused.of(focusing)),
    keymap.of([
      {
        key: "Escape",
        run: (view) => {
          if (!view.state.field(cardField).tooltip) return false;
          view.dispatch({ effects: dismiss.of(null) });
          return true;
        },
      },
    ]),
  ];
}
