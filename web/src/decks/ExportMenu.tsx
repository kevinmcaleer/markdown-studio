import { useEffect, useRef, useState } from "react";
import { files, type FileMeta } from "../notes/filesApi";
import { parseDeck } from "./deck";
import { imageLoader } from "./images";

// Download the deck as Markdown, PowerPoint or Keynote. The slide files are
// made in the browser from the text on screen, so they include changes that
// haven't reached the server yet, and work offline.

type Format = "pptx" | "key";

export function ExportMenu({ file, title, text, author }: { file: FileMeta; title: string; text: () => string; author?: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Format | null>(null);
  const [error, setError] = useState("");
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

  async function run(format: Format) {
    setOpen(false);
    setBusy(format);
    setError("");
    try {
      const deck = parseDeck(text());
      const loadImage = imageLoader();
      const blob =
        format === "pptx"
          ? await (await import("./pptx")).deckToPptx(deck, { title, author, loadImage })
          : await (await import("./keynote")).deckToKeynote(deck, { loadImage });
      download(blob, `${title || "Deck"}.${format}`);
    } catch (err) {
      console.error(err);
      setError(format === "pptx" ? "Couldn't make the PowerPoint file." : "Couldn't make the Keynote file.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="menu download-menu" ref={ref}>
      <button type="button" className="menu-button" aria-haspopup="menu" aria-expanded={open} disabled={busy !== null} onClick={() => setOpen((o) => !o)}>
        {busy ? "Exporting…" : "Download"}
      </button>
      {error && (
        <span className="error-text small" role="alert">
          {" "}
          {error}
        </span>
      )}
      {open && (
        <div className="menu-list" role="menu">
          <button type="button" role="menuitem" onClick={() => run("pptx")}>
            PowerPoint <span className="muted small">.pptx</span>
          </button>
          <button type="button" role="menuitem" onClick={() => run("key")}>
            Keynote <span className="muted small">.key</span>
          </button>
          <a role="menuitem" href={files.downloadUrl(file.id)} onClick={() => setOpen(false)}>
            Markdown <span className="muted small">.md</span>
          </a>
        </div>
      )}
    </div>
  );
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
