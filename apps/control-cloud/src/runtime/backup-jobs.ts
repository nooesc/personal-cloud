import { type Doc } from "../core";
import { databaseProbe, constraint } from "./jobs";
export const BACKUP_MAX = 100 * 1024 * 1024;
export function backupJob(
  db: Doc,
  operation: Doc,
  uri: string,
  endpoint: string,
  token: string,
): Doc {
  const job = databaseProbe({ ...db, probe_job_id: operation.job_id }, uri);
  job.Job.Constraints.push(constraint("${meta.pc_machine_id}", db.machine_id));
  const group = job.Job.TaskGroups[0];
  group.Name = "backup";
  group.EphemeralDisk = { SizeMB: 256 };
  const postgres = group.Tasks[0];
  postgres.Name = "postgres";
  postgres.Resources.MemoryMB = 128;
  const transfer: Doc = {
    Name: "transfer",
    Driver: "docker",
    User: "0",
    Config: {
      image: "curlimages/curl:8.12.1",
      command: "sh",
      args: ["-ec", ""],
    },
    Env: { BACKUP_URL: endpoint, BACKUP_TOKEN: token },
    Resources: { CPU: 100, MemoryMB: 64 },
    LogConfig: { MaxFiles: 1, MaxFileSizeMB: 1 },
  };
  if (operation.kind === "backup") {
    postgres.Lifecycle = { Hook: "prestart", Sidecar: false };
    postgres.Config.command = "sh";
    postgres.Config.args = [
      "-ec",
      `pg_dump -w --format=custom --no-owner --no-acl --file=/alloc/data/backup.dump; test "$(wc -c < /alloc/data/backup.dump)" -le ${BACKUP_MAX}`,
    ];
    transfer.Config.args[1] =
      'digest=$(sha256sum /alloc/data/backup.dump); digest=${digest%% *}; curl --fail --silent --show-error --max-time 600 -X PUT -H "Authorization: Bearer $BACKUP_TOKEN" -H "x-backup-sha256: $digest" --upload-file /alloc/data/backup.dump "$BACKUP_URL"';
    group.Tasks = [postgres, transfer];
  } else {
    transfer.Lifecycle = { Hook: "prestart", Sidecar: false };
    transfer.Env.BACKUP_SHA256 = operation.checksum;
    transfer.Config.args[1] =
      'curl --fail --silent --show-error --max-time 600 -H "Authorization: Bearer $BACKUP_TOKEN" --output /alloc/data/backup.dump "$BACKUP_URL"; echo "$BACKUP_SHA256  /alloc/data/backup.dump" | sha256sum -c -';
    postgres.Config.command = "sh";
    postgres.Config.args = [
      "-ec",
      'pg_restore -w --exit-on-error --single-transaction --no-owner --no-acl --dbname="$PGDATABASE" /alloc/data/backup.dump; psql -w -v ON_ERROR_STOP=1 -tAc "SELECT 1"',
    ];
    group.Tasks = [transfer, postgres];
  }
  return job;
}
