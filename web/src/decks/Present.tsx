import { useEffect, useMemo, useRef, useState } from "react";
import { files } from "../notes/filesApi";
import { navigate } from "../router";
import { parseDeck, type Slide } from "./deck";
import { SlideView } from "./SlideView";

// Presenting: the slides full screen in this tab, and (optionally) presenter
// view in a second window with the notes, the next slide and a timer. The two
// windows keep each other in step over a BroadcastChannel, so either can move
// through the slides. Esc or Exit in either window ends the show in both.

type Message =
  | { type: "hello" }
  | { type: "state"; index: number; text: string }
  | { type: "go"; index: number }
  // Presenter view asks the presenting window to stop.
  | { type: "exit" }
  // The presenting window has stopped.
  | { type: "end" };

const channelName = (fileId: number) => `decks-present-${fileId}`;

/** Slides that are shown when presenting: hidden ones are skipped. */
export function shownSlides(text: string): Slide[] {
  return parseDeck(text).slides.filter((s) => !s.skipped);
}

function useNavigationKeys(go: (delta: number | "first" | "last") => void, extra?: (key: string) => void) {
  const latest = useRef(go);
  latest.current = go;
  const other = useRef(extra);
  other.current = extra;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key;
      if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter", "n"].includes(key)) latest.current(1);
      else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace", "p"].includes(key)) latest.current(-1);
      else if (key === "Home") latest.current("first");
      else if (key === "End") latest.current("last");
      else {
        other.current?.(key);
        return;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/**
 * One BroadcastChannel per mounted window. It's made in an effect, not a memo,
 * so StrictMode's mount, unmount, mount doesn't leave us posting on a closed one.
 */
function useChannel(fileId: number, onMessage: (data: Message, channel: BroadcastChannel) => void, onClose?: (channel: BroadcastChannel) => void) {
  const [channel, setChannel] = useState<BroadcastChannel | null>(null);
  const handler = useRef(onMessage);
  handler.current = onMessage;
  const closing = useRef(onClose);
  closing.current = onClose;
  useEffect(() => {
    if (!("BroadcastChannel" in window)) return;
    const ch = new BroadcastChannel(channelName(fileId));
    ch.onmessage = ({ data }: MessageEvent<Message>) => handler.current(data, ch);
    setChannel(ch);
    return () => {
      closing.current?.(ch);
      ch.close();
      setChannel(null);
    };
  }, [fileId]);
  return channel;
}

function step(index: number, delta: number | "first" | "last", count: number): number {
  if (delta === "first") return 0;
  if (delta === "last") return Math.max(0, count - 1);
  return Math.min(Math.max(0, index + delta), Math.max(0, count - 1));
}

/** Full screen slides. `text` is the live deck, so edits by others show up as you present. */
export function Presentation({ fileId, text, start, onExit }: { fileId: number; text: string; start: number; onExit: () => void }) {
  const slides = useMemo(() => shownSlides(text), [text]);
  const [index, setIndex] = useState(() => Math.min(start, Math.max(0, slides.length - 1)));
  const [black, setBlack] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const state = useRef({ index, text });
  state.current = { index, text };
  const exit = useRef(onExit);
  exit.current = onExit;
  const [fullscreen, setFullscreen] = useState(false);
  // Browsers drop full screen when a popup opens, so opening presenter view
  // mustn't end the show; only leaving full screen yourself (Esc) does.
  const presenterOpened = useRef(0);
  const presenter = () => {
    presenterOpened.current = Date.now();
    openPresenterView(fileId);
  };
  const enterFullscreen = () =>
    root.current?.requestFullscreen?.().catch(() => {
      /* not allowed (iOS Safari): the page still fills the window */
    });

  useEffect(() => {
    enterFullscreen();
    const left = () => {
      setFullscreen(!!document.fullscreenElement);
      if (document.fullscreenElement) return;
      if (Date.now() - presenterOpened.current < 2000 || !document.hasFocus()) return;
      exit.current();
    };
    document.addEventListener("fullscreenchange", left);
    return () => {
      document.removeEventListener("fullscreenchange", left);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
  }, []);

  const channel = useChannel(
    fileId,
    (data, ch) => {
      if (data.type === "hello") ch.postMessage({ type: "state", ...state.current } satisfies Message);
      else if (data.type === "go") setIndex(data.index);
      else if (data.type === "exit") exit.current();
    },
    (ch) => ch.postMessage({ type: "end" } satisfies Message),
  );

  useEffect(() => {
    channel?.postMessage({ type: "state", index, text } satisfies Message);
  }, [channel, index, text]);

  useNavigationKeys(
    (delta) => {
      setBlack(false);
      setIndex((i) => step(i, delta, slides.length));
    },
    (key) => {
      if (key === "Escape") exit.current();
      else if (key === "b" || key === ".") setBlack((b) => !b);
      else if (key === "s") presenter();
      else if (key === "f") enterFullscreen();
    },
  );

  // The controls show while the mouse moves and fade after a few seconds idle,
  // so they're there when you reach for them but not in the audience's way.
  // Touch screens have no hover, so there they stay (see decks.css).
  const [controls, setControls] = useState(true);
  const idle = useRef(0);
  const wake = () => {
    setControls(true);
    window.clearTimeout(idle.current);
    idle.current = window.setTimeout(() => setControls(false), 3000);
  };
  useEffect(() => {
    wake();
    return () => window.clearTimeout(idle.current);
  }, []);

  // Swipe on touch screens; click or tap to go forward.
  const swipe = useRef<number | null>(null);
  const slide = slides[Math.min(index, slides.length - 1)];

  return (
    <div
      ref={root}
      className={controls ? "presentation controls-shown" : "presentation"}
      onPointerMove={wake}
      onPointerDown={(e) => (swipe.current = e.clientX)}
      onPointerUp={(e) => {
        if (swipe.current === null || (e.target as HTMLElement).closest("a, button")) return;
        const dx = e.clientX - swipe.current;
        swipe.current = null;
        setIndex((i) => step(i, Math.abs(dx) > 50 && dx > 0 ? -1 : 1, slides.length));
      }}
    >
      {slide && !black ? <SlideView slide={slide} className="slide-present" /> : <div className="presentation-black" />}
      <div className="presentation-controls" onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}>
        <span>
          {slides.length ? index + 1 : 0} / {slides.length}
        </span>
        {!fullscreen && document.fullscreenEnabled && (
          <button type="button" onClick={enterFullscreen}>
            Full screen
          </button>
        )}
        <button type="button" onClick={presenter}>
          Presenter view
        </button>
        <button type="button" className="presentation-exit" onClick={() => exit.current()} title="Exit (Esc)">
          Exit
        </button>
      </div>
    </div>
  );
}

export function openPresenterView(fileId: number) {
  window.open(`/decks/${fileId}/presenter`, `decks-presenter-${fileId}`, "popup,width=1100,height=720");
}

/**
 * /decks/:id/presenter: notes, the next slide and a timer. Follows the window
 * that's presenting; opened on its own, it loads the deck and runs by itself.
 */
export function PresenterView({ fileId }: { fileId: number }) {
  const [text, setText] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [linked, setLinked] = useState(false);
  const [error, setError] = useState("");
  const [started, setStarted] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const slides = useMemo(() => (text === null ? [] : shownSlides(text)), [text]);

  // Leave presenter view: close this window if we opened it as a popup,
  // otherwise go back to the deck.
  const leave = () => {
    window.close();
    window.setTimeout(() => {
      if (!window.closed) navigate(`/decks/${fileId}`);
    }, 100);
  };

  const channel = useChannel(fileId, (data) => {
    if (data.type === "state") {
      setLinked(true);
      setText(data.text);
      setIndex(data.index);
    } else if (data.type === "end" && linked) {
      // The show has ended in the presenting window, so this one goes too.
      setLinked(false);
      leave();
    }
  });

  useEffect(() => {
    channel?.postMessage({ type: "hello" } satisfies Message);
  }, [channel]);

  // Esc or Exit here ends the show in the presenting window as well.
  const end = () => {
    if (linked) channel?.postMessage({ type: "exit" } satisfies Message);
    leave();
  };

  // Nobody presenting: load the deck ourselves.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (text !== null) return;
      files.text(fileId).then(setText, () => setError("Couldn't open this deck."));
    }, 600);
    return () => window.clearTimeout(timer);
  }, [fileId, text]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useNavigationKeys(
    (delta) => {
      const next = step(index, delta, slides.length);
      setIndex(next);
      if (linked) channel?.postMessage({ type: "go", index: next } satisfies Message);
    },
    (key) => {
      if (key === "Escape") end();
    },
  );

  useEffect(() => {
    document.title = "Presenter view";
  }, []);

  if (error) return <div className="presenter error">{error}</div>;
  const current = slides[Math.min(index, slides.length - 1)];
  const next = slides[index + 1];
  const go = (delta: number) => {
    const to = step(index, delta, slides.length);
    setIndex(to);
    if (linked) channel?.postMessage({ type: "go", index: to } satisfies Message);
  };

  return (
    <div className="presenter">
      <div className="presenter-current">{current ? <SlideView slide={current} /> : <div className="slide" aria-busy="true" />}</div>
      <aside className="presenter-side">
        <div className="presenter-clock">
          <span className="presenter-elapsed" title="Time presenting">
            {elapsed(now - started)}
          </span>
          <button type="button" className="menu-button" onClick={() => setStarted(Date.now())}>
            Restart timer
          </button>
          <span className="muted small">{new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          <div className="spacer" />
          <button type="button" className="menu-button presenter-exit" onClick={end} title="Exit (Esc)">
            {linked ? "End show" : "Exit"}
          </button>
        </div>
        <div className="presenter-next">
          <span className="muted small">Next</span>
          {next ? <SlideView slide={next} /> : <p className="muted">End of the deck</p>}
        </div>
        <div className="presenter-notes" aria-label="Notes">
          {current?.notes ? current.notes : <span className="muted">No notes for this slide.</span>}
        </div>
        <div className="presenter-nav">
          <button type="button" className="menu-button" onClick={() => go(-1)} disabled={index === 0}>
            Previous
          </button>
          <span>
            {slides.length ? index + 1 : 0} / {slides.length}
          </span>
          <button type="button" className="primary" onClick={() => go(1)} disabled={index >= slides.length - 1}>
            Next
          </button>
        </div>
        <p className="muted small">{linked ? "Moving the slides in the presenting window too." : "Not linked to a presenting window. Press Present in the deck to show the slides."}</p>
      </aside>
    </div>
  );
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}
