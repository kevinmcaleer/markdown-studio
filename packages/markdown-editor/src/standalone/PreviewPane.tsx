import { useEffect, useRef, useState, type RefObject } from "react";

// The Preview and Side by side views: the document as it'll be published,
// from the host's renderer or the built-in one. Rendering waits for a pause
// in typing, and a slow (async) render never overwrites a newer one.

export type Renderer = (markdown: string, element: HTMLElement) => string | void | Promise<string | void>;

export function PreviewPane({
  markdown,
  render,
  afterRender,
  className,
  shown,
  paneRef,
  version,
}: {
  markdown: string;
  render: Renderer;
  afterRender?: (element: HTMLElement) => void;
  className: string;
  /** Rendering is skipped while the pane is hidden. */
  shown: boolean;
  paneRef: RefObject<HTMLDivElement | null>;
  /** Bumped by refreshPreview() to render again. */
  version: number;
}) {
  const content = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const latest = useRef(0);

  useEffect(() => {
    if (!shown) return;
    const ticket = ++latest.current;
    const timer = window.setTimeout(async () => {
      const el = content.current;
      if (!el) return;
      try {
        const html = await render(markdown, el);
        if (ticket !== latest.current) return;
        if (typeof html === "string") el.innerHTML = html;
        setError("");
        afterRender?.(el);
      } catch (err) {
        if (ticket === latest.current) setError(err instanceof Error ? err.message : String(err));
      }
    }, 150);
    return () => window.clearTimeout(timer);
  }, [markdown, render, afterRender, shown, version]);

  return (
    <div className="mde-preview" ref={paneRef} aria-label="Preview" role="region" tabIndex={-1}>
      {error && <p className="error mde-preview-error">Couldn't render the preview: {error}</p>}
      <div className={className} ref={content} />
    </div>
  );
}

/**
 * Keeps two scrolling elements at the same place, proportionally, like
 * EasyMDE's side-by-side. Each side ignores the scroll it caused on the other.
 */
export function syncScroll(a: HTMLElement, b: HTMLElement): () => void {
  let leader: HTMLElement | null = null;
  let release = 0;
  const follow = (from: HTMLElement, to: HTMLElement) => () => {
    if (leader && leader !== from) return;
    leader = from;
    window.clearTimeout(release);
    release = window.setTimeout(() => (leader = null), 80);
    const range = from.scrollHeight - from.clientHeight;
    const ratio = range > 0 ? from.scrollTop / range : 0;
    to.scrollTop = ratio * (to.scrollHeight - to.clientHeight);
  };
  const onA = follow(a, b);
  const onB = follow(b, a);
  a.addEventListener("scroll", onA, { passive: true });
  b.addEventListener("scroll", onB, { passive: true });
  return () => {
    a.removeEventListener("scroll", onA);
    b.removeEventListener("scroll", onB);
    window.clearTimeout(release);
  };
}
