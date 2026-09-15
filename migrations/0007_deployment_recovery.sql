ALTER TABLE deployments ADD COLUMN previous_deployment_id UUID REFERENCES deployments(id);
