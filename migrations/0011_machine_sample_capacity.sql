-- Keep the published 0010 checksum unchanged. Historical reports did not record
-- capacity; zero denotes unknown and must not be interpreted as measured usage.
ALTER TABLE machine_samples
    ADD COLUMN load REAL,
    ADD COLUMN mem_total BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN disk_total BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN uptime BIGINT,
    ADD COLUMN cpu_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN containers INTEGER NOT NULL DEFAULT 0;
