import { useEffect, useRef, useState } from "react";
import { auth, powertools, type PowerToolApp } from "./api";
import { InstallButton } from "./InstallButton";
import { Link } from "./Link";
import { navigate } from "./router";
import { useSession } from "./session";
import { SUITE_APPS, type SuiteApp } from "./suite";

export function TopBar({ current }: { current?: SuiteApp["id"] }) {
  const { user, setUser } = useSession();
  const currentApp = SUITE_APPS.find((a) => a.id === current);

  async function signOut() {
    await auth.logout();
    setUser(null);
    navigate("/login");
  }

  return (
    <header className="topbar">
      <AppSwitcher current={current} />
      <Link href="/" className="brand">
        <img src="/favicon.svg" alt="" width={22} height={22} />
        <span>Markdown Studio</span>
      </Link>
      {currentApp && (
        <>
          <span className="crumb-sep" aria-hidden="true">
            /
          </span>
          <Link href={currentApp.path} className="crumb">
            {currentApp.name}
          </Link>
        </>
      )}
      <div className="spacer" />
      <InstallButton app={currentApp} />
      <Menu label={user?.username ?? ""} className="user-menu">
        <Link href="/account">Account</Link>
        <button type="button" onClick={signOut}>
          Sign out
        </button>
      </Menu>
    </header>
  );
}

function AppSwitcher({ current }: { current?: SuiteApp["id"] }) {
  const [others, setOthers] = useState<PowerToolApp[]>([]);

  useEffect(() => {
    powertools()
      .then((data) => setOthers(data.apps.filter((a) => a.id !== data.current)))
      .catch(() => setOthers([]));
  }, []);

  return (
    <Menu label="Apps" icon className="switcher">
      <div className="menu-heading">Markdown Studio</div>
      {SUITE_APPS.map((app) => (
        <Link key={app.id} href={app.path} aria-current={app.id === current ? "page" : undefined}>
          {app.name}
          {!app.ready && <span className="badge">soon</span>}
        </Link>
      ))}
      {others.length > 0 && <div className="menu-heading">Power Tools</div>}
      {others.map((app) =>
        app.status === "live" ? (
          <a key={app.id} href={app.url}>
            {app.name}
          </a>
        ) : (
          <span key={app.id} className="disabled">
            {app.name}
            <span className="badge">soon</span>
          </span>
        ),
      )}
    </Menu>
  );
}

function Menu({
  label,
  icon = false,
  className,
  children,
}: {
  label: string;
  icon?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !ref.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  return (
    <div className={`menu ${className ?? ""}`} ref={ref}>
      <button
        type="button"
        className={icon ? "icon-button" : "menu-button"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={icon ? label : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        {icon ? <GridIcon /> : label}
      </button>
      {open && (
        <div className="menu-list" role="menu" onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}

function GridIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      {[2, 7.5, 13].flatMap((x) => [2, 7.5, 13].map((y) => <rect key={`${x}-${y}`} x={x} y={y} width="3" height="3" rx="1" />))}
    </svg>
  );
}
