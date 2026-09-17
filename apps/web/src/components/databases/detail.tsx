import { useMemo, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowUpRight, Cable, Eye, EyeOff, HardDrive, Link2, RefreshCw, Server, Trash2 } from "lucide-react";
import { api, type DatabaseInstance, type Service, type Snapshot } from "../../lib/data";
import { hosted } from "../../lib/hosted";
import { cn } from "../../lib/utils";
import { DitherGradient } from "../dither-kit";
import { Reveal } from "../fleet/primitives";
import { ProjectMark, ago, paletteOf, projectHues } from "../project-summary";
import { MACHINE_STATE, capabilityLabel } from "../readiness";
import { Feedback, Secret, useAction } from "../live";
import { Button } from "../ui/button";
import { Dialog, DialogFooter } from "../ui/dialog";
import { Input, Select } from "../ui/input";
import { Meta, StatusDot } from "../ui/misc";
import { DatabaseBackups } from "./backups";
import {
  attachableServices,
  type Health,
  type Placement,
  attachedServices,
  engineLabel,
  healthOf,
  phaseLabel,
  placementOf,
  projectOf,
  reportsBindings,
  stopsOf,
} from "./model";

/**
 * One database, end to end. The header answers "is it fine and where is it";
 * the body is what a person actually comes here to do: read the connection,
 * attach a service, keep copies, or take it down on purpose.
 */
export function DatabaseDetail({
  data,
  live,
  refresh,
  databaseId,
  onBack,
  onOpenDatabase,
  onOpenProject,
  onOpenMachines,
}: {
  data: Snapshot;
  live: boolean;
  refresh: () => Promise<unknown>;
  databaseId: string;
  onBack: () => void;
  onOpenDatabase: (id: string) => void;
  onOpenProject: (projectId: string, service?: string) => void;
  onOpenMachines: () => void;
}) {
  const db = data.databases.find((d) => d.id === databaseId);
  const hues = useMemo(() => projectHues(data.projects), [data.projects]);
  if (!db) return <Gone onBack={onBack} />;

  const project = projectOf(data, db);
  const hue = project ? hues[project.id] : undefined;
  const health = healthOf(db);
  const placement = placementOf(data, db);
  const readers = attachedServices(data, db);

  return (
    <div className="flex flex-col gap-4">
      <Reveal className="gh-surface relative overflow-hidden rounded-lg">
        <DitherGradient from={hue !== undefined ? paletteOf(hue) : "green"} direction="right" cell={3} opacity={0.14} className="w-2/3" />
        <div className="relative flex flex-col gap-4 p-5">
          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
            <div className="flex min-w-0 flex-col gap-2">
              <button
                type="button"
                onClick={onBack}
                className="flex w-fit items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <ArrowLeft className="size-3" />
                Databases
              </button>
              <div className="flex min-w-0 items-center gap-3">
                {project && <ProjectMark name={project.name} hue={hue} size={40} />}
                <div className="flex min-w-0 flex-col">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <h1 className="truncate text-xl font-semibold tracking-tight">{db.name}</h1>
                    <span className={cn("text-sm", toneClass(health.tone))}>{health.label}</span>
                  </span>
                  <Meta className="truncate">
                    {engineLabel(db)}
                    {project && (
                      <>
                        {" · "}
                        <button type="button" onClick={() => onOpenProject(project.id)} className="hover:text-foreground hover:underline">
                          {project.name}
                        </button>
                      </>
                    )}
                    {db.created_at && ` · created ${ago(db.created_at)}`}
                  </Meta>
                </div>
              </div>
            </div>
            <HeaderActions db={db} live={live} refresh={refresh} readers={readers} placement={placement} onRemoved={onBack} />
          </div>
          {(health.active || health.tone === "attention") && <Progress db={db} />}
        </div>
      </Reveal>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <Reveal delay={0.05}>
            <Placement db={db} placement={placement} onOpenMachines={onOpenMachines} />
          </Reveal>
          <Reveal delay={0.1}>
            <Connection db={db} live={live} />
          </Reveal>
        </div>
        <div className="flex flex-col gap-4">
          <Reveal delay={0.08}>
            <Attachments data={data} db={db} live={live} refresh={refresh} readers={readers} onOpenProject={onOpenProject} />
          </Reveal>
          {hosted && (
            <Reveal delay={0.13}>
              <DatabaseBackups data={data} db={db} live={live} refresh={refresh} onOpenDatabase={onOpenDatabase} />
            </Reveal>
          )}
        </div>
      </div>
    </div>
  );
}

const toneClass = (tone: Health["tone"]) =>
  tone === "attention" ? "text-destructive" : tone === "healthy" ? "text-primary" : "text-muted-foreground";

function HeaderActions({
  db,
  live,
  refresh,
  readers,
  placement,
  onRemoved,
}: {
  db: DatabaseInstance;
  live: boolean;
  refresh: () => Promise<unknown>;
  readers: Service[];
  placement: Placement;
  onRemoved: () => void;
}) {
  const action = useAction();
  const health = healthOf(db);
  const [removing, setRemoving] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {health.retryable && (
        <Button
          size="sm"
          variant="outline"
          disabled={!live || action.busy}
          isLoading={action.busy}
          onClick={() =>
            action.run(async () => {
              await api(`/databases/${db.id}/retry`, {});
              await refresh();
            }, `Restarting PostgreSQL on ${placement.label}`)
          }
        >
          {!action.busy && <RefreshCw />}
          Retry on {placement.machine ? placement.machine.report.hostname : "its machine"}
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        className="text-destructive hover:text-destructive"
        disabled={!live || action.busy || health.key === "deleting"}
        onClick={() => setRemoving(true)}
      >
        <Trash2 />
        Remove
      </Button>
      <Feedback action={action} />
      {removing && (
        <RemoveDialog db={db} readers={readers} placement={placement} refresh={refresh} onClose={() => setRemoving(false)} onRemoved={onRemoved} />
      )}
    </div>
  );
}

/** Three stops plus the controller's own words; the failure reason sits where the failure happened. */
function Progress({ db }: { db: DatabaseInstance }) {
  const stops = stopsOf(db);
  const phase = phaseLabel(db);
  const health = healthOf(db);
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-background/60 p-3">
      <ol className="grid grid-cols-3 gap-2" aria-label="Provisioning progress">
        {stops.map((s, i) => (
          <li key={s.key} className="flex flex-col gap-1.5">
            <span
              className={cn(
                "h-1 rounded-full transition-colors",
                s.state === "done" && "bg-primary",
                s.state === "active" && "animate-pulse bg-primary/60",
                s.state === "failed" && "bg-destructive",
                s.state === "todo" && "bg-border",
              )}
            />
            <span className={cn("text-xs", s.state === "todo" ? "text-muted-foreground" : s.state === "failed" ? "text-destructive" : "text-foreground")}>
              {i + 1}. {s.label}
            </span>
          </li>
        ))}
      </ol>
      <p className={cn("text-sm", health.tone === "attention" ? "text-destructive" : "text-muted-foreground")}>
        {health.tone === "attention"
          ? db.error || `${health.label}. Retry keeps the same machine and volume.`
          : phase ?? `${health.label}…`}
      </p>
    </div>
  );
}

function Placement({
  db,
  placement,
  onOpenMachines,
}: {
  db: DatabaseInstance;
  placement: Placement;
  onOpenMachines: () => void;
}) {
  const m = placement.machine;
  const cap = placement.capability;
  return (
    <section className="gh-surface flex flex-col rounded-lg" aria-label="Placement">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <span className="flex flex-col">
          <span className="gh-eyebrow">Machine</span>
          <span className={cn("text-sm font-medium", placement.orphaned && "text-destructive")}>{placement.label}</span>
        </span>
        {m && (
          <Button size="xs" variant="outline" onClick={onOpenMachines}>
            Machines
            <ArrowUpRight />
          </Button>
        )}
      </header>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 px-4 py-3 text-sm">
        {m && (
          <>
            <Row label="Status">
              <span className="flex items-center gap-2">
                <StatusDot status={cap ? MACHINE_STATE[cap.state].dot : m.status} />
                {capabilityLabel(cap)}
              </span>
            </Row>
            <Row label="Where">
              {m.location} · {m.report.architecture} · {m.report.os}
            </Row>
          </>
        )}
        {db.address && (
          <Row label="Private address">
            <span className="font-mono text-xs">
              {db.address}
              {db.port ? `:${db.port}` : ""}
            </span>
          </Row>
        )}
        {db.volume_name && (
          <Row label="Volume">
            <span className="flex items-center gap-1.5 font-mono text-xs">
              <HardDrive className="size-3 text-muted-foreground" />
              {db.volume_name}
            </span>
          </Row>
        )}
        {db.last_verified_at && <Row label="Last verified">{ago(db.last_verified_at)}</Row>}
      </dl>
      <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
        {placement.orphaned
          ? "The machine that owns this volume is no longer in the workspace. Re-enrol it to recover the data; dinghy never moves a volume elsewhere."
          : "Pinned here for life. Data lives on this machine's volume and is never moved automatically; removing the database keeps the volume for explicit recovery."}
      </p>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate">{children}</dd>
    </>
  );
}

function Connection({ db, live }: { db: DatabaseInstance; live: boolean }) {
  const action = useAction();
  const [secret, setSecret] = useState<string>();
  const health = healthOf(db);
  const restoring = health.key === "restoring" || health.key === "restore_failed";
  return (
    <section className="gh-surface flex flex-col rounded-lg" aria-label="Connection">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <span className="flex flex-col">
          <span className="gh-eyebrow">Connection</span>
          <span className="text-sm font-medium">Sealed credentials</span>
        </span>
        <Button
          size="xs"
          variant="outline"
          disabled={!live || action.busy || restoring || health.active}
          isLoading={action.busy}
          onClick={() => {
            if (secret) {
              setSecret(undefined);
              return;
            }
            void action.run(async () => {
              const result = await api<Record<string, string>>(`/databases/${db.id}/connection`);
              setSecret(result.connection_string ?? result.database_url ?? result.url ?? JSON.stringify(result));
            }, "");
          }}
        >
          {secret ? <EyeOff /> : <Eye />}
          {secret ? "Hide" : "Reveal"}
        </Button>
      </header>
      <div className="flex flex-col gap-3 px-4 py-3">
        {secret ? (
          <Secret value={secret} />
        ) : (
          <p className="text-sm text-muted-foreground">
            {restoring
              ? "The connection string is withheld until the restore has succeeded."
              : health.active
                ? "Available once PostgreSQL answers an authenticated query."
                : "A postgresql:// URL on the private fleet network. Attached services receive it as DATABASE_URL on their next deploy; reveal it here for anything else."}
          </p>
        )}
        <Feedback action={action} />
      </div>
    </section>
  );
}

function Attachments({
  data,
  db,
  live,
  refresh,
  readers,
  onOpenProject,
}: {
  data: Snapshot;
  db: DatabaseInstance;
  live: boolean;
  refresh: () => Promise<unknown>;
  readers: Service[];
  onOpenProject: (projectId: string, service?: string) => void;
}) {
  const action = useAction();
  const candidates = attachableServices(data, db);
  const free = candidates.filter((c) => !c.bound);
  const [choice, setChoice] = useState("");
  const selected = choice || free[0]?.service.id || "";
  const healthy = healthOf(db).key === "healthy";
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const service = data.services.find((s) => s.id === selected);
    if (!service) return;
    await action.run(async () => {
      await api(`/databases/${db.id}/attach`, { service_id: service.id });
      await refresh();
      setChoice("");
    }, `${service.name} reads ${db.name} from its next deploy`);
  }
  return (
    <section className="gh-surface flex flex-col rounded-lg" aria-label="Attached services">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <span className="flex flex-col">
          <span className="gh-eyebrow">Read by</span>
          <span className="text-sm font-medium">
            {!reportsBindings(data)
              ? "Attachments not reported"
              : readers.length === 0
                ? "No services yet"
                : `${readers.length} service${readers.length === 1 ? "" : "s"}`}
          </span>
        </span>
        <Cable className="size-4 text-muted-foreground" />
      </header>
      {readers.length > 0 && (
        <ul className="divide-y divide-border">
          {readers.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => onOpenProject(s.project_id, s.id)}
                className="gh-interactive flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm"
              >
                <StatusDot status={s.status ?? "idle"} />
                <span className="min-w-0 flex-1 truncate">{s.name}</span>
                <Meta className="shrink-0">DATABASE_URL</Meta>
                <ArrowUpRight className="size-3.5 text-muted-foreground" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-col gap-2 border-t border-border px-4 py-3">
        {candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {readers.length ? "Every service in this project is attached." : "Add a service to the project to attach it."}
          </p>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Select size="sm" value={selected} onChange={(e) => setChoice(e.target.value)} aria-label="Service to attach" disabled={free.length === 0}>
              {candidates.map(({ service, bound }) => (
                <option key={service.id} value={service.id} disabled={Boolean(bound)}>
                  {service.name}
                  {bound ? ` · reads ${bound.name}` : ""}
                </option>
              ))}
            </Select>
            <Button type="submit" size="sm" variant="outline" className="shrink-0" isLoading={action.busy} disabled={!live || !healthy || !selected || free.length === 0}>
              {!action.busy && <Link2 />}
              Attach
            </Button>
          </form>
        )}
        <Meta>
          {!healthy
            ? "Attach once the database is healthy."
            : "A service reads one database; the link holds until the database is removed."}
        </Meta>
        <Feedback action={action} />
      </div>
    </section>
  );
}

function RemoveDialog({
  db,
  readers,
  placement,
  refresh,
  onClose,
  onRemoved,
}: {
  db: DatabaseInstance;
  readers: Service[];
  placement: Placement;
  refresh: () => Promise<unknown>;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const action = useAction();
  const [typed, setTyped] = useState("");
  const ready = typed.trim() === db.name;
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ready) return;
    await action.run(async () => {
      await api(`/databases/${db.id}`, undefined, "DELETE");
      await refresh();
      onRemoved();
    }, `${db.name} is being removed; its volume stays on ${placement.label}`);
  }
  return (
    <Dialog title={`Remove ${db.name}?`} onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <ul className="flex flex-col gap-2 text-sm">
          <li className="flex items-start gap-2">
            <Server className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span>
              PostgreSQL stops on <span className="font-medium">{placement.label}</span>. Its volume
              {db.volume_name && (
                <>
                  {" "}
                  <code className="font-mono text-xs">{db.volume_name}</code>
                </>
              )}{" "}
              is kept there for explicit recovery; nothing is deleted from disk.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <Cable className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span>
              {readers.length === 0
                ? "No services are attached."
                : `${readers.map((s) => s.name).join(", ")} ${readers.length === 1 ? "loses" : "lose"} DATABASE_URL on ${readers.length === 1 ? "its" : "their"} next deploy.`}
            </span>
          </li>
          {hosted && (
            <li className="flex items-start gap-2">
              <HardDrive className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span>Retained backup copies block removal; delete them first if the request is refused.</span>
            </li>
          )}
        </ul>
        <label className="flex flex-col gap-1.5 text-sm">
          <span>
            Type <span className="font-mono font-medium">{db.name}</span> to confirm
          </span>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} aria-invalid={typed.length > 0 && !ready ? true : undefined} />
        </label>
        <Feedback action={action} />
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Keep it
          </Button>
          <Button type="submit" variant="destructive" size="sm" isLoading={action.busy} disabled={!ready}>
            {!action.busy && <Trash2 />}
            Remove database
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function Gone({ onBack }: { onBack: () => void }) {
  return (
    <Reveal className="gh-surface flex flex-col items-start gap-3 rounded-lg p-5">
      <span className="gh-eyebrow">Database</span>
      <h1 className="text-lg font-semibold tracking-tight">Not in this workspace</h1>
      <p className="max-w-prose text-sm text-muted-foreground">
        It was removed, or the link points at another workspace. Removed databases keep their volume on the original machine.
      </p>
      <Button size="sm" variant="outline" onClick={onBack}>
        <ArrowLeft />
        All databases
      </Button>
    </Reveal>
  );
}
