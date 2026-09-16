PRAGMA foreign_keys = ON;
CREATE TABLE users (
  id TEXT PRIMARY KEY, github_id INTEGER NOT NULL UNIQUE, login TEXT NOT NULL,
  avatar_url TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
  github_token TEXT, token_refresh_lock INTEGER NOT NULL DEFAULT 0, revoked_at INTEGER NOT NULL DEFAULT 0, auth_generation INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE memberships (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('owner','member')), created_at INTEGER NOT NULL,
  PRIMARY KEY(workspace_id,user_id)
);
CREATE INDEX memberships_user ON memberships(user_id);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, auth_generation INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE oauth_flows (
  state_hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, verifier TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('login','link','install')),
  user_id TEXT, workspace_id TEXT, session_hash TEXT, expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX oauth_flows_expiry ON oauth_flows(expires_at);
CREATE TABLE github_installations (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  installation_id INTEGER NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_login TEXT NOT NULL, account_type TEXT NOT NULL, repository_selection TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(workspace_id,installation_id,user_id)
);
CREATE INDEX installations_github ON github_installations(installation_id);
CREATE INDEX installations_user ON github_installations(user_id);
CREATE TABLE github_deliveries (
  delivery_id TEXT NOT NULL, workspace_id TEXT NOT NULL, completed_at INTEGER,
  created_at INTEGER NOT NULL, PRIMARY KEY(delivery_id,workspace_id)
);
CREATE INDEX deliveries_expiry ON github_deliveries(created_at);
CREATE TABLE auth_rate_limits (key TEXT NOT NULL, minute INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(key,minute));
CREATE INDEX auth_rate_expiry ON auth_rate_limits(minute);
