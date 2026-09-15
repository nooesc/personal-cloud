CREATE TABLE projects (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    repository TEXT NOT NULL,
    branch TEXT NOT NULL DEFAULT 'main',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE machines (
    id UUID PRIMARY KEY,
    credential_hash TEXT NOT NULL UNIQUE,
    location TEXT NOT NULL CHECK (location IN ('home', 'vps', 'dedicated')),
    roles TEXT[] NOT NULL,
    tags TEXT[] NOT NULL,
    report JSONB NOT NULL,
    last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE enrollment_tokens (
    id UUID PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    location TEXT NOT NULL,
    roles TEXT[] NOT NULL,
    tags TEXT[] NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '15 minutes',
    used_at TIMESTAMPTZ
);
CREATE TABLE services (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
    placement JSONB NOT NULL DEFAULT '{"kind":"automatic"}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(project_id, name)
);
CREATE TABLE deployments (
    id UUID PRIMARY KEY,
    service_id UUID NOT NULL REFERENCES services(id),
    status TEXT NOT NULL CHECK (status IN ('queued','building','deploying','healthy','failed','rolled_back')),
    image_digest TEXT,
    commit_sha TEXT,
    machine_id UUID REFERENCES machines(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE databases (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id),
    name TEXT NOT NULL,
    machine_id UUID NOT NULL REFERENCES machines(id),
    volume_name TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE domains (
    id UUID PRIMARY KEY,
    service_id UUID NOT NULL REFERENCES services(id),
    hostname TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE events (
    id BIGSERIAL PRIMARY KEY,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX services_project ON services(project_id);
CREATE INDEX machines_last_seen ON machines(last_seen);
CREATE INDEX events_recent ON events(created_at DESC);
