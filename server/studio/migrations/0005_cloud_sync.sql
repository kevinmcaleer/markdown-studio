-- Cloud sync: Google Docs (two-way) and iCloud Drive (save a copy, bring it back).

-- A user's connection to a cloud account. Only Google needs one: iCloud
-- copies go through the browser's share sheet and file picker.
CREATE TABLE cloud_accounts (
    user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider          TEXT    NOT NULL CHECK (provider IN ('google')),
    account_email     TEXT    NOT NULL DEFAULT '',
    refresh_token     TEXT    NOT NULL,
    access_token      TEXT,
    access_expires_at REAL,
    created_at        TEXT    NOT NULL,
    updated_at        TEXT    NOT NULL,
    PRIMARY KEY (user_id, provider)
);

-- A note kept in step with a copy somewhere else. At most one per note and provider.
--
-- Sync is a three-way merge, so each link remembers what both sides looked
-- like when they last agreed:
--   base         the note's text then
--   remote_base  the copy's text then. Google rewrites Markdown a little on
--                the way through (list markers, escapes), so this can differ
--                from base without anyone having edited anything.
CREATE TABLE sync_links (
    id              INTEGER PRIMARY KEY,
    file_id         INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    provider        TEXT    NOT NULL CHECK (provider IN ('google', 'icloud')),
    -- Whose cloud account the copy lives in.
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    remote_id       TEXT    NOT NULL DEFAULT '',
    remote_url      TEXT    NOT NULL DEFAULT '',
    remote_version  TEXT    NOT NULL DEFAULT '',
    base            TEXT    NOT NULL,
    remote_base     TEXT    NOT NULL,
    -- 'conflict': both sides changed the same lines; conflict_remote (and
    -- conflict_version) hold their side until someone chooses what to keep.
    status          TEXT    NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'conflict')),
    conflict_remote TEXT,
    conflict_version TEXT,
    last_error      TEXT,
    synced_at       TEXT,
    created_at      TEXT    NOT NULL,
    UNIQUE (file_id, provider)
);

CREATE INDEX idx_sync_links_user ON sync_links (user_id, provider);
