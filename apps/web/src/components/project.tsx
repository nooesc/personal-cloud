import { AppleJobs } from "./apple-jobs";
import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  Box,
  Cloud,
  ExternalLink,
  GitBranch,
  GitFork,
  Plus,
  Rocket,
  Trash2,
  X,
} from "lucide-react";
import {
  ApiError,
  api,
  type Deployment,
  type Project,
  type Readiness,
  type Service,
  type Snapshot,
} from "../lib/data";
import { cn } from "../lib/utils";
import {
  Feedback,
  Field,
  Secret,
  Submit,
  useAction,
  type LiveProps,
} from "./live";
import { ReadinessSummary } from "./readiness";
import {
  LinkRepository,
  ProjectResources,
  environmentsOf,
  imported,
  projectResources,
} from "./project-resources";
import { Domains, HostnameField } from "./resources";
import { Databases } from "./databases";
import { ServiceFields, serviceFields, slug } from "./service-fields";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Alert, EmptyState, Meta, StatusDot } from "./ui/misc";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

const logClasses =
  "rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all custom-logs-scrollbar max-h-80 min-h-20 overflow-auto";
const summaryClasses =
  "cursor-pointer select-none text-sm font-medium text-muted-foreground hover:text-foreground";

function statusVariant(status?: string) {
  switch (status) {
    case "healthy":
    case "running":
      return "green" as const;
    case "queued":
    case "building":
    case "deploying":
    case "pending":
      return "yellow" as const;
    case "failed":
    case "unhealthy":
      return "red" as const;
    default:
      return "blank" as const;
  }
}
/** `not_deployed` → "not deployed"; the badge capitalises. */
function statusLabel(status?: string) {
  return (status ?? "not deployed").replaceAll("_", " ");
}
function ago(iso: string) {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export const PROJECT_TABS = ["services", "cloudflare", "environment", "databases", "domains", "apple"] as const;
export type ProjectTab = (typeof PROJECT_TABS)[number];
const TAB_LABEL: Record<ProjectTab, string> = {
  apple: "Apple jobs",
  services: "Services",
  cloudflare: "Cloudflare",
  environment: "Environment",
  databases: "Databases",
  domains: "Domains",
};

/** Which tabs a project offers; Cloudflare only where resources can be organized. */
export function projectTabs(project: Project, data: Snapshot): ProjectTab[] {
  const organized = Boolean(data.capabilities?.project_organization);
  const withCloudflare =
    organized && (projectResources(data, project.id).length || imported(project));
  const tabs: ProjectTab[] = withCloudflare
    ? ["services", "cloudflare", "environment", "databases", "domains"]
    : ["services", "environment", "databases", "domains"];
  if (data.capabilities?.apple_jobs) tabs.push("apple");
  return tabs;
}

/**
 * The project's sections. Tab and open service are owned by the caller so
 * they can live in the URL; the page above supplies identity and actions.
 */
export function ProjectTabs({
  project,
  data,
  refresh,
  live,
  tab,
  onTab,
  serviceId,
  onService,
  addService,
  onLinkRepository,
  onOrganize,
  onOpenDatabase,
}: {
  project: Project;
  tab: ProjectTab;
  onTab: (tab: ProjectTab) => void;
  serviceId?: string;
  onService: (id: string | undefined) => void;
  addService: () => void;
  onLinkRepository: () => void;
  /** Opens the Cloudflare organize flow (hosted control planes only). */
  onOrganize?: () => void;
  onOpenDatabase: (id: string) => void;
} & LiveProps) {
  const resources = projectResources(data, project.id),
    noRepo = imported(project);
  const services = data.services.filter((s) => s.project_id === project.id),
    service = services.find((s) => s.id === serviceId);
  const tabs = projectTabs(project, data);
  return (
    <Tabs
      value={tab}
      // Changing section also closes the open service; the caller owns both.
      onValueChange={(next) => onTab(next as ProjectTab)}
      className="gap-4"
    >
      <TabsList
        variant="line"
        aria-label="Project sections"
        className="w-full justify-start overflow-x-auto border-b border-border"
      >
        {tabs.map((t) => (
          <TabsTrigger key={t} value={t} className="flex-none">
            {TAB_LABEL[t]}
            {t === "cloudflare" && resources.length > 0 && (
              <Meta className="ml-1">{resources.length}</Meta>
            )}
            {t === "services" && services.length > 0 && (
              <Meta className="ml-1">{services.length}</Meta>
            )}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="services" className="flex flex-col gap-6">
        {services.length ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {services.map((s) => (
              <ServiceCard
                key={s.id}
                service={s}
                host={
                  data.machines.find((m) => m.id === s.machine_id)?.report.hostname ??
                  s.placement.kind
                }
                selected={s.id === serviceId}
                onSelect={() => onService(s.id === serviceId ? undefined : s.id)}
              />
            ))}
          </div>
        ) : noRepo ? (
          <EmptyState
            icon={<Box />}
            title="Runs on Cloudflare as it is"
            description="Link a repository whenever you want to build and run services on your machines. Nothing is required."
            action={
              <Button size="sm" variant="outline" onClick={onLinkRepository}>
                <GitFork />
                Link repository
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={<Box />}
            title={`Add the first service to ${project.name}`}
            description="We build from your repository and run it on your machines."
            action={
              <Button size="sm" variant="outline" onClick={addService}>
                <Plus />
                Add service
              </Button>
            }
          />
        )}
        {service && (
          <ServiceDetail
            key={service.id}
            service={service}
            data={data}
            refresh={refresh}
            live={live}
            onClose={() => onService(undefined)}
            onRemove={() => onService(undefined)}
          />
        )}
      </TabsContent>
      {tabs.includes("cloudflare") && (
        <TabsContent value="cloudflare">
          <ProjectResources project={project} data={data} onOrganize={onOrganize} />
        </TabsContent>
      )}
      {tabs.includes("apple") && <TabsContent value="apple"><AppleJobs project={project} data={data} /></TabsContent>}
      <TabsContent value="environment">
        <Environment project={project} live={live} />
      </TabsContent>
      <TabsContent value="databases">
        <Databases data={data} refresh={refresh} live={live} projectId={project.id} onOpen={onOpenDatabase} />
      </TabsContent>
      <TabsContent value="domains">
        <Domains data={data} refresh={refresh} live={live} projectId={project.id} />
      </TabsContent>
    </Tabs>
  );
}

/** Deletes the project after confirmation; the caller leaves the page. */
export function RemoveProject({
  project,
  live,
  refresh,
  onRemoved,
  className,
}: {
  project: Project;
  onRemoved: () => void;
  className?: string;
} & LiveProps) {
  const action = useAction(),
    noRepo = imported(project);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className={cn("text-muted-foreground hover:text-destructive", className)}
        disabled={!live || action.busy}
        onClick={() => {
          if (
            confirm(
              noRepo
                ? `Remove project ${project.name}? Its Cloudflare resources stay untouched and become unassigned.`
                : `Delete project ${project.name} and stop its services? Database volumes are preserved.`,
            )
          )
            void action.run(async () => {
              await api(`/projects/${project.id}`, undefined, "DELETE");
              await refresh();
              onRemoved();
            }, "Project deleted");
        }}
      >
        <Trash2 />
        Remove
      </Button>
      <Feedback action={action} />
    </>
  );
}

function ServiceCard({
  service: s,
  host,
  selected,
  onSelect,
}: {
  service: Service;
  host: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const status = s.status;
  return (
    <div
      className={cn(
        "gh-surface gh-interactive relative flex min-w-0 flex-col gap-2 rounded-lg p-4",
        selected && "border-primary/60 ring-2 ring-primary/30",
      )}
    >
      <button
        type="button"
        aria-pressed={selected}
        aria-label={`${selected ? "Close" : "Open"} ${s.name}`}
        onClick={onSelect}
        className="absolute inset-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      />
      <div className="flex min-w-0 items-center gap-2">
        <StatusDot status={status} />
        <span className="truncate text-[15px] font-medium">{s.name}</span>
        <Badge variant={statusVariant(status)} className="ml-auto capitalize">
          {statusLabel(status)}
        </Badge>
      </div>
      <Meta className="truncate">
        :{s.port} · {host} · {s.root_directory ?? "."}
      </Meta>
      {s.address && (
        <a
          href={s.address}
          target="_blank"
          rel="noreferrer"
          className="relative z-10 inline-flex w-fit items-center gap-1 font-mono text-[11px] text-muted-foreground tabular-nums hover:text-foreground"
        >
          <span className="truncate">{s.address}</span>
          <ArrowUpRight className="size-3 shrink-0" />
        </a>
      )}
    </div>
  );
}

function Environment({ project, live }: { project: Project; live: boolean }) {
  const [variables, setVariables] = useState<
      { key: string; updated_at: string }[]
    >([]),
    [secret, setSecret] = useState<{ key: string; value: string }>(),
    action = useAction(),
    [loading, setLoading] = useState(live);
  const path = `/projects/${project.id}/environment`;
  async function load() {
    const result = await api<{ variables: typeof variables }>(path);
    setVariables(result.variables);
  }
  useEffect(() => {
    if (live) void action.run(load, "").finally(() => setLoading(false));
  }, [project.id, live]);
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        Encrypted variables are applied on the next deployment. Reveal a value
        only when you need it.
      </p>
      {loading && (
        <Meta role="status" className="block">
          Loading environment…
        </Meta>
      )}
      {variables.length > 0 && (
        <div className="divide-y divide-border rounded-lg border border-border">
          {variables.map((v) => (
            <div
              className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3"
              key={v.key}
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <code className="truncate font-mono text-xs">{v.key}</code>
                <Meta title={new Date(v.updated_at).toLocaleString()}>
                  Updated {ago(v.updated_at)}
                </Meta>
              </div>
              <div className="ml-auto flex min-w-0 items-center gap-2">
                {secret?.key === v.key ? (
                  <>
                    <Secret value={secret.value} />
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => setSecret(undefined)}
                    >
                      Hide
                    </Button>
                  </>
                ) : (
                  <>
                    <Meta aria-hidden>••••••••</Meta>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={action.busy}
                      onClick={() =>
                        action.run(async () => {
                          const result = await api<{ value: string }>(
                            `${path}/${encodeURIComponent(v.key)}/reveal`,
                          );
                          setSecret({ key: v.key, value: result.value });
                        }, "")
                      }
                    >
                      Reveal
                    </Button>
                  </>
                )}
                <Button
                  size="xs"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  disabled={action.busy}
                  onClick={() => {
                    if (confirm(`Delete ${v.key}? Applies on next deployment.`))
                      void action.run(async () => {
                        await api(
                          `${path}/${encodeURIComponent(v.key)}`,
                          undefined,
                          "DELETE",
                        );
                        setSecret(undefined);
                        await load();
                      }, "Variable deleted");
                  }}
                >
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      {!variables.length && !loading && (
        <Meta className="block">No variables yet.</Meta>
      )}
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          const element = e.currentTarget,
            form = new FormData(element);
          void action.run(async () => {
            await api(
              path,
              { key: form.get("key"), value: form.get("value") },
              "PUT",
            );
            element.reset();
            setSecret(undefined);
            await load();
          }, "Variable saved. Redeploy services to apply it.");
        }}
      >
        <span className="gh-eyebrow">Add or update variable</span>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Key">
            <Input
              name="key"
              required
              pattern="[A-Za-z_][A-Za-z0-9_]*"
              placeholder="API_KEY"
            />
          </Field>
          <Field label="Value" name="value" type="password" />
        </div>
        <div>
          <Submit busy={action.busy || !live}>Save variable</Submit>
        </div>
      </form>
      <Feedback action={action} />
    </div>
  );
}

function logText(line: unknown) {
  if (typeof line === "string") return line;
  if (line && typeof line === "object") {
    const row = line as Record<string, unknown>;
    return [
      row.created_at ?? row.timestamp,
      row.message ?? row.line ?? row.text ?? JSON.stringify(line),
    ]
      .filter(Boolean)
      .join(" ");
  }
  return String(line);
}

function ServiceDetail({
  service: s,
  data,
  refresh,
  live,
  onClose,
  onRemove,
}: { service: Service; onClose: () => void; onRemove: () => void } & LiveProps) {
  const [tab, setTab] = useState("Deployments"),
    [selected, setSelected] = useState<string>(),
    [deployment, setDeployment] = useState<Deployment>(),
    [lines, setLines] = useState<unknown[]>([]),
    [metrics, setMetrics] = useState<Record<string, unknown>>({}),
    [readError, setReadError] = useState(""),
    [loading, setLoading] = useState(false),
    [preflight, setPreflight] = useState<Readiness>(),
    [launching, setLaunching] = useState(false),
    [launchError, setLaunchError] = useState(""),
    [publishing, setPublishing] = useState(false),
    action = useAction();
  const deployments = data.deployments
      .filter((d) => d.service_id === s.id)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)),
    active = selected ?? deployments[0]?.id ?? s.current_deployment_id,
    deploying = deployments.some((d) =>
      ["queued", "building", "deploying"].includes(d.status),
    ),
    status = s.status,
    host = data.machines.find((m) => m.id === s.machine_id)?.report.hostname,
    domain = data.domains.find((d) => d.service_id === s.id),
    canPublish = status === "healthy" || status === "running",
    project = data.projects.find((p) => p.id === s.project_id);
  /**
   * Readiness comes only from the control plane: preflight first, and the
   * deploy gate's own answer if it disagrees by the time we ask. Control
   * planes that publish no readiness (legacy self-hosted) have no preflight
   * endpoint; their POST deploy performs the authoritative runtime checks.
   */
  async function launch() {
    setLaunching(true);
    setLaunchError("");
    setPreflight(undefined);
    try {
      if (data.readiness) {
        const check = await api<Readiness>(`/services/${s.id}/preflight`);
        if (check.status !== "ready") {
          setPreflight(check);
          return;
        }
      }
      await api<Deployment>(`/services/${s.id}/deploy`, {});
      setSelected(undefined);
      setTab("Deployments");
      await refresh();
    } catch (e) {
      if (e instanceof ApiError && e.readiness) setPreflight(e.readiness);
      else setLaunchError(e instanceof Error ? e.message : String(e));
    } finally {
      setLaunching(false);
    }
  }
  useEffect(() => {
    if (!live || tab !== "Logs") return;
    let ended = false,
      socket: WebSocket | undefined,
      retry: ReturnType<typeof setTimeout>;
    function connect() {
      setLoading(true);
      socket = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/services/${s.id}/events`,
      );
      socket.onmessage = (event) => {
        if (ended) return;
        try {
          const value = JSON.parse(event.data);
          if (value.type === "unavailable") {
            setReadError(value.error || "Service observability is unavailable");
          } else {
            setLines(value.lines || []);
            setMetrics({ ...value.metrics, restarts: value.restarts });
            setReadError("");
          }
          setLoading(false);
        } catch {
          setReadError("Unable to read service updates");
          setLoading(false);
        }
      };
      socket.onerror = () => {
        if (!ended) setReadError("Service updates interrupted. Reconnecting…");
      };
      socket.onclose = () => {
        if (!ended) retry = setTimeout(connect, 3000);
      };
    }
    connect();
    return () => {
      ended = true;
      clearTimeout(retry);
      socket?.close();
    };
  }, [s.id, tab, live]);
  useEffect(() => {
    if (!live || tab !== "Deployments" || !active) return;
    let ended = false;
    async function read() {
      try {
        const result = await api<Deployment & { deployment?: Deployment }>(
          `/deployments/${active}`,
        );
        if (!ended) {
          setDeployment(
            result.deployment
              ? { ...result.deployment, steps: result.steps, logs: result.logs }
              : result,
          );
          setReadError("");
        }
      } catch (e) {
        if (!ended) setReadError((e as Error).message);
      } finally {
        if (!ended) setLoading(false);
      }
    }
    setLoading(true);
    void read();
    const interval = setInterval(read, 3000);
    return () => {
      ended = true;
      clearInterval(interval);
    };
  }, [active, s.id, tab, live]);
  return (
    <section
      aria-label={`${s.name} service`}
      className="gh-surface flex flex-col gap-4 rounded-lg p-4 sm:p-6"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <StatusDot status={status} />
            <span className="truncate text-[15px] font-medium">{s.name}</span>
            <Badge variant={statusVariant(status)} className="capitalize">
              {statusLabel(status)}
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {domain ? (
              <a
                href={`https://${domain.hostname}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground tabular-nums hover:text-foreground"
              >
                {domain.hostname}
                <ExternalLink className="size-3" />
              </a>
            ) : s.address ? (
              <a
                href={s.address}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground tabular-nums hover:text-foreground"
              >
                {s.address}
                <ArrowUpRight className="size-3" />
              </a>
            ) : (
              <Meta>Not running</Meta>
            )}
            <Meta>:{s.port}</Meta>
            <Meta>{host ?? "No machine yet"}</Meta>
            {!domain && (
              <Button
                size="xs"
                variant="outline"
                disabled={!live || !canPublish}
                title={canPublish ? undefined : "Deploy a healthy version first"}
                onClick={() => setPublishing(!publishing)}
              >
                {publishing ? <X /> : <Plus />}
                {publishing ? "Cancel" : "Add public address"}
              </Button>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            disabled={!live || action.busy || deploying}
            isLoading={launching}
            title={deploying ? "A deployment is already running" : undefined}
            onClick={launch}
          >
            {launching ? (
              data.readiness ? "Checking…" : "Deploying…"
            ) : (
              <>
                <Rocket />
                Deploy
              </>
            )}
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Close service"
            onClick={onClose}
          >
            <X />
          </Button>
        </div>
      </div>
      {launchError && <Alert variant="destructive">{launchError}</Alert>}
      {preflight && (
        <ReadinessSummary
          readiness={preflight}
          className="rounded-lg border border-border p-3"
        />
      )}
      {publishing && !domain && (
        <form
          className="flex flex-col gap-4 rounded-lg border border-border p-4"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            void action.run(async () => {
              await api("/domains", {
                service_id: s.id,
                hostname: form.get("hostname"),
              });
              await refresh();
              setPublishing(false);
            }, "Public address requested");
          }}
        >
          <HostnameField
            data={data}
            defaultLabel={slug(project?.name ?? s.name)}
          />
          <Submit busy={action.busy || !live}>Add public address</Submit>
        </form>
      )}
      <Feedback action={action} />
      <Tabs value={tab} onValueChange={setTab} className="gap-4">
        <TabsList
          variant="line"
          aria-label="Service sections"
          className="w-full justify-start overflow-x-auto border-b border-border"
        >
          {["Overview", "Deployments", "Logs"].map((t) => (
            <TabsTrigger key={t} value={t} className="flex-none">
              {t}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="Overview">
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              void action.run(async () => {
                await api(`/services/${s.id}`, serviceFields(form), "PUT");
                await refresh();
              }, "Configuration saved. Deploy to apply changes.");
            }}
          >
            <ServiceFields data={data} service={s} mode="edit" />
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
              <Submit busy={action.busy || !live}>Save configuration</Submit>
              <Button
                variant="destructive"
                size="sm"
                disabled={!live || action.busy}
                onClick={() => {
                  if (confirm(`Stop and delete service ${s.name}?`))
                    void action.run(async () => {
                      await api(`/services/${s.id}`, undefined, "DELETE");
                      await refresh();
                      onRemove();
                    }, "Service deleted");
                }}
              >
                <Trash2 />
                Delete service
              </Button>
            </div>
          </form>
        </TabsContent>
        <TabsContent value="Deployments" className="flex flex-col gap-4">
          {deployment && (
            <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
              <div className="flex flex-wrap items-center gap-2">
                <StatusDot status={deployment.status} />
                <span className="text-sm font-medium">
                  Deployment{" "}
                  <span className="font-mono tabular-nums">
                    {deployment.id.slice(0, 8)}
                  </span>
                </span>
                <Badge
                  variant={statusVariant(deployment.status)}
                  className="capitalize"
                >
                  {statusLabel(deployment.status)}
                </Badge>
                <Meta className="ml-auto">
                  {deployment.step?.replaceAll("_", " ")}
                  {deployment.commit_sha &&
                    ` · ${deployment.commit_sha.slice(0, 8)}`}
                </Meta>
              </div>
              <BuildProgress deployment={deployment} />
            </section>
          )}
          {deployments.length > 0 && (
            <div className="divide-y divide-border rounded-lg border border-border">
              {deployments.map((d) => (
                <div
                  className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3"
                  key={d.id}
                >
                  <button
                    type="button"
                    aria-pressed={d.id === active}
                    onClick={() => setSelected(d.id)}
                    className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40"
                  >
                    <StatusDot status={d.status} />
                    <Meta className="text-foreground">
                      {d.commit_sha?.slice(0, 8) ?? d.id.slice(0, 8)}
                    </Meta>
                    <Badge
                      variant={statusVariant(d.status)}
                      className="capitalize"
                    >
                      {statusLabel(d.status)}
                    </Badge>
                    <Meta title={new Date(d.created_at).toLocaleString()}>
                      {ago(d.created_at)}
                    </Meta>
                    {d.step && (
                      <span className="hidden truncate text-sm text-muted-foreground sm:inline">
                        {d.step.replaceAll("_", " ")}
                      </span>
                    )}
                  </button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={
                      !live ||
                      action.busy ||
                      !d.image_digest ||
                      deploying ||
                      !["healthy", "rolled_back"].includes(d.status) ||
                      d.id === s.current_deployment_id
                    }
                    title={
                      deploying
                        ? "Wait for the active deployment to finish"
                        : !["healthy", "rolled_back"].includes(d.status)
                          ? "Only a previously healthy deployment can be restored"
                          : !d.image_digest
                            ? "This deployment has no reusable image"
                            : "Deploy this exact image without rebuilding"
                    }
                    onClick={() => {
                      if (confirm("Roll back to this deployment?"))
                        void action.run(async () => {
                          await api<Deployment>(`/services/${s.id}/rollback`, {
                            deployment_id: d.id,
                          });
                          setSelected(undefined);
                          await refresh();
                        }, "Rollback queued");
                    }}
                  >
                    Rollback
                  </Button>
                </div>
              ))}
            </div>
          )}
          {!deployments.length && (
            <EmptyState
              icon={<Rocket />}
              title="No deployments yet"
              description="Deploy builds your production branch and starts the service."
              className="py-10"
            />
          )}
          {readError && <Alert variant="destructive">{readError}</Alert>}
          <details className="group">
            <summary className={summaryClasses}>Deploy a specific image</summary>
            <form
              className="mt-3 flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                const form = new FormData(e.currentTarget);
                void action.run(async () => {
                  await api<Deployment>(`/services/${s.id}/deploy`, {
                    image: form.get("image"),
                  });
                  setSelected(undefined);
                  await refresh();
                }, "Image deployment queued");
              }}
            >
              <Field
                label="Image reference"
                hint="An exact image with its sha256 digest."
              >
                <Input
                  name="image"
                  required
                  placeholder="registry/app@sha256:…"
                  pattern=".+@sha256:[a-fA-F0-9]{64}"
                />
              </Field>
              <div>
                <Submit busy={action.busy || !live}>Deploy image</Submit>
              </div>
            </form>
          </details>
        </TabsContent>
        <TabsContent value="Logs" className="flex flex-col gap-4">
          <ServiceMetrics metrics={metrics} loading={loading} />
          {readError && <Alert variant="destructive">{readError}</Alert>}
          <div className="flex items-center justify-between gap-3">
            <span className="gh-eyebrow">Service logs</span>
            <Meta>Live runtime updates</Meta>
          </div>
          <pre className={logClasses} aria-label="Service logs">
            {lines.length
              ? lines.map(logText).join("\n")
              : loading
                ? "Loading logs…"
                : "No log lines available."}
          </pre>
          {Object.keys(metrics).length > 0 && (
            <details>
              <summary className={summaryClasses}>Raw runtime metrics</summary>
              <pre className={cn(logClasses, "mt-3")}>
                {JSON.stringify(metrics, null, 2)}
              </pre>
            </details>
          )}
        </TabsContent>
      </Tabs>
    </section>
  );
}

function BuildProgress({ deployment }: { deployment: Deployment }) {
  const steps = deployment.steps ?? [],
    logs = steps.filter((step) => step.step === "log"),
    byStage = new Map<string, NonNullable<Deployment["steps"]>[number]>();
  for (const step of steps)
    if (step.step !== "log" && step.step !== "failed")
      byStage.set(step.step ?? step.name ?? step.message ?? "progress", step);
  const milestones = [...byStage.values()];
  return (
    <>
      {milestones.length ? (
        <ol className="flex flex-col gap-2">
          {milestones.map((step, index) => {
            const last = index === milestones.length - 1;
            const failed = last && deployment.status === "failed";
            const running =
              last &&
              ["queued", "building", "deploying"].includes(deployment.status) &&
              !["upload", "health", "healthy"].includes(step.step ?? "");
            return (
              <li
                key={step.step ?? index}
                className="flex items-start gap-3"
                data-state={failed ? "failed" : running ? "running" : "done"}
              >
                <StatusDot
                  status={failed ? "failed" : running ? "running" : "done"}
                  className="mt-1.5"
                />
                <div className="flex min-w-0 flex-col">
                  <span
                    className={cn(
                      "text-sm",
                      failed && "text-destructive",
                      !failed && !running && "text-muted-foreground",
                    )}
                  >
                    {step.message ?? step.name ?? step.step}
                  </span>
                  <Meta>
                    {failed ? "Failed" : running ? "In progress" : "Complete"}
                  </Meta>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <Meta className="block">
          Waiting for build progress from the control plane.
        </Meta>
      )}
      {deployment.error && (
        <Alert variant="destructive">{deployment.error}</Alert>
      )}
      {logs.length > 0 || deployment.logs?.length ? (
        <details>
          <summary className={summaryClasses}>
            Build output · {logs.length + (deployment.logs?.length ?? 0)} lines
          </summary>
          <pre
            className={cn(logClasses, "mt-3")}
            aria-label="Deployment logs"
          >
            {[
              ...logs.map((step) => step.message ?? step.name ?? step.step),
              ...(deployment.logs ?? []).map(logText),
            ].join("\n")}
          </pre>
        </details>
      ) : null}
    </>
  );
}

function ServiceMetrics({
  metrics,
  loading,
}: {
  metrics: Record<string, unknown>;
  loading: boolean;
}) {
  const usage = metrics.ResourceUsage as
    | {
        CpuStats?: { Percent?: number };
        MemoryStats?: { Usage?: number; RSS?: number };
        NetworkStats?: { RxBytes?: number; TxBytes?: number };
      }
    | undefined;
  const waiting = metrics.Timestamp === 0;
  const cpu = usage?.CpuStats?.Percent,
    memory = usage?.MemoryStats?.Usage ?? usage?.MemoryStats?.RSS;
  const bytes = (value: number) =>
    value >= 1024 ** 3
      ? `${(value / 1024 ** 3).toFixed(2)} GB`
      : `${(value / 1024 ** 2).toFixed(1)} MB`;
  const network = usage?.NetworkStats;
  const tiles: [string, string, string][] = [
    [
      "CPU",
      !waiting && typeof cpu === "number" ? `${cpu.toFixed(1)}%` : "—",
      waiting ? "Waiting for first measurement" : "CPU usage",
    ],
    [
      "Memory",
      !waiting && typeof memory === "number" ? bytes(memory) : "—",
      waiting ? "Waiting for first measurement" : "Runtime memory usage",
    ],
    [
      "Network",
      !waiting &&
      typeof network?.RxBytes === "number" &&
      typeof network?.TxBytes === "number"
        ? `${bytes(network.RxBytes)} / ${bytes(network.TxBytes)}`
        : "—",
      "Received / sent",
    ],
    [
      "Restarts",
      typeof metrics.restarts === "number" ? String(metrics.restarts) : "—",
      "Current allocation",
    ],
  ];
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map(([label, value, detail]) => (
          <div
            key={label}
            className="gh-surface flex min-w-0 flex-col gap-1 rounded-lg p-3"
          >
            <span className="gh-eyebrow">{label}</span>
            <span className="truncate text-lg font-semibold tracking-tight tabular-nums">
              {value}
            </span>
            <Meta className="truncate">{detail}</Meta>
          </div>
        ))}
      </div>
      {waiting ? (
        <Meta role="status" className="block">
          Waiting for first measurement
        </Meta>
      ) : (
        !Object.keys(metrics).length && (
          <Meta role="status" className="block">
            {loading
              ? "Loading runtime metrics…"
              : "No runtime metrics reported."}
          </Meta>
        )
      )}
    </div>
  );
}
