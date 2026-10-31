import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { diagnostics, setDiagnostics, type Diagnostic } from "../diagnostics";
import { lint, readability, RULE_INFO, type LintHint, type LintRule, type Readability } from "./rules";

// Puts the writing lint in the editor. It runs a moment after you stop typing,
// in idle time, and sends its hints to the shared diagnostics layer. The hints
// live in this editor only, so co-editors never see yours.

export type LintSettings = { on: boolean; off: LintRule[] };

export type LintReport = {
  hints: (LintHint & { snippet: string })[];
  doc: Readability | null;
  /** The selection's score, or null when nothing (or no prose) is selected. */
  selection: Readability | null;
};

export const setLint = StateEffect.define<LintSettings>();

const lintSettings = StateField.define<LintSettings>({
  create: () => ({ on: false, off: [] }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setLint)) value = e.value;
    return value;
  },
});

const DELAY = 400;

const idle = (run: () => void): (() => void) => {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(run, { timeout: 1000 });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(run, 0);
  return () => clearTimeout(id);
};

function snippet(doc: string, hint: LintHint): string {
  const text = doc.slice(hint.from, Math.min(hint.to, hint.from + 80)).replace(/\s+/g, " ").trim();
  return hint.to - hint.from > 80 ? `${text}…` : text;
}

export function toDiagnostic(hint: LintHint): Diagnostic {
  return {
    from: hint.from,
    to: hint.to,
    source: "lint",
    rule: hint.rule,
    title: RULE_INFO[hint.rule].title,
    message: hint.message,
    fixes: hint.fixes,
    // A ready-made rewording already shows the idea; the example is for when there isn't one.
    example: hint.fixes?.[0]?.label.startsWith("Change to") ? undefined : RULE_INFO[hint.rule].example,
  };
}

export function writingLint(onReport: (report: LintReport | null) => void, initial?: LintSettings): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      timer = 0;
      selTimer = 0;
      cancelIdle: (() => void) | null = null;
      doc: Readability | null = null;
      hints: LintReport["hints"] = [];

      constructor(readonly view: EditorView) {
        this.schedule(0);
      }

      update(update: ViewUpdate) {
        const before = update.startState.field(lintSettings);
        const after = update.state.field(lintSettings);
        if (before !== after) {
          if (!after.on) this.clear();
          else this.schedule(0);
        } else if (after.on && update.docChanged) this.schedule(DELAY);
        else if (after.on && update.selectionSet) {
          clearTimeout(this.selTimer);
          this.selTimer = window.setTimeout(() => this.report(), 150);
        }
      }

      schedule(delay: number) {
        clearTimeout(this.timer);
        this.cancelIdle?.();
        this.timer = window.setTimeout(() => (this.cancelIdle = idle(() => this.run())), delay);
      }

      run() {
        this.cancelIdle = null;
        const { on, off } = this.view.state.field(lintSettings);
        if (!on) return;
        const text = this.view.state.doc.toString();
        const hints = lint(text).filter((h) => !off.includes(h.rule));
        this.hints = hints.map((h) => ({ ...h, snippet: snippet(text, h) }));
        this.doc = readability(text);
        this.view.dispatch({ effects: setDiagnostics.of({ source: "lint", items: hints.map(toDiagnostic) }) });
        this.report();
      }

      report() {
        const { state } = this.view;
        const sel = state.selection.main;
        const selection = sel.empty ? null : readability(state.doc.toString(), { from: sel.from, to: sel.to });
        onReport({ hints: this.hints, doc: this.doc, selection });
      }

      clear() {
        clearTimeout(this.timer);
        clearTimeout(this.selTimer);
        this.cancelIdle?.();
        this.hints = [];
        this.doc = null;
        // Not inside this update: dispatching has to wait for it to finish.
        queueMicrotask(() => {
          if (!this.view.state.field(lintSettings).on) this.view.dispatch({ effects: setDiagnostics.of({ source: "lint", items: [] }) });
        });
        onReport(null);
      }

      destroy() {
        clearTimeout(this.timer);
        clearTimeout(this.selTimer);
        this.cancelIdle?.();
      }
    },
  );
  return [diagnostics(), initial ? lintSettings.init(() => initial) : lintSettings, plugin];
}
