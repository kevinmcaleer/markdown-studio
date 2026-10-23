import { useState } from "react";
import { ApiError, auth } from "../api";
import { Link } from "../Link";
import { useSession } from "../session";
import { AuthCard, Field } from "./AuthForm";

export function ForgotPassword() {
  const { passwordReset } = useSession();
  const [login, setLogin] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!passwordReset) {
    return (
      <main className="auth">
        <div className="card auth-card">
          <h1>Forgot your password?</h1>
          <p className="muted">This server can't send email. Ask the person who runs it to reset your password.</p>
          <Link href="/login">Back to sign in</Link>
        </div>
      </main>
    );
  }

  if (sent) {
    return (
      <main className="auth">
        <div className="card auth-card">
          <h1>Check your email</h1>
          <p className="muted">
            If that account has an email address, a link to choose a new password is on its way. It works once, for the
            next hour.
          </p>
          <p className="muted small">
            No email? Check your spam folder. Accounts without an email address need the person who runs this server to
            reset them.
          </p>
          <Link href="/login">Back to sign in</Link>
        </div>
      </main>
    );
  }

  async function submit() {
    if (!login.trim()) {
      setError("Enter your username or email address.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await auth.forgotPassword(login);
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title="Forgot your password?"
      subtitle="We'll email you a link to choose a new one."
      error={error}
      busy={busy}
      submitLabel="Send reset link"
      onSubmit={submit}
      footer={
        <>
          Remembered it? <Link href="/login">Sign in</Link>
        </>
      }
    >
      <Field label="Username or email" autoComplete="username" autoFocus value={login} onChange={(e) => setLogin(e.target.value)} />
    </AuthCard>
  );
}
