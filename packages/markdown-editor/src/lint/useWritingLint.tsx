import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyFix } from "../diagnostics";
import { RULES, type LintRule, type Readability } from "./rules";
import { setLint, writingLint, type LintReport, type LintSettings } from "./writingLint";
import "./lint.css";

// Writing hints for one note: the switch, the score in the status bar, and a
// panel of hints grouped by rule. The choices are kept on this device only.

const KEY = "notes.lint";

export function readLintSettings(): LintSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<LintSettings> | null;
    const known = new Set(RULES.map((r) => r.rule));
    return { on: raw?.on === true, off: Array.isArray(raw?.off) ? raw.off.filter((r): r is LintRule => known.has(r)) : [] };
  } catch {
    return { on: false, off: [] };
  }
}

function writeLintSettings(settings: LintSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* private mode */
  }
}

/** "Grade 8" reads better than "Grade 8.37"; very easy text is just "Easy". */
export function gradeLabel(r: Readability): string {
  const g = Math.round(r.grade);
  return g <= 5 ? "Easy to read" : g >= 13 ? `Grade ${g}: hard to read` : `Grade ${g}`;
}

export function useWritingLint() {
  const [settings, setSettings] = useState(readLintSettings);
  const [report, setReport] = useState<LintReport | null>(null);
  const view = useRef<EditorView | null>(null);
  const current = useRef(settings);
  current.current = settings;

  // Built once: the settings go in by effect, so toggling never rebuilds the editor.
  const extensions = useMemo(() => [writingLint(setReport)], []);

  const onReady = useCallback((v: EditorView) => {
    view.current = v;
    v.dispatch({ effects: setLint.of(current.current) });
  }, []);

  useEffect(() => {
    writeLintSettings(settings);
    const v = view.current;
    if (v?.dom.isConnected) v.dispatch({ effects: setLint.of(settings) });
  }, [settings]);

  const toggle = useCallback(() => setSettings((s) => ({ ...s, on: !s.on })), []);
  const toggleRule = useCallback(
    (rule: LintRule) => setSettings((s) => ({ ...s, off: s.off.includes(rule) ? s.off.filter((r) => r !== rule) : [...s.off, rule] })),
    [],
  );

  const jump = useCallback((from: number, to: number) => {
    const v = view.current;
    if (!v) return;
    const len = v.state.doc.length;
    v.dispatch({ selection: EditorSelection.range(Math.min(from, len), Math.min(to, len)), effects: EditorView.scrollIntoView(from, { y: "center" }) });
    v.focus();
  }, []);

  const fix = useCallback((f: { label: string; from: number; to: number; insert: string }) => {
    if (view.current) applyFix(view.current, f);
  }, []);

  const status = <LintStatus settings={settings} report={settings.on ? report : null} onToggle={toggle} onToggleRule={toggleRule} onJump={jump} onFix={fix} />;
  return { extensions, onReady, status };
}

function LintStatus({
  settings,
  report,
  onToggle,
  onToggleRule,
  onJump,
  onFix,
}: {
  settings: LintSettings;
  report: LintReport | null;
  onToggle: () => void;
  onToggleRule: (rule: LintRule) => void;
  onJump: (from: number, to: number) => void;
  onFix: (fix: { label: string; from: number; to: number; insert: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<LintRule | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
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

  const counts = useMemo(() => {
    const c = new Map<LintRule, number>();
    for (const h of report?.hints ?? []) c.set(h.rule, (c.get(h.rule) ?? 0) + 1);
    return c;
  }, [report]);
  const total = report?.hints.length ?? 0;
  const score = report?.selection ?? report?.doc ?? null;

  return (
    <div className="menu writing-lint" ref={ref}>
      <button
        type="button"
        className="writing-toggle"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-pressed={settings.on}
        title="Writing hints: readability, long sentences, passive voice and more. Only you see them."
        onClick={() => setOpen((o) => !o)}
      >
        {settings.on ? `${total === 0 ? "No" : total.toLocaleString()} ${total === 1 ? "hint" : "hints"}` : "Hints"}
      </button>
      {score && (
        <span className="lint-score muted" title={`Flesch-Kincaid grade ${score.grade.toFixed(1)}, ${score.sentences} sentences${report?.selection ? ", in the selection" : ""}`}>
          {gradeLabel(score)} · {Math.round(score.avgSentence)} words a sentence
          {report?.selection && " (selection)"}
        </span>
      )}
      {open && (
        <div className="menu-list lint-panel" role="dialog" aria-label="Writing hints">
          <label className="lint-switch">
            <input type="checkbox" checked={settings.on} onChange={onToggle} />
            <span>Show writing hints</span>
          </label>
          <p className="muted small">Hints only show for you, and never change the text unless you pick a fix.</p>
          <ul className="lint-rules">
            {RULES.map((r, i) => {
              const off = settings.off.includes(r.rule);
              const n = counts.get(r.rule) ?? 0;
              const hints = expanded === r.rule ? (report?.hints ?? []).filter((h) => h.rule === r.rule) : [];
              return (
                <li key={r.rule}>
                  {RULES[i - 1]?.group !== r.group && <div className="menu-heading">{r.group}</div>}
                  <div className="lint-rule">
                    <input type="checkbox" checked={!off} disabled={!settings.on} onChange={() => onToggleRule(r.rule)} aria-label={`Check for: ${r.title}`} />
                    <button
                      type="button"
                      className="lint-rule-name"
                      title={r.looksFor}
                      disabled={!settings.on || off || n === 0}
                      aria-expanded={expanded === r.rule}
                      onClick={() => setExpanded((e) => (e === r.rule ? null : r.rule))}
                    >
                      <span>{r.title}</span>
                      <span className="muted small">{r.looksFor}</span>
                    </button>
                    {settings.on && !off && <span className={`lint-count ${n ? "" : "muted"}`}>{n}</span>}
                  </div>
                  {hints.length > 0 && (
                    <ul className="lint-hints">
                      {hints.slice(0, 50).map((h) => (
                        <li key={`${h.from}-${h.to}`}>
                          <button type="button" title={h.message} onClick={() => onJump(h.from, h.to)}>
                            {h.snippet || "(empty)"}
                          </button>
                          {h.fix && (
                            <button type="button" className="lint-fix" onClick={() => onFix(h.fix!)}>
                              {h.fix.label}
                            </button>
                          )}
                        </li>
                      ))}
                      {hints.length > 50 && <li className="muted small">and {hints.length - 50} more</li>}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
