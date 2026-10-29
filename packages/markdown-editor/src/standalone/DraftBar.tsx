import type { StoredDraft } from "../draft";

/** "Restore draft?": offered when the browser kept text the document doesn't have. */
export function DraftBar({ draft, onRestore, onDiscard }: { draft: StoredDraft; onRestore: () => void; onDiscard: () => void }) {
  return (
    <div className="mde-draft-bar" role="alert">
      <span>
        There's an unsaved draft of this from {when(draft.savedAt)}. Restore it?
      </span>
      <button type="button" className="primary" onClick={onRestore}>
        Restore draft
      </button>
      <button type="button" className="menu-button" onClick={onDiscard}>
        Discard
      </button>
    </div>
  );
}

/** "14:02" today, otherwise "3 Nov, 14:02". */
export function when(time: number, now = new Date()): string {
  const date = new Date(time);
  const clock = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return date.toDateString() === now.toDateString() ? clock : `${date.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${clock}`;
}
