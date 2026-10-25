import { syntaxTree } from "@codemirror/language";
import { Prec, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { diagnostics, setDiagnostics, type Diagnostic, type DiagnosticSource } from "../diagnostics";
import { proofingMenu } from "./contextMenu";
import { issueKey, personalDictionary } from "./dictionary";
import { basicGrammar } from "./grammarRules";
import { checkGrammar, type GrammarSegment } from "./languageApi";
import { segments, words } from "./prose";
import { LANGUAGE_NAMES, proofingField } from "./settings";
import { spellerFor, type ProofLanguage, type SpellChecker } from "./speller";

// Spelling and grammar as you type, for the visible part of the note, plus
// the right-click menu. Spelling is Hunspell in a worker (always offline);
// grammar is LanguageTool when the server has it, otherwise a few safe rules
// that run here. Both report through the shared diagnostics layer.

export { defaultProofing, LANGUAGE_NAMES, setProofing, type ProofingSettings } from "./settings";

// ---------------------------------------------------------------- shared plumbing

/** Runs `check` a moment after the note or the view stops changing, and sends what it finds. */
abstract class Checker {
  private timer = 0;
  private sent = "";
  protected run = 0;
  protected destroyed = false;
  private unsubscribe: () => void;

  constructor(
    protected view: EditorView,
    private source: DiagnosticSource,
    private delay: number,
  ) {
    this.unsubscribe = personalDictionary.subscribe(() => this.schedule(0));
    this.schedule(0);
  }

  update(u: ViewUpdate) {
    const settingsChanged =
      u.startState.field(proofingField) !== u.state.field(proofingField) || u.startState.readOnly !== u.state.readOnly;
    if (settingsChanged) this.reset();
    if (u.docChanged || u.viewportChanged || settingsChanged) this.schedule(settingsChanged ? 0 : this.delay);
  }

  protected reset() {}

  schedule(delay = this.delay) {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      const run = ++this.run;
      this.check(run).catch(() => {});
    }, delay);
  }

  protected abstract check(run: number): Promise<void>;

  /** Sends the list, unless it's what the layer already has or this run is stale. */
  protected send(run: number, items: Diagnostic[]) {
    if (this.destroyed || run !== this.run) return;
    const key = JSON.stringify(items);
    if (key === this.sent) return;
    this.sent = key;
    this.view.dispatch({ effects: setDiagnostics.of({ source: this.source, items }) });
  }

  destroy() {
    this.destroyed = true;
    window.clearTimeout(this.timer);
    this.unsubscribe();
  }
}

/** The visible part of the note, widened to whole lines. */
function visibleLines(view: EditorView): { from: number; to: number }[] {
  return view.visibleRanges.map(({ from, to }) => ({ from: view.state.doc.lineAt(from).from, to: view.state.doc.lineAt(to).to }));
}

// ---------------------------------------------------------------- spelling

class SpellChecking extends Checker {
  /** Set while you're typing a word, so it isn't underlined before you've finished it. */
  private typing = false;

  constructor(
    view: EditorView,
    private speller: (language: ProofLanguage) => SpellChecker,
  ) {
    super(view, "spelling", 250);
  }

  update(u: ViewUpdate) {
    if (u.transactions.some((tr) => tr.isUserEvent("input.type") || tr.isUserEvent("delete"))) this.typing = true;
    else if (u.selectionSet) this.typing = false;
    super.update(u);
    if (u.selectionSet && !u.docChanged) this.schedule(400);
  }

  protected async check(run: number) {
    const settings = this.view.state.field(proofingField);
    // Readers can't fix anything, so they aren't shown what to fix.
    if (!settings.spelling || this.view.state.readOnly) return this.send(run, []);
    const speller = this.speller(settings.language);
    const found = visibleLines(this.view).flatMap(({ from, to }) => words(this.view.state, from, to));
    await speller.check(found.map((w) => w.word));
    if (this.destroyed || run !== this.run) return;

    const state = this.view.state;
    const cursor = state.selection.main;
    const wrong = found.filter(
      (w) =>
        speller.known(w.word) === false &&
        !personalDictionary.has(w.word) &&
        !(this.typing && cursor.empty && cursor.head === w.to) &&
        // The note may have moved on while the worker was busy.
        state.sliceDoc(w.from, w.to) === w.word,
    );
    const items = (fixes: Map<string, string[]>) =>
      wrong.map(
        (w): Diagnostic => ({
          from: w.from,
          to: w.to,
          source: "spelling",
          rule: "SPELLING",
          title: "Spelling",
          message: `“${w.word}” isn't in the ${LANGUAGE_NAMES[settings.language]} dictionary.`,
          fixes: (fixes.get(w.word) ?? []).slice(0, 3).map((s) => ({ label: s, from: w.from, to: w.to, insert: s })),
        }),
      );
    // Underline straight away, then add the suggestions to the hover card when they come.
    this.send(run, items(new Map()));
    const unique = [...new Set(wrong.map((w) => w.word))].slice(0, 30);
    const suggested = new Map(await Promise.all(unique.map(async (w) => [w, await speller.suggest(w)] as const)));
    if (this.view.state.doc !== state.doc) return;
    this.send(run, items(suggested));
  }
}

// ---------------------------------------------------------------- grammar

// Blocks that aren't prose.
const NOT_PROSE = /^(FencedCode|CodeBlock|HTMLBlock|HorizontalRule|LinkReference|CommentBlock|ProcessingInstruction)$/;
const MAX_BLOCK = 8000;
const MAX_REQUEST = 12000;

type Block = { from: number; to: number; text: string; key: string; segs: GrammarSegment[] };
type Found = Omit<Diagnostic, "source">;

function proseBlocks(state: EditorState, ranges: { from: number; to: number }[], language: string): Block[] {
  const blocks: Block[] = [];
  const seen = new Set<number>();
  for (const range of ranges) {
    let node = syntaxTree(state).topNode.firstChild;
    for (; node; node = node.nextSibling) {
      if (node.to < range.from || node.from > range.to || seen.has(node.from)) continue;
      if (NOT_PROSE.test(node.name) || node.to - node.from > MAX_BLOCK) continue;
      seen.add(node.from);
      const text = state.sliceDoc(node.from, node.to);
      const segs = segments(state, node.from, node.to).map((s): GrammarSegment => {
        const slice = state.sliceDoc(s.from, s.to);
        return s.markup ? { markup: slice, ...(s.interpretAs && { interpretAs: s.interpretAs }) } : { text: slice };
      });
      blocks.push({ from: node.from, to: node.to, text, key: `${language}\u0000${text}`, segs });
    }
  }
  return blocks;
}

/** The block as plain prose for the local rules, same length: marks become spaces, code an underscore run. */
function plainProse(block: Block): string {
  return block.segs
    .map((s) => {
      if (s.text !== undefined) return s.text;
      const markup = s.markup ?? "";
      if (s.interpretAs === "code") return "_".repeat(markup.length);
      return markup.replace(/[^|\n]/g, " ");
    })
    .join("");
}

class GrammarChecking extends Checker {
  private remote = new Map<string, Found[]>();
  private downUntil = 0;

  constructor(view: EditorView) {
    super(view, "grammar", 1200);
  }

  protected reset() {
    this.remote.clear();
  }

  protected async check(run: number) {
    const settings = this.view.state.field(proofingField);
    if (!settings.grammar || this.view.state.readOnly) return this.send(run, []);
    const state = this.view.state;
    const blocks = proseBlocks(state, visibleLines(this.view), settings.language);
    const useRemote = settings.remoteGrammar && Date.now() > this.downUntil;
    if (useRemote) {
      try {
        await this.fetch(settings.language, blocks.filter((b) => !this.remote.has(b.key)));
      } catch {
        // Offline, or LanguageTool is down: use the local rules for a minute.
        this.downUntil = Date.now() + 60_000;
      }
      if (this.destroyed || run !== this.run || this.view.state.doc !== state.doc) return;
    }
    const items: Diagnostic[] = [];
    for (const block of blocks) {
      const found = useRemote && this.remote.has(block.key) ? this.remote.get(block.key)! : local(block);
      for (const f of found) {
        const d: Diagnostic = {
          ...f,
          source: "grammar",
          from: block.from + f.from,
          to: block.from + f.to,
          fixes: f.fixes?.map((x) => ({ ...x, from: block.from + x.from, to: block.from + x.to })),
        };
        if (!personalDictionary.has(issueKey(d.rule, state.sliceDoc(d.from, d.to)))) items.push(d);
      }
    }
    this.send(run, items);
  }

  /** Asks LanguageTool about these blocks, a few at a time, and remembers the answers by text. */
  private async fetch(language: string, blocks: Block[]) {
    const batches: Block[][] = [];
    let size = 0;
    for (const b of blocks) {
      if (!batches.length || size + b.text.length > MAX_REQUEST) batches.push([]), (size = 0);
      batches[batches.length - 1].push(b);
      size += b.text.length + 2;
    }
    for (const batch of batches) {
      const annotation: GrammarSegment[] = [];
      const starts: number[] = [];
      let offset = 0;
      batch.forEach((b, i) => {
        if (i) annotation.push({ markup: "\n\n", interpretAs: "\n\n" }), (offset += 2);
        starts.push(offset);
        annotation.push(...b.segs);
        offset += b.text.length;
      });
      const matches = await checkGrammar(language, annotation);
      batch.forEach((b, i) => {
        const start = starts[i];
        const found = matches
          .filter((m) => m.offset >= start && m.offset + m.length <= start + b.text.length)
          .map((m): Found => {
            const from = m.offset - start;
            const to = from + m.length;
            return {
              from,
              to,
              rule: m.rule,
              title: m.short || "Grammar",
              message: m.message,
              fixes: m.replacements.slice(0, 3).map((r) => ({ label: r || "Remove", from, to, insert: r })),
            };
          });
        this.remote.set(b.key, found);
      });
    }
    // Keep the memory from growing without end in a long session.
    if (this.remote.size > 2000) this.remote.clear();
  }
}

function local(block: Block): Found[] {
  return basicGrammar(plainProse(block)).map((i) => ({
    from: i.from,
    to: i.to,
    rule: i.rule,
    title: i.rule === "REPEATED_WORD" ? "Repeated word" : i.rule === "A_AN" ? "A or an" : "Capital I",
    message: i.message,
    fixes: i.replacements.map((r) => ({ label: r || "Remove", from: i.from, to: i.to, insert: r })),
  }));
}

// ---------------------------------------------------------------- the extension

/** Spelling, grammar and the right-click menu. Set the language and switches with `setProofing`. */
export function proofing({ speller = spellerFor }: { speller?: (language: ProofLanguage) => SpellChecker } = {}): Extension {
  return [
    proofingField,
    diagnostics(),
    ViewPlugin.define((view) => new SpellChecking(view, speller)),
    ViewPlugin.define((view) => new GrammarChecking(view)),
    // Our underlines replace the browser's, and screen readers and hyphenation get the language.
    Prec.highest(EditorView.contentAttributes.compute([proofingField], (s) => ({ spellcheck: "false", lang: s.field(proofingField).language }))),
    proofingMenu(speller),
  ];
}
