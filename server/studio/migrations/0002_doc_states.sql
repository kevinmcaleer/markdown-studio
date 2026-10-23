-- The co-editing (Yjs) state of each text file that has been opened live.
-- files.content always holds the plain text too, so exports, downloads and
-- backups never need to understand this blob.
CREATE TABLE doc_states (
    file_id     INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
    state       BLOB    NOT NULL,
    updated_at  TEXT    NOT NULL
);
