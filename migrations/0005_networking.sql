CREATE SEQUENCE fleet_private_address_seq MINVALUE 2 MAXVALUE 65534 NO CYCLE;
CREATE TABLE fleet_network_nodes (
 machine_id UUID PRIMARY KEY REFERENCES machines(id) ON DELETE CASCADE,
 address_slot INTEGER NOT NULL UNIQUE DEFAULT nextval('fleet_private_address_seq'),
 is_server BOOLEAN NOT NULL DEFAULT false,
 public_key TEXT UNIQUE, endpoint TEXT,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX fleet_single_bootstrap_server ON fleet_network_nodes(is_server) WHERE is_server;
CREATE TABLE fleet_commands (
 id UUID PRIMARY KEY,
 machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
 request TEXT NOT NULL,
 result TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 claimed_at TIMESTAMPTZ,
 completed_at TIMESTAMPTZ
);
CREATE INDEX fleet_pending_commands ON fleet_commands(machine_id,created_at) WHERE completed_at IS NULL;
