import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Todo } from "../todos";

// The `#todo` list: a small "N to do" button at the top right of the text,
// kept in view under the sticky toolbar. It opens a list of the todos; the
// circle marks one done (taking it out of the text), the note jumps to it.
// With no todos left, the whole thing goes.

const OPEN_KEY = "mde.todos.open";

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

export function TodoList({
  todos,
  readOnly,
  onDone,
  onJump,
}: {
  todos: Todo[];
  readOnly: boolean;
  onDone: (todo: Todo) => void;
  onJump: (todo: Todo) => void;
}) {
  const [open, setOpen] = useState(readOpen);
  const [toolbarHeight, setToolbarHeight] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  // Sit just under the toolbar, which is sticky too (and may be drawn after this).
  const shown = todos.length > 0;
  useLayoutEffect(() => {
    const host = ref.current?.parentElement;
    if (!host) return;
    let bar: HTMLElement | null = null;
    const watch = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => measure());
    const measure = () => {
      const found = host.querySelector<HTMLElement>(":scope > .mde-toolbar");
      if (found !== bar) {
        if (bar) watch?.unobserve(bar);
        bar = found;
        if (bar) watch?.observe(bar);
      }
      setToolbarHeight(bar?.offsetHeight ?? 0);
    };
    measure();
    watch?.observe(host);
    return () => watch?.disconnect();
  }, [shown]);

  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, open ? "1" : "0");
    } catch {
      /* private mode: just this page then */
    }
  }, [open]);

  if (!todos.length) return null;
  const count = todos.length;
  return (
    <div className="mde-todos" ref={ref} style={{ ["--mde-toolbar-height" as string]: `${toolbarHeight}px` }}>
      <div className={open ? "mde-todos-box open" : "mde-todos-box"} role="region" aria-label="To do">
        <button
          type="button"
          className="mde-todos-toggle"
          aria-expanded={open}
          title={open ? "Hide the todo list" : "Show the todo list"}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOpen((o) => !o)}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM5.25 8.25l1.9 1.9 3.6-3.9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>
            {count} to do
          </span>
          <svg className="mde-todos-chevron" width="10" height="10" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {open && (
          <ul className="mde-todos-list">
            {todos.map((todo) => (
              <li key={`${todo.from}:${todo.text}`}>
                <button
                  type="button"
                  className="mde-todo-done"
                  disabled={readOnly}
                  title="Mark done (takes the #todo out of the text)"
                  aria-label={`Mark done: ${todo.text || `todo on line ${todo.line}`}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onDone(todo)}
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M3.5 8.5l3 3 6-6.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <button type="button" className="mde-todo-text" title="Go to it" onClick={() => onJump(todo)}>
                  <span className={todo.text ? "mde-todo-note" : "mde-todo-note empty"}>{todo.text || "Something to finish here"}</span>
                  <span className="mde-todo-where">{todo.section ? `${todo.section} · line ${todo.line}` : `Line ${todo.line}`}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
