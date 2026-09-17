import { useMemo, useState, type ReactNode } from "react";
import { ArrowRight, Database, Plus } from "lucide-react";
import type { DatabaseInstance, Snapshot } from "../../lib/data";
import { cn } from "../../lib/utils";
import { Curtain, Reveal } from "../fleet/primitives";
import { ProjectMark, ago, projectHues } from "../project-summary";
import { Button } from "../ui/button";
import { Meta, StatusDot } from "../ui/misc";
import {
  attachedServices,
  databaseHosts,
  healthOf,
  phaseLabel,
  placementOf,
  reportsBindings,
  type DatabaseHosts,
} from "./model";
import { ProvisionDatabase } from "./provision";

/**
 * Every database in the workspace, grouped by project. Rows are dense on
 * purpose: health, where it lives, who reads it, and when it was last proven
 * to answer a query. Anything deeper is one click into the database page.
 */
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
  const hues = useMemo(() => projectHues(data.projects), [data.projects]);
  const databases = data.databases.filter((d) => !projectId || d.project_id === projectId);
  const groups = useMemo(() => {
    const byProject = new Map<string, DatabaseInstance[]>();
    for (const d of databases) byProject.set(d.project_id, [...(byProject.get(d.project_id) ?? []), d]);
    return data.projects
      .filter((p) => byProject.has(p.id))
      .map((p) => ({ project: p, databases: sortByAttention(byProject.get(p.id)!) }));
  }, [data.projects, databases]);
  const hosts = databaseHosts(data);
  const healthy = databases.filter((d) => healthOf(d).key === "healthy").length;
  const attention = databases.filter((d) => healthOf(d).tone === "attention").length;
  const busy = databases.filter((d) => healthOf(d).active).length;
  const other = databases.length - healthy - attention - busy;
  // Counts as they are: "All healthy" only when every database has been verified.
  const status: ReactNode[] = [];
  if (attention > 0)
    status.push(
      <span key="attention" className="text-destructive">
        {attention} need{attention === 1 ? "s" : ""} attention
      </span>,
    );
  if (busy > 0) status.push(`${busy} in progress`);
  if (healthy > 0) status.push(healthy === databases.length ? "All healthy" : `${healthy} healthy`);
  if (other > 0) status.push(`${other} unknown`);
  const machinesUsed = new Set(databases.map((d) => d.machine_id).filter(Boolean)).size;
  const canProvision = live && data.projects.length > 0;

  return (
    <div className="flex flex-col gap-4">
      {!projectId && (
        <Reveal className="gh-surface relative overflow-hidden rounded-lg">
          <Curtain className="text-primary" />
          <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 px-5 py-4">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="gh-eyebrow">Databases</span>
              <h1 className="text-lg font-semibold tracking-tight">
                {databases.length === 0
                  ? "PostgreSQL, on your machines"
                  : `${databases.length} database${databases.length === 1 ? "" : "s"} on ${machinesUsed} machine${machinesUsed === 1 ? "" : "s"}`}
              </h1>
              <p className="text-sm text-muted-foreground">
                {databases.length === 0 ? (
                  "Each database is pinned to one machine and one volume; it never moves on its own."
                ) : (
                  <>
                    {status.map((part, i) => (
                      <span key={i}>
                        {i > 0 && " · "}
                        {part}
                      </span>
                    ))}
                    {" · volumes never relocate"}
                  </>
                )}
              </p>
            </div>
            <Button size="sm" onClick={() => setCreating(true)} disabled={!canProvision}>
              <Plus />
              New database
            </Button>
          </header>
        </Reveal>
      )}

      {databases.length === 0 ? (
        <Reveal delay={0.05}>
          <EmptyDatabases
            hasProjects={data.projects.length > 0}
            hosts={hosts}
            live={live}
            inProject={Boolean(projectId)}
            onCreate={() => setCreating(true)}
            onMachines={onNavigate ? () => onNavigate("Machines") : undefined}
          />
        </Reveal>
      ) : (
        <div className="flex flex-col gap-3">
          {projectId && (
            <div className="flex items-center justify-end">
              <Button size="sm" variant="outline" onClick={() => setCreating(true)} disabled={!canProvision}>
                <Plus />
                New database
              </Button>
            </div>
          )}
          {groups.map(({ project, databases: rows }, gi) => (
            <Reveal key={project.id} delay={0.05 + gi * 0.04} className="gh-surface overflow-hidden rounded-lg">
              {!projectId && (
                <div className="flex items-center gap-2.5 border-b border-border px-4 py-2.5">
                  <ProjectMark name={project.name} hue={hues[project.id]} size={20} />
                  <span className="truncate text-sm font-medium">{project.name}</span>
                  <Meta className="ml-auto shrink-0">
                    {rows.length} database{rows.length === 1 ? "" : "s"}
                  </Meta>
                </div>
              )}
              <ul className="divide-y divide-border">
                {rows.map((d, i) => (
                  <DatabaseRow
                    key={d.id}
                    data={data}
                    db={d}
                    delay={0.08 + gi * 0.04 + i * 0.03}
                    onOpen={() => onOpen(d.id)}
                  />
                ))}
              </ul>
            </Reveal>
          ))}
        </div>
      )}

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

/** Problems first, then in-flight work, then the healthy majority by name. */
function sortByAttention(rows: DatabaseInstance[]): DatabaseInstance[] {
  const rank = (d: DatabaseInstance) => {
    const h = healthOf(d);
    return h.tone === "attention" ? 0 : h.active ? 1 : 2;
  };
  return [...rows].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

function DatabaseRow({
  data,
  db,
  delay,
  onOpen,
}: {
  data: Snapshot;
  db: DatabaseInstance;
  delay: number;
  onOpen: () => void;
}) {
  const health = healthOf(db);
  const placement = placementOf(data, db);
  const readers = attachedServices(data, db);
  const phase = phaseLabel(db);
  const detail =
    health.tone === "attention"
      ? db.error || health.label
      : phase ?? (db.last_verified_at ? `answered a query ${ago(db.last_verified_at)}` : "not verified yet");

  return (
    <Reveal as="li" delay={delay}>
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          "gh-interactive group grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-3 text-left",
          "sm:grid-cols-[auto_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto]",
        )}
      >
        <StatusDot status={health.dot} className={cn(health.active && "animate-pulse")} title={health.label} />
        <span className="flex min-w-0 flex-col">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium">{db.name}</span>
            <span className={cn("shrink-0 text-xs", health.tone === "attention" ? "text-destructive" : "text-muted-foreground")}>
              {health.label}
            </span>
          </span>
          <span
            className={cn(
              "truncate text-xs",
              health.tone === "attention" ? "text-destructive/80" : "text-muted-foreground",
            )}
          >
            {detail}
          </span>
        </span>
        <span className="col-start-2 flex min-w-0 flex-col sm:col-start-auto">
          <span className="gh-eyebrow">machine</span>
          <span className={cn("truncate text-sm", placement.orphaned && "text-destructive")}>{placement.label}</span>
        </span>
        <span className="col-start-2 flex min-w-0 flex-col sm:col-start-auto">
          <span className="gh-eyebrow">read by</span>
          <span className="truncate text-sm">
            {!reportsBindings(data) ? (
              <span className="text-muted-foreground">-</span>
            ) : readers.length === 0 ? (
              <span className="text-muted-foreground">nothing yet</span>
            ) : (
              readers.map((s) => s.name).join(", ")
            )}
          </span>
        </span>
        <ArrowRight className="col-start-3 row-start-1 size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none sm:col-start-auto sm:row-start-auto" />
      </button>
    </Reveal>
  );
}

function EmptyDatabases({
  hasProjects,
  hosts,
  live,
  inProject,
  onCreate,
  onMachines,
}: {
  hasProjects: boolean;
  hosts: DatabaseHosts;
  live: boolean;
  inProject: boolean;
  onCreate: () => void;
  onMachines?: () => void;
}) {
  const steps: { label: string; done: boolean; action?: { label: string; run?: () => void } }[] = [
    { label: "Create a project", done: hasProjects },
    {
      label: "Give a machine the database role",
      done: hosts.assigned.length > 0,
      action: onMachines ? { label: "Open Machines", run: onMachines } : undefined,
    },
    {
      label: "Provision PostgreSQL",
      done: false,
      action: { label: "New database", run: hasProjects && !hosts.blocked && live ? onCreate : undefined },
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
            PostgreSQL 17 runs as a container on one of your machines with a persistent volume. dinghy generates the
            credentials, keeps them sealed, and hands services a <code className="font-mono text-xs">DATABASE_URL</code> when
            you attach them. Placement is permanent: a database never moves between machines on its own.
          </p>
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
                  s.done ? "border-primary/40 bg-primary/15 text-primary" : i === next ? "border-primary text-primary" : "border-border text-muted-foreground",
                )}
              >
                {s.done ? "✓" : i + 1}
              </span>
              <span className={cn("min-w-0 flex-1", s.done && "line-through decoration-border")}>{s.label}</span>
              {!s.done && i === next && s.action && (
                <Button size="xs" variant={i === 2 ? "default" : "outline"} onClick={s.action.run} disabled={!s.action.run}>
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
          {hosts.assigned.map((m) => m.report.hostname).join(", ")} {hosts.assigned.length === 1 ? "has" : "have"} the
          database role but {hosts.assigned.length === 1 ? "is" : "are"} not ready to host yet. Finish connecting the
          runtime in Machines.
        </p>
      )}
    </div>
  );
}
