import { forceParsing } from "@codemirror/language";
import { Facet, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { matchCase } from "./contextMenu";
import { personalDictionary } from "./dictionary";
import { words, type Word } from "./prose";
import { LANGUAGE_NAMES, proofingField } from "./settings";
import { spellerFor, type ProofLanguage, type SpellChecker } from "./speller";

// Check spelling, like Word's F7: a small dialog steps through each misspelt
// word from the cursor on, selects it, and offers its suggestions, Change,
// Change all, Ignore, Ignore all and Add to dictionary. It looks at the whole
// note (as-you-type spelling only looks at what's on screen), and works even
// with as-you-type spelling switched off.

// ---------------------------------------------------------------- ignored once

/** Ignore once: the spots skipped this session, mapped through edits. As-you-type spelling skips them too. */
const ignoreOnce = StateEffect.define<{ from: number; to: number }>();

export const ignoredOnce = StateField.define<{ from: number; to: number }[]>({
  create: () => [],
  update(spots, tr) {
    if (tr.docChanged)
      spots = spots.flatMap((s) => {
        const from = tr.changes.mapPos(s.from, 1);
        const to = tr.changes.mapPos(s.to, -1);
        // Typed over: it's a different word now.
        return to > from && tr.newDoc.sliceString(from, to) === tr.startState.sliceDoc(s.from, s.to) ? [{ from, to }] : [];
      });
    for (const e of tr.effects) if (e.is(ignoreOnce)) spots = [...spots, e.value];
    return spots;
  },
});

export function isIgnoredOnce(state: EditorState, from: number, to: number): boolean {
  return (state.field(ignoredOnce, false) ?? []).some((s) => s.from === from && s.to === to);
}

// ---------------------------------------------------------------- finding words

/** Where the check gets its speller: `proofing()`'s, so the tests can pass a fake one. */
const spellerSource = Facet.define<(language: ProofLanguage) => SpellChecker, (language: ProofLanguage) => SpellChecker>({
  combine: (values) => values[0] ?? spellerFor,
});

/** The misspelt words in the whole note, in order. */
export async function misspelt(state: EditorState, speller: SpellChecker): Promise<Word[]> {
  const found = words(state, 0, state.doc.length);
  await speller.check(found.map((w) => w.word));
  return found.filter((w) => speller.known(w.word) === false && !personalDictionary.has(w.word) && !isIgnoredOnce(state, w.from, w.to));
}

/** The first of `wrong` at or after `pos`, wrapping round to the top. */
export function nextFrom(wrong: Word[], pos: number): Word | null {
  return wrong.find((w) => w.to > pos) ?? wrong[0] ?? null;
}

/** One change for every place `word` is misspelt, to `insert`. */
export function changeAll(wrong: Word[], word: string, insert: string) {
  return wrong.filter((w) => w.word === word).map((w) => ({ from: w.from, to: w.to, insert }));
}

// ---------------------------------------------------------------- the dialog

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, className: string, run: () => void, title?: string) {
  const b = el("button", className, label);
  b.type = "button";
  if (title) b.title = title;
  b.addEventListener("click", run);
  return b;
}

const CONTEXT = 40;

class SpellPass {
  dom: HTMLElement;
  private current: Word | null = null;
  private wrong: Word[] = [];
  private run = 0;
  private heading: HTMLElement;
  private body: HTMLElement;

  constructor(
    private view: EditorView,
    private onClose: () => void,
  ) {
    this.dom = el("div", "spell-pass");
    this.dom.setAttribute("role", "dialog");
    this.dom.setAttribute("aria-label", "Check spelling");
    const head = this.dom.appendChild(el("div", "spell-pass-head"));
    this.heading = head.appendChild(el("strong", "spell-pass-title", "Spelling"));
    head.append(button("×", "spell-pass-close", () => this.close(), "Close (Escape)"));
    this.body = this.dom.appendChild(el("div", "spell-pass-body"));
    this.dom.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        // Don't also leave full screen or focus mode.
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    });
    (view.dom.closest(".mde") ?? document.body).append(this.dom);
  }

  /** Looks again from `pos` (the cursor, or just past the last word dealt with). */
  async next(pos: number) {
    const run = ++this.run;
    const language = this.view.state.field(proofingField).language;
    this.heading.textContent = `Spelling: ${LANGUAGE_NAMES[language]}`;
    if (!this.current) this.message("Checking…");
    forceParsing(this.view, this.view.state.doc.length, 1000);
    const state = this.view.state;
    const speller = state.facet(spellerSource)(language);
    const wrong = await misspelt(state, speller);
    if (run !== this.run || !this.dom.isConnected) return;
    if (this.view.state.doc !== state.doc) return void this.next(pos);
    this.wrong = wrong;
    this.current = nextFrom(wrong, pos);
    if (!this.current) return this.done();
    const word = this.current;
    this.view.dispatch({
      selection: { anchor: word.from, head: word.to },
      // Clear of the dialog, which sits at the bottom of the window.
      effects: EditorView.scrollIntoView(word.from, { y: "center" }),
    });
    this.show(word, null);
    const suggestions = await speller.suggest(word.word);
    if (run === this.run && this.current === word) this.show(word, suggestions);
  }

  private message(text: string) {
    this.body.replaceChildren(el("p", "spell-pass-note", text));
  }

  private done() {
    this.current = null;
    this.message("The spelling check is complete.");
    const close = button("Close", "spell-pass-btn primary", () => this.close());
    this.body.append(el("div", "spell-pass-actions"));
    this.body.lastElementChild!.append(close);
    close.focus({ preventScroll: true });
  }

  private show(word: Word, suggestions: string[] | null) {
    const state = this.view.state;
    const line = state.doc.lineAt(word.from);
    const start = Math.max(line.from, word.from - CONTEXT);
    const end = Math.min(line.to, word.to + CONTEXT);

    const label = el("div", "spell-pass-label", "Not in the dictionary:");
    const context = el("p", "spell-pass-context");
    // From the line's start, without its heading, quote or list marks.
    const before = start > line.from ? `…${state.sliceDoc(start, word.from)}` : state.sliceDoc(start, word.from).replace(/^\s*(?:(?:#{1,6}|>|[-*+]|\d+[.)])\s+)+(?:\[[ xX]\]\s+)?/, "");
    context.append(
      before,
      el("mark", "spell-pass-word", word.word),
      `${state.sliceDoc(word.to, end)}${end < line.to ? "…" : ""}`,
    );

    const input = el("input", "spell-pass-input");
    input.type = "text";
    input.setAttribute("aria-label", "Change to");
    input.spellcheck = false;
    input.value = suggestions?.[0] ? matchCase(word.word, suggestions[0]) : word.word;

    const list = el("div", "spell-pass-suggestions");
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Suggestions");
    if (!suggestions) list.append(el("span", "spell-pass-note", "Finding suggestions…"));
    else if (!suggestions.length) list.append(el("span", "spell-pass-note", "No suggestions. Type the right spelling above."));
    const options: HTMLButtonElement[] = [];
    for (const s of (suggestions ?? []).slice(0, 6)) {
      const insert = matchCase(word.word, s);
      const option = button(insert, "spell-pass-option", () => this.select(options, option, input, insert));
      option.setAttribute("role", "option");
      option.addEventListener("dblclick", () => this.change(input.value));
      options.push(option);
      list.append(option);
    }
    options[0]?.setAttribute("aria-selected", "true");

    const count = this.wrong.length;
    const left = el("span", "spell-pass-count", count === 1 ? "1 to check" : `${count.toLocaleString()} to check`);
    const others = this.wrong.filter((w) => w.word === word.word).length;
    const readOnly = state.readOnly;
    const changeOne = button("Change", "spell-pass-btn primary", () => this.change(input.value), "Change this word (Enter)");
    const changeEvery = button("Change all", "spell-pass-btn", () => this.changeAll(input.value), `Change all ${others} of “${word.word}”`);
    changeOne.disabled = changeEvery.disabled = readOnly;
    input.disabled = readOnly;
    input.addEventListener("input", () => {
      for (const o of options) o.setAttribute("aria-selected", String(o.textContent === input.value));
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (!readOnly) this.change(input.value);
      }
    });

    const fix = el("div", "spell-pass-actions");
    fix.append(changeOne, changeEvery);
    const skip = el("div", "spell-pass-actions");
    skip.append(
      button("Ignore", "spell-pass-btn", () => this.ignore(), "Skip this one"),
      button("Ignore all", "spell-pass-btn", () => this.ignoreAll(), `Skip “${word.word}” everywhere until you reload`),
      button("Add to dictionary", "spell-pass-btn", () => this.add(), "Never mark this word again, on this device"),
    );
    const foot = el("div", "spell-pass-foot");
    foot.append(left);

    const hadFocus = this.dom.contains(document.activeElement);
    this.body.replaceChildren(label, context, input, list, fix, skip, foot);
    // The first time, focus the dialog so Enter and Escape work straight away; later, keep focus where it was.
    if (!hadFocus || !suggestions) (readOnly ? (skip.firstElementChild as HTMLElement) : input).focus({ preventScroll: true });
    if (!readOnly) input.select();
  }

  private select(options: HTMLButtonElement[], option: HTMLButtonElement, input: HTMLInputElement, value: string) {
    for (const o of options) o.setAttribute("aria-selected", String(o === option));
    input.value = value;
    input.focus({ preventScroll: true });
  }

  /** The current word, if it's still there (the note may have been edited around it). */
  private stillThere(): Word | null {
    const w = this.current;
    return w && this.view.state.sliceDoc(w.from, w.to) === w.word ? w : null;
  }

  private change(insert: string) {
    const w = this.stillThere();
    if (!w) return void this.next(this.view.state.selection.main.from);
    if (!insert || insert === w.word) return this.ignore();
    const tr = this.view.state.update({ changes: { from: w.from, to: w.to, insert }, userEvent: "input.spelling" });
    this.view.dispatch(tr);
    void this.next(tr.changes.mapPos(w.to, 1));
  }

  private changeAll(insert: string) {
    const w = this.stillThere();
    if (!w) return void this.next(this.view.state.selection.main.from);
    if (!insert || insert === w.word) return this.ignoreAll();
    const changes = changeAll(this.wrong, w.word, insert).filter((c) => this.view.state.sliceDoc(c.from, c.to) === w.word);
    const tr = this.view.state.update({ changes, userEvent: "input.spelling" });
    this.view.dispatch(tr);
    void this.next(tr.changes.mapPos(w.to, 1));
  }

  private ignore() {
    const w = this.stillThere();
    if (w) this.view.dispatch({ effects: ignoreOnce.of({ from: w.from, to: w.to }) });
    void this.next(w ? w.to : this.view.state.selection.main.from);
  }

  private ignoreAll() {
    const w = this.stillThere();
    if (w) personalDictionary.ignore(w.word);
    void this.next(w ? w.to : this.view.state.selection.main.from);
  }

  private add() {
    const w = this.stillThere();
    if (w) personalDictionary.add(w.word);
    void this.next(w ? w.to : this.view.state.selection.main.from);
  }

  /** Keeps the current word's place as the note changes. */
  update(u: ViewUpdate) {
    if (!u.docChanged || !this.current) return;
    const from = u.changes.mapPos(this.current.from, 1);
    const to = u.changes.mapPos(this.current.to, -1);
    this.current = to > from ? { ...this.current, from, to } : null;
    this.wrong = this.wrong.flatMap((w) => {
      const a = u.changes.mapPos(w.from, 1);
      const b = u.changes.mapPos(w.to, -1);
      return b > a ? [{ ...w, from: a, to: b }] : [];
    });
  }

  close(refocus = true) {
    if (!this.dom.isConnected) return;
    this.run++;
    this.dom.remove();
    this.onClose();
    if (refocus && this.view.dom.isConnected) this.view.focus();
  }
}

// ---------------------------------------------------------------- the status count

/** How many misspelt words the whole note has; null while it's being counted, or when it can't be. */
const setSpellCount = StateEffect.define<number | null>();

export const spellCount = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setSpellCount)) value = e.value;
    return value;
  },
});

/** Counts the whole note's misspelt words a moment after it stops changing, for the status bar's book. */
class SpellCounter {
  private timer = 0;
  private run = 0;
  private unsubscribe: () => void;

  constructor(private view: EditorView) {
    this.unsubscribe = personalDictionary.subscribe(() => this.schedule(0));
    this.schedule(0);
  }

  update(u: ViewUpdate) {
    const settings = u.startState.field(proofingField) !== u.state.field(proofingField);
    const ignored = u.startState.field(ignoredOnce) !== u.state.field(ignoredOnce);
    if (u.docChanged || settings || ignored || u.startState.readOnly !== u.state.readOnly) this.schedule(u.docChanged ? 800 : 0);
  }

  private schedule(delay: number) {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.count(++this.run), delay);
  }

  private async count(run: number) {
    const view = this.view;
    let count: number | null = null;
    if (!view.state.readOnly) {
      forceParsing(view, view.state.doc.length, 200);
      const state = view.state;
      const wrong = await misspelt(state, state.facet(spellerSource)(state.field(proofingField).language));
      if (run !== this.run || view.state.doc !== state.doc) return;
      count = wrong.length;
    }
    if (run === this.run && view.state.field(spellCount) !== count) view.dispatch({ effects: setSpellCount.of(count) });
  }

  destroy() {
    this.run++;
    window.clearTimeout(this.timer);
    this.unsubscribe();
  }
}

// ---------------------------------------------------------------- wiring

class SpellPassHost {
  pass: SpellPass | null = null;

  constructor(private view: EditorView) {}

  open() {
    if (this.pass) return void this.pass.next(this.view.state.selection.main.from);
    this.pass = new SpellPass(this.view, () => (this.pass = null));
    void this.pass.next(this.view.state.selection.main.from);
  }

  update(u: ViewUpdate) {
    this.pass?.update(u);
  }

  destroy() {
    this.pass?.close(false);
  }
}

const plugin = ViewPlugin.define((view) => new SpellPassHost(view));

/** Opens the spelling check at the cursor (F7). False when the note can't be checked. */
export function checkSpelling(view: EditorView): boolean {
  const host = view.plugin(plugin);
  if (!host) return false;
  host.open();
  return true;
}

/** The spelling check, its F7 key, the Ignore-once list and the whole-note count. Part of `proofing()`. */
export function spellPass(speller: (language: ProofLanguage) => SpellChecker): Extension {
  return [spellerSource.of(speller), ignoredOnce, spellCount, plugin, ViewPlugin.define((view) => new SpellCounter(view)), keymap.of([{ key: "F7", run: checkSpelling, preventDefault: true }])];
}
