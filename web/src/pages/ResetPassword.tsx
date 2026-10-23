import { useEffect, useState } from "react";
import { ApiError, auth } from "../api";
import { Link } from "../Link";
import { navigate } from "../router";
import { useSession } from "../session";
import { AuthCard, Field } from "./AuthForm";

/** The token arrives in the URL fragment, so it never reaches server or proxy logs. */
function readToken(): string {
  return new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";
}

export function ResetPassword() {
  const { setUser } = useSession();
  const [token] = useState(readToken);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    // Keep the token out of the address bar and history once it's been read.
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
  }, []);

  useEffect(() => {
    if (done) navigate("/", { replace: true });
  }, [done]);

  if (!token) {
    return (
      <main className="auth">
        <div className="card auth-card">
          <h1>Reset link missing</h1>
          <p className="muted">Open the link from your email again, or ask for a new one.</p>
          <Link href="/forgot-password">Send a new link</Link>
        </div>
      </main>
    );
  }

  async function submit() {
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { user } = await auth.resetPassword(token, password);
      setUser(user);
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title="Choose a new password"
      subtitle="You'll be signed out everywhere else."
      error={error}
      busy={busy}
      submitLabel="Set password and sign in"
      onSubmit={submit}
      footer={<Link href="/forgot-password">Send a new link</Link>}
    >
      <Field
        label="New password"
        type="password"
        autoComplete="new-password"
        autoFocus
        hint="At least 12 characters"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <Field label="Confirm new password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
    </AuthCard>
  );
}
