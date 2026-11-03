import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

// A popover under a button (or at the cursor), kept on screen. Escape or a
// click outside closes it.

export type Anchor = { left: number; top: number; bottom: number };

/** Space kept between a popover and the window's edges. */
const MARGIN = 8;
/** Gap between a popover and its anchor. */
const GAP = 6;

/** Where a popover of ``width`` × ``height`` (its full, unclipped size) goes
 *  for ``anchor`` in a ``viewWidth`` × ``viewHeight`` window: below the
 *  anchor if it fits, else above it if it fits there, else on whichever side
 *  has more room with ``maxHeight`` capping it to that room, so its bottom
 *  (an image picker's URL box, say) is never cut off by the window. */
export function placePopover(
  anchor: Anchor,
  width: number,
  height: number,
  viewWidth: number,
  viewHeight: number,
): { left: number; top: number; maxHeight: number } {
  const below = viewHeight - MARGIN - (anchor.bottom + GAP);
  const above = anchor.top - GAP - MARGIN;
  const left = Math.max(MARGIN, Math.min(anchor.left, viewWidth - width - MARGIN));
  if (height <= below) return { left, top: anchor.bottom + GAP, maxHeight: below };
  if (height <= above) return { left, top: anchor.top - GAP - height, maxHeight: above };
  // Fits on neither side: take the roomier one (or the whole window when the
  // anchor sits so that both are tiny) and let the popover scroll.
  const room = Math.max(below, above);
  if (room < 280) return { left, top: MARGIN, maxHeight: viewHeight - 2 * MARGIN };
  if (below >= above) return { left, top: anchor.bottom + GAP, maxHeight: below };
  return { left, top: anchor.top - GAP - above, maxHeight: above };
}

export function anchorOf(el: Element): Anchor {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, bottom: r.bottom };
}

export function Popover({
  anchor,
  onClose,
  className,
  label,
  children,
}: {
  anchor: Anchor;
  onClose: () => void;
  className: string;
  label: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      // Measure its full size (the stylesheet's own cap aside), then cap it to
      // the room it gets.
      // Scroll positions are kept, since uncapping can reset them.
      const scrolled = [el, ...el.querySelectorAll("*")].filter((n) => n.scrollTop > 0).map((n) => [n, n.scrollTop] as const);
      el.style.setProperty("--mde-popover-room", "100vh");
      const { width, height } = el.getBoundingClientRect();
      const at = placePopover(anchor, width, height, window.innerWidth, window.innerHeight);
      el.style.setProperty("--mde-popover-room", `${at.maxHeight}px`);
      el.style.left = `${at.left}px`;
      el.style.top = `${at.top}px`;
      for (const [n, top] of scrolled) n.scrollTop = top;
    };
    place();
    // Content that arrives later (an image library loading) changes its size.
    const changes = new MutationObserver(place);
    changes.observe(el, { childList: true, subtree: true, characterData: true });
    window.addEventListener("resize", place);
    return () => {
      changes.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [anchor]);

  useEffect(() => {
    const outside = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) close.current();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Don't also leave full screen.
      e.preventDefault();
      e.stopPropagation();
      close.current();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", key, true);
    };
  }, []);

  return (
    <div ref={ref} className={`mde-popover ${className}`} role="dialog" aria-label={label} style={{ left: 0, top: 0 }}>
      {children}
    </div>
  );
}
