-- Tables: Access-style databases. A database is a file in the user's file
-- system (name ending .tables), so folders, sharing and "Shared with me" work
-- as they do for notes. Its tables, fields, rows, queries and forms live here,
-- and go when the file is deleted.

CREATE TABLE tb_databases (
    file_id     INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
    -- Bumped by every change, so open copies know to fetch again.
    revision    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE tb_tables (
    id          INTEGER PRIMARY KEY,
    file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL,
    position    INTEGER NOT NULL DEFAULT 0,
    -- The field that names a row where other tables link to it; NULL = the first.
    primary_field_id INTEGER,
    -- The ID (autonumber) the next new row gets, counted per table as in Access.
    next_number INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
);

CREATE UNIQUE INDEX idx_tb_tables_name ON tb_tables (file_id, name COLLATE NOCASE);

CREATE TABLE tb_fields (
    id          INTEGER PRIMARY KEY,
    table_id    INTEGER NOT NULL REFERENCES tb_tables(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL,
    -- One of studio.tables.types.TYPES; options is JSON (choices, decimals, ...).
    type        TEXT    NOT NULL,
    options     TEXT    NOT NULL DEFAULT '{}',
    position    INTEGER NOT NULL DEFAULT 0,
    width       INTEGER,
    created_at  TEXT    NOT NULL
);

CREATE UNIQUE INDEX idx_tb_fields_name ON tb_fields (table_id, name COLLATE NOCASE);

-- One row per record. data is a JSON object keyed by field id, so renaming a
-- field never touches the rows; a missing key is an empty value.
CREATE TABLE tb_rows (
    id          INTEGER PRIMARY KEY,
    table_id    INTEGER NOT NULL REFERENCES tb_tables(id) ON DELETE CASCADE,
    number      INTEGER NOT NULL,
    data        TEXT    NOT NULL DEFAULT '{}',
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
);

CREATE UNIQUE INDEX idx_tb_rows_number ON tb_rows (table_id, number);

-- Saved queries and forms. spec is JSON; see studio.tables.query and forms.
CREATE TABLE tb_objects (
    id          INTEGER PRIMARY KEY,
    file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    kind        TEXT    NOT NULL CHECK (kind IN ('query', 'form')),
    name        TEXT    NOT NULL,
    spec        TEXT    NOT NULL DEFAULT '{}',
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
);

CREATE UNIQUE INDEX idx_tb_objects_name ON tb_objects (file_id, kind, name COLLATE NOCASE);
