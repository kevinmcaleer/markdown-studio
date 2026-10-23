import { useState, type DragEvent, type ReactNode } from "react";
import { Link } from "../Link";
import type { FileMeta, Folder } from "./filesApi";
import type { FolderNode } from "./tree";

// The sidebar's folder tree. Rows can be dragged onto folders (or the empty
// space at the bottom, for the top level), and files from the desktop can be
// dropped anywhere to upload them.

export type Target = { kind: "file"; item: FileMeta } | { kind: "folder"; item: Folder };

export type TreeActions = {
  open: Set<number>;
  toggle: (id: number) => void;
  currentFileId: number | null;
  selectedFolder: number | null;
  selectFolder: (id: number | null) => void;
  renaming: Target | null;
  rename: (target: Target, name: string | null) => void;
  menu: (target: Target, anchor: HTMLElement) => void;
  move: (target: Target, folderId: number | null) => void;
  upload: (files: FileList, folderId: number | null) => void;
};

const DRAG_TYPE = "application/x-studio-item";

export function FileTree({ root, actions }: { root: FolderNode; actions: TreeActions }) {
  const [dropping, setDropping] = useState(false);
  const empty = root.folders.length === 0 && root.files.length === 0;
  return (
    <div
      className={`tree ${dropping ? "drop-target" : ""}`}
      role="tree"
      aria-label="Files"
      {...dropHandlers(null, actions, setDropping)}
      onClick={(e) => {
        if (e.target === e.currentTarget) actions.selectFolder(null);
      }}
    >
      {empty && <p className="tree-empty muted small">No files yet. Create a note or drop files here.</p>}
      <Children node={root} depth={0} actions={actions} />
    </div>
  );
}

function Children({ node, depth, actions }: { node: FolderNode; depth: number; actions: TreeActions }) {
  return (
    <>
      {node.folders.map((child) => (
        <FolderRow key={`d${child.folder!.id}`} node={child} depth={depth} actions={actions} />
      ))}
      {node.files.map((file) => (
        <FileRow key={`f${file.id}`} file={file} depth={depth} actions={actions} />
      ))}
    </>
  );
}

function FolderRow({ node, depth, actions }: { node: FolderNode; depth: number; actions: TreeActions }) {
  const folder = node.folder!;
  const [dropping, setDropping] = useState(false);
  const isOpen = actions.open.has(folder.id);
  const target: Target = { kind: "folder", item: folder };
  return (
    <div role="treeitem" aria-expanded={isOpen} aria-selected={actions.selectedFolder === folder.id}>
      <Row
        depth={depth}
        className={`${dropping ? "drop-target" : ""} ${actions.selectedFolder === folder.id ? "selected" : ""}`}
        target={target}
        actions={actions}
        extra={dropHandlers(folder.id, actions, setDropping)}
      >
        <button
          type="button"
          className="tree-label"
          onClick={() => {
            actions.toggle(folder.id);
            actions.selectFolder(folder.id);
          }}
        >
          <Chevron open={isOpen} />
          <FolderIcon />
          <NameOrInput target={target} actions={actions} />
        </button>
      </Row>
      {isOpen && (
        <div role="group">
          <Children node={node} depth={depth + 1} actions={actions} />
        </div>
      )}
    </div>
  );
}

function FileRow({ file, depth, actions }: { file: FileMeta; depth: number; actions: TreeActions }) {
  const target: Target = { kind: "file", item: file };
  const current = actions.currentFileId === file.id;
  return (
    <div role="treeitem" aria-selected={current}>
      <Row depth={depth} className={current ? "current" : ""} target={target} actions={actions}>
        <Link
          href={`/notes/${file.id}`}
          className="tree-label"
          aria-current={current ? "page" : undefined}
          onClick={() => actions.selectFolder(file.folder_id)}
        >
          <span className="tree-chevron" />
          <FileIcon markdown={file.mime_type === "text/markdown"} />
          <NameOrInput target={target} actions={actions} />
        </Link>
      </Row>
    </div>
  );
}

function Row({
  depth,
  className,
  target,
  actions,
  extra,
  children,
}: {
  depth: number;
  className: string;
  target: Target;
  actions: TreeActions;
  extra?: object;
  children: ReactNode;
}) {
  return (
    <div
      className={`tree-row ${className}`}
      style={{ paddingLeft: `${0.5 + depth * 0.9}rem` }}
      draggable={actions.renaming?.item.id !== target.item.id}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ kind: target.kind, id: target.item.id }));
        e.dataTransfer.effectAllowed = "move";
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        actions.menu(target, e.currentTarget);
      }}
      {...extra}
    >
      {children}
      <button
        type="button"
        className="tree-more"
        aria-label={`Actions for ${target.item.name}`}
        onClick={(e) => actions.menu(target, e.currentTarget)}
      >
        ⋯
      </button>
    </div>
  );
}

function NameOrInput({ target, actions }: { target: Target; actions: TreeActions }) {
  const editing = actions.renaming?.kind === target.kind && actions.renaming.item.id === target.item.id;
  if (!editing) return <span className="tree-name">{target.item.name}</span>;
  return (
    <input
      className="tree-rename"
      defaultValue={target.item.name}
      autoFocus
      aria-label="New name"
      onClick={(e) => e.preventDefault()}
      onFocus={(e) => {
        // Select the name without its extension, like a desktop file manager.
        const dot = target.kind === "file" ? e.currentTarget.value.lastIndexOf(".") : -1;
        e.currentTarget.setSelectionRange(0, dot > 0 ? dot : e.currentTarget.value.length);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") actions.rename(target, e.currentTarget.value);
        if (e.key === "Escape") actions.rename(target, null);
      }}
      onBlur={(e) => actions.rename(target, e.currentTarget.value)}
    />
  );
}

function dropHandlers(folderId: number | null, actions: TreeActions, setDropping: (on: boolean) => void) {
  const accepts = (e: DragEvent) => e.dataTransfer.types.includes(DRAG_TYPE) || e.dataTransfer.types.includes("Files");
  return {
    onDragOver: (e: DragEvent) => {
      if (!accepts(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setDropping(true);
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false);
    },
    onDrop: (e: DragEvent) => {
      if (!accepts(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setDropping(false);
      const item = e.dataTransfer.getData(DRAG_TYPE);
      if (item) {
        const { kind, id } = JSON.parse(item) as { kind: Target["kind"]; id: number };
        actions.move({ kind, item: { id } } as Target, folderId);
      } else if (e.dataTransfer.files.length) {
        actions.upload(e.dataTransfer.files, folderId);
      }
    },
  };
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className="tree-chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" style={{ transform: open ? "rotate(90deg)" : undefined }}>
      <path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg className="tree-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M1.5 4.5a1 1 0 0 1 1-1h3.6l1.4 1.5h6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function FileIcon({ markdown }: { markdown: boolean }) {
  return (
    <svg className="tree-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 1.5h6l3 3v10h-9z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      {markdown && <path d="M5.5 11.5v-4l1.5 2 1.5-2v4M10.5 7.5v4m-1.2-1.2 1.2 1.2 1.2-1.2" fill="none" stroke="currentColor" strokeWidth="1" />}
    </svg>
  );
}
