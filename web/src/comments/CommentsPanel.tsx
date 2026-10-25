import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError } from "../api";
import { useSession } from "../session";
import { inDocumentOrder, type AnchorStatus, type Placement, type Range, type Resolver } from "./anchor";
import { comments as api, type Comment, type Thread } from "./api";
import { PIN_LABELS, type Pin } from "./pin";

const POLL_MS = 15_000;
const GUEST_NAME_KEY = "ms.guestName";

export type PlacedThread = { thread: Thread } & Placement;

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : "Couldn't reach the server.";
}

export function storedGuestName(): string {
  try {
    return localStorage.getItem(GUEST_NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

export function when(iso: string): string {
  const date = new Date(iso);
  const today = new Date().toDateString() === date.toDateString();
  return today
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], { day: "numeric", month: "short" });
}

/**
 * The comments side panel, in the style of Claude's artifact comments: put
 * the cursor on a word or line (or select some text), write a comment, and
 * reply in threads that can be resolved.
 *
 * The editor owns the text and the cursor; it says what a new comment would
 * be pinned to (``pins``, best first) and how to anchor it (``makeAnchor``)
 * and find it again (``resolve``). This panel tells it where each thread's
 * passage is now (``onThreadsChange``) so it can highlight them, and asks it
 * to jump to one (``onFocusThread``).
 */
export function CommentsPanel({
  fileId,
  doc,
  pins,
  resolve,
  makeAnchor,
  activeThreadId,
  onFocusThread,
  onThreadsChange,
  onClose,
  title = <h2>Comments</h2>,
  reloadKey = 0,
}: {
  fileId: number;
  doc: string;
  pins: Pin[];
  resolve?: Resolver;
  makeAnchor?: (from: number, to: number) => string;
  activeThreadId?: number | null;
  onFocusThread?: (thread: Thread, range: Range | null) => void;
  onThreadsChange?: (threads: PlacedThread[]) => void;
  onClose?: () => void;
  /** The panel's heading; the note page puts the Comments | Suggestions tabs here. */
  title?: ReactNode;
  /** Changing it loads the threads again (say, after a reply to a suggestion started one). */
  reloadKey?: number;
}) {
  const { user } = useSession();
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [canComment, setCanComment] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guestName, setGuestName] = useState(storedGuestName);

  const load = useCallback(async () => {
    try {
      const data = await api.list(fileId);
      setThreads(data.threads);
      setCanComment(data.can_comment);
      setError(null);
    } catch (err) {
      setError(message(err));
    }
  }, [fileId]);

  useEffect(() => {
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [load, reloadKey]);

  const placed = useMemo(() => inDocumentOrder(doc, threads ?? [], resolve), [doc, threads, resolve]);

  useEffect(() => {
    onThreadsChange?.(placed.filter((p) => !p.thread.resolved));
  }, [placed, onThreadsChange]);

  function replace(thread: Thread | null, removedId?: number) {
    setThreads((current) => {
      const list = current ?? [];
      if (thread === null) return list.filter((t) => t.id !== removedId);
      return list.some((t) => t.id === thread.id) ? list.map((t) => (t.id === thread.id ? thread : t)) : [...list, thread];
    });
  }

  async function act(action: () => Promise<{ thread: Thread | null; deleted_thread_id?: number }>) {
    try {
      const result = await action();
      replace(result.thread, result.deleted_thread_id);
      setError(null);
      return true;
    } catch (err) {
      setError(message(err));
      return false;
    }
  }

  function rememberName(name: string) {
    setGuestName(name);
    try {
      localStorage.setItem(GUEST_NAME_KEY, name);
    } catch {
      // Private mode: the name just isn't remembered.
    }
  }

  const visible = placed.filter((p) => showResolved || !p.thread.resolved);
  const resolvedCount = placed.length - placed.filter((p) => !p.thread.resolved).length;
  const authorName = user ? "" : guestName;

  return (
    <aside className="comments-panel" aria-label="Comments">
      <header>
        {title}
        {resolvedCount > 0 && (
          <label className="check small">
            <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
            Show resolved ({resolvedCount})
          </label>
        )}
        {onClose && (
          <button type="button" className="icon-button" aria-label="Close comments" onClick={onClose}>
            ×
          </button>
        )}
      </header>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {canComment && !user && (
        <label className="field guest-name">
          <span className="small muted">Your name (shown on your comments)</span>
          <input value={guestName} maxLength={40} placeholder="Guest" onChange={(e) => rememberName(e.target.value)} />
        </label>
      )}

      {canComment && (
        <Composer
          pins={pins}
          onSubmit={(body, pin) =>
            act(() =>
              api.start(fileId, {
                body,
                anchor_from: pin?.from ?? 0,
                anchor_to: pin?.to ?? 0,
                quote: pin?.text ?? "",
                anchor: pin && makeAnchor ? makeAnchor(pin.from, pin.to) : null,
                author_name: authorName,
              }),
            )
          }
        />
      )}

      {threads === null && !error && <p className="muted small">Loading comments…</p>}
      {threads !== null && visible.length === 0 && (
        <p className="muted small">
          {canComment ? "No comments yet. Put the cursor on a word or line, or select some text, to start a thread." : "No comments yet."}
        </p>
      )}

      <ol className="threads">
        {visible.map(({ thread, range, status }) => (
          <ThreadCard
            key={thread.id}
            thread={thread}
            status={status}
            active={thread.id === activeThreadId}
            onFocus={() => onFocusThread?.(thread, range)}
            onReply={(body) => act(() => api.reply(thread.id, body, authorName))}
            onResolve={() => act(() => (thread.resolved ? api.reopen(thread.id) : api.resolve(thread.id)))}
            onEdit={(c, body) => act(() => api.edit(c.id, body))}
            onDelete={(c) => act(() => api.remove(c.id))}
          />
        ))}
      </ol>
    </aside>
  );
}

function Composer({ pins, onSubmit }: { pins: Pin[]; onSubmit: (body: string, pin: Pin | null) => Promise<boolean> }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  // Which kind of pin they picked (word or line); kept as the cursor moves.
  const [kind, setKind] = useState<Pin["kind"] | null>(null);
  const pin = pins.find((p) => p.kind === kind) ?? pins[0] ?? null;
  const quote = pin?.text.trim();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    if (await onSubmit(body, pin)) setBody("");
    setBusy(false);
  }

  return (
    <form className="composer" onSubmit={submit}>
      {quote ? (
        <div className="pin">
          <div className="pin-head">
            <span className="small muted">Pinned to</span>
            {pins.length > 1 ? (
              <div className="segmented small" role="group" aria-label="Pin the comment to">
                {pins.map((p) => (
                  <button key={p.kind} type="button" aria-pressed={p === pin} onClick={() => setKind(p.kind)}>
                    {PIN_LABELS[p.kind]}
                  </button>
                ))}
              </div>
            ) : (
              <span className="small muted">{PIN_LABELS[pin!.kind].toLowerCase()}</span>
            )}
          </div>
          <blockquote className="quote">{quote}</blockquote>
        </div>
      ) : (
        <p className="muted small">Put the cursor on a word or line, or select some text, to pin your comment to it. Otherwise it's on the whole document.</p>
      )}
      <textarea
        aria-label="New comment"
        placeholder={quote ? `Comment on this ${PIN_LABELS[pin!.kind].toLowerCase()}` : "Add a comment"}
        value={body}
        rows={2}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e);
        }}
      />
      <div className="composer-actions">
        <button type="submit" className="primary" disabled={busy || !body.trim()}>
          Comment
        </button>
      </div>
    </form>
  );
}

const STATUS_NOTE: Record<AnchorStatus, string> = {
  ok: "Show in the document",
  edited: "This text has been edited since the comment",
  removed: "This text was deleted from the document",
};

function ThreadCard({
  thread,
  status,
  active,
  onFocus,
  onReply,
  onResolve,
  onEdit,
  onDelete,
}: {
  thread: Thread;
  status: AnchorStatus;
  active: boolean;
  onFocus: () => void;
  onReply: (body: string) => Promise<boolean>;
  onResolve: () => void;
  onEdit: (comment: Comment, body: string) => Promise<boolean>;
  onDelete: (comment: Comment) => void;
}) {
  const [reply, setReply] = useState("");
  const classes = ["thread", thread.resolved && "resolved", active && "active"].filter(Boolean).join(" ");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (reply.trim() && (await onReply(reply))) setReply("");
  }

  return (
    <li className={classes} data-thread-card={thread.id}>
      {thread.quote && (
        <button type="button" className={`quote ${status}`} onClick={onFocus} title={STATUS_NOTE[status]}>
          {thread.quote}
          {status !== "ok" && <span className="badge">{status}</span>}
        </button>
      )}
      {thread.comments.map((c) => (
        <CommentItem key={c.id} comment={c} onEdit={(body) => onEdit(c, body)} onDelete={() => onDelete(c)} />
      ))}
      {thread.resolved && (
        <p className="muted small">Resolved{thread.resolved_by ? ` by ${thread.resolved_by}` : ""}</p>
      )}
      <div className="thread-actions">
        {thread.can_reply && !thread.resolved && (
          <form className="reply" onSubmit={submit}>
            <input aria-label="Reply" placeholder="Reply" value={reply} onChange={(e) => setReply(e.target.value)} />
            {reply.trim() && (
              <button type="submit" className="primary">
                Reply
              </button>
            )}
          </form>
        )}
        {thread.can_resolve && (
          <button type="button" className="link-button" onClick={onResolve}>
            {thread.resolved ? "Reopen" : "Resolve"}
          </button>
        )}
      </div>
    </li>
  );
}

function CommentItem({ comment, onEdit, onDelete }: { comment: Comment; onEdit: (body: string) => Promise<boolean>; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);

  if (comment.deleted) {
    return <div className="comment deleted muted small">Comment deleted</div>;
  }

  return (
    <div className="comment">
      <div className="comment-head">
        <strong>{comment.author.name}</strong>
        {comment.author.anonymous && <span className="badge">guest</span>}
        <time className="muted small" dateTime={comment.created_at}>
          {when(comment.created_at)}
          {comment.edited_at && " (edited)"}
        </time>
      </div>
      {editing ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (await onEdit(draft)) setEditing(false);
          }}
        >
          <textarea aria-label="Edit comment" value={draft} rows={2} onChange={(e) => setDraft(e.target.value)} />
          <div className="composer-actions">
            <button type="button" className="link-button" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={!draft.trim()}>
              Save
            </button>
          </div>
        </form>
      ) : (
        <p className="comment-body">{comment.body}</p>
      )}
      {!editing && (comment.can_edit || comment.can_delete) && (
        <div className="comment-tools">
          {comment.can_edit && (
            <button
              type="button"
              className="link-button small"
              onClick={() => {
                setDraft(comment.body);
                setEditing(true);
              }}
            >
              Edit
            </button>
          )}
          {comment.can_delete && (
            <button type="button" className="link-button small" onClick={onDelete}>
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}
