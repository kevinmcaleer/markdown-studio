import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { auth, setCsrfToken, type SessionInfo, type User } from "./api";

type SessionState = {
  loading: boolean;
  user: User | null;
  registrationOpen: boolean;
  firstUser: boolean;
  passwordReset: boolean;
  setUser: (user: User | null) => void;
  refresh: () => Promise<void>;
};

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<SessionInfo | null>(null);

  const refresh = useCallback(async () => {
    const data = await auth.session();
    setCsrfToken(data.csrf_token);
    setInfo(data);
  }, []);

  useEffect(() => {
    refresh().catch(() => setInfo({ user: null, csrf_token: "", registration_open: false, first_user: false, password_reset: false }));
  }, [refresh]);

  const setUser = useCallback((user: User | null) => {
    setInfo((prev) => (prev ? { ...prev, user, first_user: prev.first_user && !user } : prev));
  }, []);

  const value: SessionState = {
    loading: info === null,
    user: info?.user ?? null,
    registrationOpen: info?.registration_open ?? false,
    firstUser: info?.first_user ?? false,
    passwordReset: info?.password_reset ?? false,
    setUser,
    refresh,
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession outside SessionProvider");
  return value;
}
