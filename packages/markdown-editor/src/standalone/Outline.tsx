import { useMemo } from "react";
import { parseOutline, sectionAt } from "../outline";

// The outline beside the text: the document's headings, to jump to. (Notes
// has a fuller one, with folding and moving sections, built on the same parser.)

export function Outline({ doc, cursor, onJump }: { doc: string; cursor: number; onJump: (pos: number) => void }) {
  const headings = useMemo(() => parseOutline(doc), [doc]);
  const current = sectionAt(headings, Math.min(cursor, doc.length));
  const top = Math.min(...headings.map((h) => h.level), 6);
  return (
    <nav className="mde-outline" aria-label="Outline">
      <h2>Outline</h2>
      {headings.length ? (
        <ol>
          {headings.map((h, i) => (
            <li key={`${h.from}-${i}`} style={{ paddingInlineStart: `${(h.level - top) * 0.75}rem` }}>
              <button type="button" aria-current={i === current} title={h.text} onClick={() => onJump(h.from)}>
                {h.text || "Untitled"}
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mde-empty muted">Headings show here.</p>
      )}
    </nav>
  );
}
