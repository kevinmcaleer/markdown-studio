import { files, type FileMeta } from "../notes/filesApi";
import { sync } from "./api";

// iCloud Drive has no web API. On iPhone, iPad and Mac the share sheet has
// "Save to Files", which saves into iCloud Drive; the file picker opens it
// again. Elsewhere the copy is downloaded instead.

export type Format = "md" | "docx" | "pdf";

const TYPES: Record<Format, string> = {
  md: "text/markdown",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
};

export function copyName(noteName: string, format: Format): string {
  const stem = noteName.replace(/\.(md|markdown)$/i, "");
  return `${stem}.${format}`;
}

/** The note as a file, ready to hand over. Markdown comes from `text` so the copy is exactly what we record. */
export async function prepare(file: FileMeta, format: Format, text: string): Promise<File> {
  if (format === "md") return new File([text], copyName(file.name, format), { type: TYPES.md });
  const response = await fetch(files.exportUrl(file.id, format), { credentials: "same-origin" });
  if (!response.ok) throw new Error("Couldn't make the file.");
  return new File([await response.blob()], copyName(file.name, format), { type: TYPES[format] });
}

export function canShareFiles(file: File): boolean {
  return typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });
}

/**
 * Hand the file to the share sheet (or download it). Must run straight from a
 * click: browsers only open the share sheet in response to one.
 * Resolves false if the person cancelled.
 */
export async function handOver(file: File): Promise<boolean> {
  if (canShareFiles(file)) {
    try {
      await navigator.share({ files: [file], title: file.name });
      return true;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return false;
      throw err;
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}

/** Save the note to iCloud; a Markdown copy is remembered so it can be merged back later. */
export async function saveCopy(note: FileMeta, file: File, text: string): Promise<boolean> {
  const saved = await handOver(file);
  if (saved && file.type === TYPES.md) await sync.icloudSaved(note.id, text);
  return saved;
}
