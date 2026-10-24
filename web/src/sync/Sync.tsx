import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import type { FileMeta, FileRole } from "../notes/filesApi";
import { cloud, describe, PROVIDER_NAMES, sync, type Choice, type CloudStatus, type SyncLink } from "./api";
import { canShareFiles, prepare, saveCopy, type Format } from "./icloud";

// The note's Sync menu (Google Docs and iCloud), and the banners it raises.

const POLL_MS = 60_000;

type Notice = { ok: boolean; text: string };

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : "Couldn't reach the server.";
}

function ago(iso: string | null): string {
  if (!iso) return "never";
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

export type NoteSync = ReturnType<typeof useNoteSync>;

/** Links, cloud accounts and actions for one note. `enabled` is false for people who can't edit it. */
export function useNoteSync(fileId: number, enabled: boolean) {
  const [links, setLinks] = useState<SyncLink[]>([]);
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const load = () => sync.links(fileId).then((r) => live && setLinks(r.links), () => {});
    load();
    cloud.status().then((s) => live && setStatus(s), () => {});
    // Background syncs can find a conflict while the note is open.
    const timer = window.setInterval(load, POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [fileId, enabled]);

  const run = useCallback(async (action: () => Promise<{ links: SyncLink[] } & Record<string, unknown>>, done?: (r: any) => string | null) => {
    setBusy(true);
    try {
      const result = await action();
      setLinks(result.links);
      const text = done?.(result);
      setNotice(text ? { ok: true, text } : null);
    } catch (err) {
      setNotice({ ok: false, text: message(err) });
      sync.links(fileId).then((r) => setLinks(r.links), () => {});
    } finally {
      setBusy(false);
    }
  }, [fileId]);

  const refresh = useCallback(() => sync.links(fileId).then((r) => setLinks(r.links), () => {}), [fileId]);

  return { fileId, enabled, links, status, notice, setNotice, busy, run, refresh };
}

export function SyncMenu({ note, role, sync: state, currentText }: { note: FileMeta; role: FileRole; sync: NoteSync; currentText: () => string }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const { links, status, busy, run } = state;
  const google = links.find((l) => l.provider === "google");
  const conflict = links.some((l) => l.status === "conflict");
  const owner = role === "owner";

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

  if (!state.enabled) return null;

  async function importCopy(event: React.ChangeEvent<HTMLInputElement>) {
    const picked = event.target.files?.[0];
    event.target.value = "";
    if (!picked) return;
    const text = await picked.text();
    await run(() => sync.icloudImport(note.id, text), (r) => describe(r.outcome, "icloud"));
  }

  const here = window.location.pathname + window.location.search;
  return (
    <div className="menu sync-menu" ref={ref}>
      <button type="button" className="menu-button" aria-haspopup="menu" aria-expanded={open} aria-busy={busy} onClick={() => setOpen((o) => !o)}>
        Sync
        {conflict && <span className="sync-dot" aria-label="needs attention" />}
      </button>
      {open && (
        <div className="menu-list" role="menu" onClick={() => setOpen(false)}>
          <div className="menu-heading">Google Docs</div>
          {!status ? (
            <span className="disabled">Loading…</span>
          ) : !status.google.available ? (
            <span className="disabled small">Not set up on this server</span>
          ) : google ? (
            <>
              <a role="menuitem" href={google.remote_url} target="_blank" rel="noopener noreferrer">
                Open in Google Docs
              </a>
              <button type="button" role="menuitem" disabled={busy} onClick={() => run(() => sync.syncGoogle(note.id), (r) => describe(r.outcome, "google"))}>
                Sync now <span className="muted small">{google.last_error ? "failed" : ago(google.synced_at)}</span>
              </button>
              {owner && (
                <button type="button" role="menuitem" onClick={() => run(() => sync.unlink(note.id, "google"), () => "Stopped syncing with Google Docs. The Google Doc is still in your Drive.")}>
                  Stop syncing
                </button>
              )}
            </>
          ) : !owner ? (
            <span className="disabled small">Only the owner can link Google Docs</span>
          ) : status.google.connected ? (
            <button type="button" role="menuitem" disabled={busy} onClick={() => run(() => sync.linkGoogle(note.id), () => "Created a Google Doc from this note. Changes on either side now sync.")}>
              Create a Google Doc
            </button>
          ) : (
            <a role="menuitem" href={cloud.connectGoogleUrl(here)}>
              Connect Google…
            </a>
          )}
          <div className="menu-heading">iCloud Drive</div>
          <button type="button" role="menuitem" onClick={() => setSaving(true)}>
            Save a copy…
          </button>
          <button type="button" role="menuitem" disabled={busy} onClick={() => picker.current?.click()}>
            Update from a copy…
          </button>
        </div>
      )}
      <input ref={picker} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" hidden onChange={importCopy} />
      {saving && (
        <ICloudDialog
          note={note}
          text={currentText()}
          onClose={() => setSaving(false)}
          onSaved={(format) => {
            state.setNotice({ ok: true, text: format === "md" ? "Saved a copy. Bring it back with Sync, Update from a copy." : "Saved a copy." });
            if (format === "md") state.refresh();
          }}
        />
      )}
    </div>
  );
}

const FORMATS: { id: Format; label: string; hint: string }[] = [
  { id: "md", label: "Markdown", hint: "Edit it anywhere and merge it back here later." },
  { id: "docx", label: "Word", hint: "For Pages or Word. A one-way copy." },
  { id: "pdf", label: "PDF", hint: "For reading and printing. A one-way copy." },
];

/**
 * Picks a format, makes the file, then waits for a second click to open the
 * share sheet: Safari only opens it straight from a click, and making a Word
 * or PDF file takes a moment.
 */
function ICloudDialog({ note, text, onClose, onSaved }: { note: FileMeta; text: string; onClose: () => void; onSaved: (format: Format) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [format, setFormat] = useState<Format>("md");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  useEffect(() => {
    let live = true;
    setFile(null);
    setError("");
    prepare(note, format, text).then(
      (f) => live && setFile(f),
      () => live && setError("Couldn't make that file."),
    );
    return () => {
      live = false;
    };
  }, [note, format, text]);

  async function save() {
    if (!file) return;
    try {
      if (await saveCopy(note, file, text)) {
        onSaved(format);
        dialog.current?.close();
      }
    } catch {
      setError("Couldn't save the copy.");
    }
  }

  const share = file ? canShareFiles(file) : true;
  return (
    <dialog ref={dialog} className="share-dialog icloud-dialog" onClose={onClose} aria-labelledby="icloud-title">
      <header>
        <h2 id="icloud-title">Save a copy to iCloud Drive</h2>
        <button type="button" className="icon-button" aria-label="Close" onClick={() => dialog.current?.close()}>
          ×
        </button>
      </header>
      <fieldset className="format-choice">
        <legend className="muted small">Format</legend>
        {FORMATS.map((f) => (
          <label key={f.id}>
            <input type="radio" name="format" checked={format === f.id} onChange={() => setFormat(f.id)} />
            <span>
              {f.label} <span className="muted small">{f.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <p className="muted small">
        {share
          ? "Choose Save to Files, then iCloud Drive."
          : "This browser can't hand files to other apps, so the copy downloads instead. On a Mac, keep Downloads in iCloud Drive (System Settings, Apple Account, iCloud, Desktop & Documents) or move the file there."}
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="primary" disabled={!file} onClick={save}>
          {!file ? "Preparing…" : share ? "Save to Files…" : "Download"}
        </button>
      </div>
    </dialog>
  );
}

const CHOICES: { id: Choice; label: (name: string) => string; hint: (name: string) => string }[] = [
  { id: "mine", label: () => "Keep this note", hint: (name) => `Replace the ${name} copy with this note.` },
  { id: "theirs", label: (name) => `Keep ${name}'s`, hint: (name) => `Replace this note with the ${name} copy.` },
  { id: "both", label: () => "Keep both", hint: (name) => `Keep this note, and save the ${name} copy as a new note beside it.` },
  { id: "markers", label: () => "Fix by hand", hint: () => "Put both versions into the note, marked, so you can edit the merge." },
];

/** Conflicts and sync messages, shown under the note's toolbar. */
export function SyncBanners({ sync: state, onCopy }: { sync: NoteSync; onCopy: (file: FileMeta) => void }) {
  const { links, notice, setNotice, busy, run } = state;
  if (!state.enabled) return null;
  const conflicts = links.filter((l) => l.status === "conflict");
  const failing = links.filter((l) => l.status === "ok" && l.last_error);
  return (
    <>
      {conflicts.map((link) => {
        const name = PROVIDER_NAMES[link.provider];
        return (
          <div key={link.id} className="sync-banner sync-conflict" role="alert">
            <span>
              <strong>This note and its {name} copy changed the same lines.</strong> Nothing has been overwritten. What do you want to keep?
            </span>
            <span className="sync-actions">
              {CHOICES.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  title={c.hint(name)}
                  disabled={busy}
                  onClick={() =>
                    run(
                      () => sync.resolve(link.file_id, link.provider, c.id),
                      (r) => {
                        if (r.copy) onCopy(r.copy);
                        if (r.stale) return "Kept this note. Save to iCloud again to update the copy there.";
                        return c.id === "markers" ? "Both versions are in the note between <<<<<<< and >>>>>>> lines. Edit them and the fix syncs." : "Sorted.";
                      },
                    )
                  }
                >
                  {c.label(name)}
                </button>
              ))}
            </span>
          </div>
        );
      })}
      {failing.map((link) => (
        <div key={link.id} className="sync-banner" role="status">
          <span>
            {PROVIDER_NAMES[link.provider]}: {link.last_error}
          </span>
          {link.last_error?.includes("Reconnect") && <a href={cloud.connectGoogleUrl(window.location.pathname)}>Reconnect Google</a>}
        </div>
      ))}
      {notice && (
        <div className={`sync-banner ${notice.ok ? "" : "error-text"}`} role="status">
          <span>{notice.text}</span>
          <button type="button" className="link-button" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}
    </>
  );
}

/** The Account page's section for connecting cloud accounts. */
export function CloudAccounts() {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [notice, setNotice] = useState<Notice | null>(() => {
    const result = new URLSearchParams(window.location.search).get("google");
    if (result === "connected") return { ok: true, text: "Google account connected." };
    if (result === "cancelled") return { ok: false, text: "Google wasn't connected." };
    if (result === "failed") return { ok: false, text: "Google sign-in failed. Try again." };
    return null;
  });

  useEffect(() => {
    cloud.status().then(setStatus, () => {});
  }, []);

  if (!status?.google.available) return null;

  async function disconnect() {
    try {
      await cloud.disconnectGoogle();
      setStatus(await cloud.status());
      setNotice({ ok: true, text: "Google disconnected. Your Google Docs are still in your Drive; they just stop syncing." });
    } catch (err) {
      setNotice({ ok: false, text: message(err) });
    }
  }

  return (
    <section className="card stack">
      <h2>Google Docs</h2>
      <p className="muted">Link a note to a Google Doc and changes on either side keep the other up to date. Markdown Studio can only see the Docs it creates.</p>
      {notice && (
        <p className={notice.ok ? "success" : "error"} role="status">
          {notice.text}
        </p>
      )}
      {status.google.connected ? (
        <div className="share-row">
          <span className="share-who">Connected as {status.google.email || "your Google account"}</span>
          <button type="button" onClick={disconnect}>
            Disconnect
          </button>
        </div>
      ) : (
        <a className="button primary" href={cloud.connectGoogleUrl("/account")}>
          Connect Google
        </a>
      )}
    </section>
  );
}
