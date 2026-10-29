import { EditorView } from "@codemirror/view";
import { useCallback, useMemo, useRef, useState } from "react";
import { insertImages } from "../smartPaste";
import { activeFormats, formatKeymap, runFormat, sameActive, type Active, type Block } from "./formatting";
import { itemTitle, TOOLBAR, type FormatItem } from "./items";
import { selectionToolbar } from "./selectionToolbar";
import "./format.css";

// The formatting toolbar above a note, and the mini-toolbar over a selection.
// The hook gives NoteView the editor extensions, the onReady hook and the bar.

const HEADINGS: { block: Block; label: string }[] = [
  { block: "paragraph", label: "Normal text" },
  { block: "h1", label: "Heading 1" },
  { block: "h2", label: "Heading 2" },
  { block: "h3", label: "Heading 3" },
  { block: "h4", label: "Heading 4" },
];

export function useFormatting({
  show,
  readOnly,
  uploadImage,
}: {
  /** Whether the bar is shown (a Markdown note, open in an editor). */
  show: boolean;
  readOnly: boolean;
  uploadImage?: (file: File) => Promise<string>;
}) {
  const view = useRef<EditorView | null>(null);
  const [active, setActive] = useState<Active | null>(null);
  const extensions = useMemo(
    () => [
      formatKeymap,
      selectionToolbar(),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged && !u.selectionSet) return;
        const next = activeFormats(u.state);
        setActive((prev) => (sameActive(prev, next) ? prev : next));
      }),
    ],
    [],
  );
  const onReady = useCallback((v: EditorView) => {
    view.current = v;
    setActive(activeFormats(v.state));
  }, []);
  const bar =
    show && active ? (
      <FormatToolbar view={() => (view.current?.dom.isConnected ? view.current : null)} active={active} disabled={readOnly} uploadImage={uploadImage} />
    ) : null;
  return { extensions, onReady, bar };
}

function FormatToolbar({
  view,
  active,
  disabled,
  uploadImage,
}: {
  view: () => EditorView | null;
  active: Active;
  disabled: boolean;
  uploadImage?: (file: File) => Promise<string>;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const run = (item: FormatItem) => {
    const v = view();
    if (!v) return;
    // With somewhere to keep it, Picture uploads one; otherwise it inserts an image link to fill in.
    if (item.id === "image" && uploadImage) picker.current?.click();
    else runFormat(v, item.action);
  };
  const heading = HEADINGS.some((h) => h.block === active.block) ? active.block : "paragraph";

  return (
    <div
      className="format-bar"
      role="toolbar"
      aria-label="Formatting"
      // Keep the editor's selection while clicking buttons.
      onMouseDown={(e) => {
        if (!(e.target instanceof HTMLSelectElement)) e.preventDefault();
      }}
    >
      <select
        className="format-heading"
        aria-label="Text style"
        title="Text style"
        value={heading}
        disabled={disabled}
        onChange={(e) => {
          const v = view();
          if (v) runFormat(v, { block: e.target.value as Block });
        }}
      >
        {HEADINGS.map((h) => (
          <option key={h.block} value={h.block}>
            {h.label}
          </option>
        ))}
      </select>
      {TOOLBAR.map((group, i) => (
        <div className="format-group" key={i}>
          {group.map((item) => (
            <button
              key={item.id}
              type="button"
              className="format-btn"
              title={itemTitle(item)}
              aria-label={item.label}
              aria-pressed={item.on ? item.on(active) : undefined}
              disabled={disabled}
              onClick={() => run(item)}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <path d={item.icon} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          ))}
        </div>
      ))}
      {uploadImage && (
        <input
          ref={picker}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            const v = view();
            const images = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (!v || !images.length) return;
            const line = v.state.doc.lineAt(v.state.selection.main.head);
            // Below the current line, like the other inserts.
            insertImages(v, images, line.text.trim() ? line.to : line.from, { uploadImage });
            v.focus();
          }}
        />
      )}
    </div>
  );
}
