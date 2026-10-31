import { Facet, StateField, type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { cardHtml, cardMarkdown, cardsBlockMarkdown, findCardBlocks, parseCard, type Card } from "./cards";
import "./cards.css";
import { renderMarkdown } from "./markdown";
import { rememberedHeight, rememberHeight, sizePictures } from "./steadyScroll";

// In the live view a `::: cards` block (see cards.ts) shows as its cards, and
// is built by pointing and clicking: click a card to give it a picture, a
// title and some words; its buttons move it or remove it; "Add card" adds
// one; the bar sets how many across. Every change is written straight into
// the Markdown, and the bar's "Markdown" button shows those lines (moving the
// cursor into the block does too, as with a gallery) until "Show cards".

/** Picks a picture for a card: the host's image picker, beside `anchor`. Without one, a card takes a picture's address. */
export type CardPicturePicker = (anchor: HTMLElement, done: (picture: { src: string; alt: string }) => void) => void;
export const cardPicturePicker = Facet.define<CardPicturePicker, CardPicturePicker | null>({ combine: (all) => all[0] ?? null });

const COLUMN_CHOICES: { columns: number; label: string; title: string }[] = [
  { columns: 0, label: "Fit", title: "As many across as fit" },
  { columns: 2, label: "2", title: "Two across" },
  { columns: 3, label: "3", title: "Three across" },
  { columns: 4, label: "4", title: "Four across" },
];

const ICONS = {
  left: "M10 3.5 5.5 8l4.5 4.5",
  right: "M6 3.5 10.5 8 6 12.5",
  edit: "M3 13l.6-2.6L10.8 3.2a1.4 1.4 0 0 1 2 2L5.6 12.4 3 13z",
  remove: "M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.5 8.5h5l.5-8.5",
  plus: "M8 3.5v9M3.5 8h9",
  picture: "M2.5 3.5h11v9h-11zM2.5 10.5l3-3 3 3 2-2 3 3M10.5 6.2h.01",
};

function svg(path: string): string {
  return `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${path}"/></svg>`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function iconButton(className: string, label: string, icon: string): HTMLButtonElement {
  const button = el("button", className);
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.innerHTML = svg(icon);
  return button;
}

function textButton(className: string, text: string, title = ""): HTMLButtonElement {
  const button = el("button", className, text);
  button.type = "button";
  if (title) button.title = title;
  return button;
}

/** A card to open for editing once its block is drawn again (after "Add card", say). */
const pendingEdit = new WeakMap<EditorView, { open: number; index: number }>();

type BlockAt = { from: number; to: number; openLine: number; columns: number; cards: string[] };

/** The cards block the widget's DOM stands for, read fresh from the document. */
function blockAt(view: EditorView, dom: HTMLElement): BlockAt | null {
  let pos: number;
  try {
    pos = view.posAtDOM(dom);
  } catch {
    return null;
  }
  const { doc } = view.state;
  const line = doc.lineAt(pos).number - 1;
  const block = findCardBlocks(doc.toString().split("\n")).find((b) => b.open === line);
  if (!block) return null;
  return { from: doc.line(block.open + 1).from, to: doc.line(block.close + 1).to, openLine: block.open + 1, columns: block.columns, cards: block.cards };
}


class CardsWidget extends WidgetType {
  constructor(
    readonly columns: number,
    readonly cards: readonly string[],
    readonly readOnly: boolean,
  ) {
    super();
  }
  get key() {
    return `cards ${this.columns}\n${this.cards.join("\n---\n")}`;
  }
  eq(other: CardsWidget) {
    return other.key === this.key && other.readOnly === this.readOnly;
  }
  get estimatedHeight() {
    return rememberedHeight(this.key) ?? -1;
  }
  ignoreEvent() {
    return true;
  }

  toDOM(view: EditorView) {
    const wrap = el("div", `cm-md-cards${this.readOnly ? "" : " editable"}`);
    rememberHeight(wrap, this.key);
    const grid = el("div", `md-cards${this.columns ? " md-cards-fixed" : ""}`);
    grid.dataset.cardsColumns = String(this.columns);
    if (this.columns) grid.style.setProperty("--md-cards-columns", String(this.columns));

    // Pictures and links in a card don't navigate in the editor.
    wrap.addEventListener("click", (e) => {
      if ((e.target as Element).closest("a")) e.preventDefault();
    });

    const change = (edit: (block: BlockAt) => { columns?: number; cards: string[] } | null, after?: (block: BlockAt) => void) => {
      const block = blockAt(view, wrap);
      if (!block) return;
      const next = edit(block);
      if (!next) return;
      const insert = next.cards.length ? cardsBlockMarkdown(next.columns ?? block.columns, next.cards) : "";
      after?.(block);
      view.dispatch({ changes: { from: block.from, to: block.to, insert }, userEvent: "input.cards" });
    };

    this.cards.forEach((markdown, index) => {
      const card = parseCard(markdown);
      const node = this.drawCard(card);
      if (!this.readOnly) {
        node.classList.add("cm-md-card");
        node.tabIndex = 0;
        node.setAttribute("role", "button");
        node.setAttribute("aria-label", `Edit card ${index + 1}${card.title ? `: ${card.title}` : ""}`);
        const tools = el("div", "cm-md-card-tools");
        const left = iconButton("", "Move left", ICONS.left);
        const right = iconButton("", "Move right", ICONS.right);
        const edit = iconButton("", "Edit card", ICONS.edit);
        const remove = iconButton("", "Remove card", ICONS.remove);
        left.disabled = index === 0;
        right.disabled = index === this.cards.length - 1;
        const move = (to: number) =>
          change((b) => {
            const cards = b.cards.slice();
            const [moved] = cards.splice(index, 1);
            cards.splice(to, 0, moved);
            return { cards };
          });
        left.addEventListener("click", () => move(index - 1));
        right.addEventListener("click", () => move(index + 1));
        edit.addEventListener("click", () => this.openEditor(view, wrap, node, index, change));
        remove.addEventListener("click", () => change((b) => ({ cards: b.cards.filter((_, i) => i !== index) })));
        tools.append(left, right, edit, remove);
        node.append(tools);
        node.addEventListener("click", (e) => {
          if ((e.target as Element).closest("button, .cm-md-card-form")) return;
          this.openEditor(view, wrap, node, index, change);
        });
        node.addEventListener("keydown", (e) => {
          if (e.target === node && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            this.openEditor(view, wrap, node, index, change);
          }
        });
      }
      grid.append(node);
    });

    if (!this.readOnly) {
      const add = el("button", "cm-md-card-add");
      add.type = "button";
      add.innerHTML = `${svg(ICONS.plus)}<span>Add card</span>`;
      add.addEventListener("click", () =>
        change(
          (b) => ({ cards: [...b.cards, ""] }),
          (b) => pendingEdit.set(view, { open: b.openLine, index: b.cards.length }),
        ),
      );
      grid.append(add);

      const bar = el("div", "cm-md-cards-bar");
      bar.append(el("span", "cm-md-cards-label", "Cards"));
      const across = el("span", "cm-md-cards-columns");
      across.setAttribute("role", "group");
      across.setAttribute("aria-label", "Cards across");
      for (const choice of COLUMN_CHOICES) {
        const button = textButton("", choice.label, choice.title);
        button.setAttribute("aria-pressed", String(choice.columns === this.columns));
        button.addEventListener("click", () => change((b) => ({ columns: choice.columns, cards: b.cards })));
        across.append(button);
      }
      const markdown = textButton("cm-md-cards-markdown", "Markdown", "Show the Markdown these cards are written in");
      markdown.addEventListener("click", () => {
        const block = blockAt(view, wrap);
        if (!block) return;
        const first = view.state.doc.line(Math.min(block.openLine + 1, view.state.doc.lines));
        view.focus();
        view.dispatch({ selection: { anchor: first.from }, scrollIntoView: true });
      });
      bar.append(across, markdown);
      wrap.append(bar);
      // Buttons act without taking the caret out of wherever it was.
      wrap.addEventListener("mousedown", (e) => {
        const target = e.target as Element;
        if (target.closest("input, textarea")) return;
        if (target.closest("button")) e.preventDefault();
      });
    }
    wrap.append(grid);
    sizePictures(wrap);

    const pending = pendingEdit.get(view);
    if (pending && !this.readOnly) {
      // Opened once the widget is in the document, so its position can be read.
      requestAnimationFrame(() => {
        const block = blockAt(view, wrap);
        if (!block || block.openLine !== pending.open) return;
        pendingEdit.delete(view);
        const node = grid.children[pending.index] as HTMLElement | undefined;
        if (node?.classList.contains("md-card")) this.openEditor(view, wrap, node, pending.index, change);
      });
    }
    return wrap;
  }

  private drawCard(card: Card): HTMLElement {
    const holder = el("div");
    holder.innerHTML = cardHtml(card, renderMarkdown);
    const node = holder.firstElementChild as HTMLElement;
    if (node.classList.contains("md-card-empty") && !this.readOnly) {
      node.append(el("p", "cm-md-card-hint", "Click to add a picture, a title and some words"));
    }
    return node;
  }

  /** Swaps a card for its form: picture, title and words, written into the Markdown on Done. */
  private openEditor(
    view: EditorView,
    wrap: HTMLElement,
    node: HTMLElement,
    index: number,
    change: (edit: (block: BlockAt) => { cards: string[] } | null) => void,
  ) {
    if (node.querySelector(".cm-md-card-form")) return;
    const block = blockAt(view, wrap);
    if (!block) return;
    const draft = parseCard(block.cards[index] ?? "");
    const original = cardMarkdown(draft);
    node.classList.add("cm-md-card-editing");
    node.removeAttribute("role");
    const form = el("div", "cm-md-card-form");
    form.setAttribute("role", "group");
    form.setAttribute("aria-label", `Card ${index + 1}`);

    const pic = el("div", "cm-md-card-pic");
    const drawPicture = () => {
      pic.replaceChildren();
      if (draft.picture?.src) {
        const img = el("img");
        img.src = draft.picture.src;
        img.alt = draft.picture.alt;
        pic.append(img);
      } else {
        const empty = el("div", "cm-md-card-pic-empty");
        empty.innerHTML = svg(ICONS.picture);
        pic.append(empty);
      }
      const actions = el("div", "cm-md-card-pic-actions");
      const choose = textButton("", draft.picture?.src ? "Change picture" : "Add a picture");
      choose.addEventListener("click", () => pickPicture(choose));
      actions.append(choose);
      if (draft.picture?.src) {
        const remove = textButton("", "Remove picture");
        remove.addEventListener("click", () => {
          draft.picture = null;
          drawPicture();
        });
        actions.append(remove);
      }
      pic.append(actions);
    };
    let picking = false;
    const setPicture = (picture: { src: string; alt: string }) => {
      draft.picture = { src: picture.src, alt: picture.alt || draft.picture?.alt || draft.title || "", title: "", size: draft.picture?.size ?? "" };
      drawPicture();
    };
    const pickPicture = (anchor: HTMLElement) => {
      const picker = view.state.facet(cardPicturePicker);
      if (picker) {
        picking = true;
        picker(anchor, (picture) => {
          picking = false;
          setPicture(picture);
          title.focus();
        });
        // The picker may be closed without a pick; focus coming back ends picking.
        window.setTimeout(() => form.addEventListener("focusin", () => (picking = false), { once: true }));
        return;
      }
      // No picker: the picture's address.
      const row = el("div", "cm-md-card-url");
      const input = el("input");
      input.type = "url";
      input.placeholder = "Picture address (https://…)";
      input.value = draft.picture?.src ?? "";
      const use = textButton("", "Use");
      const apply = () => {
        const src = input.value.trim();
        if (src) setPicture({ src, alt: draft.picture?.alt ?? "" });
        else row.remove();
      };
      use.addEventListener("click", apply);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          apply();
        }
      });
      pic.querySelector(".cm-md-card-url")?.remove();
      pic.append(row);
      row.append(input, use);
      input.focus();
    };
    drawPicture();

    const title = el("input", "cm-md-card-title");
    title.type = "text";
    title.placeholder = "Title";
    title.value = draft.title;
    title.setAttribute("aria-label", "Card title");
    const words = el("textarea", "cm-md-card-words");
    words.placeholder = "Some words about it";
    words.rows = 3;
    words.value = draft.text;
    words.setAttribute("aria-label", "Card words");
    const grow = () => {
      words.style.height = "auto";
      words.style.height = `${Math.min(words.scrollHeight + 2, 320)}px`;
    };
    words.addEventListener("input", grow);
    const tip = el("p", "cm-md-card-tip", "Plain words are fine. Markdown works here too: **bold**, lists, links.");

    const footer = el("div", "cm-md-card-footer");
    const done = textButton("cm-md-card-done", "Done");
    const cancel = textButton("", "Cancel");
    footer.append(cancel, done);
    form.append(pic, title, words, tip, footer);

    // The card's own look goes while its form shows.
    for (const child of Array.from(node.children)) if (!child.classList.contains("cm-md-card-tools")) (child as HTMLElement).hidden = true;
    node.append(form);

    let closed = false;
    const finish = (save: boolean) => {
      if (closed) return;
      closed = true;
      draft.title = title.value;
      draft.text = words.value;
      const markdown = cardMarkdown(draft);
      if (save && markdown !== original) {
        change((b) => {
          if (index >= b.cards.length) return null;
          const cards = b.cards.slice();
          cards[index] = markdown;
          return { cards };
        });
        return;
      }
      // Nothing to write: back to the card as it was.
      form.remove();
      node.classList.remove("cm-md-card-editing");
      node.setAttribute("role", "button");
      for (const child of Array.from(node.children)) (child as HTMLElement).hidden = false;
      node.focus();
    };
    done.addEventListener("click", () => finish(true));
    cancel.addEventListener("click", () => finish(false));
    form.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Enter" && e.target === title) {
        e.preventDefault();
        words.focus();
      }
    });
    // Clicking away keeps what was typed.
    form.addEventListener("focusout", (e) => {
      const next = (e as FocusEvent).relatedTarget as Node | null;
      if (next && form.contains(next)) return;
      window.setTimeout(() => {
        if (closed || picking || form.contains(document.activeElement)) return;
        finish(true);
      }, 150);
    });
    title.focus();
    grow();
  }
}

/** Lines of an open block (the cursor in it), and the button that shows its cards again. */
class ShowCardsWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM(view: EditorView) {
    const button = textButton("cm-md-cards-show", "Show cards", "Back to the cards");
    button.addEventListener("mousedown", (e) => e.preventDefault());
    button.addEventListener("click", (e) => {
      e.preventDefault();
      const { doc } = view.state;
      const line = doc.lineAt(view.posAtDOM(button)).number - 1;
      const block = findCardBlocks(doc.toString().split("\n")).find((b) => b.open === line);
      if (!block) return;
      const close = doc.line(block.close + 1);
      if (close.number < doc.lines) view.dispatch({ selection: { anchor: doc.line(close.number + 1).from }, scrollIntoView: true });
      else view.dispatch({ changes: { from: close.to, insert: "\n" }, selection: { anchor: close.to + 1 }, scrollIntoView: true });
    });
    return button;
  }
  ignoreEvent() {
    return true;
  }
}

/** The cards blocks: drawn as cards, or as their lines while the cursor is in one. */
export function findCardWidgets(state: EditorState): DecorationSet {
  const { doc, selection } = state;
  const text = doc.toString();
  if (!/:::[ \t]*cards/i.test(text)) return Decoration.none;
  const decorations: Range<Decoration>[] = [];
  for (const block of findCardBlocks(text.split("\n"))) {
    const open = doc.line(block.open + 1);
    const close = doc.line(block.close + 1);
    const touched = selection.ranges.some((r) => r.from <= close.to && r.to >= open.from);
    if (touched) {
      for (let n = open.number; n <= close.number; n++) {
        const edge = n === open.number ? " cm-md-cards-first" : n === close.number ? " cm-md-cards-last" : "";
        decorations.push(Decoration.line({ class: `cm-md-cards-line${edge}` }).range(doc.line(n).from));
      }
      if (!state.readOnly) decorations.push(Decoration.widget({ widget: new ShowCardsWidget(), side: 1 }).range(open.to));
      continue;
    }
    decorations.push(Decoration.replace({ widget: new CardsWidget(block.columns, block.cards, state.readOnly), block: true }).range(open.from, close.to));
  }
  return Decoration.set(decorations, true);
}

export const cardsField = StateField.define<DecorationSet>({
  create: findCardWidgets,
  update(decorations, tr) {
    if (tr.docChanged || tr.selection || tr.reconfigured || tr.state.readOnly !== tr.startState.readOnly) return findCardWidgets(tr.state);
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Inserts an empty cards block of two cards at the cursor's line, and opens the first card. */
export function insertCards(view: EditorView, from = view.state.selection.main.from, to = view.state.selection.main.to): void {
  const { doc } = view.state;
  const line = doc.lineAt(from);
  const lead = line.text.slice(0, from - line.from).trim() ? "\n\n" : line.number > 1 && doc.line(line.number - 1).text.trim() ? "\n" : "";
  const block = cardsBlockMarkdown(0, ["", ""]);
  const insert = `${lead}${block}\n`;
  const openLine = doc.lineAt(from).number + (lead.match(/\n/g)?.length ?? 0);
  pendingEdit.set(view, { open: openLine, index: 0 });
  view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, scrollIntoView: true, userEvent: "input.cards" });
}

export const cardsTheme = EditorView.theme({
  // Not the editor's pre-wrap: the rendered cards' line breaks are only HTML.
  ".cm-md-cards": { whiteSpace: "normal", position: "relative", margin: "0.5rem 0", padding: "2.4rem 0.5rem 0.5rem", borderRadius: "14px", border: "1px dashed transparent" },
  ".cm-md-cards.editable:hover, .cm-md-cards.editable:focus-within": { borderColor: "var(--border)" },
  ".cm-md-cards:not(.editable)": { paddingTop: "0.5rem" },
  ".cm-md-cards .md-cards": { margin: "0" },
  ".cm-md-cards .md-card": { position: "relative" },
  ".cm-md-cards.editable .md-card:not(.cm-md-card-editing)": { cursor: "pointer" },
  ".cm-md-cards.editable .md-card:not(.cm-md-card-editing):hover": { boxShadow: "0 4px 14px rgb(0 0 0 / 0.12)" },
  ".cm-md-cards .md-card:focus-visible": { outline: "2px solid var(--accent)", outlineOffset: "2px" },
  ".cm-md-cards .md-card-empty": { minHeight: "9rem", borderStyle: "dashed", justifyContent: "center", boxShadow: "none" },
  ".cm-md-card-hint": { margin: "0", padding: "1rem", textAlign: "center", color: "var(--muted)", fontSize: "0.88em" },
  ".cm-md-cards-bar": {
    position: "absolute",
    top: "0.45rem",
    left: "0.5rem",
    right: "0.5rem",
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    fontFamily: "var(--font-ui, inherit)",
    fontSize: "0.8rem",
    color: "var(--muted)",
    opacity: "0.55",
    transition: "opacity 0.12s",
  },
  ".cm-md-cards:hover .cm-md-cards-bar, .cm-md-cards:focus-within .cm-md-cards-bar": { opacity: "1" },
  ".cm-md-cards-label": { fontWeight: "600", letterSpacing: "0.02em", marginRight: "auto" },
  ".cm-md-cards-columns": { display: "inline-flex", gap: "2px", padding: "2px", borderRadius: "8px", border: "1px solid var(--border)", background: "var(--surface, #fff)" },
  ".cm-md-cards-bar button, .cm-md-cards-show, .cm-md-card-form button": {
    border: "0",
    borderRadius: "6px",
    padding: "0.2rem 0.55rem",
    background: "none",
    color: "var(--text)",
    font: "inherit",
    fontFamily: "var(--font-ui, inherit)",
    fontSize: "0.8rem",
    cursor: "pointer",
  },
  ".cm-md-cards-bar button:hover, .cm-md-card-form button:hover": { background: "var(--hover, rgb(0 0 0 / 0.06))" },
  ".cm-md-cards-columns button[aria-pressed=true]": { background: "var(--accent)", color: "var(--accent-text)" },
  ".cm-md-cards-markdown": { border: "1px solid var(--border) !important", background: "var(--surface, #fff) !important" },
  ".cm-md-card-tools": {
    position: "absolute",
    top: "0.4rem",
    right: "0.4rem",
    display: "flex",
    gap: "1px",
    padding: "2px",
    borderRadius: "8px",
    background: "var(--surface, #fff)",
    border: "1px solid var(--border)",
    boxShadow: "0 1px 3px rgb(0 0 0 / 0.12)",
    opacity: "0",
    transition: "opacity 0.12s",
  },
  ".md-card:hover > .cm-md-card-tools, .md-card:focus-within > .cm-md-card-tools": { opacity: "1" },
  ".cm-md-card-editing > .cm-md-card-tools": { display: "none" },
  ".cm-md-card-tools button": { display: "grid", placeItems: "center", width: "1.6rem", height: "1.6rem", padding: "0", border: "0", borderRadius: "6px", background: "none", color: "var(--text)", cursor: "pointer" },
  ".cm-md-card-tools button:hover:not(:disabled)": { background: "var(--hover, rgb(0 0 0 / 0.06))" },
  ".cm-md-card-tools button:disabled": { opacity: "0.35", cursor: "default" },
  ".cm-md-card-tools svg, .cm-md-card-add svg, .cm-md-card-pic-empty svg": { width: "1rem", height: "1rem", fill: "none", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round", strokeLinejoin: "round" },
  ".cm-md-card-add": {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "0.35rem",
    minHeight: "9rem",
    border: "1.5px dashed var(--border)",
    borderRadius: "var(--md-cards-radius, 12px)",
    background: "none",
    color: "var(--muted)",
    fontFamily: "var(--font-ui, inherit)",
    fontSize: "0.88rem",
    cursor: "pointer",
  },
  ".cm-md-card-add:hover": { color: "var(--accent)", borderColor: "var(--accent)" },
  ".cm-md-card-add svg": { width: "1.4rem", height: "1.4rem" },
  ".cm-md-card-form": { display: "flex", flexDirection: "column", gap: "0.45rem", padding: "0.5rem", fontFamily: "var(--font-ui, inherit)", cursor: "default" },
  ".cm-md-card-pic": { display: "flex", flexDirection: "column", gap: "0.35rem" },
  ".cm-md-card-pic img": { display: "block", width: "100%", height: "auto", aspectRatio: "4 / 3", objectFit: "contain", borderRadius: "8px", background: "var(--surface-2, rgb(0 0 0 / 0.03))" },
  ".cm-md-card-pic-empty": { display: "grid", placeItems: "center", aspectRatio: "4 / 3", borderRadius: "8px", border: "1.5px dashed var(--border)", color: "var(--muted)" },
  ".cm-md-card-pic-empty svg": { width: "2rem", height: "2rem" },
  ".cm-md-card-pic-actions, .cm-md-card-url": { display: "flex", gap: "0.35rem", flexWrap: "wrap" },
  ".cm-md-card-pic-actions button, .cm-md-card-url button": { border: "1px solid var(--border) !important" },
  ".cm-md-card-form input, .cm-md-card-form textarea": {
    width: "100%",
    boxSizing: "border-box",
    padding: "0.4rem 0.55rem",
    border: "1px solid var(--border)",
    borderRadius: "8px",
    background: "var(--editor-bg, var(--surface, #fff))",
    color: "var(--text)",
    font: "inherit",
    fontSize: "0.9rem",
  },
  ".cm-md-card-url input": { flex: "1", minWidth: "8rem", width: "auto" },
  ".cm-md-card-form input:focus, .cm-md-card-form textarea:focus": { outline: "2px solid color-mix(in srgb, var(--accent) 45%, transparent)", outlineOffset: "0", borderColor: "var(--accent)" },
  ".cm-md-card-title": { fontWeight: "600", fontSize: "1rem !important" },
  ".cm-md-card-words": { resize: "vertical", minHeight: "4.5rem", lineHeight: "1.45" },
  ".cm-md-card-tip": { margin: "0", color: "var(--muted)", fontSize: "0.75rem" },
  ".cm-md-card-footer": { display: "flex", justifyContent: "flex-end", gap: "0.35rem" },
  ".cm-md-card-form .cm-md-card-done": { background: "var(--accent)", color: "var(--accent-text)" },
  ".cm-md-card-form .cm-md-card-done:hover": { background: "var(--accent)", filter: "brightness(1.08)" },
  // Its lines, while the cursor is in the block.
  ".cm-line.cm-md-cards-line": { backgroundColor: "rgb(120 120 120 / 0.07)", paddingLeft: "0.75rem", paddingRight: "0.75rem" },
  ".cm-line.cm-md-cards-first": { borderTopLeftRadius: "8px", borderTopRightRadius: "8px", paddingTop: "0.3em", color: "var(--muted)" },
  ".cm-line.cm-md-cards-last": { borderBottomLeftRadius: "8px", borderBottomRightRadius: "8px", paddingBottom: "0.3em", color: "var(--muted)" },
  ".cm-md-cards-show": { marginLeft: "0.75rem", border: "1px solid var(--border) !important", background: "var(--surface, #fff) !important", verticalAlign: "middle" },
});
