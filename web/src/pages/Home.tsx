import { Link } from "../Link";
import { useSession } from "../session";
import { SUITE_APPS } from "../suite";

export function Home() {
  const { user } = useSession();
  return (
    <section>
      <h1>Hello, {user?.username}</h1>
      <p className="muted">Pick an app to get started.</p>
      <div className="app-grid">
        {SUITE_APPS.map((app) => (
          <Link key={app.id} href={app.path} className={`card app-card app-${app.id}`}>
            <div className="app-card-head">
              <span className="app-dot" aria-hidden="true" />
              <h2>{app.name}</h2>
              {!app.ready && <span className="badge">soon</span>}
            </div>
            <p className="muted">{app.description}</p>
          </Link>
        ))}
      </div>
    </section>
  );
}
