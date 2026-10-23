import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import { Link } from "../Link";
import { files } from "../notes/filesApi";
import { navigate } from "../router";
import { ROLE_LABELS } from "../sharing/api";
import { tablesApi, type Database, type SharedDatabase } from "./api";
import { decode, readTable } from "./csv";
import { DatabaseView, type Route } from "./DatabaseView";
import { Icon, ICONS } from "./ui";
import "./tables.css";

// The Tables app. Everything under /tables belongs to it:
//   /tables                     your databases
//   /tables/:db                 a database (opens its first table)
//   /tables/:db/table/:id       a table's datasheet; also /query/:id and /form/:id

export function Tables({ path }: { path: string }) {
  const m = /^\/tables\/(\d+)(?:\/(table|query|form)\/(\d+))?/.exec(path);
  if (!m) return <DatabaseList />;
  const dbId = Number(m[1]);
  const route: Route = m[2] ? { kind: m[2] as "table" | "query" | "form", id: Number(m[3]) } : null;
  return <RoutedDatabase key={dbId} dbId={dbId} route={route} />;
}

function RoutedDatabase({ dbId, route }: { dbId: number; route: Route }) {
  const onRoute = useCallback(
    (next: Route, replace = false) => navigate(next ? `/tables/${dbId}/${next.kind}/${next.id}` : `/tables/${dbId}`, { replace }),
    [dbId],
  );
  return <DatabaseView dbId={dbId} route={route} onRoute={onRoute} />;
}

/** A database opened through a share link: moving around stays on the link's page. */
export function SharedDatabaseView({ dbId }: { dbId: number }) {
  const [route, setRoute] = useState<Route>(null);
  const onRoute = useCallback((next: Route) => setRoute(next), []);
  return <DatabaseView dbId={dbId} route={route} onRoute={onRoute} />;
}

function DatabaseList() {
  const [list, setList] = useState<{ databases: Database[]; shared: SharedDatabase[] } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const csvInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => {
    tablesApi.list().then(setList, (err) => setError(err instanceof ApiError ? err.message : "Couldn't load your databases."));
  }, []);
  useEffect(reload, [reload]);

  async function attempt(action: () => Promise<void>) {
    setError("");
    setBusy(true);
    try {
      await action();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const create = () =>
    attempt(async () => {
      const name = window.prompt("Name the new database", "My database");
      if (!name?.trim()) return;
      const { database } = await tablesApi.create(name.trim());
      navigate(`/tables/${database.id}`);
    });

  const importCsv = (file: File) =>
    attempt(async () => {
      const parsed = readTable(decode(new Uint8Array(await file.arrayBuffer())));
      if (!parsed.columns.length) throw new ApiError(422, "That file has nothing in it to import.");
      const name = file.name.replace(/\.[^.]+$/, "") || "Imported";
      const { database } = await tablesApi.create(name, null, false);
      const res = await tablesApi.importTable(database.id, name, parsed.columns.map((c) => ({ name: c })), parsed.rows);
      navigate(`/tables/${database.id}/table/${res.table_id}`);
    });

  // A .tables file (downloaded from Tables) opens as a copy of that database.
  const openFile = (file: File) =>
    attempt(async () => {
      const named = file.name.toLowerCase().endsWith(".tables") ? file : new File([file], `${file.name}.tables`);
      const { file: uploaded } = await files.upload(named, null);
      navigate(`/tables/${uploaded.id}`);
    });

  async function rename(db: Database) {
    const current = db.name.replace(/\.tables$/i, "");
    const name = window.prompt("New name", current);
    if (!name?.trim() || name.trim() === current) return;
    await attempt(async () => {
      await files.rename(db.id, `${name.trim()}.tables`);
      reload();
    });
  }

  async function remove(db: Database) {
    if (!window.confirm(`Delete “${db.name.replace(/\.tables$/i, "")}” and everything in it? This can't be undone.`)) return;
    await attempt(async () => {
      await files.remove(db.id);
      reload();
    });
  }

  return (
    <div className="page tb-home">
      <div className="tb-home-head">
        <div>
          <h1>Tables</h1>
          <p className="muted">Databases with a spreadsheet-style grid, queries and forms.</p>
        </div>
        <span className="spacer" />
        <button type="button" className="menu-button" disabled={busy} onClick={() => csvInput.current?.click()}>
          <Icon d={ICONS.upload} /> Import CSV
        </button>
        <button type="button" className="menu-button" disabled={busy} onClick={() => fileInput.current?.click()} title="Open a database downloaded from Tables">
          Open .tables file
        </button>
        <button type="button" className="primary" disabled={busy} onClick={create}>
          New database
        </button>
        <input
          ref={csvInput}
          type="file"
          accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values"
          hidden
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            if (file) importCsv(file);
            e.currentTarget.value = "";
          }}
        />
        <input
          ref={fileInput}
          type="file"
          accept=".tables,application/json"
          hidden
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            if (file) openFile(file);
            e.currentTarget.value = "";
          }}
        />
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!list ? (
        <p className="muted">Loading…</p>
      ) : list.databases.length === 0 ? (
        <div className="card tb-home-empty">
          <h2>No databases yet</h2>
          <p className="muted">Start one from scratch, or import a CSV file from a spreadsheet. Each database can hold several linked tables.</p>
          <div className="row">
            <button type="button" className="primary" onClick={create}>
              New database
            </button>
            <button type="button" className="menu-button" onClick={() => csvInput.current?.click()}>
              Import CSV
            </button>
          </div>
        </div>
      ) : (
        <ul className="tb-db-list">
          {list.databases.map((db) => (
            <li key={db.id} className="card tb-db-card">
              <Link href={`/tables/${db.id}`} className="tb-db-link">
                <Icon d={ICONS.table} size={20} />
                <span className="tb-db-name">{db.name.replace(/\.tables$/i, "")}</span>
              </Link>
              <span className="muted small">Changed {new Date(db.updated_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</span>
              <span className="tb-db-actions">
                <button type="button" className="menu-button small" onClick={() => rename(db)}>
                  Rename
                </button>
                <button type="button" className="menu-button small danger-text" onClick={() => remove(db)}>
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {list && list.shared.length > 0 && (
        <section className="tb-shared">
          <h2>Shared with me</h2>
          <ul className="tb-db-list">
            {list.shared.map((db) => (
              <li key={db.id} className="card tb-db-card">
                <Link href={`/tables/${db.id}`} className="tb-db-link">
                  <Icon d={ICONS.table} size={20} />
                  <span className="tb-db-name">{db.name.replace(/\.tables$/i, "")}</span>
                </Link>
                <span className="muted small">
                  {db.owner} · {ROLE_LABELS[db.role]}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
