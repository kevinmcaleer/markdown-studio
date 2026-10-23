import { lazy, Suspense, useEffect, type ComponentType } from "react";
import { Link } from "./Link";
import { TopBar } from "./TopBar";
import { Account } from "./pages/Account";
import { ComingSoon } from "./pages/ComingSoon";
import { ForgotPassword } from "./pages/ForgotPassword";
import { Home } from "./pages/Home";
import { Login } from "./pages/Login";
import { Register } from "./pages/Register";
import { ResetPassword } from "./pages/ResetPassword";
import { navigate, useLocation } from "./router";
import { useSession } from "./session";
import { SUITE_APPS } from "./suite";

// Each app is its own bundle, loaded the first time it's opened.
const Notes = lazy(() => import("./notes/Notes").then((m) => ({ default: m.Notes })));
const SharedLink = lazy(() => import("./sharing/SharedLink").then((m) => ({ default: m.SharedLink })));

const PUBLIC_PAGES: Record<string, ComponentType> = {
  "/login": Login,
  "/register": Register,
  "/forgot-password": ForgotPassword,
  "/reset-password": ResetPassword,
};

export function App() {
  const { path, search } = useLocation();
  const { loading, user, firstUser } = useSession();
  const PublicPage = PUBLIC_PAGES[path];
  // Share links open signed out too; the page itself asks for sign-in when the link needs it.
  const shareToken = /^\/s\/([\w-]+)$/.exec(path)?.[1];
  const isPublic = PublicPage !== undefined || shareToken !== undefined;

  useEffect(() => {
    if (loading) return;
    if (!user && !isPublic) {
      const next = path === "/" ? "" : `?next=${encodeURIComponent(path + (search.size ? `?${search}` : ""))}`;
      navigate(`${firstUser ? "/register" : "/login"}${next}`, { replace: true });
    }
  }, [loading, user, isPublic, firstUser, path, search]);

  if (loading) return <div className="splash" aria-busy="true" />;
  if (shareToken)
    return (
      <div className="shell">
        {user && <TopBar current="notes" />}
        <main className="app-page">
          <Suspense fallback={<div className="splash" aria-busy="true" />}>
            <SharedLink token={shareToken} />
          </Suspense>
        </main>
      </div>
    );
  if (PublicPage) return <PublicPage />;
  if (!user) return <div className="splash" aria-busy="true" />;

  const app = SUITE_APPS.find((a) => path === a.path || path.startsWith(`${a.path}/`));
  let page;
  if (path === "/") page = <Home />;
  else if (path === "/account") page = <Account />;
  else if (app?.id === "notes") page = <Notes path={path} />;
  else if (app) page = <ComingSoon app={app} />;
  else page = <NotFound />;

  return (
    <div className="shell">
      <TopBar current={app?.id} />
      <main className={app?.ready ? "app-page" : "page"}>
        <Suspense fallback={<div className="splash" aria-busy="true" />}>{page}</Suspense>
      </main>
    </div>
  );
}

function NotFound() {
  return (
    <section className="narrow">
      <h1>Not found</h1>
      <p className="muted">That page doesn't exist.</p>
      <Link href="/">Back to the suite</Link>
    </section>
  );
}
