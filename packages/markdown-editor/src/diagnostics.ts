import { Prec, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, hoverTooltip, type DecorationSet } from "@codemirror/view";

// One layer for every "here's something about your writing" mark in the
// editor: writing lint, spelling, grammar. Each feature is a `source` that
// sends its whole list with `setDiagnostics`; the layer keeps the lists apart,
// maps them through edits until the next list arrives, underlines them, and
// shows one hover card per spot. Nothing here changes the text unless someone
// clicks a fix, which is an ordinary editor transaction.

/** Who found it. Each look is set in the theme below, so marks never clash. */
export type DiagnosticSource = "lint" | "spelling" | "grammar";

export type DiagnosticFix = { label: string; from: number; to: number; insert: string };

/**
 * A fix that's worked out when it's clicked, like rewording the whole
 * sentence. The card shows the answer beside the original and only
 * changes the text when "Use this" is clicked.
 */
export type DiagnosticSuggest = {
  label: string;
  /** Shown on the button while waiting, when working it out takes a moment. */
  busy?: string;
  /** Whether to offer it here at all. */
  available?: (state: EditorState, d: Diagnostic) => boolean;
  /** The change to offer, or a sentence saying why there isn't one. */
  run: (state: EditorState, d: Diagnostic) => Promise<DiagnosticFix | string>;
};

export type Diagnostic = {
  from: number;
  to: number;
  source: DiagnosticSource;
  /** The rule's id, so a panel can count and group them. */
  rule: string;
  /** A short name for the rule, the hover card's heading. */
  title: string;
  message: string;
  fixes?: DiagnosticFix[];
  /** A before-and-after line that shows what the rule means. */
  example?: { before: string; after: string };
  suggest?: DiagnosticSuggest;
};

/** Replaces every diagnostic from one source. Send an empty list to clear it. */
export const setDiagnostics = StateEffect.define<{ source: DiagnosticSource; items: Diagnostic[] }>();

type Sets = Partial<Record<DiagnosticSource, Diagnostic[]>>;

function mapAll(sets: Sets, map: (pos: number, assoc: number) => number): Sets {
  const out: Sets = {};
  for (const [source, items] of Object.entries(sets) as [DiagnosticSource, Diagnostic[]][]) {
    out[source] = items.flatMap((d) => {
      const from = map(d.from, 1);
      const to = map(d.to, -1);
      // A spot that was typed over is gone; the next run will say if it's back.
      if (to <= from && d.to > d.from) return [];
      const fixes = d.fixes?.map((f) => ({ ...f, from: map(f.from, 1), to: map(f.to, -1) }));
      return [{ ...d, from, to, fixes: fixes?.filter((f) => f.from <= f.to) }];
    });
  }
  return out;
}

export const diagnosticsField = StateField.define<Sets>({
  create: () => ({}),
  update(sets, tr) {
    if (tr.docChanged) sets = mapAll(sets, (pos, assoc) => tr.changes.mapPos(pos, assoc));
    for (const e of tr.effects)
      if (e.is(setDiagnostics)) {
        const len = tr.state.doc.length;
        sets = { ...sets, [e.value.source]: e.value.items.filter((d) => d.from >= 0 && d.to <= len && d.from <= d.to) };
      }
    return sets;
  },
  // High precedence puts the underline inside the live view's marks, so a
  // misspelt word in a link splits the underline, not the link's element
  // (the host styles links by that element, as chips for instance).
  provide: (f) => Prec.high(EditorView.decorations.from(f, decorate)),
});

const marks: Record<DiagnosticSource, Decoration> = {
  lint: Decoration.mark({ class: "cm-diag cm-diag-lint" }),
  spelling: Decoration.mark({ class: "cm-diag cm-diag-spelling" }),
  grammar: Decoration.mark({ class: "cm-diag cm-diag-grammar" }),
};

function decorate(sets: Sets): DecorationSet {
  const ranges = [];
  for (const [source, items] of Object.entries(sets) as [DiagnosticSource, Diagnostic[]][])
    for (const d of items) if (d.to > d.from) ranges.push(marks[source].range(d.from, d.to));
  return Decoration.set(ranges, true);
}

/** Everything at `pos`, spelling first, then grammar, then lint. */
export function diagnosticsAt(state: EditorState, pos: number): Diagnostic[] {
  const sets = state.field(diagnosticsField, false) ?? {};
  const order: DiagnosticSource[] = ["spelling", "grammar", "lint"];
  return order.flatMap((s) => (sets[s] ?? []).filter((d) => d.from <= pos && pos <= d.to));
}

/** One source's current list, in document order. */
export function diagnosticsOf(state: EditorState, source: DiagnosticSource): Diagnostic[] {
  return [...(state.field(diagnosticsField, false)?.[source] ?? [])].sort((a, b) => a.from - b.from);
}

export function applyFix(view: EditorView, fix: DiagnosticFix) {
  view.dispatch({ changes: { from: fix.from, to: fix.to, insert: fix.insert }, userEvent: "input.fix" });
  view.focus();
}

/** The hover card for the diagnostics at one spot (exported for tests). */
export function card(view: EditorView, found: Diagnostic[]): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "cm-diag-card";
  for (const d of found) {
    const item = dom.appendChild(document.createElement("div"));
    item.className = `cm-diag-item cm-diag-item-${d.source}`;
    const title = item.appendChild(document.createElement("strong"));
    title.textContent = d.title;
    const message = item.appendChild(document.createElement("p"));
    message.textContent = d.message;
    if (d.example) {
      const ex = item.appendChild(document.createElement("p"));
      ex.className = "cm-diag-example";
      ex.appendChild(document.createElement("span")).textContent = "For example ";
      ex.appendChild(document.createElement("del")).textContent = d.example.before;
      ex.appendChild(document.createTextNode(" → "));
      ex.appendChild(document.createElement("ins")).textContent = d.example.after;
    }
    const suggest = d.suggest && !view.state.readOnly && (d.suggest.available?.(view.state, d) ?? true) ? d.suggest : null;
    if ((d.fixes?.length || suggest) && !view.state.readOnly) {
      const row = item.appendChild(document.createElement("div"));
      row.className = "cm-diag-fixes";
      if (suggest) suggestButton(view, d, suggest, item, row);
      for (const fix of d.fixes ?? []) {
        const button = row.appendChild(document.createElement("button"));
        button.type = "button";
        button.textContent = fix.label;
        button.addEventListener("mousedown", (e) => e.preventDefault());
        button.addEventListener("click", () => applyFix(view, fix));
      }
    }
  }
  return dom;
}

function suggestButton(view: EditorView, d: Diagnostic, suggest: DiagnosticSuggest, item: HTMLElement, row: HTMLElement) {
  const button = row.appendChild(document.createElement("button"));
  button.type = "button";
  button.className = "cm-diag-suggest";
  button.textContent = suggest.label;
  button.addEventListener("mousedown", (e) => e.preventDefault());
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = suggest.busy ?? suggest.label;
    item.querySelector(".cm-diag-preview")?.remove();
    let answer: DiagnosticFix | string;
    try {
      answer = await suggest.run(view.state, d);
    } catch {
      answer = "Couldn't get a suggestion just now. Try again in a moment.";
    }
    button.disabled = false;
    button.textContent = suggest.label;
    const preview = item.appendChild(document.createElement("div"));
    preview.className = "cm-diag-preview";
    if (typeof answer === "string") {
      preview.appendChild(document.createElement("p")).textContent = answer;
      return;
    }
    const fix = answer;
    // What it replaces, so a click after the text has changed underneath doesn't land in the wrong place.
    const before = view.state.sliceDoc(fix.from, fix.to);
    const text = preview.appendChild(document.createElement("p"));
    text.className = "cm-diag-example";
    text.appendChild(document.createElement("del")).textContent = before;
    text.appendChild(document.createTextNode(" → "));
    text.appendChild(document.createElement("ins")).textContent = fix.insert;
    const actions = preview.appendChild(document.createElement("div"));
    actions.className = "cm-diag-fixes";
    const use = actions.appendChild(document.createElement("button"));
    use.type = "button";
    use.className = "cm-diag-use";
    use.textContent = "Use this";
    const dismiss = actions.appendChild(document.createElement("button"));
    dismiss.type = "button";
    dismiss.textContent = "Dismiss";
    for (const b of [use, dismiss]) b.addEventListener("mousedown", (e) => e.preventDefault());
    use.addEventListener("click", () => {
      if (view.state.sliceDoc(fix.from, fix.to) !== before) {
        preview.replaceChildren(Object.assign(document.createElement("p"), { textContent: "The sentence changed. Ask again for a fresh suggestion." }));
        return;
      }
      // An ordinary edit, so Ctrl+Z puts the old sentence back.
      applyFix(view, fix);
    });
    dismiss.addEventListener("click", () => preview.remove());
  });
}

const hoverCard = hoverTooltip((view, pos) => {
  const found = diagnosticsAt(view.state, pos);
  if (!found.length) return null;
  return {
    pos: Math.min(...found.map((d) => d.from)),
    end: Math.max(...found.map((d) => d.to)),
    above: true,
    create: () => ({ dom: card(view, found) }),
  };
});

const diagnosticsTheme = EditorView.theme({
  ".cm-diag": { textDecorationSkipInk: "none", textUnderlineOffset: "3px" },
  // Lint is a gentle nudge: a faint dotted line, never a squiggle.
  ".cm-diag-lint": { textDecoration: "underline dotted color-mix(in srgb, var(--accent, #c96442) 60%, transparent)" },
  ".cm-diag-spelling": { textDecoration: "underline wavy var(--danger, #b4322a)", textDecorationThickness: "1px" },
  ".cm-diag-grammar": { textDecoration: "underline wavy #3a78d8", textDecorationThickness: "1px" },
  ".cm-tooltip.cm-tooltip-hover:has(.cm-diag-card)": { border: "0", background: "transparent" },
  ".cm-diag-card": {
    maxWidth: "320px",
    padding: "0.5rem 0.65rem",
    background: "var(--surface, #fff)",
    color: "var(--text, inherit)",
    border: "1px solid var(--border, #ddd)",
    borderRadius: "10px",
    boxShadow: "0 6px 24px rgb(0 0 0 / 0.12)",
    font: "13px/1.4 system-ui, sans-serif",
  },
  ".cm-diag-item + .cm-diag-item": { marginTop: "0.5rem", paddingTop: "0.5rem", borderTop: "1px solid var(--border, #ddd)" },
  ".cm-diag-item p": { margin: "0.15rem 0 0", color: "var(--muted, #666)" },
  ".cm-diag-item .cm-diag-example": { fontSize: "12px", marginTop: "0.3rem" },
  ".cm-diag-example span": { fontWeight: "600" },
  ".cm-diag-example del": { textDecorationColor: "var(--danger, #b4322a)" },
  ".cm-diag-example ins": { textDecoration: "none", color: "var(--text, inherit)", background: "color-mix(in srgb, var(--accent, #c96442) 14%, transparent)", borderRadius: "3px", padding: "0 2px" },
  ".cm-diag-fixes": { display: "flex", flexWrap: "wrap", gap: "0.3rem", marginTop: "0.4rem" },
  ".cm-diag-fixes button": {
    font: "inherit",
    padding: "0.15rem 0.5rem",
    border: "1px solid var(--border, #ddd)",
    borderRadius: "6px",
    background: "var(--surface-2, #f4f4f4)",
    color: "inherit",
    cursor: "pointer",
  },
  ".cm-diag-preview": { marginTop: "0.45rem", paddingTop: "0.4rem", borderTop: "1px dashed var(--border, #ddd)" },
  ".cm-diag-preview .cm-diag-example": { fontSize: "13px", color: "var(--text, inherit)" },
  ".cm-diag-fixes button:disabled": { opacity: "0.6", cursor: "progress" },
  ".cm-diag-fixes button:first-child": { borderColor: "color-mix(in srgb, var(--accent, #c96442) 55%, transparent)" },
  ".cm-diag-fixes button:hover": { background: "color-mix(in srgb, var(--accent, #c96442) 14%, var(--surface-2, #f4f4f4))" },
});

const layer: Extension = [diagnosticsField, hoverCard, diagnosticsTheme];

/** The layer itself. Every feature that sends `setDiagnostics` can include it; it's only added once. */
export function diagnostics(): Extension {
  return layer;
}
