/**
 * Copy text, even where navigator.clipboard is missing: it only exists in a
 * secure context, so a self-hosted install on plain http (http://pi.local:8000)
 * has none. The fallback selects a hidden textarea and runs execCommand("copy").
 *
 * Pass `within` when a modal <dialog> is open: everything outside it is inert,
 * so a textarea appended to <body> can't be selected.
 */
export async function copyText(text: string, within: HTMLElement | null = null): Promise<void> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Denied permission and the like: try the old way before giving up.
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  area.style.pointerEvents = "none";
  (within ?? document.body).appendChild(area);
  const focused = document.activeElement as HTMLElement | null;
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } finally {
    area.remove();
    focused?.focus();
  }
  if (!ok) throw new Error("copy failed");
}
