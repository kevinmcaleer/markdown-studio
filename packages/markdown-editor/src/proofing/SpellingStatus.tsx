// The status bar's proofing book, like Word's: a tick when the whole note's
// spelling is fine, a cross and how many words when it isn't. Clicking it
// starts the spelling check.

export function SpellingStatus({ count, onCheck }: { count: number | null; onCheck?: () => void }) {
  const state = count === null ? "checking" : count === 0 ? "ok" : "issues";
  const title =
    count === null
      ? "Checking spelling…"
      : count === 0
        ? "No spelling mistakes found"
        : `${count.toLocaleString()} possible spelling ${count === 1 ? "mistake" : "mistakes"}${onCheck ? ". Check spelling (F7)" : ""}`;
  return (
    <button
      type="button"
      className={`writing-toggle spelling-status ${state}`}
      title={title}
      aria-label={title}
      disabled={!onCheck}
      onClick={onCheck}
    >
      <svg width="20" height="16" viewBox="0 0 20 16" aria-hidden="true">
        {/* An open book: two pages meeting at the spine. */}
        <path
          d="M8.5 3.2C7 2.2 4.7 1.8 1.5 2v9.6c3.2-.2 5.5.2 7 1.2 1.5-1 3.8-1.4 7-1.2V2c-3.2-.2-5.5.2-7 1.2zM8.5 3.2v9.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
        {state !== "checking" && <circle className="spelling-badge" cx="15" cy="11" r="4.25" />}
        {state === "ok" && <path d="m13.1 11 1.3 1.3 2.5-2.6" fill="none" stroke="#fff" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />}
        {state === "issues" && <path d="m13.5 9.5 3 3m0-3-3 3" fill="none" stroke="#fff" strokeWidth="1.3" strokeLinecap="round" />}
      </svg>
      {state === "issues" && <span className="spelling-count">{count!.toLocaleString()}</span>}
    </button>
  );
}
