import type {
  CloudflareOverview,
  Project,
  ProjectResource,
  ResourceEnvironment,
  Service,
  Snapshot,
} from "../lib/data";
import { cn } from "../lib/utils";
import { DitherAvatar, type DitherColor } from "./dither-kit";
import { ENVIRONMENTS } from "./organize";

/*
 * Project identity and summary, shared by the Overview ledger and the
 * Projects collection so a project looks the same wherever it appears.
 */

const compact = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});
/** null means Cloudflare did not report it; zero was observed. */
export const count = (n: number | null) => (n === null ? "—" : compact.format(n));

export function ago(iso: string | null): string {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Short environment names for chips; production stays spelled out because it is the default. */
export const ENV_SHORT: Record<ResourceEnvironment, string> = {
  production: "production",
  development: "dev",
  staging: "staging",
  preview: "preview",
};

/**
 * One hue per project, stepped by the golden angle in creation order from the
 * accent's mint: neighbours never share a colour, and a project keeps its hue
 * as later ones are added. Name-derived hues collided too often to tell six
 * projects apart.
 */
export function projectHues(projects: Project[]): Record<string, number> {
  const hues: Record<string, number> = {};
  [...projects]
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    .forEach((p, i) => {
      hues[p.id] = Math.round((150 + i * 137.508) % 360);
    });
  return hues;
}

/**
 * The project's generative mark: an ordered-dither glyph seeded by its name,
 * the same idiom the fleet uses for hosts. Same name, same glyph, everywhere;
 * the hue comes from `projectHues`.
 */
export function ProjectMark({
  name,
  hue,
  size = 36,
  className,
}: {
  name: string;
  hue?: number;
  size?: number;
  className?: string;
}) {
  return (
    <DitherAvatar
      name={name}
      hue={hue}
      size={size}
      bloom="low"
      className={cn("shrink-0 rounded-[4px] ring-1 ring-white/10", className)}
    />
  );
}

export type ProjectSummary = {
  /** Saved Cloudflare links, ignored ones excluded. */
  resources: ProjectResource[];
  environments: ResourceEnvironment[];
  workers: number;
  pages: number;
  services: Service[];
  /** Hostnames of the machines this project's services are placed on. */
  hosts: string[];
  /**
   * Machine services decide; without any, the connected Cloudflare account's
   * observations do (Pages deployment state, 24h sampled Worker errors and
   * requests). null until something has been observed.
   */
  health: { status: string; label: string; detail?: string } | null;
  /**
   * Public hostnames per row key (`service:<id>` or resource id): dinghy's
   * managed domains plus what the connected Cloudflare account reports for
   * the exact resource. Missing keys mean nothing is known, not "no domain".
   */
  hostnames: Record<string, string[]>;
  /** 24h sampled Cloudflare sums over production Workers; null until Cloudflare reported one. */
  traffic: { requests: number; errors: number } | null;
  /** Latest deployment, Worker upload or Pages deployment anywhere in the project. */
  modified_at: string | null;
  /** Hourly sampled requests over production Workers, oldest first; null until Cloudflare reported a series. */
  usage: number[] | null;
  /** Deployments per day over the last 14 days, oldest first: dinghy deployments, Worker versions, Pages production deployments. */
  changes: number[];
  /** Sum of `changes`. */
  changed: number;
};

export const USAGE_HOURS = 24;
export const CHANGE_DAYS = 14;

const later = (a: string | null, b: string | null | undefined) =>
  !b ? a : !a || Date.parse(b) > Date.parse(a) ? b : a;

/**
 * Everything the workspace snapshot knows about one project, in one shape.
 * With the Cloudflare overview, linked resources also carry their addresses,
 * traffic and dates; the join is exact on account, kind and script name.
 */
export function summarize(
  data: Snapshot,
  project: Project,
  overview?: CloudflareOverview,
): ProjectSummary {
  const resources = (data.project_resources ?? []).filter(
    (r) => r.project_id === project.id && !r.ignored,
  );
  const services = data.services.filter((s) => s.project_id === project.id);
  const hosts = [
    ...new Set(
      services
        .map((s) => data.machines.find((m) => m.id === s.machine_id)?.report.hostname)
        .filter((h): h is string => Boolean(h)),
    ),
  ];
  const hostnames: Record<string, string[]> = {};
  let modified_at: string | null = null;
  const changes = new Array<number>(CHANGE_DAYS).fill(0);
  const today = Math.floor(Date.now() / 86400_000);
  const change = (iso: string | null | undefined) => {
    if (!iso) return;
    const index = CHANGE_DAYS - 1 - (today - Math.floor(Date.parse(iso) / 86400_000));
    if (index >= 0 && index < CHANGE_DAYS) changes[index]++;
  };
  for (const s of services) {
    const owned = data.domains.filter((d) => d.service_id === s.id).map((d) => d.hostname);
    if (owned.length) hostnames[`service:${s.id}`] = owned;
    for (const d of data.deployments)
      if (d.service_id === s.id) {
        modified_at = later(modified_at, d.finished_at ?? d.updated_at ?? d.created_at);
        change(d.created_at);
      }
  }
  // Links may predate a reconnect; only the connected account's inventory is joined.
  const reported =
    overview && overview.status !== "not_connected" && overview.status !== "error"
      ? overview
      : undefined;
  let requests = 0,
    errors = 0,
    sampled = false;
  let usage: number[] | null = null;
  let pagesFailed = false;
  for (const r of resources) {
    if (!reported || r.account_id !== reported.account_id) continue;
    const worker = r.kind === "worker" ? reported.workers.find((w) => w.name === r.name) : undefined;
    const page = r.kind === "pages" ? reported.pages.find((p) => p.name === r.name) : undefined;
    modified_at = later(modified_at, worker?.modified_at ?? page?.modified_at);
    const owned = (reported.domains ?? [])
      .filter((d) => d.kind === r.kind && d.name === r.name && d.environment === "production")
      .map((d) => d.hostname);
    if (page?.url) owned.push(page.url.replace(/^https?:\/\//, ""));
    if (owned.length) hostnames[r.id] = owned;
    if (worker && r.environment === "production" && worker.requests !== null && worker.errors !== null) {
      requests += worker.requests;
      errors += worker.errors;
      sampled = true;
    }
    if (worker?.series && r.environment === "production") {
      usage ??= new Array<number>(USAGE_HOURS).fill(0);
      for (let i = 0; i < USAGE_HOURS; i++) usage[i] += worker.series[i] ?? 0;
    }
    for (const iso of worker?.changes ?? page?.changes ?? []) change(iso);
    const state = page?.deployment_status?.toLowerCase();
    if (state === "failure" || state === "failed") pagesFailed = true;
  }
  const traffic = sampled ? { requests, errors } : null;
  const health: ProjectSummary["health"] =
    services.length
      ? services.every((s) => s.status === "healthy")
        ? { status: "healthy", label: "Healthy" }
        : services.some((s) => s.status === "failed" || s.status === "unhealthy")
          ? { status: "failed", label: "Needs attention" }
          : services.some((s) => s.status && s.status !== "not_deployed")
            ? { status: "deploying", label: "Deploying" }
            : { status: "idle", label: "Not deployed" }
      : pagesFailed
        ? { status: "failed", label: "Deploy failed", detail: "A Pages production deployment failed" }
        : traffic && traffic.errors > 0
          ? {
              status: "degraded",
              label: `${count(traffic.errors)} errors`,
              detail: `${traffic.errors.toLocaleString()} invocation errors in Cloudflare's 24h sample; not a serving check`,
            }
          : traffic
            ? traffic.requests > 0
              ? { status: "healthy", label: "Serving", detail: `${traffic.requests.toLocaleString()} requests in Cloudflare's 24h sample` }
              : { status: "idle", label: "No traffic", detail: "No requests in Cloudflare's 24h sample" }
            : null;
  return {
    resources,
    environments: ENVIRONMENTS.filter((env) => resources.some((r) => r.environment === env)),
    workers: resources.filter((r) => r.kind === "worker").length,
    pages: resources.filter((r) => r.kind === "pages").length,
    services,
    hosts,
    health,
    hostnames,
    traffic,
    modified_at,
    usage,
    changes,
    changed: changes.reduce((a, b) => a + b, 0),
  };
}

const PALETTE_HUES: [DitherColor, number][] = [
  ["red", 0],
  ["orange", 30],
  ["green", 140],
  ["blue", 215],
  ["purple", 260],
  ["pink", 320],
];
/** The chart palette colour nearest a project hue, so sparklines match the mark. */
export function paletteOf(hue: number): DitherColor {
  let best: DitherColor = "green",
    distance = 360;
  for (const [name, at] of PALETTE_HUES) {
    const d = Math.min(Math.abs(hue - at), 360 - Math.abs(hue - at));
    if (d < distance) {
      distance = d;
      best = name;
    }
  }
  return best;
}

/** "4 Workers · 1 Pages" from counts, skipping zero kinds; empty when nothing is linked. */
export function kindsLabel(workers: number, pages: number): string {
  const parts: string[] = [];
  if (workers) parts.push(`${workers} Worker${workers === 1 ? "" : "s"}`);
  if (pages) parts.push(`${pages} Pages`);
  return parts.join(" · ");
}

/** Environment chips in canonical order; renders nothing for an empty list. */
export function EnvironmentChips({
  environments,
  className,
}: {
  environments: ResourceEnvironment[];
  className?: string;
}) {
  if (!environments.length) return null;
  return (
    <span className={cn("flex flex-wrap items-center gap-1", className)}>
      {environments.map((env) => (
        <span
          key={env}
          className={cn(
            "rounded-sm px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.08em]",
            env === "production"
              ? "bg-primary/10 text-primary"
              : "bg-muted text-muted-foreground",
          )}
        >
          {ENV_SHORT[env]}
        </span>
      ))}
    </span>
  );
}
