-- Suggested edits (Suggesting mode): a proposed replacement for a passage that
-- someone with edit access accepts or rejects. Nothing here touches the
-- document until it's accepted; the client then applies it like any edit.

CREATE TABLE suggestions (
    id          INTEGER PRIMARY KEY,
    file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    -- Where, as for comment threads: offsets and the original text when it was
    -- made, plus the editor's own anchor (Yjs relative positions), which the
    -- server stores but never reads. An empty quote is an insertion at a point.
    anchor_from INTEGER NOT NULL DEFAULT 0,
    anchor_to   INTEGER NOT NULL DEFAULT 0,
    quote       TEXT    NOT NULL DEFAULT '',
    anchor      TEXT,
    -- What the passage becomes. Empty means the passage is deleted.
    replacement TEXT    NOT NULL DEFAULT '',
    -- Who suggested it: a user, or an anonymous visitor (as for comments).
    author_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    author_anon TEXT,
    author_name TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'accepted', 'rejected')),
    decided_at  TEXT,
    decided_by  TEXT,
    -- The comment thread that replies to it go into, once someone replies.
    thread_id   INTEGER REFERENCES comment_threads(id) ON DELETE SET NULL,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
);

CREATE INDEX idx_suggestions_file ON suggestions (file_id);
