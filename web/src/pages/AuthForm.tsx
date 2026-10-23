import { useId, type FormEvent, type ReactNode } from "react";

export function AuthCard({
  title,
  subtitle,
  error,
  busy,
  submitLabel,
  onSubmit,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  error: string | null;
  busy: boolean;
  submitLabel: string;
  onSubmit: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!busy) onSubmit();
  }
  return (
    <main className="auth">
      <form className="card auth-card" onSubmit={submit} noValidate>
        <img src="/favicon.svg" alt="" width={40} height={40} />
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {children}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Please wait…" : submitLabel}
        </button>
        {footer && <p className="muted small">{footer}</p>}
      </form>
    </main>
  );
}

export function Field({
  label,
  hint,
  ...input
}: { label: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} aria-describedby={hint ? `${id}-hint` : undefined} {...input} />
      {hint && (
        <small id={`${id}-hint`} className="muted">
          {hint}
        </small>
      )}
    </div>
  );
}
