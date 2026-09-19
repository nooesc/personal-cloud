import { useMemo, useState, type ReactNode } from "react";
import { ArrowRight, Database, Link2, Plus, Server } from "lucide-react";
import type {
  DatabaseInstance,
  Project,
  ProviderResource,
  Snapshot,
} from "../../lib/data";
import { cn } from "../../lib/utils";
import { Curtain, Reveal } from "../fleet/primitives";
import { ProjectMark, ago, projectHues } from "../project-summary";
import { Button } from "../ui/button";
import { Eyebrow, Meta, StatusDot } from "../ui/misc";
import { ENGINES, EngineMark, engineMix, hostOf, type Engine } from "./engine";
import {
  attachedServices,
  databaseHosts,
  engineLabel,
  healthOf,
  phaseLabel,
  placementOf,
  reportsBindings,
  type DatabaseHosts,
} from "./model";
import {
  ProviderAccounts,
  ProviderDialogs,
  type ProviderDialog,
} from "./providers";
import { ProvisionDatabase } from "./provision";

/*
 * Every backend a project reads, in one ledger: PostgreSQL pinned to a fleet
 * machine and hosted resources linked from Neon or Convex sit side by side
 * under the project that owns them. Rows are dense on purpose: what engine,
 * where it runs, who reads it, and when access was last proven. Anything
 * deeper is one click into the database page or the resource dialog.
 */

/**
 * One column template for the heads and every row so cells line up across
 * bands: dot | identity | runs on | read by | verified | chevron. Below `sm`
 * the middle columns fold into the identity cell.
 */
const ROW_GRID =
  "grid grid-cols-[0.5rem_minmax(0,1fr)_1rem] items-center gap-x-3 sm:grid-cols-[0.5rem_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_5.5rem_1rem] sm:gap-x-4";
/** The band's project identity beside its rows; grows a little on very wide screens. */
const BAND_GRID =
  "lg:grid-cols-[minmax(11rem,15rem)_minmax(0,1fr)] 2xl:grid-cols-[minmax(13rem,18rem)_minmax(0,1fr)]";

type Row =
  | { kind: "fleet"; key: string; db: DatabaseInstance }
  | { kind: "linked"; key: string; r: ProviderResource };

type Band = {
  key: string;
  project: Project | undefined;
  rows: Row[];
};

export function Databases({
  data,
  live,
  refresh,
  projectId,
  onOpen,
  onNavigate,
}: {
  data: Snapshot;
  live: boolean;
  refresh: () => Promise<unknown>;
  /** Restricts the list to one project (the project tab). */
  projectId?: string;
  onOpen: (id: string) => void;
  onNavigate?: (page: "Machines") => void;
}) {
  const [creating, setCreating] = useState(false);
  const [dialog, setDialog] = useState<ProviderDialog | null>(null);
  const hues = useMemo(() => projectHues(data.projects), [data.projects]);
  const databases = data.databases.filter(
    (d) => !projectId || d.project_id === projectId,
  );
  const linked = (data.database_providers?.resources ?? []).filter(
    (r) => !projectId || r.project_id === projectId,
  );
  const byProject = new Map<string, Row[]>();
  const push = (id: string, row: Row) =>
    byProject.set(id, [...(byProject.get(id) ?? []), row]);
  for (const db of databases)
    push(db.project_id, { kind: "fleet", key: `db:${db.id}`, db });
  for (const r of linked)
    push(r.project_id, { kind: "linked", key: `link:${r.id}`, r });
  const bands: Band[] = data.projects
    .filter((p) => byProject.has(p.id))
    .map((p) => ({
      key: p.id,
      project: p,
      rows: sortByAttention(byProject.get(p.id)!),
    }));
  // Rows whose project was removed stay visible rather than vanishing.
  const orphans = [...byProject]
    .filter(([id]) => !data.projects.some((p) => p.id === id))
    .flatMap(([, rows]) => rows);
  if (orphans.length)
    bands.push({
      key: "orphans",
      project: undefined,
      rows: sortByAttention(orphans),
    });

  const total = databases.length + linked.length;
  const machinesUsed = data.machines.filter((m) =>
    databases.some((d) => d.machine_id === m.id),
  ).length;
  const hosts = databaseHosts(data);
  const accounts = data.database_providers?.accounts ?? [];
  const canProvision = live && data.projects.length > 0;
  const canLink = live && accounts.length > 0 && data.projects.length > 0;
  const canSelfHost = live && data.projects.length > 0;

  if (!data.generated_at) return <LoadingLedger />;

  // Self-hosted control planes without provider support report no state; offer only fleet PostgreSQL there.
  const providers = Boolean(data.database_providers);
  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      {providers && (
        <>
          <Button
            size="sm"
            variant="outline"
            disabled={!canLink}
            title={
              !accounts.length
                ? "Connect a Neon or Convex account first"
                : undefined
            }
            onClick={() => setDialog({ kind: "link" })}
          >
            <Link2 />
            Link resource
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!canSelfHost}
            onClick={() => setDialog({ kind: "self" })}
          >
            <Server />
            Self-hosted Convex
          </Button>
        </>
      )}
      <Button
        size="sm"
        disabled={!canProvision}
        onClick={() => setCreating(true)}
      >
        <Plus />
        New database
      </Button>
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      {projectId ? (
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <Summary
            databases={databases}
            linked={linked}
            machines={machinesUsed}
            projects={bands.length}
            inProject
          />
          {actions}
        </div>
      ) : (
        <Reveal className="gh-surface relative overflow-hidden rounded-lg">
          <Curtain className="text-primary" />
          <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 px-4 py-4 sm:px-5">
            <div className="flex min-w-0 flex-col gap-1">
              <Eyebrow>Databases</Eyebrow>
              <h1 className="text-lg font-semibold tracking-tight">
                {total === 0
                  ? "Your application data, at home"
                  : `${total} backend${total === 1 ? "" : "s"} across ${bands.length} project${bands.length === 1 ? "" : "s"}`}
              </h1>
              <Summary
                databases={databases}
                linked={linked}
                machines={machinesUsed}
                projects={bands.length}
              />
            </div>
            {actions}
          </header>
          <ProviderAccounts
            data={data}
            live={live}
            refresh={refresh}
            className="border-t border-border pb-1"
            onConnect={() => setDialog({ kind: "account" })}
            onRotate={(account) => setDialog({ kind: "rotate", account })}
          />
        </Reveal>
      )}

      {total === 0 ? (
        <Reveal delay={0.05}>
          <EmptyDatabases
            hasProjects={data.projects.length > 0}
            hosts={hosts}
            live={live}
            inProject={Boolean(projectId)}
            providers={providers}
            onCreate={() => setCreating(true)}
            onMachines={onNavigate ? () => onNavigate("Machines") : undefined}
          />
        </Reveal>
      ) : (
        <Reveal
          delay={0.05}
          className="gh-surface flex min-w-0 flex-col rounded-lg"
        >
          <div
            className={cn(
              "hidden gap-x-8 border-b border-border px-4 py-2 sm:grid sm:px-5",
              !projectId && BAND_GRID,
            )}
            aria-hidden
          >
            {!projectId && (
              <Eyebrow className="hidden lg:block">project</Eyebrow>
            )}
            <div className={ROW_GRID}>
              <span />
              <Eyebrow>database</Eyebrow>
              <Eyebrow>runs on</Eyebrow>
              <Eyebrow>read by</Eyebrow>
              <Eyebrow
                className="text-right"
                title="When the control plane last completed an authenticated query or access check"
              >
                verified
              </Eyebrow>
              <span />
            </div>
          </div>
          <div className="flex flex-col divide-y divide-border">
            {bands.map((band, bi) => (
              <ProjectBand
                key={band.key}
                data={data}
                band={band}
                hue={band.project ? hues[band.project.id] : undefined}
                identity={!projectId}
                delay={0.08 + bi * 0.04}
                onOpenDatabase={onOpen}
                onOpenResource={(id) => setDialog({ kind: "resource", id })}
              />
            ))}
          </div>
          <Meta className="border-t border-border px-4 py-2 sm:px-5">
            Fleet PostgreSQL stays on the machine and volume it was created
            with. Linked backends remain with their provider or self-hosted operator.
          </Meta>
        </Reveal>
      )}

      <ProviderDialogs
        data={data}
        live={live}
        refresh={refresh}
        projectId={projectId}
        dialog={dialog}
        onClose={() => setDialog(null)}
      />
      {creating && (
        <ProvisionDatabase
          data={data}
          live={live}
          refresh={refresh}
          projectId={projectId}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            if (id) onOpen(id);
          }}
        />
      )}
    </div>
  );
}

/** Counts as they are: "all healthy" only when every fleet database has been verified. */
function Summary({
  databases,
  linked,
  machines,
  projects,
  inProject = false,
}: {
  databases: DatabaseInstance[];
  linked: ProviderResource[];
  /** Distinct machines still in the workspace that host one of `databases`. */
  machines: number;
  projects: number;
  inProject?: boolean;
}) {
  const parts: ReactNode[] = [];
  const total = databases.length + linked.length;
  if (total === 0) {
    parts.push(
      inProject
        ? "No backends in this project yet"
        : "Each database is pinned to one machine and one volume; it never moves on its own",
    );
  } else {
    if (databases.length)
      parts.push(
        `${databases.length} PostgreSQL on ${machines} machine${machines === 1 ? "" : "s"}`,
      );
    for (const [name, n] of engineMix(linked.map((r) => r.provider)))
      parts.push(`${n} ${name}`);
    const healthy = databases.filter(
      (d) => healthOf(d).key === "healthy",
    ).length;
    const attention =
      databases.filter((d) => healthOf(d).tone === "attention").length +
      linked.filter((r) => r.check_error).length;
    const busy = databases.filter((d) => healthOf(d).active).length;
    if (attention > 0)
      parts.push(
        <span className="text-destructive">
          {attention} need{attention === 1 ? "s" : ""} attention
        </span>,
      );
    if (busy > 0) parts.push(`${busy} in progress`);
    if (healthy > 0 && healthy === databases.length && attention === 0)
      parts.push(linked.length === 0 && (inProject || projects === 1) ? "all healthy" : "fleet PostgreSQL healthy");
    else if (healthy > 0) parts.push(`${healthy} healthy`);
  }
  return (
    <Meta className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      {parts.map((part, i) => (
        <span key={i} className="contents">
          {i > 0 && <span aria-hidden>·</span>}
          <span>{part}</span>
        </span>
      ))}
    </Meta>
  );
}

/** Problems first, then in-flight work, then the rest by name. */
function sortByAttention(rows: Row[]): Row[] {
  const rank = (row: Row) => {
    if (row.kind === "linked") return row.r.check_error ? 0 : 2;
    const h = healthOf(row.db);
    return h.tone === "attention" ? 0 : h.active ? 1 : 2;
  };
  const name = (row: Row) => (row.kind === "fleet" ? row.db.name : row.r.name);
  return [...rows].sort(
    (a, b) => rank(a) - rank(b) || name(a).localeCompare(name(b)),
  );
}

function ProjectBand({
  data,
  band,
  hue,
  identity,
  delay,
  onOpenDatabase,
  onOpenResource,
}: {
  data: Snapshot;
  band: Band;
  hue: number | undefined;
  /** Show the project column; off inside the project tab where it is implied. */
  identity: boolean;
  delay: number;
  onOpenDatabase: (id: string) => void;
  onOpenResource: (id: string) => void;
}) {
  const name = band.project?.name ?? "Project no longer exists";
  const mix = engineMix(
    band.rows.map((row) =>
      row.kind === "fleet" ? "postgresql" : row.r.provider,
    ),
  );
  const attention = band.rows.filter((row) =>
    row.kind === "fleet"
      ? healthOf(row.db).tone === "attention"
      : Boolean(row.r.check_error),
  ).length;
  return (
    <Reveal
      delay={delay}
      className={cn(
        "grid gap-x-8 gap-y-2 px-4 py-3 sm:px-5 lg:gap-y-0",
        identity && BAND_GRID,
      )}
    >
      {identity && (
        <header className="flex min-w-0 items-start gap-3 lg:pt-2">
          <ProjectMark name={name} hue={hue} size={32} />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span
              className={cn(
                "truncate text-[15px] font-semibold leading-tight tracking-tight",
                !band.project && "text-muted-foreground",
              )}
              title={name}
            >
              {name}
            </span>
            <Meta>
              {mix.map(([engine, n]) => `${n} ${engine}`).join(" · ")}
            </Meta>
            {attention > 0 && (
              <Meta className="text-destructive">
                {attention} need{attention === 1 ? "s" : ""} attention
              </Meta>
            )}
          </div>
        </header>
      )}
      <ul className="flex min-w-0 flex-col divide-y divide-border/60">
        {band.rows.map((row) =>
          row.kind === "fleet" ? (
            <FleetRow
              key={row.key}
              data={data}
              db={row.db}
              onOpen={() => onOpenDatabase(row.db.id)}
            />
          ) : (
            <LinkedRow
              key={row.key}
              data={data}
              r={row.r}
              onOpen={() => onOpenResource(row.r.id)}
            />
          ),
        )}
      </ul>
    </Reveal>
  );
}

/** The shared row chrome; each engine fills the cells with its own facts. */
function LedgerRow({
  engine,
  dot,
  pulse = false,
  name,
  status,
  attention = false,
  subline,
  runsOn,
  runsOnAttention = false,
  readBy,
  verified,
  onOpen,
}: {
  engine: Engine;
  dot: string;
  pulse?: boolean;
  name: string;
  status: string;
  attention?: boolean;
  subline: string;
  runsOn: string;
  runsOnAttention?: boolean;
  readBy: ReactNode;
  verified: string;
  onOpen: () => void;
}) {
  return (
    <li className="py-0.5 first:pt-0 last:pb-0">
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          ROW_GRID,
          "gh-interactive group -mx-2 w-[calc(100%+1rem)] rounded-md px-2 py-2 text-left",
        )}
      >
        <StatusDot
          status={dot}
          className={cn(pulse && "animate-pulse motion-reduce:animate-none")}
          title={status}
        />
        <span className="flex min-w-0 items-center gap-2.5">
          <EngineMark engine={engine} />
          <span className="flex min-w-0 flex-col">
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="truncate text-sm font-medium" title={name}>
                {name}
              </span>
              <span
                className={cn(
                  "shrink-0 text-xs",
                  attention ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {status}
              </span>
            </span>
            <Meta
              className={cn("truncate", attention && "text-destructive/80")}
              title={subline}
            >
              {subline}
            </Meta>
            <Meta className="break-words whitespace-normal sm:hidden">
              <span className={cn(runsOnAttention && "text-destructive")}>
                {runsOn}
              </span>
              {" · read by "}
              {readBy}
              {" · verified "}
              {verified}
            </Meta>
          </span>
        </span>
        <span
          className={cn(
            "hidden min-w-0 truncate text-sm sm:block",
            runsOnAttention && "text-destructive",
          )}
          title={runsOn}
        >
          {runsOn}
        </span>
        <span className="hidden min-w-0 truncate text-sm sm:block">
          {readBy}
        </span>
        <Meta className="hidden text-right sm:block">{verified}</Meta>
        <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
      </button>
    </li>
  );
}

function Readers({ names }: { names: string[] | null }) {
  if (names === null) return <span className="text-muted-foreground">—</span>;
  if (names.length === 0)
    return <span className="text-muted-foreground">nothing yet</span>;
  return <span title={names.join(", ")}>{names.join(", ")}</span>;
}

function FleetRow({
  data,
  db,
  onOpen,
}: {
  data: Snapshot;
  db: DatabaseInstance;
  onOpen: () => void;
}) {
  const health = healthOf(db);
  const placement = placementOf(data, db);
  const attention = health.tone === "attention";
  const subline = attention
    ? db.error || health.label
    : (phaseLabel(db) ?? `${engineLabel(db)} · fleet`);
  return (
    <LedgerRow
      engine="postgresql"
      dot={health.dot}
      pulse={health.active}
      name={db.name}
      status={health.label}
      attention={attention}
      subline={subline}
      runsOn={placement.label}
      runsOnAttention={placement.orphaned}
      readBy={
        <Readers
          names={
            reportsBindings(data)
              ? attachedServices(data, db).map((s) => s.name)
              : null
          }
        />
      }
      verified={db.last_verified_at ? ago(db.last_verified_at) : "not yet"}
      onOpen={onOpen}
    />
  );
}

function LinkedRow({
  data,
  r,
  onOpen,
}: {
  data: Snapshot;
  r: ProviderResource;
  onOpen: () => void;
}) {
  const state = data.database_providers!;
  const readers = state.bindings
    .filter((b) => b.resource_id === r.id)
    .map(
      (b) =>
        data.services.find((s) => s.id === b.service_id)?.name ??
        "removed service",
    );
  const attention = Boolean(r.check_error);
  let subline: string;
  let runsOn: string;
  switch (r.provider) {
    case "neon":
      subline = [
        ENGINES.neon.label,
        r.database_name,
        r.role_name && `role ${r.role_name}`,
      ]
        .filter(Boolean)
        .join(" · ");
      runsOn = r.address ?? "Neon";
      break;
    case "convex":
      subline = [ENGINES.convex.label, r.environment]
        .filter(Boolean)
        .join(" · ");
      runsOn = r.deployment ?? "Convex Cloud";
      break;
    case "convex_self_hosted": {
      const machine = r.runtime
        ? data.machines.find((m) => m.id === r.runtime!.machine_id)
        : undefined;
      subline = [ENGINES.convex_self_hosted.label, hostOf(r.url)]
        .filter(Boolean)
        .join(" · ");
      runsOn = machine
        ? machine.report.hostname
        : r.runtime
          ? "Machine no longer in workspace"
          : (hostOf(r.url) ?? "your hardware");
      break;
    }
  }
  return (
    <LedgerRow
      engine={r.provider}
      dot={attention ? "failed" : "healthy"}
      name={r.name}
      status={attention ? "Needs attention" : "Access verified"}
      attention={attention}
      subline={subline}
      runsOn={runsOn}
      runsOnAttention={
        Boolean(r.runtime) && runsOn === "Machine no longer in workspace"
      }
      readBy={<Readers names={readers} />}
      verified={ago(r.checked_at)}
      onOpen={onOpen}
    />
  );
}

/** The ledger's shape while the first snapshot is still on its way. */
function LoadingLedger() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="gh-surface flex flex-col rounded-lg"
    >
      <div className="flex flex-col gap-2 border-b border-border px-4 py-4 sm:px-5">
        <Eyebrow>Databases</Eyebrow>
        <span className="h-5 w-56 max-w-full animate-pulse rounded-sm bg-muted motion-reduce:animate-none" />
        <span className="h-3 w-80 max-w-full animate-pulse rounded-sm bg-muted/70 motion-reduce:animate-none" />
      </div>
      <ul className="flex flex-col divide-y divide-border/60 px-4 sm:px-5">
        {[0, 1, 2].map((i) => (
          <li key={i} className="flex items-center gap-3 py-3">
            <span className="size-2 rounded-full bg-muted" />
            <span className="size-[26px] rounded-[4px] bg-muted" />
            <span
              className="h-4 animate-pulse rounded-sm bg-muted motion-reduce:animate-none"
              style={{ width: `${34 - i * 6}%` }}
            />
          </li>
        ))}
      </ul>
      <span className="sr-only">
        Loading your databases and connected backends…
      </span>
    </div>
  );
}

function EmptyDatabases({
  hasProjects,
  hosts,
  live,
  inProject,
  providers,
  onCreate,
  onMachines,
}: {
  hasProjects: boolean;
  hosts: DatabaseHosts;
  live: boolean;
  inProject: boolean;
  /** Whether this control plane can link Neon and Convex backends. */
  providers: boolean;
  onCreate: () => void;
  onMachines?: () => void;
}) {
  const steps: {
    label: string;
    done: boolean;
    action?: { label: string; run?: () => void };
  }[] = [
    { label: "Create a project", done: hasProjects },
    {
      label: "Give a machine the database role",
      done: hosts.assigned.length > 0,
      action: onMachines
        ? { label: "Open Machines", run: onMachines }
        : undefined,
    },
    {
      label: "Provision PostgreSQL",
      done: false,
      action: {
        label: "New database",
        run: hasProjects && !hosts.blocked && live ? onCreate : undefined,
      },
    },
  ];
  const next = steps.findIndex((s) => !s.done);
  return (
    <div className="gh-surface relative overflow-hidden rounded-lg">
      <div className="grid gap-6 p-5 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] md:p-6">
        <div className="flex flex-col gap-2">
          <div className="flex size-9 items-center justify-center rounded-md border border-border bg-background/60">
            <Database className="size-4 text-muted-foreground" />
          </div>
          <h2 className="mt-1 text-base font-semibold tracking-tight">
            {inProject ? "No database in this project yet" : "No databases yet"}
          </h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            PostgreSQL 17 runs as a container on one of your machines with a
            persistent volume. dinghy generates the credentials, keeps them
            sealed, and hands services a{" "}
            <code className="font-mono text-xs">DATABASE_URL</code> when you
            attach them. Placement is permanent: a database never moves between
            machines on its own.
          </p>
          {providers && (
            <p className="max-w-prose text-sm text-muted-foreground">
              Already running elsewhere? Link a Neon database or Convex
              deployment, or connect a self-hosted Convex backend, and it
              appears in the same ledger.
            </p>
          )}
        </div>
        <ol className="flex flex-col gap-1.5">
          {steps.map((s, i) => (
            <li
              key={s.label}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm",
                i === next ? "bg-primary/[0.06]" : "",
                s.done ? "text-muted-foreground" : "",
              )}
            >
              <span
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full border font-mono text-[11px]",
                  s.done
                    ? "border-primary/40 bg-primary/15 text-primary"
                    : i === next
                      ? "border-primary text-primary"
                      : "border-border text-muted-foreground",
                )}
              >
                {s.done ? "✓" : i + 1}
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1",
                  s.done && "line-through decoration-border",
                )}
              >
                {s.label}
              </span>
              {!s.done && i === next && s.action && (
                <Button
                  size="xs"
                  variant={i === 2 ? "default" : "outline"}
                  onClick={s.action.run}
                  disabled={!s.action.run}
                >
                  {s.label === "Provision PostgreSQL" && <Plus />}
                  {s.action.label}
                  {i !== 2 && <ArrowRight />}
                </Button>
              )}
            </li>
          ))}
        </ol>
      </div>
      {hosts.assigned.length > 0 && hosts.blocked && (
        <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground md:px-6">
          {hosts.assigned.map((m) => m.report.hostname).join(", ")}{" "}
          {hosts.assigned.length === 1 ? "has" : "have"} the database role but{" "}
          {hosts.assigned.length === 1 ? "is" : "are"} not ready to host yet.
          Finish connecting the runtime in Machines.
        </p>
      )}
    </div>
  );
}
