import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../api";
import { navigate } from "../router";
import { FileTree, type Target, type TreeActions } from "./FileTree";
import { files, folders, type Tree } from "./filesApi";
import { NotesHome } from "./NotesHome";
import { NoteView } from "./NoteView";
import { ancestors, buildTree, descendants, folderPaths } from "./tree";

// The Notes app: a file browser on the left, the open note on the right.
// Everything under /notes belongs to it: /notes is the browser, /notes/:id a file.

const OPEN_KEY = "notes.openFolders";

export function Notes({ path }: { path: string }) {
  const fileId = Number(/^\/notes\/(\d+)/.exec(path)?.[1] ?? NaN);
  const currentFileId = Number.isFinite(fileId) ? fileId : null;
  const [tree, setTree] = useState<Tree | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<Set<number>>(() => new Set(readOpen()));
  const [selectedFolder, selectFolder] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<Target | null>(null);
  const [menu, setMenu] = useState<{ target: Target; x: number; y: number } | null>(null);
  const [moving, setMoving] = useState<Target | null>(null);
  // On phones the home page shows the documents, so the file drawer starts closed.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const uploadInput = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    try {
      setTree(await files.tree());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load your files.");
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify([...open]));
    } catch {
      /* private mode: forget which folders were open */
    }
  }, [open]);

  // Reveal the open file in the tree.
  useEffect(() => {
    const file = tree?.files.find((f) => f.id === currentFileId);
    if (!file || !tree) return;
    const parents = ancestors(tree.folders, file.folder_id);
    if (parents.some((id) => !open.has(id))) setOpen((prev) => new Set([...prev, ...parents]));
    // Only when the file changes, not every time a folder is toggled.
  }, [currentFileId, tree]);

  // On phones the file list is a drawer; opening a file closes it.
  useEffect(() => {
    if (currentFileId !== null) setSidebarOpen(false);
  }, [currentFileId]);

  const root = useMemo(() => (tree ? buildTree(tree) : null), [tree]);

  async function attempt(action: () => Promise<unknown>) {
    setError("");
    try {
      await action();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    }
    await reload();
  }

  const newNote = () =>
    attempt(async () => {
      const { file } = await files.createNote("Untitled.md", selectedFolder);
      if (selectedFolder !== null) setOpen((prev) => new Set(prev).add(selectedFolder));
      navigate(`/notes/${file.id}`);
      setRenaming(null);
    });

  const newFolder = () =>
    attempt(async () => {
      const taken = new Set(tree?.folders.filter((f) => f.parent_id === selectedFolder).map((f) => f.name.toLowerCase()));
      let name = "New folder";
      for (let n = 2; taken.has(name.toLowerCase()); n++) name = `New folder ${n}`;
      const { folder } = await folders.create(name, selectedFolder);
      if (selectedFolder !== null) setOpen((prev) => new Set(prev).add(selectedFolder));
      setRenaming({ kind: "folder", item: folder });
    });

  const actions: TreeActions = {
    open,
    toggle: (id) =>
      setOpen((prev) => {
        const next = new Set(prev);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    currentFileId,
    selectedFolder,
    selectFolder,
    renaming,
    rename: (target, name) => {
      setRenaming(null);
      if (name === null || !name.trim() || name.trim() === target.item.name) return;
      attempt(() => (target.kind === "file" ? files.rename(target.item.id, name) : folders.rename(target.item.id, name)));
    },
    menu: (target, anchor) => {
      const rect = anchor.getBoundingClientRect();
      setMenu({ target, x: Math.min(rect.left, window.innerWidth - 220), y: rect.bottom + 4 });
    },
    move: (target, folderId) => {
      if (target.kind === "folder" && tree && folderId !== null && descendants(tree.folders, target.item.id).has(folderId)) return;
      attempt(async () => {
        if (target.kind === "file") await files.move(target.item.id, folderId);
        else await folders.move(target.item.id, folderId);
        if (folderId !== null) setOpen((prev) => new Set(prev).add(folderId));
      });
    },
    upload: (list, folderId) =>
      attempt(async () => {
        for (const file of Array.from(list)) await files.upload(file, folderId);
        if (folderId !== null) setOpen((prev) => new Set(prev).add(folderId));
      }),
  };

  async function remove(target: Target) {
    const what = target.kind === "folder" ? `the folder “${target.item.name}” and everything in it` : `“${target.item.name}”`;
    if (!window.confirm(`Delete ${what}? This can't be undone.`)) return;
    await attempt(async () => {
      if (target.kind === "file") await files.remove(target.item.id);
      else await folders.remove(target.item.id);
    });
    const gone =
      target.kind === "file"
        ? target.item.id === currentFileId
        : tree?.files.some((f) => f.id === currentFileId && f.folder_id !== null && descendants(tree.folders, target.item.id).has(f.folder_id));
    if (gone) navigate("/notes");
  }

  return (
    <div className={`notes ${sidebarOpen ? "sidebar-open" : ""}`}>
      <aside className="notes-sidebar" aria-label="Files">
        <div className="sidebar-head">
          <h2>Files</h2>
          <div className="spacer" />
          <IconButton label="New note" onClick={newNote} icon="M8 3v10M3 8h10" />
          <IconButton label="New folder" onClick={newFolder} icon="M2 5h4.5l1.5 1.5h6v6.5H2zM8 8.5v3M6.5 10h3" />
          <IconButton label="Upload files" onClick={() => uploadInput.current?.click()} icon="M8 11V3M4.5 6.5 8 3l3.5 3.5M3 13h10" />
          <input
            ref={uploadInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.currentTarget.files?.length) actions.upload(e.currentTarget.files, selectedFolder);
              e.currentTarget.value = "";
            }}
          />
        </div>
        {error && (
          <p className="error small" role="alert">
            {error}
          </p>
        )}
        {root ? <FileTree root={root} actions={actions} /> : <p className="muted small tree-empty">Loading…</p>}
      </aside>
      <section className="notes-main">
        <button type="button" className="sidebar-toggle menu-button" onClick={() => setSidebarOpen((o) => !o)} aria-expanded={sidebarOpen}>
          Files
        </button>
        {currentFileId === null ? (
          <NotesHome tree={tree} onNew={newNote} onMenu={(file, anchor) => actions.menu({ kind: "file", item: file }, anchor)} />
        ) : (
          <NoteView
            key={currentFileId}
            fileId={currentFileId}
            onRenamed={reload}
            onSaved={(file) => setTree((t) => t && { ...t, files: t.files.map((f) => (f.id === file.id ? file : f)) })}
          />
        )}
      </section>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button type="button" onClick={() => setRenaming(menu.target)}>
            Rename
          </button>
          <button type="button" onClick={() => setMoving(menu.target)}>
            Move to…
          </button>
          {menu.target.kind === "file" && <a href={files.downloadUrl(menu.target.item.id)}>Download</a>}
          {menu.target.kind === "folder" && (
            <button
              type="button"
              onClick={() => {
                selectFolder(menu.target.item.id);
                setOpen((prev) => new Set(prev).add(menu.target.item.id));
                setTimeout(newNote);
              }}
            >
              New note here
            </button>
          )}
          <button type="button" className="danger-text" onClick={() => remove(menu.target)}>
            Delete
          </button>
        </ContextMenu>
      )}
      {moving && tree && (
        <MoveDialog
          target={moving}
          tree={tree}
          onClose={() => setMoving(null)}
          onMove={(folderId) => {
            actions.move(moving, folderId);
            setMoving(null);
          }}
        />
      )}
    </div>
  );
}

function readOpen(): number[] {
  try {
    const value = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((v) => typeof v === "number") : [];
  } catch {
    return [];
  }
}

function IconButton({ label, onClick, icon }: { label: string; onClick: () => void; icon: string }) {
  return (
    <button type="button" className="icon-button" aria-label={label} title={label} onClick={onClick}>
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <path d={icon} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

function ContextMenu({ x, y, onClose, children }: { x: number; y: number; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !ref.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    ref.current?.querySelector<HTMLElement>("button, a")?.focus();
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [onClose]);
  return (
    <div ref={ref} className="menu-list context-menu" role="menu" style={{ left: x, top: y }} onClick={onClose}>
      {children}
    </div>
  );
}

function MoveDialog({
  target,
  tree,
  onClose,
  onMove,
}: {
  target: Target;
  tree: Tree;
  onClose: () => void;
  onMove: (folderId: number | null) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const current = target.kind === "file" ? (tree.files.find((f) => f.id === target.item.id)?.folder_id ?? null) : (tree.folders.find((f) => f.id === target.item.id)?.parent_id ?? null);
  const [choice, setChoice] = useState(current === null ? "" : String(current));
  const blocked = target.kind === "folder" ? descendants(tree.folders, target.item.id) : new Set<number>();
  const options = folderPaths(tree.folders).filter((f) => !blocked.has(f.id));

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  return (
    <dialog ref={ref} className="card dialog" onClose={onClose}>
      <form
        method="dialog"
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          onMove(choice === "" ? null : Number(choice));
        }}
      >
        <h2>Move “{target.item.name}”</h2>
        <div className="field">
          <label htmlFor="move-to">To folder</label>
          <select id="move-to" value={choice} onChange={(e) => setChoice(e.target.value)}>
            <option value="">Top level</option>
            {options.map((f) => (
              <option key={f.id} value={f.id}>
                {f.path}
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          <button type="submit" className="primary">
            Move
          </button>
          <button type="button" className="menu-button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}
