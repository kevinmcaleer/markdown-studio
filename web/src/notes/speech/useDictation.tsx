import type { EditorView } from "@codemirror/view";
import { useCallback, useEffect, useRef, useState } from "react";
import { insertDictation, setInterim } from "./speechEditor";
import {
  DICTATE_SHORTCUT,
  DICTATION_LANGUAGES,
  dictationBlocked,
  dictationLanguage,
  isShortcut,
  osDictationHint,
  recognizerClass,
  rememberDictationLanguage,
  type Recognizer,
} from "./support";
import "./speech.css";

const ERRORS: Record<string, string> = {
  "not-allowed": "The microphone is blocked for this site. Allow it in your browser's site settings, then try again.",
  "service-not-allowed": "Your browser won't run speech recognition here.",
  "audio-capture": "No microphone was found.",
  network: "Speech recognition needs a network connection in this browser.",
  "language-not-supported": "Your browser can't recognise that language. Pick another.",
};

/**
 * Dictation into the editor: a microphone button for the note's toolbar, and
 * Ctrl/Cmd+Shift+D. What's heard shows as a faint ghost at the cursor until
 * the browser settles on it, then goes in as an ordinary edit.
 */
export function useDictation({ view, enabled }: { view: () => EditorView | null; enabled: boolean }) {
  const blocked = dictationBlocked();
  const [listening, setListening] = useState(false);
  const [lang, setLang] = useState(dictationLanguage);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const recognizer = useRef<Recognizer | null>(null);
  // Whether we still want to listen; the browser ends a session after a pause, and we start another.
  const wanted = useRef(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  const ref = useRef<HTMLDivElement>(null);

  const clearGhost = () => {
    const v = viewRef.current();
    if (v?.dom.isConnected) v.dispatch({ effects: setInterim.of(null) });
  };

  const stop = useCallback(() => {
    wanted.current = false;
    recognizer.current?.abort();
    recognizer.current = null;
    setListening(false);
    clearGhost();
  }, []);

  const start = useCallback((code: string) => {
    const Recognizer = recognizerClass();
    if (!Recognizer || dictationBlocked()) return setOpen(true);
    const r = new Recognizer();
    r.lang = code;
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (event) => {
      const v = viewRef.current();
      if (!v?.dom.isConnected) return;
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) insertDictation(v, result[0].transcript);
        else interim += result[0].transcript;
      }
      v.dispatch({ effects: setInterim.of(interim.trim() || null) });
    };
    r.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") return;
      wanted.current = false;
      setError(ERRORS[event.error] ?? `Dictation stopped (${event.error}).`);
      setOpen(true);
    };
    r.onend = () => {
      if (wanted.current && recognizer.current === r) {
        try {
          r.start();
          return;
        } catch {
          /* fall through and stop */
        }
      }
      if (recognizer.current === r) recognizer.current = null;
      setListening(false);
      clearGhost();
    };
    wanted.current = true;
    recognizer.current = r;
    setError("");
    try {
      r.start();
      setListening(true);
      viewRef.current()?.focus();
    } catch {
      stop();
    }
  }, [stop]);

  const toggle = useCallback(() => (recognizer.current ? stop() : start(lang)), [start, stop, lang]);

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isShortcut(e, "d")) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, toggle]);

  // Stop when the editor goes (Preview, read only) or the note closes.
  useEffect(() => {
    if (!enabled) stop();
  }, [enabled, stop]);
  useEffect(() => stop, [stop]);

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !ref.current?.contains(event.target as Node)) {
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

  const pickLanguage = (code: string) => {
    setLang(code);
    rememberDictationLanguage(code);
    // Start again in the new language.
    if (recognizer.current) {
      stop();
      start(code);
    }
  };

  const languages = DICTATION_LANGUAGES.some((l) => l.code === lang) ? DICTATION_LANGUAGES : [{ code: lang, label: lang }, ...DICTATION_LANGUAGES];
  const label = blocked ? "Dictation" : listening ? `Stop dictating (${DICTATE_SHORTCUT})` : `Dictate (${DICTATE_SHORTCUT})`;

  const button = enabled ? (
    <div className={`menu dictation-menu ${listening ? "listening" : ""}`} ref={ref}>
      <button
        type="button"
        className="icon-button dictation-button"
        aria-pressed={blocked ? undefined : listening}
        aria-label={label}
        title={label}
        onClick={blocked ? () => setOpen((o) => !o) : toggle}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm-1-9a1 1 0 1 1 2 0v6a1 1 0 1 1-2 0V5Zm6 6a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z" />
        </svg>
      </button>
      {!blocked && (
        <button
          type="button"
          className="icon-button dictation-more"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label="Dictation language and commands"
          title="Dictation language and commands"
          onClick={() => setOpen((o) => !o)}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path d="M7 10h10l-5 6-5-6Z" />
          </svg>
        </button>
      )}
      {open && (
        <div className="menu-list dictation-pop" role="dialog" aria-label="Dictation">
          {blocked === "unsupported" ? (
            <p>
              This browser can't do speech recognition. {osDictationHint()}
            </p>
          ) : blocked === "insecure" ? (
            <p>
              Dictation needs the microphone, which browsers only allow on secure pages (https, or localhost). This server is on plain
              http. Put it behind https to dictate here; until then, {osDictationHint().replace(/^./, (c) => c.toLowerCase())}
            </p>
          ) : (
            <>
              {error && <p className="error-text">{error}</p>}
              <label className="field">
                <span>Language</span>
                <select value={lang} onChange={(e) => pickLanguage(e.target.value)}>
                  {languages.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </label>
              <p className="muted small">
                Say "full stop", "comma", "question mark", "new line" or "new paragraph" for punctuation; start with "heading",
                "bullet" or "numbered list" for a block; "undo that" takes back the last phrase. Commands are in English.
              </p>
              <p className="muted small">Your browser does the recognition. Chrome and Edge send the audio to their own speech service.</p>
            </>
          )}
        </div>
      )}
    </div>
  ) : null;

  return { button, listening };
}
