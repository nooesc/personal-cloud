import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Cloud,
  ExternalLink,
  GitBranch,
  GitFork,
  Plus,
  Rocket,
} from "lucide-react";
import type { CloudflareOverview, Deployment, Project } from "../lib/data";
import { cn } from "../lib/utils";
import { DitherGradient, Sparkline, type DitherColor } from "./dither-kit";
import type { LiveProps } from "./live";
import { ProjectTabs, RemoveProject, projectTabs, type ProjectTab } from "./project";
import { LinkRepository, imported } from "./project-resources";
import {
  CHANGE_DAYS,
  EnvironmentChips,
  ProjectMark,
  USAGE_HOURS,
  ago,
  count,
  kindsLabel,
  paletteOf,
  summarize,
} from "./project-summary";
import { checkedLabel } from "./readiness";
import { Button } from "./ui/button";
import { Eyebrow, Meta, StatusDot } from "./ui/misc";

const EMPTY_USAGE = new Array<number>(USAGE_HOURS).fill(0);
const EMPTY_CHANGES = new Array<number>(CHANGE_DAYS).fill(0);

/**
 * One project, end to end: identity and addresses up top, what it is made
 * of below, and what happened lately beside it. Everything renders from the
 * workspace snapshot; the Cloudflare overview fills in addresses, traffic
 * and change history when the account is connected.
 */
export function ProjectPage({
  project,
  data,
  overview,
  hue,
  live,
  refresh,
  tab,
  onTab,
  serviceId,
  onService,
  addService,
  onRemoved,
  onOrganize,
  onOpenDatabase,
}: {
  project: Project;
  overview?: CloudflareOverview;
  hue: number;
  tab?: ProjectTab;
  onTab: (tab: ProjectTab) => void;
  serviceId?: string;
  onService: (id: string | undefined) => void;
  addService: () => void;
  onRemoved: () => void;
  onOrganize?: () => void;
  onOpenDatabase: (id: string) => void;
} & LiveProps) {
  const s = summarize(data, project, overview);
  const noRepo = imported(project);
  const [linking, setLinking] = useState(false);
  const tabs = projectTabs(project, data);
  // Imported projects lead with what they are made of; everything else with services.
  const activeTab = tab && tabs.includes(tab) ? tab : noRepo && s.resources.length ? "cloudflare" : tabs[0];
  const color: DitherColor = paletteOf(hue);
  const cloudTab: ProjectTab = tabs.includes("cloudflare") ? "cloudflare" : "services";
  // A stat is a pointer: clicking it opens what it counts and lights that up
  // for a beat, so the eye lands where the number came from.
  const tabsRef = useRef<HTMLElement>(null),
    deploymentsRef = useRef<HTMLElement>(null);
  const [spot, setSpot] = useState<{ target: "tabs" | "deployments"; n: number }>();
  function focus(target: ProjectTab | "deployments") {
    if (target === "deployments") setSpot((v) => ({ target, n: (v?.n ?? 0) + 1 }));
    else {
      if (target !== activeTab) onTab(target);
      setSpot((v) => ({ target: "tabs", n: (v?.n ?? 0) + 1 }));
    }
  }
  useEffect(() => {
    if (!spot) return;
    const el = spot.target === "tabs" ? tabsRef.current : deploymentsRef.current;
    if (!el) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "nearest", behavior: still ? "auto" : "smooth" });
    el.classList.remove("spotlight");
    void el.offsetWidth;
    el.classList.add("spotlight");
    const done = setTimeout(() => el.classList.remove("spotlight"), 1100);
    return () => clearTimeout(done);
  }, [spot]);
  const databases = data.databases.filter((d) => d.project_id === project.id).length + (data.database_providers?.resources ?? []).filter((d) => d.project_id === project.id).length;
  const serviceIds = new Set(s.services.map((x) => x.id));
  const managed = data.domains.filter((d) => serviceIds.has(d.service_id));
  // Every address the project answers on, managed ones first (they carry a
  // state), then what Cloudflare reported for linked resources. A `www.`
  // alias folds into its apex so a site reads as one address, and
  // workers.dev routes trail the custom domains they usually mirror.
  const seen = new Map<string, { hostname: string; status: string | null; error?: string; www: boolean }>();
  for (const a of [
    ...managed.map((d) => ({ hostname: d.hostname, status: d.status ?? null, error: d.error })),
    ...Object.entries(s.hostnames)
      .filter(([key]) => !key.startsWith("service:"))
      .flatMap(([, hosts]) => hosts)
      .map((hostname) => ({ hostname, status: null, error: undefined })),
  ]) {
    if (!seen.has(a.hostname)) seen.set(a.hostname, { ...a, www: false });
  }
  for (const hostname of [...seen.keys()]) {
    const apex = hostname.startsWith("www.") ? hostname.slice(4) : null;
    if (apex && seen.has(apex)) {
      seen.get(apex)!.www = true;
      seen.delete(hostname);
    }
  }
  const addresses = [...seen.values()].sort(
    (a, b) => Number(a.hostname.endsWith(".workers.dev")) - Number(b.hostname.endsWith(".workers.dev")),
  );
  const recent = data.deployments
    .filter((d) => serviceIds.has(d.service_id))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, 6);
  const hosts = data.machines.filter((m) => s.services.some((x) => x.machine_id === m.id));
  const reported = overview && overview.status !== "not_connected" && overview.status !== "error";
  const repoUrl = /^https?:\/\//.test(project.repository)
    ? project.repository
    : `https://github.com/${project.repository}`;

  return (
    <div className="flex flex-col gap-5">
      <header className="gh-surface relative overflow-hidden rounded-lg">
        <DitherGradient
          from={hue}
          direction="left"
          cell={3}
          opacity={0.22}
          className="top-0 right-0 bottom-auto left-auto h-full w-3/5 [mask-image:linear-gradient(to_bottom,#000,transparent_85%)]"
        />
        <div className="relative flex flex-col gap-5 p-5">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div className="flex min-w-0 items-start gap-4">
              <ProjectMark name={project.name} hue={hue} size={56} className="shrink-0" />
              <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                  <h1 className="truncate text-2xl font-semibold leading-tight tracking-tight">
                    {project.name}
                  </h1>
                  {s.health && (
                    <span
                      className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background/60 px-2 py-0.5 text-xs text-muted-foreground backdrop-blur-sm"
                      title={s.health.detail ?? s.health.label}
                    >
                      <StatusDot status={s.health.status} />
                      {s.health.label}
                    </span>
                  )}
                </div>
                <Meta className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                  {noRepo ? (
                    <span className="inline-flex items-center gap-1">
                      <Cloud className="size-3" />
                      {s.resources.length ? "Organized from Cloudflare" : "No repository linked"}
                    </span>
                  ) : (
                    <>
                      <a
                        href={repoUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex min-w-0 items-center gap-1 hover:text-foreground"
                      >
                        <GitFork className="size-3 shrink-0" />
                        <span className="truncate">{project.repository}</span>
                        <ArrowUpRight className="size-3 shrink-0" />
                      </a>
                      <span className="inline-flex items-center gap-1">
                        <GitBranch className="size-3" />
                        {project.branch}
                      </span>
                    </>
                  )}
                  <span>created {ago(project.created_at)}</span>
                  {s.modified_at && (
                    <span title={new Date(s.modified_at).toLocaleString()}>
                      updated {ago(s.modified_at)}
                    </span>
                  )}
                </Meta>
                {addresses.length > 0 && (
                  <ul className="mt-1 flex flex-wrap items-center gap-1.5" aria-label="Addresses">
                    {addresses.map((a) => (
                      <li key={a.hostname}>
                        <a
                          href={`https://${a.hostname}`}
                          target="_blank"
                          rel="noreferrer"
                          title={
                            a.error ??
                            (a.status ? `Managed domain · ${a.status}` : "Reported by Cloudflare") +
                              (a.www ? ` · also www.${a.hostname}` : "")
                          }
                          className={cn(
                            "gh-interactive inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/70 bg-background/60 px-2 py-1 font-mono text-[11px] backdrop-blur-sm hover:border-primary/50 hover:text-primary",
                            a.hostname.endsWith(".workers.dev") ? "text-muted-foreground" : "text-foreground/90",
                          )}
                        >
                          {a.status && <StatusDot status={a.status} className="size-1.5" />}
                          <span className="truncate">{a.hostname}</span>
                          {a.www && <span className="text-muted-foreground">+www</span>}
                          <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2 md:justify-end">
              {noRepo && !linking && (
                <Button size="sm" variant="outline" onClick={() => setLinking(true)}>
                  <GitFork />
                  Link repository
                </Button>
              )}
              {!noRepo && (
                <Button size="sm" onClick={addService}>
                  <Plus />
                  Add service
                </Button>
              )}
              <RemoveProject project={project} data={data} live={live} refresh={refresh} onRemoved={onRemoved} />
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-2 border-t border-border/60 pt-3 sm:grid-cols-4 xl:grid-cols-6">
            <Stat
              label="services"
              value={String(s.services.length)}
              note={s.hosts.length ? `on ${s.hosts.join(", ")}` : undefined}
              hint="Open services"
              active={activeTab === "services"}
              onClick={() => focus("services")}
            />
            <Stat
              label="cloudflare"
              value={String(s.resources.length)}
              note={kindsLabel(s.workers, s.pages) || undefined}
              hint={cloudTab === "cloudflare" ? "Open Cloudflare resources" : "Open services"}
              active={activeTab === cloudTab}
              onClick={() => focus(cloudTab)}
            />
            <Stat
              label="databases"
              value={String(databases)}
              hint="Open databases"
              active={activeTab === "databases"}
              onClick={() => focus("databases")}
            />
            <Stat
              label="addresses"
              value={String(addresses.length)}
              note={managed.length ? `${managed.length} managed` : undefined}
              hint="Open domains"
              active={activeTab === "domains"}
              onClick={() => focus("domains")}
            />
            <Spark
              label="req · 24h"
              value={s.usage ? count(s.usage.reduce((a, b) => a + b, 0)) : "—"}
              note={s.traffic && s.traffic.errors > 0 ? `${count(s.traffic.errors)} errors` : undefined}
              warm={Boolean(s.traffic && s.traffic.errors > 0)}
              data={s.usage ?? EMPTY_USAGE}
              color={s.usage?.some(Boolean) ? color : "grey"}
              title={
                s.usage
                  ? "Hourly requests across production Workers, Cloudflare's 24h sample; not a serving check"
                  : "Cloudflare did not report an hourly series"
              }
              active={activeTab === cloudTab}
              onClick={() => focus(cloudTab)}
            />
            <Spark
              label="deploys · 14d"
              value={String(s.changed)}
              data={s.changed ? s.changes : EMPTY_CHANGES}
              color={s.changed ? color : "grey"}
              title="Deployments per day: dinghy deployments, Worker versions and Pages production deployments"
              active={false}
              onClick={() => focus("deployments")}
            />
          </dl>
        </div>
      </header>

      {linking && (
        <LinkRepository project={project} live={live} refresh={refresh} onDone={() => setLinking(false)} />
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_19rem]">
        <section ref={tabsRef} className="min-w-0 rounded-lg">
          <ProjectTabs
            project={project}
            data={data}
            refresh={refresh}
            live={live}
            tab={activeTab}
            onTab={onTab}
            serviceId={serviceId}
            onService={onService}
            addService={addService}
            onLinkRepository={() => setLinking(true)}
            onOrganize={onOrganize}
            onOpenDatabase={onOpenDatabase}
          />
        </section>
        <aside className="flex min-w-0 flex-col gap-4 xl:sticky xl:top-20 xl:self-start">
          <Rail
            ref={deploymentsRef}
            title="Recent deployments"
            empty={recent.length ? undefined : "No deployments yet."}
          >
            {recent.map((d) => (
              <DeploymentRow
                key={d.id}
                deployment={d}
                name={data.services.find((x) => x.id === d.service_id)?.name ?? "service"}
                onOpen={() => {
                  onTab("services");
                  onService(d.service_id);
                }}
              />
            ))}
          </Rail>
          {hosts.length > 0 && (
            <Rail title="Runs on">
              {hosts.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-3 py-1.5">
                  <span className="flex min-w-0 items-center gap-2 text-sm">
                    <StatusDot status={m.status} />
                    <span className="truncate">{m.report.hostname}</span>
                  </span>
                  <Meta className="shrink-0">
                    {s.services.filter((x) => x.machine_id === m.id).length} svc · {m.location}
                  </Meta>
                </li>
              ))}
            </Rail>
          )}
          {s.resources.length > 0 && (
            <Rail title="Cloudflare">
              <li className="flex flex-col gap-1.5 py-1.5">
                <span className="flex items-center justify-between gap-3 text-sm">
                  <span>{kindsLabel(s.workers, s.pages)}</span>
                  <EnvironmentChips environments={s.environments} />
                </span>
                <Meta>
                  {reported && overview.checked_at
                    ? checkedLabel(overview.checked_at)
                    : overview
                      ? "Cloudflare is not connected"
                      : "Asking Cloudflare…"}
                </Meta>
              </li>
            </Rail>
          )}
        </aside>
      </div>
    </div>
  );
}

/** The clickable shell every stat shares: a quiet tile that lifts on hover and underlines when its section is open. */
function StatTile({
  label,
  hint,
  active,
  onClick,
  children,
}: {
  label: string;
  hint: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        title={hint}
        className={cn(
          "gh-interactive group/stat -mx-2 -my-1.5 flex min-w-0 flex-col gap-1 rounded-md px-2 py-1.5 text-left outline-none",
          "hover:bg-background/50 focus-visible:ring-2 focus-visible:ring-primary/40",
          active && "bg-background/40",
        )}
      >
        <dt className="flex items-center gap-1.5">
          <Eyebrow className={cn(active && "text-primary/80")}>{label}</Eyebrow>
          <ArrowUpRight
            className="size-3 shrink-0 text-muted-foreground opacity-0 transition-[opacity,transform] group-hover/stat:translate-x-px group-hover/stat:opacity-100 group-focus-visible/stat:opacity-100 motion-reduce:transition-none"
            aria-hidden
          />
        </dt>
        {children}
        <span
          aria-hidden
          className={cn(
            "mt-0.5 h-px w-full origin-left bg-primary/70 transition-transform duration-300 ease-out motion-reduce:transition-none",
            active ? "scale-x-100" : "scale-x-0",
          )}
        />
      </button>
    </div>
  );
}

function Stat({
  label,
  value,
  note,
  hint,
  active,
  onClick,
}: {
  label: string;
  value: string;
  note?: string;
  hint: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <StatTile label={label} hint={hint} active={active} onClick={onClick}>
      <dd className="flex min-w-0 items-baseline gap-2">
        <span className="font-mono text-xl tabular-nums leading-none">{value}</span>
        {note && <Meta className="truncate">{note}</Meta>}
      </dd>
    </StatTile>
  );
}

function Spark({
  label,
  value,
  note,
  warm,
  data,
  color,
  title,
  active,
  onClick,
}: {
  label: string;
  value: string;
  note?: string;
  warm?: boolean;
  data: number[];
  color: DitherColor;
  title: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <StatTile label={label} hint={title} active={active} onClick={onClick}>
      <dd className="flex w-full min-w-0 flex-col gap-1">
        <span className="flex items-baseline gap-2">
          <span className="font-mono text-xl tabular-nums leading-none">{value}</span>
          {note && (
            <Meta className={cn("truncate", warm && "text-yellow-600 dark:text-yellow-500")}>{note}</Meta>
          )}
        </span>
        <Sparkline data={data} color={color} className="h-7 w-full" />
      </dd>
    </StatTile>
  );
}

function Rail({
  ref,
  title,
  empty,
  children,
}: {
  ref?: React.Ref<HTMLElement>;
  title: string;
  empty?: string;
  children: React.ReactNode;
}) {
  return (
    <section ref={ref} className="gh-surface flex flex-col gap-2 rounded-lg p-4" aria-label={title}>
      <Eyebrow>{title}</Eyebrow>
      {empty ? (
        <span className="text-sm text-muted-foreground">{empty}</span>
      ) : (
        <ul className="flex flex-col divide-y divide-border/60">{children}</ul>
      )}
    </section>
  );
}

function DeploymentRow({
  deployment: d,
  name,
  onOpen,
}: {
  deployment: Deployment;
  name: string;
  onOpen: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="gh-interactive -mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2.5 rounded-md px-1 py-1.5 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <StatusDot status={d.status} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-sm">{name}</span>
            {d.commit_sha && <Meta className="shrink-0">{d.commit_sha.slice(0, 7)}</Meta>}
          </span>
          <Meta className="truncate">
            {d.status.replaceAll("_", " ")}
            {d.step ? ` · ${d.step}` : ""} · {ago(d.created_at)}
          </Meta>
        </span>
        <Rocket className="size-3.5 shrink-0 text-muted-foreground/60" />
      </button>
    </li>
  );
}
