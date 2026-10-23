-- Sharing: links anyone can open (optionally without signing in) and
-- per-user grants. Roles, lowest first: view < comment < edit. The file's
-- owner is always 'owner' and never needs a row here.

CREATE TABLE share_links (
    id          INTEGER PRIMARY KEY,
    file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    -- Random, URL-safe; the whole link is /s/<token>. Kept in clear so the
    -- owner can copy the link again later.
    token       TEXT    NOT NULL UNIQUE,
    role        TEXT    NOT NULL CHECK (role IN ('view', 'comment', 'edit')),
    -- 1: anyone with the link, signed in or not. 0: signed-in users only.
    anonymous   INTEGER NOT NULL DEFAULT 1 CHECK (anonymous IN (0, 1)),
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TEXT    NOT NULL,
    expires_at  TEXT,
    revoked_at  TEXT
);

CREATE INDEX idx_share_links_file ON share_links (file_id);

-- A file shared with a named user. Appears in their "Shared with me".
CREATE TABLE file_members (
    file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        TEXT    NOT NULL CHECK (role IN ('view', 'comment', 'edit')),
    added_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TEXT    NOT NULL,
    PRIMARY KEY (file_id, user_id)
);

CREATE INDEX idx_file_members_user ON file_members (user_id);

-- Signed-in users who opened a link, so the file shows in their "Shared with
-- me". Access still comes from the link: revoke it and this grants nothing.
CREATE TABLE share_link_visits (
    link_id     INTEGER NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_opened_at TEXT NOT NULL,
    PRIMARY KEY (link_id, user_id)
);

CREATE INDEX idx_share_link_visits_user ON share_link_visits (user_id);
