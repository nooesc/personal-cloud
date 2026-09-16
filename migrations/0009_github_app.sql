-- Browser authorization requests are short-lived, hashed and consumed atomically.
CREATE TABLE github_flows (
 state_hash TEXT PRIMARY KEY,
 browser_hash TEXT NOT NULL,
 purpose TEXT NOT NULL CHECK (purpose IN ('manifest','link','login','install')),
 verifier_encrypted TEXT NOT NULL,
 admin_hash TEXT NOT NULL,
 owner_session_hash TEXT,
 used_at TIMESTAMPTZ,
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '10 minutes'
);
CREATE TABLE github_owner (
 singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
 user_id BIGINT NOT NULL UNIQUE,
 login TEXT NOT NULL,
 avatar_url TEXT,
 linked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE github_installations (
 id BIGINT PRIMARY KEY,
 account_login TEXT NOT NULL,
 account_type TEXT NOT NULL,
 repository_selection TEXT NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE owner_sessions ADD COLUMN github_user_id BIGINT;
