import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { isUndoCommand, spokenToText } from "./spoken";

// The editor side of dictation and read-aloud: a faint ghost of what's being
// heard, final words inserted as ordinary edits (so they merge with Yjs), and
// the sentence being read highlighted. None of it touches the Markdown.

type Range = { from: number; to: number };

/** What the recogniser has heard so far but not settled on; null clears it. */
export const setInterim = StateEffect.define<string | null>();
/** The sentence being read aloud; null clears it. */
export const setSpoken = StateEffect.define<Range | null>();
const setDictated = StateEffect.define<Range | null>();

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: GhostWidget) {
    return other.text === this.text;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-dictation-ghost";
    span.setAttribute("aria-hidden", "true");
    span.textContent = this.text;
    return span;
  }
  ignoreEvent() {
    return true;
  }
}

const interimField = StateField.define<string | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setInterim)) value = e.value;
    return value;
  },
  provide: (f) =>
    EditorView.decorations.compute([f, "selection"], (state) => {
      const text = state.field(f);
      if (!text) return Decoration.none;
      const at = state.selection.main.head;
      return Decoration.set([Decoration.widget({ widget: new GhostWidget(` ${text}`), side: 1 }).range(at)]);
    }),
});

const spokenMark = Decoration.mark({ class: "cm-read-aloud" });

const spokenField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects)
      if (e.is(setSpoken)) {
        const r = e.value;
        value = r && r.to > r.from && r.to <= tr.state.doc.length ? Decoration.set([spokenMark.range(r.from, r.to)]) : Decoration.none;
      }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Where the last dictated phrase went, kept in step with later edits so "undo that" can find it. */
const dictatedField = StateField.define<Range | null>({
  create: () => null,
  update(value, tr) {
    if (value && tr.docChanged) {
      const from = tr.changes.mapPos(value.from, 1);
      const to = tr.changes.mapPos(value.to, -1);
      value = to > from ? { from, to } : null;
    }
    for (const e of tr.effects) if (e.is(setDictated)) value = e.value;
    return value;
  },
});

const speechTheme = EditorView.theme({
  ".cm-dictation-ghost": { opacity: "0.45", fontStyle: "italic" },
  ".cm-read-aloud": { background: "color-mix(in srgb, var(--accent) 22%, transparent)", borderRadius: "3px" },
});

export function speechEditor(): Extension {
  return [interimField, spokenField, dictatedField, speechTheme];
}

/**
 * Puts a final dictation result in at the cursor, replacing any selection.
 * "Undo that" takes back the last dictated phrase instead, if it's still there.
 */
export function insertDictation(view: EditorView, transcript: string) {
  const state = view.state;
  if (isUndoCommand(transcript)) {
    const last = state.field(dictatedField, false);
    if (last)
      view.dispatch({
        changes: { from: last.from, to: last.to },
        selection: { anchor: last.from },
        effects: [setDictated.of(null), setInterim.of(null)],
        userEvent: "delete.dictate",
      });
    else view.dispatch({ effects: setInterim.of(null) });
    return;
  }
  const { from, to } = state.selection.main;
  const text = spokenToText(transcript, { before: state.sliceDoc(Math.max(0, from - 200), from) });
  if (!text) return view.dispatch({ effects: setInterim.of(null) });
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    effects: [setDictated.of({ from, to: from + text.length }), setInterim.of(null), EditorView.scrollIntoView(from + text.length)],
    userEvent: "input.dictate",
  });
}

/** Highlights the sentence being read and keeps it in view; null clears it. */
export function showSpoken(view: EditorView, range: Range | null) {
  if (!view.dom.isConnected) return;
  const effects: StateEffect<unknown>[] = [setSpoken.of(range)];
  if (range && range.to <= view.state.doc.length) effects.push(EditorView.scrollIntoView(range.from, { y: "nearest", yMargin: 80 }));
  view.dispatch({ effects });
}
