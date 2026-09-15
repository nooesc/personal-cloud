ALTER TABLE services ADD COLUMN promotion_deployment_id UUID;
ALTER TABLE services ADD COLUMN promotion_address TEXT;
ALTER TABLE deployments ADD COLUMN stopped_at TIMESTAMPTZ;
