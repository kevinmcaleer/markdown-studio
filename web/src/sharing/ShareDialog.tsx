import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import { copyText } from "../clipboard";
import { isLocalOnly, ROLE_LABELS, sharing, shareUrl, type ShareLink, type ShareRole, type Shares } from "./api";

const ROLES: ShareRole[] = ["view", "comment", "edit"];

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : "Couldn't reach the server.";
}

/** The owner's Share dialog: links and people, like a Google Docs share sheet. */
export function ShareDialog({ fileId, fileName, onClose }: { fileId: number; fileName: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [shares, setShares] = useState<Shares | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [memberRole, setMemberRole] = useState<ShareRole>("edit");
  const [copied, setCopied] = useState<number | null>(null);

  useEffect(() => {
    dialog.current?.showModal();
    sharing.list(fileId).then(setShares, (err) => setError(message(err)));
  }, [fileId]);

  async function run(action: () => Promise<Shares | void>) {
    setError(null);
    try {
      const next = await action();
      setShares(next ?? (await sharing.list(fileId)));
    } catch (err) {
      setError(message(err));
    }
  }

  async function copy(link: ShareLink) {
    try {
      await copyText(shareUrl(link), dialog.current);
      setCopied(link.id);
      setTimeout(() => setCopied((c) => (c === link.id ? null : c)), 2000);
    } catch {
      setError("Couldn't copy. Select the link and copy it by hand.");
    }
  }

  async function addMember(event: React.FormEvent) {
    event.preventDefault();
    if (!username.trim()) return;
    await run(async () => {
      const next = await sharing.addMember(fileId, username.trim(), memberRole);
      setUsername("");
      return next;
    });
  }

  return (
    <dialog ref={dialog} className="share-dialog" onClose={onClose} aria-labelledby="share-title">
      <header>
        <h2 id="share-title">Share “{fileName}”</h2>
        <button type="button" className="icon-button" aria-label="Close" onClick={() => dialog.current?.close()}>
          ×
        </button>
      </header>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <section>
        <h3>People</h3>
        <form className="share-row" onSubmit={addMember}>
          <input
            aria-label="Username"
            placeholder="Add someone by username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="off"
          />
          <RoleSelect value={memberRole} onChange={setMemberRole} />
          <button type="submit" className="primary" disabled={!username.trim()}>
            Share
          </button>
        </form>
        <ul className="share-list">
          {shares?.members.map((m) => (
            <li key={m.user_id} className="share-row">
              <span className="share-who">{m.username}</span>
              <RoleSelect
                value={m.role}
                onChange={(role) => run(() => sharing.addMember(fileId, m.username, role))}
              />
              <button
                type="button"
                className="link-button"
                onClick={() => run(() => sharing.removeMember(fileId, m.user_id))}
              >
                Remove
              </button>
            </li>
          ))}
          {shares && shares.members.length === 0 && <li className="muted small">Only you have access.</li>}
        </ul>
      </section>

      <section>
        <h3>Links</h3>
        {shares?.links.some((link) => isLocalOnly(link)) && (
          <p className="muted small">
            These links point at {window.location.hostname}, which only works on this computer. Open Markdown
            Studio by its network address, or set PUBLIC_URL on the server, so others can use them.
          </p>
        )}
        <ul className="share-list">
          {shares?.links.map((link) => (
            <li key={link.id} className="share-link">
              <div className="share-row">
                <input readOnly value={shareUrl(link)} aria-label="Share link" onFocus={(e) => e.target.select()} />
                <button type="button" onClick={() => copy(link)} disabled={!link.active}>
                  {copied === link.id ? "Copied" : "Copy"}
                </button>
              </div>
              <div className="share-row">
                <select
                  aria-label="Who can open it"
                  value={link.anonymous ? "anyone" : "signed-in"}
                  onChange={(e) =>
                    run(async () => {
                      await sharing.updateLink(fileId, link.id, { anonymous: e.target.value === "anyone" });
                    })
                  }
                >
                  <option value="anyone">Anyone with the link</option>
                  <option value="signed-in">Signed-in users with the link</option>
                </select>
                <RoleSelect
                  value={link.role}
                  onChange={(role) =>
                    run(async () => {
                      await sharing.updateLink(fileId, link.id, { role });
                    })
                  }
                />
                <button
                  type="button"
                  className="link-button danger-text"
                  onClick={() =>
                    run(async () => {
                      await sharing.revokeLink(fileId, link.id);
                    })
                  }
                >
                  Turn off
                </button>
              </div>
              <p className="muted small">
                {!link.active
                  ? "Expired."
                  : link.expires_at
                    ? `Expires ${new Date(link.expires_at).toLocaleDateString()}.`
                    : "Never expires."}
              </p>
            </li>
          ))}
        </ul>
        <NewLink
          onCreate={(role, anonymous, days) =>
            run(async () => {
              await sharing.createLink(fileId, role, anonymous, days);
            })
          }
        />
      </section>
    </dialog>
  );
}

function NewLink({ onCreate }: { onCreate: (role: ShareRole, anonymous: boolean, days: number | null) => void }) {
  const [role, setRole] = useState<ShareRole>("view");
  const [anonymous, setAnonymous] = useState(true);
  const [days, setDays] = useState("");
  return (
    <form
      className="share-row new-link"
      onSubmit={(e) => {
        e.preventDefault();
        onCreate(role, anonymous, days ? Number(days) : null);
      }}
    >
      <select aria-label="Who can open it" value={anonymous ? "anyone" : "signed-in"} onChange={(e) => setAnonymous(e.target.value === "anyone")}>
        <option value="anyone">Anyone with the link</option>
        <option value="signed-in">Signed-in users only</option>
      </select>
      <RoleSelect value={role} onChange={setRole} />
      <select aria-label="Expires" value={days} onChange={(e) => setDays(e.target.value)}>
        <option value="">Never expires</option>
        <option value="1">1 day</option>
        <option value="7">7 days</option>
        <option value="30">30 days</option>
      </select>
      <button type="submit" className="primary">
        Create link
      </button>
    </form>
  );
}

function RoleSelect({ value, onChange }: { value: ShareRole; onChange: (role: ShareRole) => void }) {
  return (
    <select aria-label="Permission" value={value} onChange={(e) => onChange(e.target.value as ShareRole)}>
      {ROLES.map((r) => (
        <option key={r} value={r}>
          {ROLE_LABELS[r]}
        </option>
      ))}
    </select>
  );
}
