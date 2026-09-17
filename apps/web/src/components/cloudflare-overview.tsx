import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ArrowUpRight,
  Cloud,
  ExternalLink,
  FolderTree,
  GitFork,
  RefreshCw,
  Unplug,
} from "lucide-react";
import {
  api,
  type CloudflareOverview,
  type CloudflarePage,
  type CloudflareWorker,
  type Project,
  type ProjectResource,
  type ResourceEnvironment,
  type Snapshot,
} from "../lib/data";
import { cn } from "../lib/utils";
import { Reveal } from "./fleet/primitives";
import { Field, Feedback, useAction } from "./live";
import { ENVIRONMENTS, KIND_LABEL, OrganizeDialog, resourceKey } from "./organize";
import {
  ago,
  count,
  EnvironmentChips,
  kindsLabel,
  ProjectMark,
  projectHues,
} from "./project-summary";
import { checkedLabel } from "./readiness";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog, DialogFooter } from "./ui/dialog";
import { Input } from "./ui/input";
import { Alert, Eyebrow, Meta, StatusDot } from "./ui/misc";

const TOKEN_URL = "https://dash.cloudflare.com/profile/api-tokens";
const PERMISSIONS = [
  "Workers Scripts Read",
  "Pages Read",
  "Account Analytics Read",
];
/** Rows shown before "more" on the first-run page, where the setup path leads. */
const COMPACT_ROWS = 4;

function windowLabel(w: CloudflareOverview["window"]): string {
  if (!w) return "no metrics window";
  const hours = Math.round((Date.parse(w.end) - Date.parse(w.start)) / 3600000);
  return hours >= 48 ? `${Math.round(hours / 24)}d sample` : `${hours}h sample`;
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

/* ----------------------------------------------------------------------- */
/* Ledger rows                                                             */

/**
 * One column template for every row and the header, so numbers line up
 * across projects: name | modified | requests | errors. Below `sm` the
 * metrics collapse into the name cell.
 */
const ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 sm:grid-cols-[minmax(0,1fr)_5.5rem_5rem_4rem] xl:grid-cols-[minmax(0,1fr)_5.5rem_5rem_4rem_5.5rem]";
/** The band's identity column beside its rows; grows a little on very wide screens. */
const BAND_GRID =
  "lg:grid-cols-[minmax(12rem,16rem)_minmax(0,1fr)] 2xl:grid-cols-[minmax(14rem,20rem)_minmax(0,1fr)]";

const linkClass =
  "group/link inline-flex min-w-0 max-w-full items-center gap-1 self-start rounded-sm text-sm font-medium text-foreground outline-none hover:text-primary focus-visible:text-primary focus-visible:ring-2 focus-visible:ring-primary/40";

/** A number cell; null stays "—" and says why on hover. Errors above zero warm up. */
function Num({
  value,
  label,
  warm = false,
  className,
}: {
  value: number | null;
  label: string;
  warm?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "text-right font-mono text-[13px] tabular-nums",
        value === null
          ? "text-muted-foreground/60"
          : warm && value > 0
            ? "text-yellow-600 dark:text-yellow-500"
            : value === 0
              ? "text-muted-foreground"
              : "text-foreground",
        className,
      )}
      title={
        value === null
          ? `${label} unavailable`
          : `${value.toLocaleString()} ${label} in the sampled window; not a serving check`
      }
    >
      {count(value)}
    </span>
  );
}

function WorkerRow({ w }: { w: CloudflareWorker }) {
  return (
    <li className={cn(ROW_GRID, "py-2")}>
      <span className="flex min-w-0 flex-col">
        <a href={w.dashboard_url} target="_blank" rel="noreferrer" className={linkClass}>
          <span className="truncate">{w.name}</span>
          <ExternalLink className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/link:opacity-100 group-focus-visible/link:opacity-100" />
        </a>
        <Meta className="sm:hidden">modified {ago(w.modified_at)}</Meta>
      </span>
      <Meta className="flex items-baseline gap-2 sm:hidden">
        <Num value={w.requests} label="requests" /> req
        <Num value={w.errors} label="errors" warm /> err
      </Meta>
      <Meta className="hidden sm:block">{ago(w.modified_at)}</Meta>
      <Num value={w.requests} label="requests" className="hidden sm:block" />
      <Num value={w.errors} label="errors" warm className="hidden sm:block" />
      <Num value={w.subrequests} label="subrequests" className="hidden xl:block" />
    </li>
  );
}

function PageRow({ p }: { p: CloudflarePage }) {
  const status = p.deployment_status?.toLowerCase() ?? null;
  return (
    <li className={cn(ROW_GRID, "py-2")}>
      <span className="flex min-w-0 flex-col">
        <a href={p.dashboard_url} target="_blank" rel="noreferrer" className={linkClass}>
          <span className="truncate">{p.name}</span>
          <ExternalLink className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/link:opacity-100 group-focus-visible/link:opacity-100" />
        </a>
        {p.url ? (
          <a
            href={p.url}
            target="_blank"
            rel="noreferrer"
            className="truncate font-mono text-[11px] text-muted-foreground hover:text-foreground focus-visible:text-foreground"
          >
            {p.url.replace(/^https?:\/\//, "")}
          </a>
        ) : (
          <Meta>no production URL</Meta>
        )}
      </span>
      <Meta className="hidden sm:block">{ago(p.modified_at)}</Meta>
      <span className="flex items-center justify-end gap-1.5 sm:col-span-2 xl:col-span-3">
        {p.production_branch && (
          <Meta className="hidden truncate md:block" title="production branch">
            {p.production_branch}
          </Meta>
        )}
        <StatusDot status={status ? (PAGE_DOT[status] ?? "idle") : "idle"} />
        <Meta className={cn("shrink-0", status && "capitalize")}>{status ?? "no deployment"}</Meta>
      </span>
    </li>
  );
}

/** A saved link Cloudflare no longer lists, or one from an account that is not connected. */
function MissingRow({ r, foreign }: { r: Linked; foreign: boolean }) {
  return (
    <li className={cn(ROW_GRID, "py-2")}>
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm font-medium text-muted-foreground">{r.name}</span>
        <Badge variant="outline" className="shrink-0">
          {KIND_LABEL[r.kind]}
        </Badge>
      </span>
      <Meta className="text-right sm:col-span-3 xl:col-span-4">
        {foreign ? "from an account that is not connected" : "not reported by Cloudflare now"}
      </Meta>
    </li>
  );
}

function LinkedRow({ r, account }: { r: Linked; account: string | null }) {
  if (r.worker) return <WorkerRow w={r.worker} />;
  if (r.page) return <PageRow p={r.page} />;
  return <MissingRow r={r} foreign={Boolean(r.record && r.record.account_id !== account)} />;
}

/** The column captions, aligned to `ROW_GRID`; hidden where the rows collapse. */
function ColumnHeads({ window }: { window: CloudflareOverview["window"] }) {
  return (
    <div className={cn(ROW_GRID, "hidden sm:grid")} aria-hidden>
      <Eyebrow>resource</Eyebrow>
      <Eyebrow>modified</Eyebrow>
      <Eyebrow className="text-right">requests</Eyebrow>
      <Eyebrow className="text-right" title={`Sampled Cloudflare estimates, ${windowLabel(window)}`}>
        errors
      </Eyebrow>
      <Eyebrow className="hidden text-right xl:block">subrequests</Eyebrow>
    </div>
  );
}

/** "ok" lists what Cloudflare returned; the others come from a `Workers:`/`Pages:` issue. */
type Inventory = "ok" | "incomplete" | "unavailable";

function inventory(prefix: "Workers" | "Pages", issues: string[], rows: number): Inventory {
  if (!issues.some((i) => i.startsWith(`${prefix}:`))) return "ok";
  return rows > 0 ? "incomplete" : "unavailable";
}

/** A kind's rows under one caption: the unassigned view and the plain inventory. */
function KindList({
  label,
  state,
  total,
  empty,
  children,
}: {
  label: string;
  state: Inventory;
  total: number;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-1 px-4 py-3 sm:px-5">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-medium">{label}</span>
        <Meta>{state === "unavailable" ? "—" : state === "incomplete" ? `${total}+` : total}</Meta>
        {state !== "ok" && (
          <Meta className="text-yellow-600 dark:text-yellow-500">
            {state === "unavailable" ? "inventory unavailable" : "list incomplete"}
          </Meta>
        )}
      </div>
      {total ? (
        <ul className="flex flex-col divide-y divide-border/60">{children}</ul>
      ) : (
        <Meta>{state === "unavailable" ? "Cloudflare did not return this list." : empty}</Meta>
      )}
    </section>
  );
}

/* ----------------------------------------------------------------------- */

/**
 * The connect form: credentials go straight to the control plane and are
 * never kept in the browser. Cloudflare validates them before we show anything.
 */
function ConnectDialog({
  reconnect,
  onClose,
  onConnected,
}: {
  reconnect: boolean;
  onClose: () => void;
  onConnected: (overview: CloudflareOverview) => void;
}) {
  const action = useAction();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget,
      account_id = String(new FormData(form).get("account_id") || "").trim().toLowerCase(),
      api_token = String(new FormData(form).get("api_token") || "").trim();
    await action.run(async () => {
      if (!/^[0-9a-f]{32}$/.test(account_id))
        throw new Error("The account ID is 32 hex characters; find it on the account's Overview page in Cloudflare.");
      if (!api_token) throw new Error("Paste an API token.");
      const overview = await api<CloudflareOverview>(
        "/integrations/cloudflare/account",
        { account_id, api_token },
      );
      form.reset();
      onConnected(overview);
    }, "");
  }
  return (
    <Dialog
      title={reconnect ? "Reconnect Cloudflare" : "Connect Cloudflare"}
      onClose={onClose}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Read-only access to the Workers and Pages in one account. Your token is
          checked with Cloudflare, encrypted, and stored only in this workspace.
        </p>
        <div className="gh-surface flex flex-col gap-2 rounded-lg p-3">
          <Eyebrow>Token permissions</Eyebrow>
          <ul className="flex flex-wrap gap-1.5">
            {PERMISSIONS.map((p) => (
              <li
                key={p}
                className="rounded-sm border border-border bg-muted px-1.5 py-px font-mono text-[10px] text-muted-foreground"
              >
                {p}
              </li>
            ))}
          </ul>
          <Meta>
            Account permissions, scoped to the account you enter.{" "}
            <a
              href={TOKEN_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              Create a token
              <ExternalLink className="size-3" />
            </a>
          </Meta>
        </div>
        <Field
          label="Account ID"
          hint="32 hex characters, shown on the account's Overview page."
        >
          <Input
            name="account_id"
            required
            autoFocus
            autoComplete="off"
            spellCheck={false}
            pattern="[0-9a-fA-F]{32}"
            placeholder="0123456789abcdef0123456789abcdef"
            className="font-mono text-xs"
          />
        </Field>
        <Field label="API token">
          <Input
            name="api_token"
            type="password"
            required
            autoComplete="off"
            placeholder="Paste the token"
            className="font-mono text-xs"
          />
        </Field>
        <Feedback action={action} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" isLoading={action.busy}>
            {action.busy ? "Checking with Cloudflare…" : reconnect ? "Reconnect" : "Connect"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

type View = "projects" | "unassigned" | "ignored";

/** A discovered resource joined with its saved link (if any) and its Cloudflare detail. */
type Linked = {
  key: string;
  kind: ProjectResource["kind"];
  name: string;
  record?: ProjectResource;
  worker?: CloudflareWorker;
  page?: CloudflarePage;
};

/**
 * One project's band in the ledger: identity on the left, its resources on
 * the right, grouped by environment in canonical order. Environments are
 * captioned only when the project spans more than one, or when the only one
 * is not production.
 */
function ProjectBand({
  project,
  hue,
  rows,
  account,
  onOpen,
}: {
  project: Project | undefined;
  hue: number | undefined;
  rows: Linked[];
  account: string | null;
  onOpen: () => void;
}) {
  const byEnv = ENVIRONMENTS.map((env) => ({
    env,
    rows: rows.filter((r) => (r.record?.environment ?? "production") === env),
  })).filter((g) => g.rows.length);
  const environments = byEnv.map((g) => g.env);
  const caption = environments.length > 1 || environments[0] !== "production";
  const workers = rows.filter((r) => r.kind === "worker").length;
  const pages = rows.length - workers;
  const name = project?.name ?? "Project no longer exists";
  return (
    <article className={cn("grid gap-x-8 gap-y-3 px-4 py-4 sm:px-5 lg:gap-y-0", BAND_GRID)}>
      <header className="flex min-w-0 items-start gap-3">
        <ProjectMark name={name} hue={hue} size={36} />
        <div className="flex min-w-0 flex-col gap-1">
          {project ? (
            <button
              type="button"
              onClick={onOpen}
              className="group/name inline-flex min-w-0 max-w-full items-center gap-1 self-start rounded-sm text-left text-[15px] font-semibold leading-tight tracking-tight outline-none hover:text-primary focus-visible:text-primary focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              <span className="truncate">{project.name}</span>
              <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-[opacity,transform] group-hover/name:translate-x-px group-hover/name:opacity-100 group-focus-visible/name:opacity-100 motion-reduce:transition-none" />
            </button>
          ) : (
            <span className="text-[15px] font-semibold leading-tight tracking-tight text-muted-foreground">
              {name}
            </span>
          )}
          <Meta>{kindsLabel(workers, pages)}</Meta>
          {project?.repository && (
            <Meta className="flex min-w-0 items-center gap-1">
              <GitFork className="size-3 shrink-0" />
              <span className="truncate">{project.repository}</span>
            </Meta>
          )}
          <EnvironmentChips environments={environments} className="mt-0.5" />
        </div>
      </header>
      <div className="flex min-w-0 flex-col gap-2">
        {byEnv.map((g) => (
          <section key={g.env} className="flex flex-col">
            {caption && <EnvironmentCaption env={g.env} />}
            <ul className="flex flex-col divide-y divide-border/60">
              {g.rows.map((r) => (
                <LinkedRow key={r.key} r={r} account={account} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </article>
  );
}

function EnvironmentCaption({ env }: { env: ResourceEnvironment }) {
  return (
    <span className="flex items-center gap-2 pb-1 pt-1 first:pt-0">
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-[1px]",
          env === "production" ? "bg-primary" : "bg-muted-foreground/60",
        )}
      />
      <Eyebrow className={cn(env === "production" && "text-primary/80")}>{env}</Eyebrow>
    </span>
  );
}

/** Something the user should look at, with the action that resolves it. */
type Attention = { key: string; text: string; action?: { label: string; run: () => void } };

/**
 * Projects on Cloudflare, next to what runs on the user's machines. Read-only;
 * everything shown is what Cloudflare reported at `checked_at`. Metrics are
 * 24h sampled estimates, absent ones stay "—", and nothing here is a serving
 * check. With project organization, resources sit under the project the user
 * sorted them into; nothing here ever writes to Cloudflare.
 */
export function CloudflareSection({
  data,
  refresh,
  onSelectProject,
  delay = 0,
  compact: compactRows = false,
  organizeRequest = 0,
}: {
  data: Snapshot;
  refresh: () => Promise<unknown>;
  onSelectProject: (p: Project) => void;
  delay?: number;
  /** First-run page: shorter lists so the setup path stays the focus. */
  compact?: boolean;
  /** Bumped by the shell when another page asks to open the organizer here. */
  organizeRequest?: number;
}) {
  const [overview, setOverview] = useState<CloudflareOverview>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [dialog, setDialog] = useState<"connect" | "reconnect" | "organize" | null>(null);
  const [organizeKey, setOrganizeKey] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [view, setView] = useState<View>("projects");
  const disconnect = useAction();
  // Every load and every connection change starts a new generation; an
  // answer from an older generation is dropped so a slow refresh can never
  // paint a previous account over a disconnect or reconnect.
  const generation = useRef(0);

  const settle = useCallback((next: CloudflareOverview | undefined, error = "") => {
    generation.current++;
    setOverview(next);
    setLoadError(error);
    setLoading(false);
  }, []);
  const load = useCallback(async () => {
    const gen = ++generation.current;
    setLoading(true);
    setLoadError("");
    try {
      const next = await api<CloudflareOverview>("/integrations/cloudflare/overview");
      if (gen !== generation.current) return;
      setOverview(next);
    } catch (e) {
      if (gen !== generation.current) return;
      // A failed refresh never leaves a previous account's data on screen.
      setOverview(undefined);
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      if (gen === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);
  // A request from elsewhere opens the organizer once Cloudflare has answered.
  const handledRequest = useRef(0);
  const canOrganize = Boolean(overview?.organization && data.capabilities?.project_organization);
  useEffect(() => {
    if (organizeRequest === handledRequest.current || !canOrganize) return;
    handledRequest.current = organizeRequest;
    setDialog("organize");
    document.getElementById("cloudflare-heading")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [organizeRequest, canOrganize]);

  const status = overview?.status ?? (loadError ? "error" : "loading");
  const connected = status === "connected" || status === "partial";
  const workers = overview?.workers ?? [];
  const pages = overview?.pages ?? [];
  const issues = overview?.issues ?? [];
  const workersState = inventory("Workers", issues, workers.length);
  const pagesState = inventory("Pages", issues, pages.length);
  const cap = compactRows && !expanded ? COMPACT_ROWS : Infinity;
  const countLabel = (state: Inventory, n: number, noun: string) =>
    state === "unavailable"
      ? `${noun} unavailable`
      : `${n}${state === "incomplete" ? "+" : ""} ${noun}`;

  // Organization: the control plane's saved links joined onto what Cloudflare
  // reported now. Saved links for resources Cloudflare no longer lists stay
  // visible under their project so the user can unassign them.
  const organization = overview?.organization;
  const organized = Boolean(organization && data.capabilities?.project_organization);
  const account = overview?.account_id ?? null;
  const linked = useMemo<Linked[]>(() => {
    // Only this account's links join onto its inventory; links from another
    // account still show under their project as not reported here.
    const mine = (organization?.resources ?? []).filter((r) => r.account_id === account);
    const records = new Map(mine.map((r) => [resourceKey(r), r]));
    const rows: Linked[] = [
      ...workers.map((w) => ({ key: `worker:${w.name}`, kind: "worker" as const, name: w.name, worker: w })),
      ...pages.map((p) => ({ key: `pages:${p.name}`, kind: "pages" as const, name: p.name, page: p })),
    ];
    for (const row of rows) row.record = records.get(row.key);
    const seen = new Set(rows.map((r) => r.key));
    for (const r of organization?.resources ?? [])
      if ((r.account_id !== account || !seen.has(resourceKey(r))) && (r.project_id || r.ignored))
        rows.push({ key: `${r.account_id}:${resourceKey(r)}`, kind: r.kind, name: r.name, record: r });
    return rows;
  }, [organization, account, workers, pages]);
  const unassigned = linked.filter((r) => !r.record || (!r.record.project_id && !r.record.ignored));
  const ignored = linked.filter((r) => r.record?.ignored);
  const hues = useMemo(() => projectHues(data.projects), [data.projects]);
  const groups = useMemo(() => {
    const map = new Map<string, Linked[]>();
    for (const r of linked)
      if (r.record?.project_id && !r.record.ignored)
        map.set(r.record.project_id, [...(map.get(r.record.project_id) ?? []), r]);
    return [...map.entries()]
      .map(([id, rows]) => ({
        id,
        project: data.projects.find((p) => p.id === id),
        rows: rows.sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => (a.project?.name ?? "").localeCompare(b.project?.name ?? ""));
  }, [linked, data.projects]);
  const hidden = organized
    ? 0
    : Math.max(0, workers.length - cap) + Math.max(0, pages.length - cap);

  // What needs a look: only things observed, each with its way out. Sampled
  // error counts are listed as counts, never as a health verdict.
  const attention: Attention[] = [];
  if (connected) {
    if (status === "partial")
      for (const issue of issues) attention.push({ key: `issue:${issue}`, text: issue });
    if (organized && unassigned.length > 0)
      attention.push({
        key: "unassigned",
        text: `${unassigned.length} resource${unassigned.length === 1 ? "" : "s"} not in any project yet`,
        action: { label: "Organize", run: () => setDialog("organize") },
      });
    const missing = linked.filter((r) => r.record?.project_id && !r.record.ignored && !r.worker && !r.page);
    const gone = missing.filter((r) => r.record!.account_id === account);
    const foreign = missing.length - gone.length;
    if (gone.length)
      attention.push({
        key: "gone",
        text: `${gone.length} linked resource${gone.length === 1 ? " is" : "s are"} no longer reported by Cloudflare`,
        action: { label: "Review", run: () => setDialog("organize") },
      });
    if (foreign)
      attention.push({
        key: "foreign",
        text: `${foreign} linked resource${foreign === 1 ? " comes" : "s come"} from an account that is not connected`,
      });
    const erroring = workers.filter((w) => (w.errors ?? 0) > 0);
    if (erroring.length)
      attention.push({
        key: "errors",
        text: `${erroring.map((w) => `${w.name}: ${count(w.errors)} error${w.errors === 1 ? "" : "s"}`).join(" · ")} in Cloudflare's ${windowLabel(overview!.window)}, not a serving check`,
      });
  }
  const errorsKnown = workers.length > 0 && workers.every((w) => w.errors !== null);

  const title = !connected
    ? "Cloudflare"
    : organized && groups.length > 0
      ? "Projects on Cloudflare"
      : "Already in your Cloudflare account";

  return (
    <Reveal delay={delay}>
      <section className="flex flex-col gap-4" aria-labelledby="cloudflare-heading">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="flex min-w-0 flex-col gap-1">
            <Eyebrow>Cloudflare</Eyebrow>
            <h2 id="cloudflare-heading" className="text-lg font-semibold tracking-tight">
              {title}
            </h2>
            {connected && (
              <Meta className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span>{countLabel(workersState, workers.length, "Workers")}</span>
                <span aria-hidden>·</span>
                <span>{countLabel(pagesState, pages.length, "Pages")}</span>
                {organized && groups.length > 0 && (
                  <>
                    <span aria-hidden>·</span>
                    <span>
                      {groups.length} project{groups.length === 1 ? "" : "s"}
                    </span>
                  </>
                )}
                {overview?.checked_at && (
                  <>
                    <span aria-hidden>·</span>
                    <span>{checkedLabel(overview.checked_at)}</span>
                  </>
                )}
                {workers.length > 0 && !errorsKnown && (
                  <>
                    <span aria-hidden>·</span>
                    <span>error counts unavailable</span>
                  </>
                )}
              </Meta>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {connected && organized && linked.length > 0 && (
              <Button
                size="sm"
                variant={unassigned.length > 0 ? "default" : "outline"}
                onClick={() => setDialog("organize")}
              >
                <FolderTree />
                {unassigned.length > 0
                  ? `Organize ${unassigned.length} unassigned`
                  : "Organize"}
              </Button>
            )}
            {status === "not_connected" && (
              <Button size="sm" onClick={() => setDialog("connect")}>
                <Cloud />
                Connect account
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              aria-label="Refresh Cloudflare overview"
              title="Refresh (Cloudflare data is cached for a minute)"
              disabled={loading}
              onClick={() => void load()}
            >
              <RefreshCw className={cn(loading && "animate-spin motion-reduce:animate-none")} />
            </Button>
          </div>
        </div>

        <Feedback action={disconnect} />

        {status === "loading" && (
          <div role="status" className="flex items-center gap-2 py-2">
            <StatusDot status="pending" />
            <Meta>Asking Cloudflare…</Meta>
          </div>
        )}
        {status === "error" && (
          <Alert variant="destructive" className="flex flex-col gap-1">
            <span className="font-medium">
              {overview ? "Cloudflare could not be read" : "Cloudflare overview unavailable"}
            </span>
            {(overview?.issues.length ? overview.issues : [loadError]).map((issue) => (
              <Meta key={issue} className="text-destructive/80">
                {issue}
              </Meta>
            ))}
            {!overview && (
              <div>
                <Button size="xs" variant="outline" onClick={() => void load()}>
                  <RefreshCw />
                  Try again
                </Button>
              </div>
            )}
          </Alert>
        )}
        {status === "not_connected" && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-border px-4 py-3">
            <span className="text-sm text-muted-foreground">
              Connect a Cloudflare account to see its Workers and Pages here,
              with request and error counts for the last day. Existing apps
              become projects as they are; no machine or repository needed.
            </span>
            <Meta>Read-only · account-scoped token</Meta>
          </div>
        )}

        {attention.length > 0 && (
          <ul
            aria-label="Needs a look"
            className="flex flex-col divide-y divide-border/60 rounded-lg border border-yellow-500/25 bg-yellow-500/[0.04]"
          >
            {attention.map((a) => (
              <li key={a.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <StatusDot status="degraded" />
                <span className="min-w-0 flex-1 text-sm">{a.text}</span>
                {a.action && (
                  <Button size="xs" variant="outline" onClick={a.action.run}>
                    {a.action.label}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        {connected && (
          <>
            {organized && (
              <div
                role="tablist"
                aria-label="Cloudflare resource views"
                className="flex flex-wrap items-center gap-1"
              >
                {(
                  [
                    ["projects", "By project", groups.length],
                    ["unassigned", "Unassigned", unassigned.length],
                    ["ignored", "Ignored", ignored.length],
                  ] as [View, string, number][]
                ).map(([id, label, n]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={view === id}
                    onClick={() => setView(id)}
                    className={cn(
                      "gh-interactive flex h-7 items-center gap-1.5 rounded-md border px-2 font-mono text-[11px] transition-colors",
                      view === id
                        ? "border-border bg-accent text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {label}
                    <span className={cn("tabular-nums", view === id ? "text-foreground/70" : "text-muted-foreground/70")}>
                      {n}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {organized && view === "projects" &&
              (groups.length ? (
                <div className="gh-surface flex flex-col rounded-lg">
                  <div className={cn("grid gap-x-8 border-b border-border px-4 py-2 sm:px-5", BAND_GRID)}>
                    <Eyebrow className="hidden lg:block">project</Eyebrow>
                    <ColumnHeads window={overview!.window} />
                  </div>
                  <div className="flex flex-col divide-y divide-border">
                    {groups.map((g) => (
                      <ProjectBand
                        key={g.id}
                        project={g.project}
                        hue={hues[g.id]}
                        rows={g.rows}
                        account={account}
                        onOpen={() => g.project && onSelectProject(g.project)}
                      />
                    ))}
                  </div>
                  <Meta className="border-t border-border px-4 py-2 sm:px-5">
                    Uploaded scripts and production deployments, not serving status.
                    Counts are Cloudflare's {windowLabel(overview!.window)}; "—" means it did not report one.
                  </Meta>
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-border px-4 py-3">
                  <span className="text-sm text-muted-foreground">
                    {linked.length
                      ? "Nothing is sorted into a project yet. Suggestions come from resource names; you decide what sticks."
                      : "Cloudflare reported no Workers or Pages to organize."}
                  </span>
                  {linked.length > 0 && (
                    <Button size="sm" onClick={() => setDialog("organize")}>
                      <FolderTree />
                      Organize
                    </Button>
                  )}
                </div>
              ))}

            {organized && view === "unassigned" && (
              <div className="gh-surface flex flex-col divide-y divide-border rounded-lg">
                <div className="px-4 py-2 sm:px-5">
                  <ColumnHeads window={overview!.window} />
                </div>
                <KindList
                  label="Worker scripts"
                  state={workersState}
                  total={unassigned.filter((r) => r.kind === "worker").length}
                  empty="Every Worker script has a project or is ignored."
                >
                  {unassigned
                    .filter((r) => r.worker)
                    .slice(0, cap)
                    .map((r) => (
                      <WorkerRow key={r.key} w={r.worker!} />
                    ))}
                </KindList>
                <KindList
                  label="Pages projects"
                  state={pagesState}
                  total={unassigned.filter((r) => r.kind === "pages").length}
                  empty="Every Pages project has a project or is ignored."
                >
                  {unassigned
                    .filter((r) => r.page)
                    .slice(0, cap)
                    .map((r) => (
                      <PageRow key={r.key} p={r.page!} />
                    ))}
                </KindList>
              </div>
            )}

            {organized && view === "ignored" &&
              (ignored.length ? (
                <ul className="gh-surface flex flex-col divide-y divide-border rounded-lg">
                  {ignored.map((r) => (
                    <li key={r.key} className="flex flex-wrap items-center gap-2 px-4 py-2 sm:px-5">
                      <span className="truncate text-sm">{r.name}</span>
                      <Badge variant="outline">{KIND_LABEL[r.kind]}</Badge>
                      {!r.worker && !r.page && <Meta>not reported by Cloudflare now</Meta>}
                    </li>
                  ))}
                </ul>
              ) : (
                <Meta>Nothing ignored. Ignore resources you do not want to see from Organize.</Meta>
              ))}

            {!organized && (
              <div className="gh-surface flex flex-col divide-y divide-border rounded-lg">
                <div className="px-4 py-2 sm:px-5">
                  <ColumnHeads window={overview!.window} />
                </div>
                <KindList
                  label="Worker scripts"
                  state={workersState}
                  total={workers.length}
                  empty="No Worker scripts uploaded to this account."
                >
                  {workers.slice(0, cap).map((w) => (
                    <WorkerRow key={w.name} w={w} />
                  ))}
                </KindList>
                <KindList
                  label="Pages projects"
                  state={pagesState}
                  total={pages.length}
                  empty="No Pages projects in this account."
                >
                  {pages.slice(0, cap).map((p) => (
                    <PageRow key={p.name} p={p} />
                  ))}
                </KindList>
              </div>
            )}
            {hidden > 0 && (
              <div>
                <Button size="xs" variant="outline" onClick={() => setExpanded(true)}>
                  Show all ({hidden} more)
                </Button>
              </div>
            )}
          </>
        )}

        {(connected || status === "error") && overview && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {overview.account_id && (
              <Meta title={overview.account_id}>account {overview.account_id.slice(0, 8)}…</Meta>
            )}
            <Meta>read-only token</Meta>
            <span className="flex items-center gap-0.5">
              <Button
                size="xs"
                variant="ghost"
                className="text-muted-foreground"
                onClick={() => setDialog("reconnect")}
              >
                Reconnect
              </Button>
              <Button
                size="xs"
                variant="ghost"
                className="text-muted-foreground"
                isLoading={disconnect.busy}
                onClick={() => {
                  if (!confirm("Disconnect this Cloudflare account? Managed hosting is not affected."))
                    return;
                  void disconnect.run(async () => {
                    await api("/integrations/cloudflare/account", undefined, "DELETE");
                    settle(undefined);
                    await load();
                  }, "");
                }}
              >
                {!disconnect.busy && <Unplug />}
                Disconnect
              </Button>
            </span>
          </div>
        )}

        {(dialog === "connect" || dialog === "reconnect") && (
          <ConnectDialog
            reconnect={dialog === "reconnect"}
            onClose={() => setDialog(null)}
            onConnected={(next) => {
              settle(next);
              setDialog(null);
            }}
          />
        )}
        {dialog === "organize" && overview && organization && (
          <OrganizeDialog
            key={organizeKey}
            overview={overview}
            organization={organization}
            projects={data.projects}
            onClose={() => setDialog(null)}
            onSaved={(result) => {
              settle({ ...overview, organization: result.organization });
              setDialog(null);
              setView("projects");
              void refresh();
            }}
            onReload={async () => {
              await Promise.all([load(), refresh()]);
              setOrganizeKey((k) => k + 1);
            }}
          />
        )}
      </section>
    </Reveal>
  );
}
