import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from "@codemirror/view";
import { imageAt } from "./imagePopover";

// A host's own editor in the text (`openBlock`): a box the host fills, drawn
// in place of the picture whose Markdown starts at `pos`, or, with `pos` on a
// line that isn't a picture, after that line. It stays put while the text
// around it changes and is redrawn without losing what's in it, until the
// host closes it. kevsrobots puts its wiring workspace in one, over the
// wiring diagram's picture, like Layers graphics (layersBlock.ts).

export type HostBlockOptions = {
  /** Called once when the block closes: by `close()`, another block opening, or the editor going. */
  onClose?: () => void;
  /** The height the editor allows for it before it's drawn, in px (520). */
  estimatedHeight?: number;
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

type Open = { id: number; pos: number; height: number };
const openEffect = StateEffect.define<Open>();
const closeEffect = StateEffect.define<number>();

type Session = { id: number; container: HTMLElement; closed: boolean; onClose?: () => void };
const sessions = new WeakMap<EditorView, Session>();
let nextId = 1;

class HostBlockWidget extends WidgetType {
  constructor(readonly id: number, readonly height: number) {
    super();
  }
  eq(other: HostBlockWidget) {
    return other.id === this.id;
  }
  toDOM(view: EditorView) {
    const s = sessions.get(view);
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

const field = StateField.define<Open | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(openEffect)) return e.value;
      if (e.is(closeEffect) && value?.id === e.value) return null;
    }
    if (!value || !tr.docChanged) return value;
    const pos = tr.changes.mapPos(value.pos, -1);
    return pos === value.pos ? value : { ...value, pos };
  },
});

/** Where the block goes for `pos`: over the picture's line, or after the line. */
export function hostBlockRange(state: EditorState, pos: number): { from: number; to: number; replace: boolean } {
  const at = Math.max(0, Math.min(pos, state.doc.length));
  const line = state.doc.lineAt(at);
  if (imageAt(state, at)) return { from: line.from, to: line.to, replace: true };
  return { from: line.to, to: line.to, replace: false };
}

function decorationsFor(state: EditorState, open: Open): DecorationSet {
  const widget = new HostBlockWidget(open.id, open.height);
  const r = hostBlockRange(state, open.pos);
  if (r.replace) return Decoration.set([Decoration.replace({ widget, block: true }).range(r.from, r.to)]);
  return Decoration.set([Decoration.widget({ widget, block: true, side: 1 }).range(r.to)]);
}

// Block decorations have to come straight from the state, not a view plugin.
const decorations = EditorView.decorations.compute([field, "doc"], (state) => {
  const open = state.field(field);
  return open ? decorationsFor(state, open) : Decoration.none;
});

function end(view: EditorView, s: Session, dispatch: boolean): void {
  if (s.closed) return;
  s.closed = true;
  if (sessions.get(view) === s) sessions.delete(view);
  if (dispatch && view.state.field(field, false)?.id === s.id) view.dispatch({ effects: closeEffect.of(s.id) });
  s.container.remove();
  s.onClose?.();
}

/** Opens a host block at `pos` (see above). One at a time: an open one closes first. */
export function openHostBlock(view: EditorView, pos: number, options: HostBlockOptions = {}): HostBlock {
  const old = sessions.get(view);
  if (old) end(view, old, true);
  const id = nextId++;
  const height = options.estimatedHeight ?? 520;
  const container = document.createElement("div");
  container.className = "cm-host-block";
  const session: Session = { id, container, closed: false, onClose: options.onClose };
  sessions.set(view, session);
  view.dispatch({ effects: openEffect.of({ id, pos, height }), scrollIntoView: false });
  return {
    element: container,
    pos: () => {
      const open = view.state.field(field, false);
      return open && open.id === id ? open.pos : -1;
    },
    moveTo(next) {
      if (session.closed) return;
      view.dispatch({ effects: openEffect.of({ id, pos: next, height }), scrollIntoView: false });
    },
    isOpen: () => !session.closed,
    close: () => end(view, session, true),
  };
}

const theme = EditorView.theme({
  ".cm-host-block": { margin: "0.5rem 0 1rem", whiteSpace: "normal", cursor: "default", fontFamily: "var(--font-sans, system-ui)" },
});

// One extension, so redrawing the editor's extensions keeps an open block.
const extension: Extension = [
  field,
  decorations,
  theme,
  ViewPlugin.define((view) => ({
    destroy() {
      const s = sessions.get(view);
      if (s) end(view, s, false);
    },
  })),
];

/** Host blocks in the live view (always on: nothing shows until the host opens one). */
export function hostBlocks(): Extension {
  return extension;
}
