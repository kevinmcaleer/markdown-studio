import { useState } from "react";
import { ApiError, auth } from "../api";
import { navigate } from "../router";
import { useSession } from "../session";
import { Field } from "./AuthForm";

export function Account() {
  const { user, setUser, refresh, passwordReset } = useSession();
  const [email, setEmail] = useState(user?.email ?? "");
  const [emailPassword, setEmailPassword] = useState("");
  const [emailMessage, setEmailMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [passwordMessage, setPasswordMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmName, setConfirmName] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);

  if (!user) return null;

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    if (next !== confirm) {
      setPasswordMessage({ ok: false, text: "New passwords do not match." });
      return;
    }
    try {
      await auth.changePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      setPasswordMessage({ ok: true, text: "Password changed. Your other devices have been signed out." });
    } catch (err) {
      setPasswordMessage({ ok: false, text: err instanceof ApiError ? err.message : "Couldn't reach the server." });
    }
  }

  async function changeEmail(event: React.FormEvent) {
    event.preventDefault();
    try {
      const { user } = await auth.changeEmail(email, emailPassword);
      setUser(user);
      setEmailPassword("");
      setEmailMessage({ ok: true, text: user.email ? "Email address saved." : "Email address removed." });
    } catch (err) {
      setEmailMessage({ ok: false, text: err instanceof ApiError ? err.message : "Couldn't reach the server." });
    }
  }

  async function deleteAccount(event: React.FormEvent) {
    event.preventDefault();
    try {
      await auth.deleteAccount(confirmName);
      setUser(null);
      await refresh();
      navigate("/login");
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : "Couldn't reach the server.");
    }
  }

  return (
    <section className="narrow">
      <h1>Account</h1>
      <dl className="facts">
        <dt>Username</dt>
        <dd>{user.username}</dd>
        <dt>Email</dt>
        <dd>{user.email ?? <span className="muted">none</span>}</dd>
        <dt>Member since</dt>
        <dd>{new Date(user.created_at).toLocaleDateString()}</dd>
      </dl>

      <form className="card stack" onSubmit={changePassword}>
        <h2>Change password</h2>
        {passwordMessage && (
          <p className={passwordMessage.ok ? "success" : "error"} role="status">
            {passwordMessage.text}
          </p>
        )}
        <Field label="Current password" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        <Field label="New password" type="password" autoComplete="new-password" hint="At least 12 characters" value={next} onChange={(e) => setNext(e.target.value)} />
        <Field label="Confirm new password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        <button type="submit" className="primary">
          Change password
        </button>
      </form>

      <form className="card stack" onSubmit={changeEmail}>
        <h2>Email address</h2>
        <p className="muted">
          {passwordReset
            ? "If you forget your password, a reset link is sent here."
            : "This server can't send email yet, but your address is kept for when it can."}
        </p>
        {emailMessage && (
          <p className={emailMessage.ok ? "success" : "error"} role="status">
            {emailMessage.text}
          </p>
        )}
        <Field label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Field label="Current password" type="password" autoComplete="current-password" value={emailPassword} onChange={(e) => setEmailPassword(e.target.value)} />
        <button type="submit" className="primary">
          Save email
        </button>
      </form>

      <form className="card stack danger-zone" onSubmit={deleteAccount}>
        <h2>Delete account</h2>
        <p className="muted">This deletes your account and everything in it. It can't be undone.</p>
        {deleteError && (
          <p className="error" role="alert">
            {deleteError}
          </p>
        )}
        <Field label={`Type ${user.username} to confirm`} value={confirmName} onChange={(e) => setConfirmName(e.target.value)} />
        <button type="submit" className="danger">
          Delete my account
        </button>
      </form>
    </section>
  );
}
