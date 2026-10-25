import { useState, type ReactNode } from "react";
import type { AnchorStatus, Placement } from "../comments/anchor";
import { when } from "../comments/CommentsPanel";
import type { Suggestion } from "./api";

export type PlacedSuggestion = { suggestion: Suggestion } & Placement;

/** What a suggestion does, in a few words: "Replace", "Add" or "Delete". */
export function verb(s: Pick<Suggestion, "quote" | "replacement">): "Replace" | "Add" | "Delete" {
  if (!s.quote) return "Add";
  return s.replacement ? "Replace" : "Delete";
}

const STATUS_NOTE: Record<AnchorStatus, string> = {
  ok: "Show in the document",
  edited: "This text has been edited since the suggestion",
  removed: "This text was deleted from the document",
};

/**
 * The Suggestions tab of the comments panel: each suggested edit with Accept
 * and Reject for editors, Withdraw for its author, and a reply box that starts
 * a comment thread on the same passage.
 */
export function SuggestionsPanel({
  title,
  items,
  canDecide,
  canSuggest,
  suggesting,
  activeId,
  error,
  loading,
  onFocus,
  onAccept,
  onReject,
  onWithdraw,
  onReply,
  onOpenThread,
  onAcceptAll,
  onRejectAll,
  onClose,
}: {
  title: ReactNode;
  items: PlacedSuggestion[];
  canDecide: boolean;
  canSuggest: boolean;
  suggesting: boolean;
  activeId: number | null;
  error: string | null;
  loading: boolean;
  onFocus: (item: PlacedSuggestion) => void;
  onAccept: (s: Suggestion) => void;
  onReject: (s: Suggestion) => void;
  onWithdraw: (s: Suggestion) => void;
  onReply: (s: Suggestion, body: string) => Promise<boolean>;
  onOpenThread: (threadId: number) => void;
  onAcceptAll: () => void;
  onRejectAll: () => void;
  onClose?: () => void;
}) {
  const [showResolved, setShowResolved] = useState(false);
  const open = items.filter((p) => p.suggestion.status === "open");
  const resolvedCount = items.length - open.length;
  const visible = showResolved ? items : open;
  const decidable = open.filter((p) => p.suggestion.can_decide);

  return (
    <aside className="comments-panel" aria-label="Suggestions">
      <header>
        {title}
        {onClose && (
          <button type="button" className="icon-button" aria-label="Close comments" onClick={onClose}>
            ×
          </button>
        )}
      </header>

      {(resolvedCount > 0 || (canDecide && decidable.length > 1)) && (
        <div className="sugg-tools">
          {resolvedCount > 0 && (
            <label className="check small">
              <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
              Show resolved ({resolvedCount})
            </label>
          )}
          {canDecide && decidable.length > 1 && (
            <>
              <button type="button" className="link-button small" onClick={onAcceptAll}>
                Accept all
              </button>
              <button type="button" className="link-button small" onClick={onRejectAll}>
                Reject all
              </button>
            </>
          )}
        </div>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {loading && <p className="muted small">Loading suggestions…</p>}
      {!loading && visible.length === 0 && (
        <p className="muted small">
          {!canSuggest
            ? "No suggestions yet."
            : suggesting
              ? "No suggestions yet. You're suggesting: type in the note and your changes show here for the owner to accept."
              : "No suggestions yet. Switch to Suggesting to propose changes instead of making them."}
        </p>
      )}

      <ol className="threads">
        {visible.map((item) => (
          <SuggestionCard
            key={item.suggestion.id}
            item={item}
            active={item.suggestion.id === activeId}
            onFocus={() => onFocus(item)}
            onAccept={() => onAccept(item.suggestion)}
            onReject={() => onReject(item.suggestion)}
            onWithdraw={() => onWithdraw(item.suggestion)}
            onReply={(body) => onReply(item.suggestion, body)}
            onOpenThread={onOpenThread}
          />
        ))}
      </ol>
    </aside>
  );
}

function SuggestionCard({
  item: { suggestion: s, status },
  active,
  onFocus,
  onAccept,
  onReject,
  onWithdraw,
  onReply,
  onOpenThread,
}: {
  item: PlacedSuggestion;
  active: boolean;
  onFocus: () => void;
  onAccept: () => void;
  onReject: () => void;
  onWithdraw: () => void;
  onReply: (body: string) => Promise<boolean>;
  onOpenThread: (threadId: number) => void;
}) {
  const [reply, setReply] = useState("");
  const isOpen = s.status === "open";
  const removed = status === "removed";
  const classes = ["thread", "sugg", !isOpen && "resolved", active && "active"].filter(Boolean).join(" ");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (reply.trim() && (await onReply(reply))) setReply("");
  }

  return (
    <li className={classes} data-suggestion-card={s.id}>
      <div className="comment-head">
        <strong>{s.author.name}</strong>
        {s.author.anonymous && <span className="badge">guest</span>}
        <time className="muted small" dateTime={s.created_at}>
          {when(s.created_at)}
        </time>
      </div>
      <button type="button" className="sugg-change" onClick={onFocus} title={STATUS_NOTE[status]}>
        <span className="small muted">{verb(s)}</span>{" "}
        {s.quote && <del>{s.quote}</del>}
        {s.quote && s.replacement && " "}
        {s.replacement && <ins>{s.replacement}</ins>}
        {isOpen && status !== "ok" && <span className="badge">{removed ? "passage removed" : "edited"}</span>}
      </button>
      {!isOpen && (
        <p className="muted small">
          {s.status === "accepted" ? "Accepted" : "Rejected"}
          {s.decided_by ? ` by ${s.decided_by}` : ""}
        </p>
      )}
      {s.thread_id !== null && (
        <button type="button" className="link-button small sugg-replies" onClick={() => onOpenThread(s.thread_id!)}>
          See the replies
        </button>
      )}
      <div className="thread-actions">
        {isOpen && (
          <form className="reply" onSubmit={submit}>
            <input aria-label="Reply" placeholder="Reply" value={reply} onChange={(e) => setReply(e.target.value)} />
            {reply.trim() && (
              <button type="submit" className="primary">
                Reply
              </button>
            )}
          </form>
        )}
        {s.can_decide && (
          <>
            <button type="button" className="primary small" onClick={onAccept} disabled={removed} title={removed ? STATUS_NOTE.removed : "Make this change"}>
              Accept
            </button>
            <button type="button" className="link-button" onClick={onReject}>
              Reject
            </button>
          </>
        )}
        {s.mine && isOpen && !s.can_decide && s.can_delete && (
          <button type="button" className="link-button" onClick={onWithdraw}>
            Withdraw
          </button>
        )}
      </div>
    </li>
  );
}
