import { useEffect, useState } from "react";
import { ApiError, auth } from "../api";
import { Link } from "../Link";
import { navigate, safeNext, useLocation } from "../router";
import { useSession } from "../session";
import { AuthCard, Field } from "./AuthForm";

export function Login() {
  const { search } = useLocation();
  const { user, setUser, registrationOpen, firstUser, passwordReset } = useSession();
  const next = safeNext(search.get("next"));
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (user) navigate(next, { replace: true });
    else if (firstUser) navigate(`/register${window.location.search}`, { replace: true });
  }, [user, firstUser, next]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const { user } = await auth.login(username, password, remember);
      setUser(user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title="Sign in"
      subtitle="Notes, Tables and Decks in one place."
      error={error}
      busy={busy}
      submitLabel="Sign in"
      onSubmit={submit}
      footer={
        registrationOpen ? (
          <>
            New here? <Link href={`/register${window.location.search}`}>Create an account</Link>
          </>
        ) : undefined
      }
    >
      <Field label="Username" autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} />
      <Field label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <label className="check">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        Keep me signed in for 30 days
      </label>
      {passwordReset && (
        <p className="small forgot">
          <Link href="/forgot-password">Forgot your password?</Link>
        </p>
      )}
    </AuthCard>
  );
}
