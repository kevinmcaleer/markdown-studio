import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { READ_SHORTCUT } from "./speech/support";
import { countChars, countWords, readingMinutes, type SelectionStats } from "./writingMode";

// The status bar under a note: counts, the day's word goal, and the writing
// mode switches. Everything here is remembered on this device only.

const TYPEWRITER_KEY = "notes.typewriter";
const GOAL_KEY = "notes.goal";
const WRITTEN_KEY = "notes.written";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode */
  }
}

/** Today in local time, as YYYY-MM-DD. */
export function today(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

type Written = { day: string; words: number };

/** Adds to today's tally, starting again from zero on a new day. */
export function addWritten(prev: Written | null, delta: number, day: string): Written {
  return { day, words: (prev?.day === day ? prev.words : 0) + delta };
}

export function useTypewriter() {
  const [on, setOn] = useState(() => read<unknown>(TYPEWRITER_KEY, false) === true);
  useEffect(() => write(TYPEWRITER_KEY, on), [on]);
  return [on, setOn] as const;
}

/** A words-per-day goal shared by every note, and the words you've written today. */
export function useDailyGoal() {
  const [target, setTargetState] = useState<number | null>(() => {
    const t = read<number | null>(GOAL_KEY, null);
    return typeof t === "number" && t > 0 ? t : null;
  });
  const [written, setWritten] = useState(() => {
    const w = read<Written | null>(WRITTEN_KEY, null);
    return w?.day === today() ? w.words : 0;
  });

  const setTarget = useCallback((t: number | null) => {
    setTargetState(t);
    write(GOAL_KEY, t);
  }, []);

  // Read and write storage each time, so two open notes add to the same tally.
  const add = useCallback((delta: number) => {
    const next = addWritten(read<Written | null>(WRITTEN_KEY, null), delta, today());
    write(WRITTEN_KEY, next);
    setWritten(next.words);
  }, []);

  return { target, written: Math.max(0, written), setTarget, add };
}

export function WritingBar({
  text,
  selection,
  goal,
  focus,
  onFocus,
  typewriter,
  onTypewriter,
  onFind,
  reading,
  onReadAloud,
}: {
  text: string;
  selection: SelectionStats;
  goal: ReturnType<typeof useDailyGoal>;
  focus: boolean;
  onFocus: (on: boolean) => void;
  /** Left out where there's no editor (Preview). */
  typewriter?: boolean;
  onTypewriter?: (on: boolean) => void;
  onFind?: () => void;
  /** Left out where the browser can't speak. */
  reading?: boolean;
  onReadAloud?: () => void;
}) {
  const stats = useMemo(() => {
    const words = countWords(text);
    return { words, chars: countChars(text), minutes: readingMinutes(words) };
  }, [text]);
  const n = (v: number) => v.toLocaleString();
  const plural = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;

  return (
    <footer className="writing-bar small" aria-label="Writing">
      <span className="writing-stats" aria-live="polite">
        {selection ? (
          <>
            {plural(selection.words, "word")}, {plural(selection.chars, "character")} selected
            <span className="muted"> of {plural(stats.words, "word")}</span>
          </>
        ) : (
          <>
            {plural(stats.words, "word")} <span className="muted">·</span> {plural(stats.chars, "character")}{" "}
            {stats.minutes > 0 && (
              <>
                <span className="muted">·</span> {stats.minutes} min read
              </>
            )}
          </>
        )}
      </span>
      <GoalButton goal={goal} />
      <div className="spacer" />
      {onFind && (
        <button type="button" className="writing-toggle" title="Find and replace (Ctrl+F, Ctrl+H)" onClick={onFind}>
          Find
        </button>
      )}
      {onReadAloud && (
        <button
          type="button"
          className="writing-toggle"
          aria-pressed={reading}
          title={`${reading ? "Stop reading" : "Read aloud from the cursor, or the selection"} (${READ_SHORTCUT})`}
          onClick={onReadAloud}
        >
          Read aloud
        </button>
      )}
      {onTypewriter && (
        <button
          type="button"
          className="writing-toggle typewriter-toggle"
          aria-pressed={typewriter}
          title="Keep the line you're on in the middle of the screen"
          onClick={() => onTypewriter(!typewriter)}
        >
          Typewriter
        </button>
      )}
      <button
        type="button"
        className="writing-toggle"
        aria-pressed={focus}
        title={focus ? "Leave focus mode (Escape)" : "Focus mode (Ctrl+Shift+F)"}
        onClick={() => onFocus(!focus)}
      >
        {focus ? "Exit focus" : "Focus"}
      </button>
    </footer>
  );
}

function GoalButton({ goal }: { goal: ReturnType<typeof useDailyGoal> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    input.current?.select();
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !ref.current?.contains(event.target as Node)) {
        // Stop Escape from also leaving focus mode.
        if (event instanceof KeyboardEvent) event.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const { target, written } = goal;
  const done = target !== null && written >= target;
  const label = target === null ? "Set a daily goal" : `${written.toLocaleString()} / ${target.toLocaleString()} today`;

  return (
    <div className="menu writing-goal" ref={ref}>
      <button
        type="button"
        className={`writing-toggle ${done ? "goal-done" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Words you've written today, across all your notes"
        onClick={() => setOpen((o) => !o)}
      >
        {label}
        {target !== null && (
          <span className="goal-track" aria-hidden="true">
            <span className="goal-fill" style={{ width: `${Math.min(100, (written / target) * 100)}%` }} />
          </span>
        )}
      </button>
      {open && (
        <form
          className="menu-list goal-popover"
          role="dialog"
          aria-label="Daily goal"
          onSubmit={(e) => {
            e.preventDefault();
            const value = Math.round(Number(input.current?.value));
            goal.setTarget(value > 0 ? value : null);
            setOpen(false);
          }}
        >
          <label className="field">
            <span>Words a day</span>
            <input ref={input} type="number" min={1} defaultValue={target ?? 500} autoFocus />
          </label>
          <p className="muted small">Counts what you write in any note on this device, and starts again each day.</p>
          <div className="row">
            <button type="submit" className="primary">
              Save
            </button>
            {target !== null && (
              <button type="button" className="menu-button" onClick={() => (goal.setTarget(null), setOpen(false))}>
                Remove goal
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
