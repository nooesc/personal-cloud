CREATE TABLE domain_routes (hostname TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, domain_id TEXT NOT NULL UNIQUE);
CREATE INDEX domain_workspace ON domain_routes(workspace_id);
