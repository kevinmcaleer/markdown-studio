-- One person's own state for a file: where they left off, bookmarks, folds,
-- how they like it opened. Never shown to anyone else and never written into
-- the file. The server keeps `state` as an opaque JSON object; the editor owns
-- its shape. Anonymous share-link visitors keep theirs in their browser.

CREATE TABLE file_user_state (
    file_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    state      TEXT    NOT NULL,
    updated_at TEXT    NOT NULL,
    PRIMARY KEY (file_id, user_id)
);

CREATE INDEX idx_file_user_state_user ON file_user_state (user_id);
