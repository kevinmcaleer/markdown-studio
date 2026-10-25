import type { EditorState, Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type * as Y from "yjs";
import { ApiError } from "../api";
import { inDocumentOrder, place, type Resolver } from "../comments/anchor";
import { storedGuestName, when } from "../comments/CommentsPanel";
import { createYAnchor } from "../comments/yAnchor";
import { colorFor } from "../notes/live";
import { useSession } from "../session";
import { allows, type Role } from "../sharing/api";
import { suggestions as api, type Suggestion, type SuggestionBody } from "./api";
import { SuggestionsPanel, verb, type PlacedSuggestion } from "./SuggestionsPanel";
import { setDraftId, setSuggesting, setSuggestionMarks, suggestMode, type Draft, type SuggestHandlers, type SuggestionMark } from "./suggestMode";

const POLL_MS = 15_000;
// How long typing pauses before the draft is saved.
const SAVE_MS = 700;

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : "Couldn't reach the server.";
}

/** Saving one draft: its id once created, and its latest text. Saves run one at a time. */
type Saving = { id: number | null; body: SuggestionBody; timer?: number; chain: Promise<void> };

/**
 * Suggesting mode for a note: the editor extension, the Editing/Suggesting
 * switch, and the Suggestions tab of the comments panel.
 *
 * People with the comment role are always suggesting; editors choose. A
 * suggestion is applied by whoever accepts it, straight onto the shared Yjs
 * text, so it reaches co-editors like any other edit.
 */
export function useSuggestions({
  fileId,
  doc,
  role,
  text,
  resolve,
  enabled,
  onOpenPanel,
  onOpenThread,
}: {
  fileId: number;
  doc: string;
  role: Role;
  text?: Y.Text | null;
  resolve?: Resolver;
  /** Off for documents that aren't edited as text here (Decks). */
  enabled: boolean;
  /** Show the Suggestions tab, scrolled to this suggestion. */
  onOpenPanel: (id: number) => void;
  /** Show a comment thread in the Comments tab. */
  onOpenThread: (threadId: number) => void;
}) {
  const { user } = useSession();
  const canChoose = allows(role, "edit");
  const [chosen, setChosen] = useState(false);
  const suggesting = enabled && (canChoose ? chosen : role === "comment");
  const [list, setList] = useState<Suggestion[] | null>(null);
  const [canDecide, setCanDecide] = useState(false);
  const [canSuggest, setCanSuggest] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const view = useRef<EditorView | null>(null);
  const saving = useRef(new Map<number, Saving>());

  const load = useCallback(async () => {
    try {
      const data = await api.list(fileId);
      setList(data.suggestions);
      setCanDecide(data.can_decide);
      setCanSuggest(data.can_suggest);
      setError(null);
    } catch (err) {
      setError(message(err));
    }
  }, [fileId]);

  useEffect(() => {
    if (!enabled) return;
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [load, enabled]);

  const upsert = (s: Suggestion) =>
    setList((current) => {
      const all = current ?? [];
      return all.some((x) => x.id === s.id) ? all.map((x) => (x.id === s.id ? s : x)) : [...all, s];
    });
  const drop = (id: number) => setList((current) => (current ?? []).filter((x) => x.id !== id));

  const placed = useMemo<PlacedSuggestion[]>(
    () => inDocumentOrder(doc, list ?? [], resolve).map(({ thread, ...placement }) => ({ suggestion: thread, ...placement })),
    [doc, list, resolve],
  );

  // ----------------------------------------------------------- saving drafts

  const bodyOf = (draft: Draft, state: EditorState): SuggestionBody => {
    const length = Math.min(state.doc.length, text?.length ?? state.doc.length);
    const from = Math.min(draft.from, length);
    const to = Math.min(Math.max(draft.to, from), length);
    return {
      anchor_from: from,
      anchor_to: to,
      quote: state.sliceDoc(from, to),
      anchor: text ? createYAnchor(text, from, to) : null,
      replacement: draft.insert,
      author_name: user ? "" : storedGuestName(),
    };
  };

  async function save(key: number) {
    const entry = saving.current.get(key);
    if (!entry) return;
    const body = entry.body;
    try {
      if (!body.quote && !body.replacement) {
        // Typed and then rubbed out again.
        if (entry.id !== null) {
          await api.remove(entry.id);
          drop(entry.id);
          entry.id = null;
        }
        return;
      }
      if (entry.id === null) {
        const { suggestion } = await api.create(fileId, body);
        entry.id = suggestion.id;
        view.current?.dispatch({ effects: setDraftId.of({ key, id: suggestion.id }) });
        upsert(suggestion);
      } else {
        upsert((await api.update(entry.id, body)).suggestion);
      }
      setError(null);
    } catch (err) {
      setError(message(err));
    }
  }

  function queue(key: number, body: SuggestionBody, now: boolean) {
    let entry = saving.current.get(key);
    if (!entry) {
      entry = { id: null, body, chain: Promise.resolve() };
      saving.current.set(key, entry);
    }
    entry.body = body;
    window.clearTimeout(entry.timer);
    const run = () => {
      entry.chain = entry.chain.then(() => save(key));
    };
    if (now) run();
    else entry.timer = window.setTimeout(run, SAVE_MS);
  }

  // Leaving the page shouldn't lose what was just typed.
  useEffect(
    () => () => {
      for (const [key, entry] of saving.current) {
        if (entry.timer !== undefined) {
          window.clearTimeout(entry.timer);
          entry.chain = entry.chain.then(() => save(key));
        }
      }
    },
    [],
  );

  // --------------------------------------------------------------- deciding

  async function accept(s: Suggestion): Promise<boolean> {
    if (!text?.doc) return false;
    if (!place(text.toString(), s, resolve).range) {
      setError("The text this suggestion changes was deleted, so it can't be applied.");
      return false;
    }
    try {
      upsert((await api.accept(s.id)).suggestion);
    } catch (err) {
      setError(message(err));
      load();
      return false;
    }
    // Where it is now, in case someone typed while we were asking.
    const range = place(text.toString(), s, resolve).range;
    if (range) {
      text.doc.transact(() => {
        if (range.to > range.from) text.delete(range.from, range.to - range.from);
        if (s.replacement) text.insert(range.from, s.replacement);
      });
    }
    setError(null);
    return true;
  }

  async function reject(s: Suggestion) {
    try {
      upsert((await api.reject(s.id)).suggestion);
      setError(null);
    } catch (err) {
      setError(message(err));
      load();
    }
  }

  async function withdraw(s: Suggestion) {
    try {
      await api.remove(s.id);
      drop(s.id);
      setError(null);
    } catch (err) {
      setError(message(err));
    }
  }

  async function reply(s: Suggestion, body: string): Promise<boolean> {
    try {
      const result = await api.reply(s.id, body, user ? "" : storedGuestName());
      upsert(result.suggestion);
      onOpenThread(result.thread.id);
      setError(null);
      return true;
    } catch (err) {
      setError(message(err));
      return false;
    }
  }

  /** Last in the document first, so applying one doesn't move the ones before it. */
  const decidable = () =>
    placed
      .filter((p) => p.suggestion.status === "open" && p.suggestion.can_decide)
      .sort((a, b) => (b.range?.from ?? -1) - (a.range?.from ?? -1));

  async function acceptAll() {
    for (const p of decidable()) if (p.range) await accept(p.suggestion);
  }

  async function rejectAll() {
    if (!window.confirm("Reject every open suggestion?")) return;
    for (const p of decidable()) await reject(p.suggestion);
  }

  // ----------------------------------------------------------------- editor

  // Null while there's no editor on screen (Preview mode, or not loaded yet).
  const liveView = () => (view.current?.dom.isConnected ? view.current : null);

  const focus = (p: PlacedSuggestion) => {
    setActive(p.suggestion.id);
    const v = liveView();
    if (!v || !p.range) return;
    const to = Math.min(p.range.to, v.state.doc.length);
    v.dispatch({ selection: { anchor: Math.min(p.range.from, to), head: to }, scrollIntoView: true });
  };

  const marks = useMemo<SuggestionMark[]>(
    () =>
      placed.flatMap(({ suggestion: s, range }) =>
        s.status === "open" && range
          ? [{ id: s.id, from: range.from, to: range.to, insert: s.replacement, color: colorFor(s.author.name), active: s.id === active }]
          : [],
      ),
    [placed, active],
  );
  const latest = useRef({ marks, suggesting });
  latest.current = { marks, suggesting };

  useEffect(() => {
    liveView()?.dispatch({ effects: setSuggestionMarks.of(marks) });
  }, [marks]);
  useEffect(() => {
    liveView()?.dispatch({ effects: setSuggesting.of(suggesting) });
  }, [suggesting]);

  // The editor is rebuilt when switching to Preview and back; tell it again.
  const onReady = useCallback((v: EditorView) => {
    view.current = v;
    v.dispatch({ effects: [setSuggesting.of(latest.current.suggesting), setSuggestionMarks.of(latest.current.marks)] });
  }, []);

  const byId = (id: number) => list?.find((s) => s.id === id) ?? null;
  const handlers = useRef<SuggestHandlers>(null!);
  handlers.current = {
    ownColor: () => colorFor(user?.username ?? (storedGuestName() || "Guest")),
    onDraft: (draft, previous, state) => {
      if (previous) queue(previous.key, bodyOf(previous, state), true);
      if (draft) queue(draft.key, bodyOf(draft, state), false);
    },
    onMarkClick: (id) => {
      setActive(id);
      onOpenPanel(id);
    },
    card: (id) => {
      const s = byId(id);
      return s ? hoverCard(s, { accept, reject, open: () => (setActive(id), onOpenPanel(id)) }) : null;
    },
  };

  // Read once by the editor at mount, so it must not change identity.
  const extensions = useMemo<Extension[]>(() => [suggestMode(handlers)], []);

  const switcher: ReactNode = !enabled ? null : canChoose ? (
    <div className="segmented" role="group" aria-label="Editing or suggesting">
      <button type="button" aria-pressed={!chosen} title="Change the note directly" onClick={() => setChosen(false)}>
        Editing
      </button>
      <button type="button" aria-pressed={chosen} title="Propose changes for the owner to accept or reject" onClick={() => setChosen(true)}>
        Suggesting
      </button>
    </div>
  ) : role === "comment" ? (
    <span className="badge sugg-badge" title="You can suggest changes; the owner accepts or rejects them">
      Suggesting
    </span>
  ) : null;

  const openCount = placed.filter((p) => p.suggestion.status === "open").length;

  const panel = (title: ReactNode, onClose?: () => void) => (
    <SuggestionsPanel
      title={title}
      items={placed}
      canDecide={canDecide}
      canSuggest={canSuggest}
      suggesting={suggesting}
      activeId={active}
      error={error}
      loading={list === null && !error}
      onFocus={focus}
      onAccept={accept}
      onReject={reject}
      onWithdraw={withdraw}
      onReply={reply}
      onOpenThread={onOpenThread}
      onAcceptAll={acceptAll}
      onRejectAll={rejectAll}
      onClose={onClose}
    />
  );

  return { extensions, onReady, suggesting, switcher, panel, openCount, enabled };
}

/** The card shown when hovering over a suggestion in the editor. */
function hoverCard(s: Suggestion, actions: { accept: (s: Suggestion) => unknown; reject: (s: Suggestion) => unknown; open: () => void }): HTMLElement {
  const el = (tag: string, className = "", textContent = "") => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (textContent) node.textContent = textContent;
    return node;
  };
  const card = el("div", "sugg-card");
  const head = el("div", "comment-head");
  head.append(el("strong", "", s.author.name), el("time", "muted small", when(s.created_at)));
  const change = el("p", "small", `${verb(s)} `);
  if (s.quote) change.append(el("del", "", s.quote.length > 80 ? `${s.quote.slice(0, 80)}…` : s.quote));
  if (s.quote && s.replacement) change.append(" ");
  if (s.replacement) change.append(el("ins", "", s.replacement.length > 80 ? `${s.replacement.slice(0, 80)}…` : s.replacement));
  const buttons = el("div", "thread-actions");
  const button = (label: string, className: string, onClick: () => void) => {
    const b = el("button", className, label) as HTMLButtonElement;
    b.type = "button";
    // Keep the editor's selection (and so the tooltip) where it is.
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", onClick);
    buttons.append(b);
  };
  if (s.can_decide) {
    button("Accept", "primary small", () => actions.accept(s));
    button("Reject", "link-button", () => actions.reject(s));
  }
  button("Reply", "link-button", actions.open);
  card.append(head, change, buttons);
  return card;
}
