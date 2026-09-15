CREATE TABLE settings (key TEXT PRIMARY KEY,value JSONB NOT NULL);
CREATE TABLE environment_variables (
 project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 key TEXT NOT NULL,value_encrypted TEXT NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(project_id,key)
);
ALTER TABLE services ADD COLUMN root_directory TEXT NOT NULL DEFAULT '.';
ALTER TABLE services ADD COLUMN health_path TEXT NOT NULL DEFAULT '/';
ALTER TABLE services ADD COLUMN cpu_mhz INTEGER NOT NULL DEFAULT 500;
ALTER TABLE services ADD COLUMN memory_mb INTEGER NOT NULL DEFAULT 256;
ALTER TABLE services ADD COLUMN architecture TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE services ADD COLUMN status TEXT NOT NULL DEFAULT 'not_deployed';
ALTER TABLE services ADD COLUMN current_deployment_id UUID;
ALTER TABLE services ADD COLUMN machine_id UUID REFERENCES machines(id);
ALTER TABLE services ADD COLUMN address TEXT;
ALTER TABLE services ADD COLUMN image_digest TEXT;
ALTER TABLE services ADD COLUMN auto_deploy BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE deployments ADD COLUMN step TEXT NOT NULL DEFAULT 'queued';
ALTER TABLE deployments ADD COLUMN error TEXT;
ALTER TABLE deployments ADD COLUMN job_id TEXT;
ALTER TABLE deployments ADD COLUMN allocation_id TEXT;
ALTER TABLE deployments ADD COLUMN architecture TEXT;
ALTER TABLE deployments ADD COLUMN lease_until TIMESTAMPTZ;
ALTER TABLE deployments ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE deployments ADD COLUMN finished_at TIMESTAMPTZ;
ALTER TABLE deployments ADD COLUMN rollback_of UUID REFERENCES deployments(id);
CREATE UNIQUE INDEX one_active_deployment ON deployments(service_id) WHERE status IN ('queued','building','deploying');
CREATE TABLE deployment_steps (
 id BIGSERIAL PRIMARY KEY,deployment_id UUID NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
 step TEXT NOT NULL,message TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE databases ADD COLUMN job_id TEXT;
ALTER TABLE databases ADD COLUMN allocation_id TEXT;
ALTER TABLE databases ADD COLUMN address TEXT;
ALTER TABLE databases ADD COLUMN connection_encrypted TEXT;
ALTER TABLE databases ADD COLUMN error TEXT;
ALTER TABLE databases ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE UNIQUE INDEX database_name ON databases(project_id,name);
CREATE TABLE service_database_bindings (service_id UUID PRIMARY KEY REFERENCES services(id) ON DELETE CASCADE,database_id UUID NOT NULL REFERENCES databases(id));
ALTER TABLE databases ADD COLUMN nomad_node_id TEXT NOT NULL DEFAULT '';
ALTER TABLE databases ADD COLUMN port INTEGER CHECK (port BETWEEN 1 AND 65535);
ALTER TABLE databases ADD COLUMN lease_until TIMESTAMPTZ;
CREATE TABLE retained_database_volumes (
    database_id UUID PRIMARY KEY,
    project_id UUID NOT NULL,
    machine_id UUID NOT NULL,
    nomad_node_id TEXT NOT NULL,
    volume_name TEXT NOT NULL UNIQUE,
    connection_encrypted TEXT NOT NULL,
    retained_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
