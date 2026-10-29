import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  searchKeymap,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import { Prec, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, type Panel, type ViewUpdate } from "@codemirror/view";

// Find and replace, in CodeMirror rather than the browser so it finds lines
// that aren't drawn yet. Replacing is an ordinary edit, so it merges with Yjs.

const MAX_COUNT = 9999;

/** How many matches there are (up to a cap) and which one is selected, from 1; 0 when none is. */
export function matchCount(state: EditorState, query: SearchQuery): { total: number; current: number; capped: boolean } {
  if (!query.valid) return { total: 0, current: 0, capped: false };
  const sel = state.selection.main;
  const cursor = query.getCursor(state);
  let total = 0;
  let current = 0;
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    total++;
    if (next.value.from === sel.from && next.value.to === sel.to) current = total;
    if (total >= MAX_COUNT) return { total, current, capped: true };
  }
  return { total, current, capped: false };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string>, ...children: (Node | string)[]) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

function findPanel(view: EditorView): Panel {
  let query = getSearchQuery(view.state);
  const find = el("input", { type: "text", "main-field": "true", placeholder: "Find", "aria-label": "Find", class: "cm-find-input" });
  const replace = el("input", { type: "text", placeholder: "Replace with", "aria-label": "Replace with", class: "cm-find-input cm-find-replace" });
  const count = el("span", { class: "cm-find-count", "aria-live": "polite" });
  const toggle = (label: string, title: string) => el("button", { type: "button", class: "cm-find-toggle", title, "aria-label": title, "aria-pressed": "false" }, label);
  const caseBtn = toggle("Aa", "Match case");
  const wordBtn = toggle("W", "Whole word");
  const regexBtn = toggle(".*", "Regular expression");
  const button = (label: string, title: string, run: () => void) => {
    const b = el("button", { type: "button", class: "cm-find-button", title, "aria-label": title }, label);
    b.addEventListener("click", run);
    return b;
  };
  const prev = button("↑", "Previous match (Shift+Enter)", () => findPrevious(view));
  const next = button("↓", "Next match (Enter)", () => findNext(view));
  const close = button("×", "Close (Escape)", () => (closeSearchPanel(view), view.focus()));
  const replaceOne = button("Replace", "Replace this match", () => replaceNext(view));
  const replaceEvery = button("All", "Replace every match", () => replaceAll(view));
  replaceOne.classList.add("text");
  replaceEvery.classList.add("text");
  const replaceRow = el("div", { class: "cm-find-row" }, replace, replaceOne, replaceEvery);
  const dom = el(
    "div",
    { class: "cm-find", role: "search" },
    el("div", { class: "cm-find-row" }, find, count, caseBtn, wordBtn, regexBtn, prev, next, close),
    replaceRow,
  );

  function sync() {
    find.value = query.search;
    replace.value = query.replace;
    caseBtn.setAttribute("aria-pressed", String(query.caseSensitive));
    wordBtn.setAttribute("aria-pressed", String(query.wholeWord));
    regexBtn.setAttribute("aria-pressed", String(query.regexp));
    replaceRow.hidden = view.state.readOnly;
  }
  function showCount(state: EditorState) {
    find.classList.toggle("invalid", !!query.search && !query.valid);
    if (!query.search) return void (count.textContent = "");
    if (!query.valid) return void (count.textContent = "Bad pattern");
    const { total, current, capped } = matchCount(state, query);
    const all = `${total.toLocaleString()}${capped ? "+" : ""}`;
    count.textContent = total === 0 ? "No results" : current ? `${current} of ${all}` : `${all} found`;
  }
  function commit(change: Partial<ConstructorParameters<typeof SearchQuery>[0]>) {
    const q = new SearchQuery({
      search: find.value,
      replace: replace.value,
      caseSensitive: query.caseSensitive,
      wholeWord: query.wholeWord,
      regexp: query.regexp,
      literal: query.literal,
      ...change,
    });
    if (!q.eq(query)) view.dispatch({ effects: setSearchQuery.of(q) });
  }

  find.addEventListener("input", () => commit({}));
  replace.addEventListener("input", () => commit({}));
  caseBtn.addEventListener("click", () => commit({ caseSensitive: !query.caseSensitive }));
  wordBtn.addEventListener("click", () => commit({ wholeWord: !query.wholeWord }));
  regexBtn.addEventListener("click", () => commit({ regexp: !query.regexp }));
  dom.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeSearchPanel(view);
      view.focus();
    } else if (e.key === "Enter" && e.target === find) {
      e.preventDefault();
      (e.shiftKey ? findPrevious : findNext)(view);
    } else if (e.key === "Enter" && e.target === replace) {
      e.preventDefault();
      (e.metaKey || e.ctrlKey ? replaceAll : replaceNext)(view);
    }
  });

  sync();
  showCount(view.state);
  return {
    dom,
    top: true,
    mount() {
      find.focus();
      find.select();
    },
    update(update: ViewUpdate) {
      let changed = false;
      for (const tr of update.transactions)
        for (const e of tr.effects)
          if (e.is(setSearchQuery) && !e.value.eq(query)) {
            query = e.value;
            changed = true;
          }
      if (changed || update.startState.readOnly !== update.state.readOnly) sync();
      if (changed || update.docChanged || update.selectionSet) showCount(update.state);
    },
  };
}

/** Opens the panel with the cursor in the replace box. */
function openReplace(view: EditorView): boolean {
  if (view.state.readOnly) return openSearchPanel(view);
  openSearchPanel(view);
  const field = view.dom.querySelector<HTMLInputElement>(".cm-find-replace");
  field?.focus();
  field?.select();
  return true;
}

const findTheme = EditorView.theme({
  ".cm-panels": { backgroundColor: "var(--surface)", color: "var(--text)", fontFamily: "var(--font-sans)", fontSize: "13px" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-find": { display: "flex", flexDirection: "column", gap: "6px", padding: "8px 12px", maxWidth: "46rem", margin: "0 auto" },
  ".cm-find-row": { display: "flex", alignItems: "center", gap: "4px" },
  ".cm-find-row[hidden]": { display: "none" },
  ".cm-find-input": {
    flex: "1",
    minWidth: "0",
    font: "inherit",
    color: "var(--text)",
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: "7px",
    padding: "4px 8px",
  },
  ".cm-find-input:focus": { outline: "none", borderColor: "var(--accent)" },
  ".cm-find-input.invalid": { borderColor: "var(--danger)" },
  ".cm-find-count": { minWidth: "5.5em", textAlign: "right", color: "var(--muted)", fontSize: "12px", whiteSpace: "nowrap", paddingRight: "4px" },
  ".cm-find-toggle, .cm-find-button": {
    font: "inherit",
    minWidth: "28px",
    height: "28px",
    padding: "0 6px",
    border: "1px solid transparent",
    borderRadius: "7px",
    background: "none",
    color: "var(--muted)",
    cursor: "pointer",
  },
  ".cm-find-toggle": { fontFamily: "var(--font-mono)", fontSize: "12px" },
  ".cm-find-button.text": { color: "var(--text)", border: "1px solid var(--border)", padding: "0 10px" },
  ".cm-find-toggle:hover, .cm-find-button:hover": { background: "var(--surface-2)", color: "var(--text)" },
  ".cm-find-toggle[aria-pressed=true]": {
    color: "var(--accent)",
    background: "color-mix(in srgb, var(--accent) 14%, transparent)",
    borderColor: "color-mix(in srgb, var(--accent) 40%, transparent)",
  },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--highlight) 70%, transparent)", borderRadius: "2px" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--accent) 35%, transparent)" },
});

export function findReplace(): Extension {
  return [
    search({ top: true, createPanel: findPanel }),
    // Ahead of the slash menu and the Markdown keymap, so Mod-f is always ours.
    Prec.high(keymap.of([{ key: "Mod-h", run: openReplace }, { key: "Mod-Alt-f", run: openReplace }, ...searchKeymap])),
    findTheme,
  ];
}
