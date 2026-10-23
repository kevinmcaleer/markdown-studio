import { useEffect, useState } from "react";
import { ApiError, auth } from "../api";
import { Link } from "../Link";
import { navigate, safeNext, useLocation } from "../router";
import { useSession } from "../session";
import { AuthCard, Field } from "./AuthForm";

export function Register() {
  const { search } = useLocation();
  const { user, setUser, registrationOpen, firstUser } = useSession();
  const next = safeNext(search.get("next"));
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (user) navigate(next, { replace: true });
  }, [user, next]);

  if (!registrationOpen) {
    return (
      <main className="auth">
        <div className="card auth-card">
          <h1>Sign-ups are closed</h1>
          <p className="muted">Ask the person who runs this server to create an account for you.</p>
          <Link href="/login">Back to sign in</Link>
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
      const { user } = await auth.register(username, email, password);
      setUser(user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title={firstUser ? "Create the owner account" : "Create an account"}
      subtitle={firstUser ? "This is a fresh install. The first account you create runs the show." : undefined}
      error={error}
      busy={busy}
      submitLabel="Create account"
      onSubmit={submit}
      footer={
        firstUser ? undefined : (
          <>
            Already have an account? <Link href={`/login${window.location.search}`}>Sign in</Link>
          </>
        )
      }
    >
      <Field
        label="Username"
        autoComplete="username"
        autoFocus
        hint="3–32 letters, numbers, '.', '_' or '-'"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
      />
      <Field label="Email (optional)" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <Field
        label="Password"
        type="password"
        autoComplete="new-password"
        hint="At least 12 characters"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <Field label="Confirm password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
    </AuthCard>
  );
}
