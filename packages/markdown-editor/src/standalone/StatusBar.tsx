import type { ReactNode } from "react";
import type { DraftState } from "../draft";
import { LanguageChip } from "../proofing/LanguageChip";
import type { Proofing } from "../proofing/useProofing";
import type { SelectionStats } from "../writingMode";
import { when } from "./DraftBar";
import type { Stats, StatusItem } from "./options";
import "../writing.css";

// The mounted editor's status bar: the items the host asked for, in its order.

const n = (v: number) => v.toLocaleString();
const plural = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;

export function StatusBar({
  items,
  stats,
  selection,
  cursor,
  draft,
  proofing,
  lint,
  readAloud,
}: {
  items: StatusItem[];
  stats: Stats;
  selection: SelectionStats;
  cursor: { line: number; col: number };
  draft: DraftState | null;
  proofing?: Proofing;
  lint?: ReactNode;
  readAloud?: { reading: boolean; toggle: () => void };
}) {
  const item = (name: StatusItem) => {
    switch (name) {
      case "words":
        return (
          <span key={name} className="mde-status-item" aria-live="polite">
            {selection ? `${plural(selection.words, "word")} of ${n(stats.words)}` : plural(stats.words, "word")}
          </span>
        );
      case "chars":
        return (
          <span key={name} className="mde-status-item">
            {selection ? `${plural(selection.chars, "character")} selected` : plural(stats.chars, "character")}
          </span>
        );
      case "reading":
        return stats.readingMinutes > 0 ? (
          <span key={name} className="mde-status-item muted">
            {stats.readingMinutes} min read
          </span>
        ) : null;
      case "lines":
        return (
          <span key={name} className="mde-status-item muted">
            {plural(stats.lines, "line")}
          </span>
        );
      case "cursor":
        return (
          <span key={name} className="mde-status-item muted" title="Line and column">
            Ln {n(cursor.line)}, Col {n(cursor.col)}
          </span>
        );
      case "draft":
        if (!draft || draft.status === "off" || draft.status === "clean") return null;
        return (
          <span key={name} className={`mde-status-item ${draft.status === "unavailable" ? "warn" : "muted"}`} aria-live="polite">
            {draft.status === "pending"
              ? "Saving draft…"
              : draft.status === "saved"
                ? `Draft saved ${when(draft.savedAt!)}`
                : "This browser can't keep a draft"}
          </span>
        );
      case "language":
        return proofing ? <LanguageChip key={name} proofing={proofing} /> : null;
      case "lint":
        return lint ? <span key={name}>{lint}</span> : null;
      case "read-aloud":
        return readAloud ? (
          <button key={name} type="button" className="writing-toggle" aria-pressed={readAloud.reading} onClick={readAloud.toggle}>
            Read aloud
          </button>
        ) : null;
      default:
        return null;
    }
  };
  return (
    <footer className="writing-bar small mde-status" aria-label="Status">
      {items.map(item)}
    </footer>
  );
}
