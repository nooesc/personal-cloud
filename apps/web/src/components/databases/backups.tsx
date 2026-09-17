import { useEffect, useState, type FormEvent } from "react";
import { Archive, Download, HardDriveDownload, RotateCcw, Trash2 } from "lucide-react";
import { api, type DatabaseInstance, type Snapshot } from "../../lib/data";
import { cn } from "../../lib/utils";
import { Reveal } from "../fleet/primitives";
import { ago } from "../project-summary";
import { Feedback, Field, useAction } from "../live";
import { Button } from "../ui/button";
import { Dialog, DialogFooter } from "../ui/dialog";
import { Input, Select, Switch } from "../ui/input";
import { Meta, StatusDot } from "../ui/misc";
import { DATABASE_LIMITS, bytes, databaseHosts, healthOf } from "./model";

export type Backup = {
  id: string;
  kind: "backup" | "restore";
  status: string;
  created_at: string;
  finished_at?: string;
  size?: number;
  error?: string;
  target_database_id?: string;
  target_name?: string;
};
export type BackupPolicy = {
  enabled: boolean;
  keep: number;
  /** Epoch ms of the next scheduled run; absent until the policy has been saved once. */
  next_at?: number;
  error?: string;
};
export type BackupState = { policy: BackupPolicy; backups: Backup[] };

const DEFAULT_KEEP = 7;
const KEEP_RANGE = { min: 1, max: 30 };
/** Rows shown before "Show more"; retention allows 30 copies and expired rows linger, so the list must reach all of them. */
const PAGE = 10;

const BACKUP_STATUS: Record<string, { label: string; dot: string; active: boolean }> = {
  queued: { label: "Queued", dot: "pending", active: true },
  provisioning: { label: "Preparing destination", dot: "pending", active: true },
  running: { label: "Running", dot: "provisioning", active: true },
  succeeded: { label: "Complete", dot: "healthy", active: false },
  failed: { label: "Failed", dot: "failed", active: false },
  expiring: { label: "Deleting", dot: "pending", active: true },
};
const statusOf = (b: Backup) =>
  BACKUP_STATUS[b.status] ?? { label: b.status.replaceAll("_", " "), dot: "idle", active: false };

/**
 * Private daily snapshots to R2 and restores into new copies. The policy is
 * two independent facts, on/off and how many copies to keep; toggling one
 * never rewrites the other.
 */
export function DatabaseBackups({
  data,
  db,
  live,
  refresh,
  onOpenDatabase,
}: {
  data: Snapshot;
  db: DatabaseInstance;
  live: boolean;
  refresh: () => Promise<unknown>;
  onOpenDatabase: (id: string) => void;
}) {
  const base = `/databases/${db.id}/backups`;
  const [state, setState] = useState<BackupState>();
  const [error, setError] = useState<string>();
  const [restoring, setRestoring] = useState<Backup>();
  const [deleting, setDeleting] = useState<Backup>();
  const [shown, setShown] = useState(PAGE);
  const action = useAction();
  const healthy = healthOf(db).key === "healthy";

  // Polling belongs to one mount; a response arriving after the effect has
  // been torn down (database switched, page left) is dropped.
  async function load(stale: () => boolean = () => false) {
    try {
      const next = await api<BackupState>(base);
      if (stale()) return;
      setState(next);
      setError(undefined);
    } catch (e) {
      if (stale()) return;
      setError(e instanceof Error ? e.message : "Backup history unavailable");
    }
  }
  useEffect(() => {
    let cancelled = false;
    const tick = () => void load(() => cancelled);
    tick();
    const timer = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [db.id]);

  const run = (fn: () => Promise<unknown>, message: string) =>
    action.run(async () => {
      await fn();
      await load();
      await refresh();
    }, message);

  const policy = state?.policy;
  const keep = policy?.keep ?? DEFAULT_KEEP;
  const savePolicy = (next: Partial<BackupPolicy>, message: string) =>
    run(() => api(`${base}/policy`, { enabled: policy?.enabled ?? false, keep, ...next }, "PUT"), message);
  const active = state?.backups.some((b) => statusOf(b).active) ?? false;
  const copies = state?.backups.filter((b) => b.kind === "backup" && b.status === "succeeded").length ?? 0;

  return (
    <section className="gh-surface overflow-hidden rounded-lg" aria-label="Backups">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-4 py-3">
        <div className="flex min-w-0 flex-col">
          <span className="gh-eyebrow">Backups</span>
          <span className="text-sm">
            {state
              ? copies === 0
                ? "No copies yet"
                : `${copies} ${copies === 1 ? "copy" : "copies"} in private storage`
              : error
                ? "Unavailable"
                : "Loading…"}
          </span>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={!live || action.busy || !healthy || active || !state}
          onClick={() => run(() => api(base, {}), "Backup queued")}
        >
          <HardDriveDownload />
          Back up now
        </Button>
      </header>

      {error && (
        <p role="alert" className="border-b border-border px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {policy && (
        <div className="grid gap-x-6 gap-y-3 border-b border-border px-4 py-3 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center">
          <label className="flex items-center gap-3 text-sm">
            <Switch
              checked={policy.enabled}
              disabled={!live || action.busy}
              onCheckedChange={(enabled) =>
                savePolicy({ enabled }, enabled ? "Daily backups scheduled" : "Daily backups paused")
              }
            />
            <span className="flex flex-col">
              <span className="font-medium">Daily backups</span>
              <Meta>
                {policy.enabled
                  ? policy.next_at
                    ? `next run ${nextRun(policy.next_at)}`
                    : "scheduled"
                  : "off · manual backups still work"}
              </Meta>
            </span>
          </label>
          <RetentionField
            keep={keep}
            disabled={!live || action.busy}
            onSave={(n) => savePolicy({ keep: n }, `Keeping the ${n} most recent ${n === 1 ? "copy" : "copies"}`)}
          />
          {policy.error && (
            <p role="alert" className="text-sm text-destructive sm:col-span-2">
              {policy.error}
            </p>
          )}
        </div>
      )}

      {state && (
        <ul className="divide-y divide-border">
          {state.backups.length === 0 && (
            <li className="flex items-center gap-3 px-4 py-4 text-sm text-muted-foreground">
              <Archive className="size-4 shrink-0" />
              Nothing saved yet. A copy is a compressed <code className="font-mono text-xs">pg_dump</code> of up to{" "}
              {bytes(DATABASE_LIMITS.backupBytes)}; restores always land in a new database.
            </li>
          )}
          {state.backups.slice(0, shown).map((b, i) => {
            const s = statusOf(b);
            const target = b.target_database_id ? data.databases.find((d) => d.id === b.target_database_id) : undefined;
            return (
              <Reveal as="li" key={b.id} delay={i * 0.02} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                <StatusDot status={s.dot} className={cn(s.active && "animate-pulse")} title={s.label} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-baseline gap-2">
                    <span className="font-medium">
                      {b.kind === "restore" ? `Restore → ${b.target_name ?? "new database"}` : "Backup"}
                    </span>
                    <span className={cn("text-xs", b.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
                      {s.label}
                    </span>
                  </span>
                  <Meta>
                    {ago(b.created_at)}
                    {b.size !== undefined && ` · ${bytes(b.size)}`}
                    {b.finished_at && b.kind === "backup" && ` · took ${duration(b.created_at, b.finished_at)}`}
                  </Meta>
                </span>
                <span className="flex shrink-0 gap-1.5">
                  {b.kind === "restore" && target && (
                    <Button size="xs" variant="outline" onClick={() => onOpenDatabase(target.id)}>
                      Open {target.name}
                    </Button>
                  )}
                  {b.kind === "backup" && b.status === "succeeded" && (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={!live || action.busy || active}
                      onClick={() => setRestoring(b)}
                    >
                      <RotateCcw />
                      Restore a copy
                    </Button>
                  )}
                  {b.kind === "backup" && (b.status === "succeeded" || b.status === "failed") && (
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label="Delete this copy"
                      disabled={!live || action.busy}
                      onClick={() => setDeleting(b)}
                    >
                      <Trash2 />
                    </Button>
                  )}
                </span>
                {b.error && (
                  <p role="alert" className="basis-full text-xs text-destructive">
                    {b.error}
                  </p>
                )}
              </Reveal>
            );
          })}
          {state.backups.length > shown && (
            <li className="flex items-center justify-between gap-3 px-4 py-2 text-xs text-muted-foreground">
              <span>
                {shown} of {state.backups.length} shown
              </span>
              <Button size="xs" variant="ghost" onClick={() => setShown((n) => n + PAGE)}>
                Show {Math.min(PAGE, state.backups.length - shown)} more
              </Button>
            </li>
          )}
        </ul>
      )}
      <div className="px-4 pb-3 pt-2">
        <Feedback action={action} />
      </div>

      {restoring && (
        <RestoreDialog
          data={data}
          db={db}
          backup={restoring}
          onClose={() => setRestoring(undefined)}
          onRestore={(name, machineId) =>
            run(
              () => api(`${base}/${restoring.id}/restore`, { name, machine_id: machineId || undefined }),
              `Restoring into ${name}`,
            ).then(() => setRestoring(undefined))
          }
        />
      )}
      {deleting && (
        <Dialog
          title="Delete this copy?"
          description={`The ${bytes(deleting.size ?? 0)} backup from ${ago(deleting.created_at)} is removed from private storage. The running database is unchanged.`}
          onClose={() => setDeleting(undefined)}
        >
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setDeleting(undefined)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              size="sm"
              isLoading={action.busy}
              onClick={() =>
                run(() => api(`${base}/${deleting.id}`, undefined, "DELETE"), "Backup deletion queued").then(() =>
                  setDeleting(undefined),
                )
              }
            >
              <Trash2 />
              Delete copy
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </section>
  );
}

/** Retention edits commit on blur/Enter so a half-typed number never hits the API. */
function RetentionField({
  keep,
  disabled,
  onSave,
}: {
  keep: number;
  disabled: boolean;
  onSave: (keep: number) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState(String(keep));
  useEffect(() => setDraft(String(keep)), [keep]);
  const value = Number(draft);
  const valid = Number.isInteger(value) && value >= KEEP_RANGE.min && value <= KEEP_RANGE.max;
  const commit = () => {
    if (!valid || value === keep) {
      setDraft(String(keep));
      return;
    }
    void onSave(value);
  };
  return (
    <label className="flex items-center gap-2 text-sm sm:justify-self-end">
      <span className="text-muted-foreground">Keep</span>
      <Input
        type="number"
        inputMode="numeric"
        min={KEEP_RANGE.min}
        max={KEEP_RANGE.max}
        value={draft}
        disabled={disabled}
        aria-invalid={!valid || undefined}
        aria-label="Copies to keep"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        className="h-8 w-16 text-center tabular-nums"
      />
      <span className="text-muted-foreground">
        successful {keep === 1 ? "copy" : "copies"}
      </span>
    </label>
  );
}

function RestoreDialog({
  data,
  db,
  backup,
  onClose,
  onRestore,
}: {
  data: Snapshot;
  db: DatabaseInstance;
  backup: Backup;
  onClose: () => void;
  onRestore: (name: string, machineId: string) => Promise<unknown>;
}) {
  const [name, setName] = useState(`${db.name}-restored`);
  const [machine, setMachine] = useState(db.machine_id ?? "");
  const [busy, setBusy] = useState(false);
  const hosts = databaseHosts(data);
  const taken = data.databases.some((d) => d.project_id === db.project_id && d.name === name.trim());
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    try {
      await onRestore(name.trim(), machine);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title="Restore into a new database"
      description={`The ${bytes(backup.size ?? 0)} copy from ${ago(backup.created_at)} is loaded into a fresh PostgreSQL instance. ${db.name} is untouched, and nothing is attached to the copy until you say so.`}
      onClose={onClose}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field
          label="Name"
          hint={taken ? <span className="text-destructive">A database with this name already exists in the project.</span> : undefined}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} aria-invalid={taken || undefined} />
        </Field>
        <Field label="Machine" hint="Permanent, like any database placement.">
          <Select value={machine} onChange={(e) => setMachine(e.target.value)}>
            {hosts.ready.map((m) => (
              <option value={m.id} key={m.id}>
                {m.report.hostname}
                {m.id === db.machine_id ? " · same as source" : ""}
              </option>
            ))}
            {hosts.ready.every((m) => m.id !== db.machine_id) && db.machine_id && (
              <option value={db.machine_id}>Same machine as {db.name}</option>
            )}
          </Select>
        </Field>
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" isLoading={busy} disabled={taken || !name.trim()}>
            {!busy && <Download />}
            Restore copy
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function nextRun(at: number): string {
  const s = (at - Date.now()) / 1000;
  if (s <= 0) return "shortly";
  if (s < 3600) return `in ${Math.ceil(s / 60)}m`;
  return `in ${Math.round(s / 3600)}h`;
}

function duration(from: string, to: string): string {
  const s = Math.max(0, (Date.parse(to) - Date.parse(from)) / 1000);
  return s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}
