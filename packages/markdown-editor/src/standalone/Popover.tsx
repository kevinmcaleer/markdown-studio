import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

// A popover under a button (or at the cursor), kept on screen. Escape or a
// click outside closes it.

export type Anchor = { left: number; top: number; bottom: number };

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
    const { width, height } = el.getBoundingClientRect();
    const margin = 8;
    let top = anchor.bottom + 6;
    if (top + height > window.innerHeight - margin) top = Math.max(margin, anchor.top - height - 6);
    el.style.left = `${Math.max(margin, Math.min(anchor.left, window.innerWidth - width - margin))}px`;
    el.style.top = `${top}px`;
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
