import type { Extension } from "@codemirror/state";
import { closeHoverTooltips, EditorView } from "@codemirror/view";
import { copyText } from "../clipboard";
import { applyFix, diagnosticsAt, type Diagnostic } from "../diagnostics";
import { issueKey, personalDictionary } from "./dictionary";
import { define, translate, translationLanguages, type Definition } from "./languageApi";
import { proofingField } from "./settings";
import { wordAt } from "./prose";
import "./proofing.css";
import type { ProofLanguage, SpellChecker } from "./speller";

// The editor's right-click menu: spelling suggestions and grammar fixes for
// the spot you clicked, then Look Up, Synonyms and Translate (like macOS),
// then the clipboard. Shift+right-click still gives the browser's own menu.

type Item = { label: string; title?: string; strong?: boolean; disabled?: boolean; run?: () => void };
type Entry = Item | "separator" | { note: string } | { loading: string; items: Promise<Item[]>; empty?: string };

let closeOpen: (() => void) | null = null;

/** Closes whatever menu or card is open. */
export function closeProofingPopups() {
  closeOpen?.();
}

/** Puts `el` at (x, y) in the viewport, flipped or nudged so it stays on screen. */
function place(el: HTMLElement, x: number, y: number, below?: number) {
  el.style.left = "0px";
  el.style.top = "0px";
  if (!el.isConnected) document.body.append(el);
  const { width, height } = el.getBoundingClientRect();
  const margin = 8;
  let top = y;
  if (top + height > window.innerHeight - margin) top = below !== undefined ? below - height - 4 : y - height;
  el.style.left = `${Math.max(margin, Math.min(x, window.innerWidth - width - margin))}px`;
  el.style.top = `${Math.max(margin, top)}px`;
}

/** Shows `el` until Escape, a click elsewhere, scrolling or resizing. */
function open(view: EditorView, el: HTMLElement, onClose?: () => void) {
  // Inside a mounted editor (`.mde`), so the popup picks up its theme; it's fixed, so it still sits on top.
  (view.dom.closest(".mde") ?? document.body).append(el);
  closeOpen?.();
  const close = (refocus = true) => {
    if (closeOpen !== done) return;
    closeOpen = null;
    el.remove();
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", key, true);
    window.removeEventListener("resize", dismiss);
    window.removeEventListener("blur", dismiss);
    view.scrollDOM.removeEventListener("scroll", dismiss);
    onClose?.();
    if (refocus && view.dom.isConnected) view.focus();
  };
  const done = () => close(false);
  const dismiss = () => close(false);
  const outside = (e: Event) => {
    if (!el.contains(e.target as Node)) close(false);
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      // Don't also leave focus mode.
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  closeOpen = done;
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", key, true);
  window.addEventListener("resize", dismiss);
  window.addEventListener("blur", dismiss);
  view.scrollDOM.addEventListener("scroll", dismiss, { passive: true });
  return close;
}

function short(text: string, max = 24): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

// ---------------------------------------------------------------- the menu

function showMenu(view: EditorView, x: number, y: number, entries: Entry[]) {
  const menu = document.createElement("div");
  menu.className = "proof-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Edit");
  // Keep the editor's selection while clicking.
  menu.addEventListener("mousedown", (e) => e.preventDefault());
  const close = open(view, menu);

  const button = (item: Item) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `proof-menu-item${item.strong ? " strong" : ""}`;
    b.setAttribute("role", "menuitem");
    b.textContent = item.label;
    if (item.title) b.title = item.title;
    if (item.disabled || !item.run) b.setAttribute("aria-disabled", "true");
    else
      b.addEventListener("click", () => {
        close();
        item.run!();
      });
    return b;
  };

  for (const entry of entries) {
    if (entry === "separator") {
      const hr = menu.appendChild(document.createElement("div"));
      hr.className = "proof-menu-separator";
      hr.setAttribute("role", "separator");
    } else if ("note" in entry) {
      const p = menu.appendChild(document.createElement("div"));
      p.className = "proof-menu-note";
      p.textContent = entry.note;
    } else if ("loading" in entry) {
      const slot = menu.appendChild(document.createElement("div"));
      slot.className = "proof-menu-note";
      slot.textContent = entry.loading;
      entry.items.then(
        (items) => {
          if (!menu.isConnected) return;
          slot.replaceWith(...(items.length ? items.map(button) : [Object.assign(slot, { textContent: entry.empty ?? "No suggestions" })]));
          place(menu, parseFloat(menu.style.left), parseFloat(menu.style.top));
        },
        () => (slot.textContent = entry.empty ?? "No suggestions"),
      );
    } else menu.append(button(entry));
  }

  menu.addEventListener("keydown", (e) => {
    const items = [...menu.querySelectorAll<HTMLButtonElement>(".proof-menu-item:not([aria-disabled])")];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (step) {
      e.preventDefault();
      items[(at + step + items.length) % items.length]?.focus();
    } else if (e.key === "Tab") e.preventDefault();
  });
  place(menu, x, y);
  menu.querySelector<HTMLButtonElement>(".proof-menu-item:not([aria-disabled])")?.focus({ preventScroll: true });
}

function fixes(view: EditorView, d: Diagnostic): Item[] {
  return (d.fixes ?? []).map((fix) => ({ label: fix.label, strong: true, run: () => applyFix(view, fix) }));
}

function menuEntries(view: EditorView, pos: number, speller: (l: ProofLanguage) => SpellChecker): Entry[] {
  const state = view.state;
  const settings = state.field(proofingField);
  const editable = !state.readOnly;
  const sel = state.selection.main;
  const selected = sel.empty ? "" : state.sliceDoc(sel.from, sel.to);
  const word = wordAt(state, pos);
  const entries: Entry[] = [];

  let misspelt = false;
  for (const d of diagnosticsAt(state, pos)) {
    if (d.source === "spelling") {
      misspelt = true;
      const text = state.sliceDoc(d.from, d.to);
      if (editable) {
        entries.push({
          loading: "Looking for suggestions…",
          items: speller(settings.language)
            .suggest(text)
            .then((list) => list.map((s) => ({ label: s, strong: true, run: () => applyFix(view, { label: s, from: d.from, to: d.to, insert: s }) }))),
        });
      }
      entries.push(
        { label: "Ignore Spelling", run: () => personalDictionary.ignore(text) },
        { label: "Add to Dictionary", run: () => personalDictionary.add(text) },
        "separator",
      );
    } else if (d.source === "grammar") {
      entries.push({ note: d.message }, ...(editable ? fixes(view, d) : []), { label: "Ignore", run: () => personalDictionary.ignore(issueKey(d.rule, state.sliceDoc(d.from, d.to))) }, "separator");
    }
  }

  const target = selected.trim() || word?.word || "";
  if (target) {
    const lookup = selected.trim() && selected.trim().split(/\s+/).length <= 3 ? selected.trim() : (word?.word ?? "");
    if (lookup) {
      entries.push({
        label: `Look Up “${short(lookup)}”`,
        disabled: !settings.lookup,
        title: settings.lookup ? "Show the dictionary definition" : "The dictionary isn't installed on this server",
        run: () => showLookup(view, lookup),
      });
    }
    // The thesaurus: one word under the cursor (or selected), swapped for the synonym you pick.
    // Not for a misspelt word: the suggestions above are what it needs.
    const one = misspelt ? null : selected.trim() ? (/^[\p{L}'’-]+$/u.test(selected.trim()) ? { word: selected.trim(), from: sel.from, to: sel.to } : null) : word;
    if (one && editable && settings.lookup) {
      entries.push({ note: "Synonyms" }, { loading: "Finding synonyms…", empty: "No synonyms", items: synonymItems(view, one) });
    }
    entries.push({
      label: `Translate “${short(target)}”`,
      disabled: !settings.translate,
      title: settings.translate ? "Translate with the server's translation service" : settings.translateHint,
      run: () => showTranslate(view, target, selected.trim() ? { from: sel.from, to: sel.to } : word!),
    });
    entries.push("separator");
  }

  const mod = isMac ? "⌘" : "Ctrl+";
  const canPaste = editable && window.isSecureContext && !!navigator.clipboard?.readText;
  entries.push(
    ...(editable
      ? [
          {
            label: "Cut",
            disabled: !selected,
            title: `${mod}X`,
            run: () => copyText(selected).then(() => view.dispatch({ changes: { from: sel.from, to: sel.to }, userEvent: "delete.cut" })),
          },
        ]
      : []),
    { label: "Copy", disabled: !selected, title: `${mod}C`, run: () => void copyText(selected).catch(() => {}) },
    ...(editable
      ? [
          {
            label: "Paste",
            disabled: !canPaste,
            title: canPaste ? `${mod}V` : `Press ${mod}V to paste`,
            run: () =>
              void navigator.clipboard.readText().then((text) => {
                const s = view.state.selection.main;
                view.dispatch({ changes: { from: s.from, to: s.to, insert: text }, selection: { anchor: s.from + text.length }, userEvent: "input.paste" });
              }),
          },
        ]
      : []),
  );
  return entries;
}

// ---------------------------------------------------------------- Synonyms

/** WordNet's synonyms for `word`, across every sense, most common sense first. */
export function synonymsOf(entry: Definition | null, word: string, max = 8): string[] {
  const seen = new Set([word.toLowerCase()]);
  const out: string[] = [];
  for (const group of entry?.entries ?? [])
    for (const sense of group.senses)
      for (const s of sense.synonyms) {
        if (out.length >= max) return out;
        if (!seen.has(s.toLowerCase())) {
          seen.add(s.toLowerCase());
          out.push(s);
        }
      }
  return out;
}

/** Keeps the replaced word's capitals: "Quick" → "Fast", "QUICK" → "FAST". */
export function matchCase(original: string, replacement: string): string {
  if (original.length > 1 && original === original.toUpperCase() && original !== original.toLowerCase()) return replacement.toUpperCase();
  if (original[0] && original[0] !== original[0].toLowerCase()) return replacement[0].toUpperCase() + replacement.slice(1);
  return replacement;
}

function synonymItems(view: EditorView, at: { word: string; from: number; to: number }): Promise<Item[]> {
  return define(at.word).then((entry) =>
    synonymsOf(entry, at.word).map((s) => {
      const insert = matchCase(at.word, s);
      return { label: insert, run: () => applyFix(view, { label: insert, from: at.from, to: at.to, insert }) };
    }),
  );
}

// ---------------------------------------------------------------- Look Up

function card(className: string, label: string): HTMLElement {
  const el = document.createElement("div");
  el.className = `proof-card ${className}`;
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", label);
  el.tabIndex = -1;
  return el;
}

function anchor(view: EditorView, range: { from: number; to: number }) {
  const start = view.coordsAtPos(range.from) ?? { left: 0, top: 0, bottom: 0 };
  return { x: start.left, y: start.bottom + 6, above: start.top };
}

export function showLookup(view: EditorView, word: string) {
  const el = card("lookup-card", `Definition of ${word}`);
  const heading = el.appendChild(document.createElement("h2"));
  heading.textContent = word;
  const body = el.appendChild(document.createElement("div"));
  body.className = "lookup-body muted";
  body.textContent = "Looking up…";
  const sel = view.state.selection.main;
  const at = anchor(view, sel.empty ? { from: sel.head, to: sel.head } : sel);
  open(view, el);
  place(el, at.x, at.y, at.above);
  el.focus({ preventScroll: true });

  define(word).then(
    (entry) => {
      if (!el.isConnected) return;
      body.className = "lookup-body";
      if (!entry) {
        body.className = "lookup-body muted";
        body.textContent = `No definition found for “${word}”.`;
      } else renderDefinition(heading, body, entry);
      place(el, parseFloat(el.style.left), parseFloat(el.style.top), at.above);
    },
    () => {
      body.textContent = navigator.onLine ? "Couldn't look that up." : "Lookup needs a connection to the server.";
    },
  );
}

function renderDefinition(heading: HTMLElement, body: HTMLElement, entry: Definition) {
  heading.textContent = entry.lemma;
  body.replaceChildren();
  for (const group of entry.entries) {
    const pos = body.appendChild(document.createElement("div"));
    pos.className = "lookup-pos";
    pos.textContent = group.lemma !== entry.lemma ? `${group.pos} · ${group.lemma}` : group.pos;
    const list = body.appendChild(document.createElement("ol"));
    for (const sense of group.senses) {
      const li = list.appendChild(document.createElement("li"));
      li.append(sense.definition);
      for (const example of sense.examples.slice(0, 1)) {
        const ex = li.appendChild(document.createElement("span"));
        ex.className = "lookup-example";
        ex.textContent = `: “${example}”`;
      }
      if (sense.synonyms.length) {
        const syn = li.appendChild(document.createElement("div"));
        syn.className = "lookup-synonyms";
        syn.textContent = `Similar: ${sense.synonyms.slice(0, 5).join(", ")}`;
      }
    }
  }
  const source = body.appendChild(document.createElement("div"));
  source.className = "lookup-source";
  source.textContent = "WordNet";
}

// ---------------------------------------------------------------- Translate

const TARGET_KEY = "notes.translateTo";

function savedTarget(): string {
  try {
    return localStorage.getItem(TARGET_KEY) ?? "";
  } catch {
    return "";
  }
}

export function showTranslate(view: EditorView, text: string, range: { from: number; to: number }) {
  const el = card("translate-card", "Translate");
  const head = el.appendChild(document.createElement("div"));
  head.className = "translate-head";
  const title = head.appendChild(document.createElement("strong"));
  title.textContent = "Translate to";
  const select = head.appendChild(document.createElement("select"));
  select.setAttribute("aria-label", "Language");
  const source = el.appendChild(document.createElement("p"));
  source.className = "translate-source muted";
  source.textContent = text;
  const result = el.appendChild(document.createElement("p"));
  result.className = "translate-result";
  result.setAttribute("aria-live", "polite");
  const actions = el.appendChild(document.createElement("div"));
  actions.className = "translate-actions";
  const replace = document.createElement("button");
  replace.type = "button";
  replace.className = "primary";
  replace.textContent = "Replace";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "menu-button";
  copy.textContent = "Copy";
  if (!view.state.readOnly) actions.append(replace);
  actions.append(copy);
  replace.disabled = copy.disabled = true;

  const at = anchor(view, range);
  const close = open(view, el);
  place(el, at.x, at.y, at.above);

  let translated = "";
  let asked = 0;
  const run = async () => {
    const target = select.value;
    if (!target) return;
    try {
      localStorage.setItem(TARGET_KEY, target);
    } catch {
      /* private mode */
    }
    const ask = ++asked;
    result.textContent = "Translating…";
    result.classList.add("muted");
    replace.disabled = copy.disabled = true;
    try {
      const answer = await translate(text, target);
      if (ask !== asked) return;
      translated = answer.text;
      result.textContent = translated;
      result.classList.remove("muted");
      replace.disabled = copy.disabled = !translated;
    } catch (err) {
      if (ask !== asked) return;
      result.textContent = err instanceof Error && err.message ? err.message : "Couldn't translate that.";
    }
  };
  select.addEventListener("change", run);
  copy.addEventListener("click", () => void copyText(translated).then(() => (copy.textContent = "Copied")).catch(() => {}));
  replace.addEventListener("click", () => {
    // Only if the text is still what was translated (someone may have edited it since).
    const mapped = view.state.sliceDoc(range.from, range.to) === text;
    if (mapped) view.dispatch({ changes: { from: range.from, to: range.to, insert: translated }, userEvent: "input.translate" });
    close();
  });

  result.textContent = "Loading languages…";
  translationLanguages().then(
    (languages) => {
      const wanted = savedTarget() || (languages.find((l) => l.code !== "en")?.code ?? "");
      for (const lang of languages.filter((l) => l.code !== "en")) {
        const option = select.appendChild(document.createElement("option"));
        option.value = lang.code;
        option.textContent = lang.name;
      }
      select.value = languages.some((l) => l.code === wanted) ? wanted : (select.options[0]?.value ?? "");
      select.focus({ preventScroll: true });
      place(el, parseFloat(el.style.left), parseFloat(el.style.top), at.above);
      void run();
    },
    (err) => (result.textContent = err instanceof Error && err.message ? err.message : "Translation isn't available."),
  );
}

// ---------------------------------------------------------------- wiring

/** The right-click menu. Shift+right-click (or a menu already open) gives the browser's own. */
export function proofingMenu(speller: (language: ProofLanguage) => SpellChecker): Extension {
  return EditorView.domEventHandlers({
    contextmenu(event, view) {
      if (event.shiftKey) return false;
      event.preventDefault();
      // The keyboard's menu key fires at (0, 0): use the cursor instead.
      const fromKeyboard = event.clientX === 0 && event.clientY === 0;
      let pos = fromKeyboard ? view.state.selection.main.head : view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return true;
      const sel = view.state.selection.main;
      if (sel.empty || pos < sel.from || pos > sel.to) {
        // Like macOS, a right-click on a word selects it.
        const word = wordAt(view.state, pos);
        view.dispatch({ selection: word ? { anchor: word.from, head: word.to } : { anchor: pos } });
        if (word) pos = word.from;
      }
      // The menu says everything the hover card would.
      view.dispatch({ effects: closeHoverTooltips });
      const coords = fromKeyboard ? view.coordsAtPos(pos) : null;
      const x = coords ? coords.left : event.clientX;
      const y = coords ? coords.bottom + 4 : event.clientY;
      showMenu(view, x, y, menuEntries(view, pos, speller));
      return true;
    },
  });
}
