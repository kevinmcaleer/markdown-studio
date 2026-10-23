import { useEffect, useRef, useState } from "react";
import { files, type FileMeta } from "./filesApi";

// Download as-is, or (for Markdown notes) as a Word document or a PDF.

export function DownloadMenu({ file, markdown }: { file: FileMeta; markdown: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  if (!markdown)
    return (
      <a className="menu-button" href={files.downloadUrl(file.id)}>
        Download
      </a>
    );

  return (
    <div className="menu download-menu" ref={ref}>
      <button type="button" className="menu-button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Download
      </button>
      {open && (
        <div className="menu-list" role="menu" onClick={() => setOpen(false)}>
          <a role="menuitem" href={files.downloadUrl(file.id)}>
            Markdown <span className="muted small">.md</span>
          </a>
          <a role="menuitem" href={files.exportUrl(file.id, "docx")}>
            Word <span className="muted small">.docx</span>
          </a>
          <a role="menuitem" href={files.exportUrl(file.id, "pdf")}>
            PDF <span className="muted small">.pdf</span>
          </a>
        </div>
      )}
    </div>
  );
}
