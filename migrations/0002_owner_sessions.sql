CREATE TABLE owner_sessions (
    token_hash TEXT PRIMARY KEY,
    admin_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '12 hours'
);
CREATE INDEX owner_sessions_expiry ON owner_sessions(expires_at);
