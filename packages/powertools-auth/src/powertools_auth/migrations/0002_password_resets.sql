-- One-time links for "forgot password" emails. Like sessions, only a SHA-256
-- of the token in the link is stored.
CREATE TABLE password_resets (
    id          TEXT    PRIMARY KEY,  -- sha256 of the emailed token
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TEXT    NOT NULL,
    expires_at  TEXT    NOT NULL
);

CREATE INDEX idx_password_resets_user ON password_resets (user_id);
