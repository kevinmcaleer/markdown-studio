-- Threaded comments, anchored to a selection in the document.

CREATE TABLE comment_threads (
    id          INTEGER PRIMARY KEY,
    file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    -- Character offsets into the markdown when the thread was started, plus
    -- the quoted text so the client can find the passage again after edits.
    -- anchor holds the editor's own position data (e.g. Yjs relative
    -- positions); the server stores it but never reads it.
    anchor_from INTEGER NOT NULL DEFAULT 0,
    anchor_to   INTEGER NOT NULL DEFAULT 0,
    quote       TEXT    NOT NULL DEFAULT '',
    anchor      TEXT,
    resolved_at TEXT,
    resolved_by TEXT,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
);

CREATE INDEX idx_comment_threads_file ON comment_threads (file_id);

CREATE TABLE comments (
    id          INTEGER PRIMARY KEY,
    thread_id   INTEGER NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
    -- Exactly one of these says who wrote it: a user, or an anonymous visitor
    -- (sha256 of their anonymous cookie, so they can edit their own comments).
    author_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    author_anon TEXT,
    author_name TEXT    NOT NULL,
    body        TEXT    NOT NULL,
    created_at  TEXT    NOT NULL,
    edited_at   TEXT,
    deleted_at  TEXT
);

CREATE INDEX idx_comments_thread ON comments (thread_id);
