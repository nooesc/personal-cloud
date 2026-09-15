CREATE TABLE integrations (
    provider TEXT PRIMARY KEY CHECK (provider IN ('github','cloudflare')),
    metadata JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE integration_secrets (
    key TEXT PRIMARY KEY,
    ciphertext TEXT NOT NULL
);
CREATE TABLE github_deliveries (
    id TEXT PRIMARY KEY,
    event TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE github_deploy_requests (
    service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    commit_sha TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    error TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(service_id,commit_sha)
);
CREATE TABLE github_repository_hooks (
    repository TEXT PRIMARY KEY,
    hook_id BIGINT,
    url TEXT,
    status TEXT NOT NULL DEFAULT 'polling',
    error TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE github_branch_heads (
    project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    commit_sha TEXT NOT NULL,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE domains ADD COLUMN account_id TEXT;
ALTER TABLE domains ADD COLUMN zone_id TEXT;
ALTER TABLE domains ADD COLUMN tunnel_id TEXT;
ALTER TABLE domains ADD COLUMN dns_record_id TEXT;
ALTER TABLE domains ADD COLUMN upstream TEXT;
ALTER TABLE domains ADD COLUMN error TEXT;
ALTER TABLE domains ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX github_requests_pending ON github_deploy_requests(updated_at) WHERE status='pending';
ALTER TABLE domains ADD COLUMN configuration_version BIGINT;
ALTER TABLE domains ADD COLUMN configuration_applied BOOLEAN NOT NULL DEFAULT false;
