import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import { ShareButton } from "../sharing/ShareButton";
import { allows, ROLE_LABELS } from "../sharing/api";
import { tablesApi, type Opened, type Schema } from "./api";
import { decode, readTable } from "./csv";
import { FormView } from "./FormView";
import { QueryDesigner } from "./QueryDesigner";
import { TableView } from "./TableView";
import { Icon, ICONS, MenuPopover } from "./ui";
import "./tables.css";

// An open database: the navigation pane (tables, queries, forms) on the left,
// as in Access, and the open object on the right. Changes other people make
// show up within a few seconds.

export type Route = { kind: "table" | "query" | "form"; id: number } | null;

const POLL_MS = 4000;

export function DatabaseView({ dbId, route, onRoute }: { dbId: number; route: Route; onRoute: (route: Route, replace?: boolean) => void }) {
  const [opened, setOpened] = useState<Opened | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [menu, setMenu] = useState<{ kind: "table" | "query" | "form"; id: number; rect: DOMRect } | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const known = useRef(0);
  const csvInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const data = await tablesApi.open(dbId);
      known.current = data.revision;
      setOpened(data);
      setError("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't open this database.");
    }
  }, [dbId]);

  useEffect(() => {
    setOpened(null);
    load();
  }, [load]);

  const applySchema = useCallback((schema: Schema) => {
    known.current = Math.max(known.current, schema.revision);
    setOpened((o) => (o ? { ...o, ...schema } : o));
  }, []);

  /** A change of ours came back with this revision. Anything in between was someone else's. */
  const onRevision = useCallback(
    (revision: number) => {
      const missed = revision > known.current + 1;
      known.current = Math.max(known.current, revision);
      if (missed) {
        load();
        setReloadKey((k) => k + 1);
      } else {
        // Row counts in the navigation pane.
        tablesApi.open(dbId).then((data) => setOpened((o) => (o ? { ...o, tables: data.tables } : o)), () => {});
      }
    },
    [dbId, load],
  );

  // Watch for other people's changes while the page is in view.
  useEffect(() => {
    const timer = setInterval(async () => {
      if (document.hidden) return;
      try {
        const { revision } = await tablesApi.revision(dbId);
        if (revision > known.current) {
          await load();
          setReloadKey((k) => k + 1);
        }
      } catch {
        /* offline for a moment: try again next time */
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [dbId, load]);

  // Open the first table when nothing (or something deleted) is open.
  useEffect(() => {
    if (!opened) return;
    const exists =
      route &&
      (route.kind === "table" ? opened.tables : route.kind === "query" ? opened.queries : opened.forms).some((o) => o.id === route.id);
    if (!exists) {
      const first = opened.tables[0];
      onRoute(first ? { kind: "table", id: first.id } : null, true);
    }
  }, [opened, route, onRoute]);

  if (error && !opened)
    return (
      <section className="narrow tb-message">
        <h1>Can't open this database</h1>
        <p className="muted">{error}</p>
      </section>
    );
  if (!opened) return <div className="splash" aria-busy="true" />;

  const canEdit = allows(opened.role, "edit");
  const isOwner = opened.role === "owner";
  const { tables } = opened;
  const currentTable = route?.kind === "table" ? tables.find((t) => t.id === route.id) : undefined;
  const query = route?.kind === "query" ? opened.queries.find((q) => q.id === route.id) : undefined;
  const form = route?.kind === "form" ? opened.forms.find((f) => f.id === route.id) : undefined;
  const title = opened.database.name.replace(/\.tables$/i, "");

  async function act(action: () => Promise<void>) {
    setError("");
    try {
      await action();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    }
  }

  const go = (kind: "table" | "query" | "form", id: number) => {
    onRoute({ kind, id });
    setNavOpen(false);
  };

  const newTable = () =>
    act(async () => {
      const name = window.prompt("Name the new table", "Table");
      if (!name?.trim()) return;
      const res = await tablesApi.addTable(dbId, name.trim());
      applySchema(res);
      go("table", res.table_id);
    });

  const defaultTable = currentTable ?? (query && tables.find((t) => t.id === query.spec.table_id)) ?? (form && tables.find((t) => t.id === form.spec.table_id)) ?? tables[0];

  const newQuery = () =>
    act(async () => {
      if (!defaultTable) return setError("Add a table first.");
      const res = await tablesApi.addObject(dbId, "query", `${defaultTable.name} query`, { table_id: defaultTable.id, fields: [] });
      applySchema(res);
      go("query", res.object_id);
    });

  const newForm = () =>
    act(async () => {
      if (!defaultTable) return setError("Add a table first.");
      const res = await tablesApi.addObject(dbId, "form", `${defaultTable.name} form`, { table_id: defaultTable.id, fields: [], columns: 1 });
      applySchema(res);
      go("form", res.object_id);
    });

  const importCsv = (file: File) =>
    act(async () => {
      const parsed = readTable(decode(new Uint8Array(await file.arrayBuffer())));
      if (!parsed.columns.length) return setError("That file has nothing in it to import.");
      const res = await tablesApi.importTable(
        dbId,
        file.name.replace(/\.[^.]+$/, "") || "Imported",
        parsed.columns.map((name) => ({ name })),
        parsed.rows,
      );
      applySchema(res);
      go("table", res.table_id);
      setNotice(`Imported ${parsed.rows.length.toLocaleString()} rows${res.skipped ? `; ${res.skipped} values didn't fit and were left empty` : ""}.`);
      setTimeout(() => setNotice(""), 5000);
    });

  function rename(kind: "table" | "query" | "form", id: number, current: string) {
    const name = window.prompt("New name", current);
    if (!name?.trim() || name.trim() === current) return;
    act(async () => applySchema(kind === "table" ? await tablesApi.changeTable(dbId, id, { name: name.trim() }) : await tablesApi.changeObject(dbId, id, { name: name.trim() })));
  }

  function remove(kind: "table" | "query" | "form", id: number, name: string) {
    const what = kind === "table" ? `the table “${name}”, all its rows, and the queries and forms on it` : `“${name}”`;
    if (!window.confirm(`Delete ${what}? This can't be undone.`)) return;
    act(async () => applySchema(kind === "table" ? await tablesApi.deleteTable(dbId, id) : await tablesApi.deleteObject(dbId, id)));
  }

  const section = (kind: "table" | "query" | "form", label: string, items: { id: number; name: string; count?: number }[], onNew: () => void, icon: string) => (
    <section className="tb-nav-section">
      <div className="tb-nav-head">
        <h3>{label}</h3>
        {canEdit && (
          <button type="button" className="icon-button" aria-label={`New ${kind}`} title={`New ${kind}`} onClick={onNew}>
            <Icon d={ICONS.plus} />
          </button>
        )}
      </div>
      <ul>
        {items.map((item) => (
          <li key={item.id} className={route?.kind === kind && route.id === item.id ? "current" : ""}>
            <button type="button" className="tb-nav-item" aria-current={route?.kind === kind && route.id === item.id ? "page" : undefined} onClick={() => go(kind, item.id)}>
              <Icon d={icon} />
              <span className="tb-nav-name">{item.name}</span>
              {item.count !== undefined && <span className="muted small">{item.count.toLocaleString()}</span>}
            </button>
            {canEdit && (
              <button type="button" className="icon-button tb-nav-more" aria-label={`${item.name} options`} onClick={(e) => setMenu({ kind, id: item.id, rect: e.currentTarget.getBoundingClientRect() })}>
                <Icon d={ICONS.more} />
              </button>
            )}
          </li>
        ))}
        {items.length === 0 && <li className="muted small tb-nav-none">None yet</li>}
      </ul>
    </section>
  );

  const menuItem = menu ? (menu.kind === "table" ? tables : menu.kind === "query" ? opened.queries : opened.forms).find((o) => o.id === menu.id) : undefined;

  return (
    <div className={`tb-app ${navOpen ? "nav-open" : ""}`}>
      <aside className="tb-navpane" aria-label="Database objects">
        <div className="tb-db-head">
          <h2 title={opened.database.name}>{title}</h2>
          {!isOwner && (
            <span className="muted small">
              {opened.database.owner} · {ROLE_LABELS[opened.role]}
            </span>
          )}
        </div>
        {section("table", "Tables", tables.map((t) => ({ id: t.id, name: t.name, count: t.row_count })), newTable, ICONS.table)}
        {section("query", "Queries", opened.queries, newQuery, ICONS.query)}
        {section("form", "Forms", opened.forms, newForm, ICONS.form)}
        <div className="tb-nav-foot">
          {canEdit && (
            <button type="button" className="menu-button small" onClick={() => csvInput.current?.click()}>
              <Icon d={ICONS.upload} /> Import CSV
            </button>
          )}
          <a className="menu-button small" href={tablesApi.exportUrl(dbId)} download>
            <Icon d={ICONS.download} /> Download database
          </a>
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
        </div>
      </aside>
      <section className="tb-main">
        <header className="tb-main-head">
          <button type="button" className="menu-button tb-nav-toggle" aria-expanded={navOpen} onClick={() => setNavOpen((o) => !o)}>
            {title}
          </button>
          <h1>{currentTable?.name ?? query?.name ?? form?.name ?? title}</h1>
          {currentTable && <span className="muted small">{currentTable.row_count.toLocaleString()} rows</span>}
          {query && <span className="badge">Query</span>}
          {form && <span className="badge">Form</span>}
          <span className="spacer" />
          {notice && (
            <span className="success-text small" role="status">
              {notice}
            </span>
          )}
          {error && (
            <span className="error-text small" role="alert">
              {error}
            </span>
          )}
          {isOwner && <ShareButton fileId={dbId} fileName={opened.database.name} />}
        </header>
        <div className="tb-main-body">
          {currentTable && (
            <TableView
              key={`t${currentTable.id}`}
              dbId={dbId}
              table={currentTable}
              tables={tables}
              canEdit={canEdit}
              reloadKey={reloadKey}
              onSchema={applySchema}
              onRevision={onRevision}
            />
          )}
          {query && (
            <QueryDesigner key={`q${query.id}`} dbId={dbId} query={query} tables={tables} canEdit={canEdit} reloadKey={reloadKey} onSchema={applySchema} onRevision={onRevision} />
          )}
          {form && <FormView key={`f${form.id}`} dbId={dbId} form={form} tables={tables} canEdit={canEdit} reloadKey={reloadKey} onSchema={applySchema} onRevision={onRevision} />}
          {!route && (
            <div className="tb-empty">
              <h2>An empty database</h2>
              <p className="muted">Add a table to start, or import one from a CSV file.</p>
              {canEdit && (
                <div className="row">
                  <button type="button" className="primary" onClick={newTable}>
                    New table
                  </button>
                  <button type="button" className="menu-button" onClick={() => csvInput.current?.click()}>
                    Import CSV
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </section>
      {menu && menuItem && (
        <MenuPopover anchor={menu.rect} onClose={() => setMenu(null)}>
          <button type="button" onClick={() => rename(menu.kind, menu.id, menuItem.name)}>
            Rename
          </button>
          {menu.kind === "table" && tables.length > 1 && (
            <>
              <button type="button" disabled={tables[0]?.id === menu.id} onClick={() => act(async () => applySchema(await tablesApi.changeTable(dbId, menu.id, { position: tables.findIndex((t) => t.id === menu.id) - 1 })))}>
                Move up
              </button>
              <button
                type="button"
                disabled={tables[tables.length - 1]?.id === menu.id}
                onClick={() => act(async () => applySchema(await tablesApi.changeTable(dbId, menu.id, { position: tables.findIndex((t) => t.id === menu.id) + 1 })))}
              >
                Move down
              </button>
            </>
          )}
          {menu.kind === "table" && (
            <a href={tablesApi.tableCsvUrl(dbId, menu.id)} download>
              Download as CSV
            </a>
          )}
          <button type="button" className="danger-text" onClick={() => remove(menu.kind, menu.id, menuItem.name)}>
            Delete
          </button>
        </MenuPopover>
      )}
    </div>
  );
}
