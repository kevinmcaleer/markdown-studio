import type { EditorView } from "@codemirror/view";
import { useCallback, useEffect, useRef, useState } from "react";
import { showSpoken } from "./speechEditor";
import { segmentsToRead, speechSegments, type Segment } from "./spoken";
import { canReadAloud, dictationLanguage, isShortcut, READ_SHORTCUT, readSettings, rememberReadSettings, type ReadSettings } from "./support";
import "./speech.css";

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];

/**
 * Reads the note aloud with the browser's own voices, from the cursor or just
 * the selection, a sentence at a time so the sentence being read can be
 * highlighted. Stops when the note closes.
 */
export function useReadAloud({ view, doc }: { view: () => EditorView | null; doc: () => string }) {
  const supported = canReadAloud();
  const [queue, setQueue] = useState<Segment[] | null>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [settings, setSettings] = useState<ReadSettings>(readSettings);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  // Each utterance checks it's still the current one; cancelling fires end and error events late.
  const turn = useRef(0);
  const live = useRef({ queue, settings, voices });
  live.current = { queue, settings, voices };
  const viewRef = useRef(view);
  viewRef.current = view;
  const docRef = useRef(doc);
  docRef.current = doc;

  useEffect(() => {
    if (!supported) return;
    const load = () => setVoices(speechSynthesis.getVoices());
    load();
    speechSynthesis.addEventListener("voiceschanged", load);
    return () => speechSynthesis.removeEventListener("voiceschanged", load);
  }, [supported]);

  /** Where a sentence is now; co-editors may have moved it since reading started. */
  const locate = (segment: Segment): Segment | null => {
    const v = viewRef.current();
    if (!v) return null;
    const here = v.state.sliceDoc(segment.from, segment.to);
    if (segment.to <= v.state.doc.length && speechSegments(here)[0]?.text === segment.text) return segment;
    let best: Segment | null = null;
    for (const s of speechSegments(v.state.doc.toString()))
      if (s.text === segment.text && (!best || Math.abs(s.from - segment.from) < Math.abs(best.from - segment.from))) best = s;
    return best;
  };

  const highlight = (segment: Segment | null) => {
    const v = viewRef.current();
    if (v) showSpoken(v, segment && locate(segment));
  };

  const speak = useCallback((i: number) => {
    const { queue, settings, voices } = live.current;
    const me = ++turn.current;
    speechSynthesis.cancel();
    if (!queue || i >= queue.length) {
      setPlaying(false);
      setQueue(null);
      highlight(null);
      return;
    }
    const u = new SpeechSynthesisUtterance(queue[i].text);
    const voice = voices.find((v) => v.voiceURI === settings.voice);
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    }
    u.rate = settings.rate;
    u.onend = () => {
      if (turn.current === me) speak(i + 1);
    };
    u.onerror = (e) => {
      if (turn.current !== me || e.error === "interrupted" || e.error === "canceled") return;
      setPlaying(false);
    };
    setIndex(i);
    setPlaying(true);
    highlight(queue[i]);
    speechSynthesis.speak(u);
  }, []);

  const stop = useCallback(() => {
    turn.current++;
    if (supported) speechSynthesis.cancel();
    setPlaying(false);
    setQueue(null);
    highlight(null);
  }, [supported]);

  const start = useCallback(() => {
    if (!supported) return;
    const v = viewRef.current();
    const all = speechSegments(v ? v.state.doc.toString() : docRef.current());
    const sel = v?.state.selection.main;
    const next = sel ? segmentsToRead(all, sel.from, sel.to) : all;
    // At the very end of the note, read it from the top.
    const toRead = next.length ? next : all;
    if (!toRead.length) return;
    live.current.queue = toRead;
    setQueue(toRead);
    speak(0);
  }, [supported, speak]);

  const toggle = useCallback(() => (live.current.queue ? stop() : start()), [start, stop]);

  // Pausing in the middle of a sentence is unreliable in Chrome, so pause starts the sentence again on resume.
  const pause = () => {
    turn.current++;
    speechSynthesis.cancel();
    setPlaying(false);
  };

  const change = (next: Partial<ReadSettings>) => {
    const merged = { ...settings, ...next };
    setSettings(merged);
    rememberReadSettings(merged);
    live.current.settings = merged;
    if (playing) speak(index);
  };

  useEffect(() => {
    if (!supported) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isShortcut(e, "r")) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [supported, toggle]);

  useEffect(() => stop, [stop]);

  const current = queue?.[index];
  // Some systems have hundreds of voices; offer the ones for the note's language family.
  const family = dictationLanguage().split("-")[0].toLowerCase();
  const nearby = voices.filter((v) => v.lang.toLowerCase().startsWith(family) || v.voiceURI === settings.voice);
  const offered = nearby.length ? nearby : voices;
  const bar = queue ? (
    <div className="read-aloud-bar" role="region" aria-label="Read aloud">
      <button type="button" className="icon-button" aria-label="Previous sentence" title="Previous sentence" disabled={index === 0} onClick={() => speak(index - 1)}>
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path d="M6 5h2v14H6V5Zm3.5 7L18 5v14l-8.5-7Z" />
        </svg>
      </button>
      <button type="button" className="icon-button read-aloud-play" aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause" : "Play"} onClick={() => (playing ? pause() : speak(index))}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path d={playing ? "M7 5h4v14H7V5Zm6 0h4v14h-4V5Z" : "M8 5v14l11-7L8 5Z"} />
        </svg>
      </button>
      <button type="button" className="icon-button" aria-label="Next sentence" title="Next sentence" onClick={() => speak(index + 1)}>
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path d="M16 5h2v14h-2V5Zm-1.5 7L6 19V5l8.5 7Z" />
        </svg>
      </button>
      <span className="read-aloud-text small" aria-live="off" title={current?.text}>
        {current?.text}
      </span>
      <select className="read-aloud-rate small" aria-label="Speed" value={settings.rate} onChange={(e) => change({ rate: Number(e.target.value) })}>
        {RATES.map((r) => (
          <option key={r} value={r}>
            {r}×
          </option>
        ))}
      </select>
      {offered.length > 0 && (
        <select className="read-aloud-voice small" aria-label="Voice" value={settings.voice ?? ""} onChange={(e) => change({ voice: e.target.value || null })}>
          <option value="">Default voice</option>
          {offered.map((v) => (
            <option key={v.voiceURI} value={v.voiceURI}>
              {v.name} ({v.lang})
            </option>
          ))}
        </select>
      )}
      <button type="button" className="icon-button" aria-label="Stop reading" title={`Stop reading (${READ_SHORTCUT})`} onClick={stop}>
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4 6.4 5Z" />
        </svg>
      </button>
    </div>
  ) : null;

  return { supported, reading: queue !== null, toggle, bar };
}
