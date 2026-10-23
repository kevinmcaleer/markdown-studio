-- Each user's files and folders. File contents live in the database as blobs,
-- so a backup of studio.db is a backup of everything.
CREATE TABLE folders (
    id          INTEGER PRIMARY KEY,
    owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id   INTEGER REFERENCES folders(id) ON DELETE CASCADE,  -- NULL = top level
    name        TEXT    NOT NULL,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
);

-- Names are unique within a folder, ignoring case (NULL parents compare as 0).
CREATE UNIQUE INDEX idx_folders_name ON folders (owner_id, coalesce(parent_id, 0), name COLLATE NOCASE);
CREATE INDEX idx_folders_parent ON folders (parent_id);

CREATE TABLE files (
    id          INTEGER PRIMARY KEY,
    owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    folder_id   INTEGER REFERENCES folders(id) ON DELETE CASCADE,  -- NULL = top level
    name        TEXT    NOT NULL,
    mime_type   TEXT    NOT NULL,
    size        INTEGER NOT NULL,
    content     BLOB    NOT NULL,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
);

CREATE UNIQUE INDEX idx_files_name ON files (owner_id, coalesce(folder_id, 0), name COLLATE NOCASE);
CREATE INDEX idx_files_folder ON files (folder_id);
