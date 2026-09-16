CREATE TABLE machine_routes (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE);
CREATE INDEX machine_workspace ON machine_routes(workspace_id);
CREATE TABLE enrollment_routes (token_hash TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE INDEX enrollment_expiry ON enrollment_routes(expires_at);
