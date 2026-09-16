-- Per-heartbeat vitals so the dashboard can draw the last hour without replaying reports.
CREATE TABLE machine_samples (
    machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    at TIMESTAMPTZ NOT NULL DEFAULT now(),
    cpu REAL NOT NULL,
    mem BIGINT NOT NULL,
    disk BIGINT NOT NULL,
    PRIMARY KEY (machine_id, at)
);
