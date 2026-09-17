import { useEffect, useState, type FormEvent } from "react";
import { ExternalLink, GitFork } from "lucide-react";
import {
  api,
  type CloudflareOverview,
  type Project,
  type ProjectResource,
  type ResourceEnvironment,
  type Snapshot,
} from "../lib/data";
import { cn } from "../lib/utils";
import { Feedback, useAction } from "./live";
import { ENVIRONMENTS, KIND_LABEL } from "./organize";
import { checkedLabel } from "./readiness";
import { RepositoryField } from "./service-fields";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Alert, Eyebrow, Meta, StatusDot } from "./ui/misc";

/** True for projects that were organized from existing resources and never linked to source. */
export const imported = (p: Project) => !p.repository;

/** Saved Cloudflare links for one project. */
export function projectResources(data: Snapshot, projectId: string): ProjectResource[] {
  return (data.project_resources ?? []).filter((r) => r.project_id === projectId && !r.ignored);
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const count = (n: number | null) => (n === null ? "—" : compact.format(n));

function ago(iso: string | null): string {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const PAGE_DOT: Record<string, string> = {
  success: "healthy",
  active: "healthy",
  building: "building",
  queued: "queued",
  deploying: "deploying",
  failure: "failed",
  failed: "failed",
  canceled: "idle",
  cancelled: "idle",
};

/**
 * The project's Cloudflare resources with whatever Cloudflare reported last:
 * 24h sampled Worker counts, Pages production status. Nothing here is a
 * serving check, and nothing here changes the account.
 */
export function ProjectResources({
  project,
  data,
  onOrganize,
}: {
  project: Project;
  data: Snapshot;
  onOrganize?: () => void;
}) {
  const resources = projectResources(data, project.id);
  const [overview, setOverview] = useState<CloudflareOverview>();
  const [error, setError] = useState("");
  useEffect(() => {
    let ended = false;
    setOverview(undefined);
    setError("");
    api<CloudflareOverview>("/integrations/cloudflare/overview")
      .then((o) => {
        if (!ended) setOverview(o);
      })
      .catch((e) => {
        if (!ended) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      ended = true;
    };
  }, [project.id]);
  const byEnv = ENVIRONMENTS.map((env) => ({
    env,
    rows: resources.filter((r) => r.environment === env).sort((a, b) => a.name.localeCompare(b.name)),
  })).filter((g) => g.rows.length);
  const reported = overview && overview.status !== "not_connected" && overview.status !== "error";
  // Links may come from an account that is no longer connected; only the
  // connected account's inventory is ever joined onto them.
  const account = reported ? overview.account_id : null;
  const foreign = resources.filter((r) => r.account_id !== account).length;

  if (!resources.length)
    return (
      <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-border px-4 py-3">
        <span className="text-sm text-muted-foreground">
          Nothing from your Cloudflare account is in this project yet.
        </span>
        {onOrganize && (
          <Button size="sm" variant="outline" onClick={onOrganize}>
            Organize Cloudflare resources
          </Button>
        )}
      </div>
    );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <Meta>
          {resources.length} from your Cloudflare account · dinghy never changes them
        </Meta>
        {overview?.checked_at && <Meta>{checkedLabel(overview.checked_at)}</Meta>}
        {!overview && !error && <Meta>Asking Cloudflare…</Meta>}
      </div>
      {error && <Alert variant="destructive">Cloudflare details unavailable: {error}</Alert>}
      {overview?.status === "error" && (
        <Alert variant="destructive">Cloudflare could not be read right now; showing what is linked.</Alert>
      )}
      {overview?.status === "partial" && overview.issues.length > 0 && (
        <Alert className="flex flex-col gap-1">
          <span className="font-medium">Some Cloudflare details are missing</span>
          {overview.issues.map((issue) => (
            <Meta key={issue}>{issue}</Meta>
          ))}
        </Alert>
      )}
      {overview?.status === "not_connected" && (
        <Alert>Cloudflare is not connected; showing what is linked.</Alert>
      )}
      {reported && foreign > 0 && (
        <Alert>
          {foreign === resources.length ? "These" : `${foreign} of these`} came from a different
          Cloudflare account than the one connected now.
        </Alert>
      )}
      {byEnv.map((g) => (
        <section key={g.env} className="flex flex-col gap-1.5">
          <Eyebrow>{g.env}</Eyebrow>
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {g.rows.map((r) => {
              const mine = r.account_id === account;
              const worker = mine && r.kind === "worker" ? overview?.workers.find((w) => w.name === r.name) : undefined;
              const page = mine && r.kind === "pages" ? overview?.pages.find((p) => p.name === r.name) : undefined;
              const link = worker?.dashboard_url ?? page?.dashboard_url;
              const status = page?.deployment_status?.toLowerCase() ?? null;
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 sm:flex-nowrap">
                  <div className="flex min-w-0 flex-1 basis-40 flex-col">
                    <span className="flex min-w-0 items-center gap-2">
                      {link ? (
                        <a
                          href={link}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex min-w-0 items-center gap-1 text-sm font-medium hover:text-primary hover:underline"
                        >
                          <span className="truncate">{r.name}</span>
                          <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
                        </a>
                      ) : (
                        <span className="truncate text-sm font-medium">{r.name}</span>
                      )}
                      <Badge variant="outline" className="shrink-0">
                        {KIND_LABEL[r.kind]}
                      </Badge>
                    </span>
                    {page?.url ? (
                      <a
                        href={page.url}
                        target="_blank"
                        rel="noreferrer"
                        className="truncate font-mono text-[11px] text-muted-foreground hover:text-foreground"
                      >
                        {page.url.replace(/^https?:\/\//, "")}
                      </a>
                    ) : (
                      <Meta>
                        {worker
                          ? `modified ${ago(worker.modified_at)}`
                          : reported
                            ? mine
                              ? "not reported by Cloudflare now"
                              : "from an account that is not connected"
                            : `added ${ago(r.updated_at)}`}
                      </Meta>
                    )}
                  </div>
                  {worker && (
                    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1">
                      {(
                        [
                          ["requests", worker.requests],
                          ["errors", worker.errors],
                          ["subrequests", worker.subrequests],
                        ] as [string, number | null][]
                      ).map(([label, value]) => (
                        <span key={label} className="flex items-baseline gap-1" title={value === null ? `${label} unavailable` : undefined}>
                          <span className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">{label}</span>
                          <span className={cn("font-mono text-xs tabular-nums", value === null ? "text-muted-foreground" : "text-foreground")}>
                            {count(value)}
                          </span>
                        </span>
                      ))}
                    </div>
                  )}
                  {page && (
                    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1">
                      {page.production_branch && <Meta title="production branch">{page.production_branch}</Meta>}
                      <span className="flex items-center gap-1.5">
                        <StatusDot status={status ? (PAGE_DOT[status] ?? "idle") : "idle"} />
                        <Meta className={cn(status && "capitalize")}>{status ?? "no deployment"}</Meta>
                      </span>
                      <Meta>{ago(page.modified_at)}</Meta>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {reported && overview.window && (
        <Meta>Worker counts are 24h sampled Cloudflare estimates; "—" means Cloudflare did not report one.</Meta>
      )}
    </div>
  );
}

/** Which environments this project spans, for compact labels. */
export function environmentsOf(resources: ProjectResource[]): ResourceEnvironment[] {
  return ENVIRONMENTS.filter((env) => resources.some((r) => r.environment === env));
}

/**
 * Link source to an imported project later. Repository changes are refused
 * by the control plane once machine services exist, so this only appears
 * for projects without one.
 */
export function LinkRepository({
  project,
  live,
  refresh,
  onDone,
}: {
  project: Project;
  live: boolean;
  refresh: () => Promise<unknown>;
  onDone: () => void;
}) {
  const action = useAction();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    await action.run(async () => {
      const repository = String(form.get("repository") || "").trim();
      if (!repository) throw new Error("Choose a repository first.");
      await api(`/projects/${project.id}`, {
        repository,
        branch: String(form.get("branch") || "main"),
      }, "PATCH");
      await refresh();
      onDone();
    }, "Repository linked");
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-4 rounded-lg border border-border p-4">
      <div className="flex flex-col gap-1">
        <span className="inline-flex items-center gap-1.5 text-sm font-medium">
          <GitFork className="size-4 text-muted-foreground" />
          Link a repository
        </span>
        <span className="text-sm text-muted-foreground">
          Optional. Linking source lets this project build and run services on your machines. It
          does not deploy anything by itself.
        </span>
      </div>
      <RepositoryField live={live} />
      <Feedback action={action} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" isLoading={action.busy} disabled={!live}>
          Link repository
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Not now
        </Button>
      </div>
    </form>
  );
}
