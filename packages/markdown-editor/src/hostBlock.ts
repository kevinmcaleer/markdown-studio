import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from "@codemirror/view";
import { imageAt } from "./imagePopover";

// A host's own editor in the text (`openBlock`): a box the host fills, drawn
// in place of the picture whose Markdown starts at `pos`, or, with `pos` on a
// line that isn't a picture, after that line. It stays put while the text
// around it changes and is redrawn without losing what's in it, until the
// host closes it. kevsrobots puts its wiring workspace in one, over the
// wiring diagram's picture, like Layers graphics (layersBlock.ts), and its
// Files & Models panel under that section's text.
//
// Blocks in different `slot`s are open together; opening a block in a slot
// closes the one already in it (one per slot, "default" when not given).

export type HostBlockOptions = {
  /** Called once when the block closes: by `close()`, another block opening, or the editor going. */
  onClose?: () => void;
  /** The height the editor allows for it before it's drawn, in px (520). */
  estimatedHeight?: number;
  /** Which of the host's blocks this is ("default"): one open per slot. */
  slot?: string;
};

export interface HostBlock {
  /** The box the host fills. It's in the editor while the block is open. */
  readonly element: HTMLElement;
  /** Where it is: the picture's start (in place of it) or a position on the line it follows. */
  pos(): number;
  /** Moves it to the picture whose Markdown starts at `pos` (or after the line at `pos`). */
  moveTo(pos: number): void;
  isOpen(): boolean;
  close(): void;
}

type Open = { id: number; pos: number; height: number; slot: string };
const openEffect = StateEffect.define<Open>();
const closeEffect = StateEffect.define<number>();

type Session = { id: number; slot: string; container: HTMLElement; closed: boolean; onClose?: () => void };
// Each editor's open blocks, by slot.
const sessions = new WeakMap<EditorView, Map<string, Session>>();
let nextId = 1;

function sessionsOf(view: EditorView): Map<string, Session> {
  let map = sessions.get(view);
  if (!map) sessions.set(view, (map = new Map()));
  return map;
}

class HostBlockWidget extends WidgetType {
  constructor(readonly id: number, readonly slot: string, readonly height: number) {
    super();
  }
  eq(other: HostBlockWidget) {
    return other.id === this.id;
  }
  toDOM(view: EditorView) {
    const s = sessions.get(view)?.get(this.slot);
    if (s && s.id === this.id) return s.container;
    return document.createElement("div");
  }
  get estimatedHeight() {
    return this.height;
  }
  ignoreEvent() {
    return true;
  }
  destroy() {
    // The block outlives a redraw; closing it is what ends it.
  }
}

// The open blocks, by slot.
const field = StateField.define<ReadonlyMap<string, Open>>({
  create: () => new Map(),
  update(value, tr) {
    let next: Map<string, Open> | null = null;
    const edit = () => (next ??= new Map(value));
    for (const e of tr.effects) {
      if (e.is(openEffect)) edit().set(e.value.slot, e.value);
      if (e.is(closeEffect)) {
        for (const [slot, open] of next ?? value) if (open.id === e.value) edit().delete(slot);
      }
    }
    const current: ReadonlyMap<string, Open> = next ?? value;
    if (!current.size || !tr.docChanged) return current;
    let moved: Map<string, Open> | null = null;
    for (const [slot, open] of current) {
      const pos = tr.changes.mapPos(open.pos, -1);
      if (pos !== open.pos) (moved ??= new Map(current)).set(slot, { ...open, pos });
    }
    return moved ?? current;
  },
});

/** Where the block goes for `pos`: over the picture's line, or after the line. */
export function hostBlockRange(state: EditorState, pos: number): { from: number; to: number; replace: boolean } {
  const at = Math.max(0, Math.min(pos, state.doc.length));
  const line = state.doc.lineAt(at);
  if (imageAt(state, at)) return { from: line.from, to: line.to, replace: true };
  return { from: line.to, to: line.to, replace: false };
}

function decorationsFor(state: EditorState, blocks: ReadonlyMap<string, Open>): DecorationSet {
  const ranges = [];
  const replaced: { from: number; to: number }[] = [];
  for (const open of blocks.values()) {
    const widget = new HostBlockWidget(open.id, open.slot, open.height);
    const r = hostBlockRange(state, open.pos);
    if (r.replace) {
      // Two blocks can't both replace one picture: the first keeps it.
      if (replaced.some((x) => x.from < r.to && r.from < x.to)) continue;
      replaced.push(r);
      ranges.push(Decoration.replace({ widget, block: true }).range(r.from, r.to));
    } else {
      ranges.push(Decoration.widget({ widget, block: true, side: 1 }).range(r.to));
    }
  }
  return Decoration.set(ranges, true);
}

// Block decorations have to come straight from the state, not a view plugin.
const decorations = EditorView.decorations.compute([field, "doc"], (state) => {
  const blocks = state.field(field);
  return blocks.size ? decorationsFor(state, blocks) : Decoration.none;
});

function end(view: EditorView, s: Session, dispatch: boolean): void {
  if (s.closed) return;
  s.closed = true;
  const map = sessions.get(view);
  if (map?.get(s.slot) === s) map.delete(s.slot);
  if (dispatch && view.state.field(field, false)?.get(s.slot)?.id === s.id) view.dispatch({ effects: closeEffect.of(s.id) });
  s.container.remove();
  s.onClose?.();
}

/** Opens a host block at `pos` (see above). One per slot: an open one in the same slot closes first. */
export function openHostBlock(view: EditorView, pos: number, options: HostBlockOptions = {}): HostBlock {
  const slot = options.slot || "default";
  const old = sessions.get(view)?.get(slot);
  if (old) end(view, old, true);
  const id = nextId++;
  const height = options.estimatedHeight ?? 520;
  const container = document.createElement("div");
  container.className = "cm-host-block";
  container.dataset.slot = slot;
  const session: Session = { id, slot, container, closed: false, onClose: options.onClose };
  sessionsOf(view).set(slot, session);
  view.dispatch({ effects: openEffect.of({ id, pos, height, slot }), scrollIntoView: false });
  return {
    element: container,
    pos: () => {
      const open = view.state.field(field, false)?.get(slot);
      return open && open.id === id ? open.pos : -1;
    },
    moveTo(next) {
      if (session.closed) return;
      view.dispatch({ effects: openEffect.of({ id, pos: next, height, slot }), scrollIntoView: false });
    },
    isOpen: () => !session.closed,
    close: () => end(view, session, true),
  };
}

// Spaced with padding, never margin: CodeMirror measures a block widget by its
// border box, so a margin (its own, or a child's that collapses through it)
// put every line below the block that much lower than CodeMirror thought,
// and clicks and the arrow keys landed a line or two down. flow-root keeps
// the host's own margins inside the box.
const theme = EditorView.theme({
  ".cm-host-block": {
    display: "flow-root",
    margin: "0",
    padding: "0.5rem 0 1rem",
    whiteSpace: "normal",
    cursor: "default",
    fontFamily: "var(--font-sans, system-ui)",
  },
});

// One extension, so redrawing the editor's extensions keeps an open block.
const extension: Extension = [
  field,
  decorations,
  theme,
  ViewPlugin.define((view) => ({
    destroy() {
      const map = sessions.get(view);
      if (map) for (const s of [...map.values()]) end(view, s, false);
    },
  })),
];

/** Host blocks in the live view (always on: nothing shows until the host opens one). */
export function hostBlocks(): Extension {
  return extension;
}
