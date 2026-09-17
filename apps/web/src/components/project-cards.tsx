import { ArrowUpRight, Cloud, GitFork } from "lucide-react";
import type { CloudflareOverview, Project, Snapshot } from "../lib/data";
import { cn } from "../lib/utils";
import { DitherGradient, Sparkline, type DitherColor } from "./dither-kit";
import { Reveal } from "./fleet/primitives";
import {
  ago,
  count,
  ENV_SHORT,
  EnvironmentChips,
  kindsLabel,
  paletteOf,
  ProjectMark,
  projectHues,
  summarize,
  USAGE_HOURS,
} from "./project-summary";
import { Meta, StatusDot } from "./ui/misc";

/** Rows shown on a card before "+n more". */
const CARD_ROWS = 3;
const EMPTY_USAGE = new Array<number>(USAGE_HOURS).fill(0);

/**
 * Every project as a card: mark, what it is made of, traffic and deploy
 * sparklines, environment chips. The one representation of a project list,
 * shared by the Overview and anywhere else projects are browsed.
 */
export function ProjectCards({
  projects,
  data,
  overview,
  onSelect,
  className,
}: {
  projects: Project[];
  data: Snapshot;
  overview?: CloudflareOverview;
  onSelect: (p: Project) => void;
  className?: string;
}) {
  if (!projects.length) return null;
  const hues = projectHues(data.projects);
  return (
    <ul className={cn("grid gap-3 sm:grid-cols-2 xl:grid-cols-3 3xl:grid-cols-4", className)}>
      {projects.map((p, i) => {
        const s = summarize(data, p, overview);
        // Production alone is the default and goes unsaid, as in the Overview
        // ledger; chips appear once an environment needs naming.
        const multiEnv = s.environments.length > 1;
        const chips = multiEnv || s.environments[0] !== "production";
        // What the project is made of, services first: each row is a real
        // service or linked resource, in canonical environment order. The
        // right column is the row's address when one is known, else where
        // it runs; nothing known stays blank rather than claiming "no domain".
        const rows = [
          ...s.services.map((svc) => ({
            key: `service:${svc.id}`,
            name: svc.name,
            env: "",
            hostnames: s.hostnames[`service:${svc.id}`] ?? [],
            fallback: data.machines.find((m) => m.id === svc.machine_id)?.report.hostname ?? "unplaced",
            status: svc.status ?? null,
          })),
          ...s.environments.flatMap((env) =>
            s.resources
              .filter((r) => r.environment === env)
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((r) => ({
                key: r.id,
                name: r.name,
                env: multiEnv ? ENV_SHORT[env] : "",
                hostnames: s.hostnames[r.id] ?? [],
                fallback: "",
                status: null,
              })),
          ),
        ];
        const more = rows.length - CARD_ROWS;
        const made = [
          p.repository,
          s.services.length
            ? `${s.services.length} service${s.services.length === 1 ? "" : "s"}${s.hosts.length ? ` on ${s.hosts.join(", ")}` : ""}`
            : "",
          kindsLabel(s.workers, s.pages),
        ].filter(Boolean);
        return (
          <Reveal as="li" key={p.id} delay={Math.min(i, 8) * 0.03} className="flex">
            <button
              type="button"
              onClick={() => onSelect(p)}
              className="gh-interactive group/card relative flex w-full flex-col gap-4 overflow-hidden rounded-lg border border-border bg-card p-4 text-left"
            >
              <DitherGradient
                from={hues[p.id]}
                direction="left"
                cell={3}
                opacity={0.16}
                className="top-0 right-0 bottom-auto left-auto h-28 w-48 opacity-70 transition-opacity duration-300 [mask-image:linear-gradient(to_bottom,#000,transparent)] group-hover/card:opacity-100 group-focus-visible/card:opacity-100 motion-reduce:transition-none"
              />
              <span className="relative flex items-start gap-3">
                <ProjectMark name={p.name} hue={hues[p.id]} size={40} />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-center gap-1 text-[15px] font-semibold leading-tight tracking-tight">
                    <span className="truncate">{p.name}</span>
                    <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-[opacity,transform] group-hover/card:translate-x-px group-hover/card:opacity-100 group-focus-visible/card:opacity-100 motion-reduce:transition-none" />
                  </span>
                  <Meta className="flex min-w-0 items-center gap-1">
                    {p.repository ? (
                      <GitFork className="size-3 shrink-0" />
                    ) : (
                      <Cloud className="size-3 shrink-0" />
                    )}
                    <span className="truncate">{made.join(" · ") || "No repository linked"}</span>
                  </Meta>
                </span>
                {s.health && (
                  <span
                    className="flex shrink-0 items-center gap-1.5 pt-1 text-xs text-muted-foreground"
                    title={s.health.detail ?? s.health.label}
                  >
                    <StatusDot status={s.health.status} />
                    <span className="hidden md:inline">{s.health.label}</span>
                  </span>
                )}
              </span>
              {rows.length > 0 ? (
                <span className="flex flex-col divide-y divide-border/60 border-t border-border/60">
                  {rows.slice(0, CARD_ROWS).map((r) => (
                    <span key={r.key} className="flex items-center justify-between gap-3 py-1.5">
                      <span className="flex min-w-0 items-center gap-1.5 text-[13px]">
                        {r.status && <StatusDot status={r.status} className="size-1.5" />}
                        <span className="truncate">{r.name}</span>
                        {r.env && <Meta>{r.env}</Meta>}
                      </span>
                      {r.hostnames.length ? (
                        <Meta
                          className="flex min-w-0 max-w-[62%] items-baseline gap-1 font-mono text-[11px]"
                          title={r.hostnames.join("\n")}
                        >
                          <span className="truncate">{r.hostnames[0]}</span>
                          {r.hostnames.length > 1 && <span className="shrink-0">+{r.hostnames.length - 1}</span>}
                        </Meta>
                      ) : (
                        <Meta className="shrink-0">{r.fallback}</Meta>
                      )}
                    </span>
                  ))}
                  {more > 0 && <Meta className="py-1.5">+{more} more</Meta>}
                </span>
              ) : (
                <span className="border-t border-border/60 pt-3 text-[13px] text-muted-foreground">
                  Nothing here yet — add a service or link a repository.
                </span>
              )}
              {(s.usage || s.changed > 0) && (
                <span className="grid grid-cols-2 gap-3 border-t border-border/60 pt-3">
                  <Spark
                    label="req · 24h"
                    value={s.usage ? `${count(Math.max(...s.usage))}/h pk` : "—"}
                    data={s.usage ?? EMPTY_USAGE}
                    color={s.usage?.some(Boolean) ? paletteOf(hues[p.id]) : "grey"}
                    title={
                      s.usage
                        ? "Hourly requests across production Workers, Cloudflare's 24h sample; not a serving check"
                        : "Cloudflare did not report an hourly series"
                    }
                  />
                  <Spark
                    label="deploys · 14d"
                    value={String(s.changed)}
                    data={s.changes}
                    color={s.changed ? paletteOf(hues[p.id]) : "grey"}
                    title="Deployments per day: dinghy deployments, Worker versions and Pages production deployments"
                  />
                </span>
              )}
              <span className="mt-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <Meta className="flex min-w-0 flex-wrap items-baseline gap-x-2 tabular-nums">
                  {s.traffic && (
                    <span
                      className="whitespace-nowrap"
                      title={`${s.traffic.requests.toLocaleString()} requests, ${s.traffic.errors.toLocaleString()} errors across production Workers in Cloudflare's 24h sample; not a serving check`}
                    >
                      {count(s.traffic.requests)} req ·{" "}
                      <span className={cn(s.traffic.errors > 0 && "text-yellow-600 dark:text-yellow-500")}>
                        {count(s.traffic.errors)} err
                      </span>{" "}
                      · 24h
                    </span>
                  )}
                  {s.modified_at && (
                    <span className="whitespace-nowrap" title={new Date(s.modified_at).toLocaleString()}>
                      updated {ago(s.modified_at)}
                    </span>
                  )}
                  {!s.traffic && !s.modified_at && !rows.length && "empty project"}
                </Meta>
                {chips && <EnvironmentChips environments={s.environments} />}
              </span>
            </button>
          </Reveal>
        );
      })}
    </ul>
  );
}

/** A labelled sparkline cell on a project card; the number is the series total. */
function Spark({
  label,
  value,
  data,
  color,
  title,
}: {
  label: string;
  value: string;
  data: number[];
  color: DitherColor;
  title: string;
}) {
  return (
    <span className="flex min-w-0 flex-col gap-1" title={title}>
      <span className="flex items-baseline justify-between gap-2">
        <Meta className="truncate">{label}</Meta>
        <span className="shrink-0 whitespace-nowrap font-mono text-xs tabular-nums">{value}</span>
      </span>
      <Sparkline data={data} color={color} className="h-8 w-full" />
    </span>
  );
}
