import { hosted } from "../lib/hosted";
import { GitHubAppPanel } from "./github";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Check, ChevronRight, Copy, RefreshCw, Server, Trash2 } from "lucide-react";
import { api, type Snapshot, type Service, type Machine, type Provider } from "../lib/data";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card";
import { Checkbox, Input, Select, Textarea } from "./ui/input";
import { Alert, EmptyState, Eyebrow, Meta, Separator, StatusDot } from "./ui/misc";
export type LiveProps = {
  data: Snapshot;
  refresh: () => Promise<unknown>;
  live: boolean;
};
export type Action = {
  busy: boolean;
  error: string;
  message: string;
  run: (action: () => Promise<unknown>, success?: string) => Promise<void>;
};
export function useAction(): Action {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  async function run(action: () => Promise<unknown>, success = "Saved") {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
      setMessage(success);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, message, run };
}
export function Feedback({ action }: { action: Action }) {
  return (
    <>
      {action.error && <Alert variant="destructive">{action.error}</Alert>}
      {action.message && <Alert variant="success">{action.message}</Alert>}
    </>
  );
}
export function Submit({
  busy,
  children,
}: {
  busy: boolean;
  children: ReactNode;
}) {
  return (
    <Button type="submit" size="sm" isLoading={busy} className="self-start">
      {busy ? "Working…" : children}
    </Button>
  );
}
export function Field({
  label,
  name,
  value,
  type = "text",
  required = false,
  placeholder,
  hint,
  className,
  children,
}: {
  label: string;
  name?: string;
  value?: string | number;
  type?: string;
  required?: boolean;
  placeholder?: string;
  hint?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  const control =
    children ??
    (type === "textarea" ? (
      <Textarea
        name={name}
        defaultValue={value}
        required={required}
        placeholder={placeholder}
      />
    ) : (
      <Input
        name={name}
        defaultValue={value}
        type={type}
        required={required}
        placeholder={placeholder}
        autoComplete={type === "password" ? "new-password" : undefined}
      />
    ));
  return (
    <label className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <span className="text-sm leading-none font-medium select-none">
        {label}
      </span>
      {control}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}
function f(form: FormData, key: string) {
  return String(form.get(key) || "");
}
export function Secret({ value }: { value: string }) {
  const [copied, setCopied] = useState(false),
    [error, setError] = useState("");
  return (
    <div className="flex w-full flex-col gap-1">
      <div className="flex items-center gap-2">
        <Input
          aria-label="Revealed secret"
          readOnly
          value={value}
          className="font-mono text-xs"
        />
        <Button
          size="icon-sm"
          variant="outline"
          aria-label="Copy secret"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
            } catch {
              setError("Select the value to copy it manually.");
            }
          }}
        >
          {copied ? <Check className="text-primary" /> : <Copy />}
        </Button>
      </div>
      {error && <span className="text-xs text-muted-foreground">{error}</span>}
    </div>
  );
}
function Disclosure({
  title,
  defaultOpen,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="group rounded-lg border border-border" open={defaultOpen}>
      <summary className="gh-interactive flex cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium select-none [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 text-muted-foreground transition-transform group-open:rotate-90" />
        {title}
      </summary>
      <div className="flex flex-col gap-4 border-t border-border p-4">
        {children}
      </div>
    </details>
  );
}
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <Separator />
      <Eyebrow>{title}</Eyebrow>
      {children}
    </>
  );
}
function status(value: string | Provider | undefined) {
  return typeof value === "string" ? value : (value?.status ?? "not_connected");
}
function StatusBadge({ status }: { status: string }) {
  const variant =
    status === "connected" || status === "ready" || status === "healthy"
      ? "green"
      : status === "error" || status === "failed" || status === "unreachable"
        ? "red"
        : status === "checking"
          ? "yellow"
          : "blank";
  return <Badge variant={variant}>{status.replaceAll("_", " ")}</Badge>;
}
export function Setup({
  data,
  refresh,
  live,
  signIn,
  signOut,
  explore,
}: {
  data: Snapshot;
  refresh: () => Promise<unknown>;
  live: boolean;
  signIn: () => void;
  signOut: () => void;
  explore: () => void;
}) {
  const action = useAction(),
    [runtime, setRuntime] = useState<Record<string, unknown>>({}),
    [discovery, setDiscovery] = useState<{
      accounts: { id: string; name: string }[];
      zones: { id: string; name: string; account?: { id: string } }[];
    }>(),
    [webhook, setWebhook] = useState<Record<string, unknown>>();
  useEffect(() => {
    if (live)
      void api<Record<string, unknown>>("/runtime")
        .then(setRuntime)
        .catch(() => {});
  }, [live, data.generated_at]);
  async function save(
    e: FormEvent<HTMLFormElement>,
    path: string,
    transform?: (form: FormData) => unknown,
  ) {
    e.preventDefault();
    const element = e.currentTarget,
      form = new FormData(element);
    await action.run(async () => {
      await api(
        path,
        transform ? transform(form) : Object.fromEntries(form),
        "PUT",
      );
      element
        .querySelectorAll<HTMLInputElement>("input[type=password]")
        .forEach((x) => (x.value = ""));
      await refresh();
    });
  }
  const signedIn = live && !!data.generated_at,
    github = status(data.integrations.github),
    cloudflare = status(data.integrations.cloudflare),
    runtimeStatus = String(runtime.status ?? "checking"),
    checks: [string, boolean][] = [
      ["GitHub", github === "connected"],
      [hosted ? "Managed hosting" : "Cloudflare", cloudflare === "connected"],
      ["Machine", data.machines.some((m) => m.status === "online")],
      ["Application", data.services.some((s) => s.status === "healthy")],
    ];
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card className="lg:col-span-2">
        <CardHeader>
          <Eyebrow>Your first deployment</Eyebrow>
          <CardTitle>Connect your cloud</CardTitle>
          <CardDescription>
            {hosted ? "Choose your repositories and add a machine. Your applications run on your hardware; this workspace manages your fleet." : "Connect your source and Cloudflare, then add a machine. Your projects and credentials stay in your control plane."}
          </CardDescription>
          <CardAction>
            <Badge variant={signedIn ? "green" : "blank"}>
              {signedIn ? (hosted ? "signed in" : "owner signed in") : live ? "signed out" : "demo"}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {checks.map(([label, done], i) => (
              <li
                key={label}
                className="gh-surface flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm"
              >
                <span
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-full font-mono text-[11px] tabular-nums",
                    done
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {done ? <Check className="size-3" /> : i + 1}
                </span>
                {label}
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap items-center gap-2">
            {!signedIn && <Button variant="outline" size="sm" onClick={signIn}>
              {hosted ? "Sign in with GitHub" : "Owner sign in"}
            </Button>}
            <Button variant="link" size="sm" onClick={explore}>
              Explore sample workspace
            </Button>
            {signedIn && (
              <Button variant="link" size="sm" onClick={signOut}>
                Sign out
              </Button>
            )}
          </div>
          <Feedback action={action} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>GitHub</CardTitle>
          <CardDescription>
            Source access for the repositories this cloud can deploy.
          </CardDescription>
          <CardAction>
            <StatusBadge status={github} />
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <GitHubAppPanel live={signedIn} refresh={refresh} />
          {!hosted && (typeof data.integrations.github === "string" ||
            data.integrations.github.mode !== "github_app") && (
            <Section title="Advanced · personal access token">
              <form
                className="flex flex-col gap-4"
                onSubmit={(e) => save(e, "/integrations/github")}
              >
                <Field
                  label="GitHub access token"
                  name="token"
                  type="password"
                  required
                  placeholder="github_pat_…"
                  hint="Grant repository contents read access. Repository administration enables automatic webhook setup; otherwise the control plane polls for pushes."
                />
                <Submit busy={action.busy || !live}>Connect GitHub</Submit>
              </form>
              {github === "connected" && (
                <div className="flex flex-col gap-3">
                  <p className="text-xs text-muted-foreground">
                    For a public control plane, register the payload URL and
                    secret in your repository.
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        action.run(
                          async () =>
                            setWebhook(
                              await api("/integrations/github/webhook"),
                            ),
                          "Webhook details loaded",
                        )
                      }
                    >
                      Reveal webhook details
                    </Button>
                    {webhook && (
                      <Button
                        variant="link"
                        size="sm"
                        onClick={() => setWebhook(undefined)}
                      >
                        Hide details
                      </Button>
                    )}
                  </div>
                  {webhook && (
                    <div className="flex flex-col gap-4">
                      {Object.entries(webhook).map(([key, value]) => (
                        <Field key={key} label={key}>
                          <Secret
                            value={
                              typeof value === "string"
                                ? value
                                : JSON.stringify(value)
                            }
                          />
                        </Field>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </Section>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Cloudflare</CardTitle>
          <CardDescription>
            Your domains and private image storage, connected in one place.
          </CardDescription>
          <CardAction>
            <StatusBadge status={cloudflare} />
          </CardAction>
        </CardHeader>
        <CardContent>
          {hosted ? <p className="text-sm text-muted-foreground">Public application routes and artifact storage are managed by Personal Cloud. You do not need a Cloudflare account. Availability is shown above.</p> : <form
            className="flex flex-col gap-4"
            onSubmit={(e) => save(e, "/integrations/cloudflare")}
          >
            <Field
              label="Cloudflare API token"
              name="token"
              type="password"
              required
            />
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              disabled={action.busy || !live}
              onClick={(e) => {
                const form = new FormData(e.currentTarget.form!);
                void action.run(
                  async () =>
                    setDiscovery(
                      await api("/integrations/cloudflare/discover", {
                        token: f(form, "token"),
                      }),
                    ),
                  "Accounts and zones loaded",
                );
              }}
            >
              Find accounts and domains
            </Button>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Account" name="account_id" required>
                {discovery ? (
                  <Select name="account_id" required>
                    {discovery.accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </Select>
                ) : undefined}
              </Field>
              <Field label="Domain zone" name="zone_id" required>
                {discovery ? (
                  <Select name="zone_id" required>
                    {discovery.zones.map((z) => (
                      <option key={z.id} value={z.id}>
                        {z.name}
                      </option>
                    ))}
                  </Select>
                ) : undefined}
              </Field>
            </div>
            <Section title="Image storage credentials">
              <p className="text-xs text-muted-foreground">
                Use an R2 bucket and its S3 API credentials. Personal Cloud
                configures the image registry for you.
              </p>
              <Field
                label="R2 bucket"
                name="bucket"
                required
                placeholder="personal-cloud-images"
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="R2 access key ID"
                  name="r2_access_key_id"
                  type="password"
                  required
                />
                <Field
                  label="R2 secret access key"
                  name="r2_secret_access_key"
                  type="password"
                  required
                />
              </div>
            </Section>
            <Submit busy={action.busy || !live}>Connect Cloudflare</Submit>
          </form>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Cluster connection</CardTitle>
          <CardDescription>
            {hosted ? "Your first Linux machine coordinates your fleet through an outbound connection. Image storage is included; connect your repositories and machine to start deploying." : "Your first installed Linux machine connects automatically and coordinates your fleet. Connect Cloudflare, then set up image storage to start deploying."}
          </CardDescription>
          <CardAction>
            <StatusBadge status={runtimeStatus} />
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {runtime.error != null && (
            <Alert variant="destructive">{String(runtime.error)}</Alert>
          )}
          <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1.5">
            <dt className="text-xs text-muted-foreground">Status</dt>
            <dd className="flex items-center gap-2">
              <StatusDot status={runtimeStatus} />
              <Meta>{runtimeStatus.replaceAll("_", " ")}</Meta>
            </dd>
            <dt className="text-xs text-muted-foreground">Scheduler</dt>
            <dd>
              <Meta className="break-all">
                {String(runtime.nomad_url ?? "Not configured")}
              </Meta>
            </dd>
            <dt className="text-xs text-muted-foreground">Registry</dt>
            <dd>
              <Meta className="break-all">
                {String(runtime.registry_url ?? "Not configured")}
              </Meta>
            </dd>
          </dl>
          {!hosted && <form
            key={String(runtime.nomad_url ?? "new")}
            className="flex flex-col gap-4"
            onSubmit={(e) =>
              save(e, "/runtime", (form) =>
                Object.fromEntries(
                  [...form].map(([key, value]) => [
                    key,
                    key === "allow_insecure_registry" ? true : value,
                  ]),
                ),
              )
            }
          >
            <Field
              label="Scheduler URL"
              name="nomad_url"
              value={String(runtime.nomad_url ?? "")}
              required
              placeholder="http://10.77.0.2:4646"
            />
            <Field
              label="Scheduler token"
              name="nomad_token"
              type="password"
              hint="Leave blank to keep the saved token."
            />
            <Disclosure title="Advanced runtime settings">
              <Field
                label="Image registry address"
                name="registry_url"
                value={String(runtime.registry_url ?? "http://10.77.0.2:5000")}
                placeholder="http://10.77.0.2:5000"
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Registry username"
                  name="registry_username"
                  value={String(runtime.registry_username ?? "")}
                />
                <Field
                  label="Registry password"
                  name="registry_password"
                  type="password"
                  hint="Leave blank to keep."
                />
              </div>
              <Field
                label="BuildKit address"
                name="buildkit_address"
                value={String(
                  runtime.buildkit_address ?? "tcp://127.0.0.1:1234",
                )}
                placeholder="tcp://10.77.0.2:1234"
              />
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  name="allow_insecure_registry"
                  defaultChecked={runtime.allow_insecure_registry === true}
                />
                Allow HTTP registry on trusted private network
              </label>
            </Disclosure>
            <Submit busy={action.busy || !live}>Save cluster connection</Submit>
          </form>}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!live || action.busy}
              onClick={() =>
                action.run(
                  async () => setRuntime(await api("/runtime")),
                  "Diagnostics refreshed",
                )
              }
            >
              <RefreshCw />
              Check connection
            </Button>
            {!hosted && <Button
              variant="outline"
              size="sm"
              disabled={!live || action.busy}
              onClick={() =>
                action.run(async () => {
                  await api("/runtime/bootstrap-registry", {});
                  setRuntime(await api("/runtime"));
                  await refresh();
                }, "Image storage provisioning requested")
              }
            >
              Set up image storage
            </Button>}
          </div>
          <Disclosure title="Runtime diagnostics">
            <pre className="max-h-60 overflow-auto rounded-lg bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
              {JSON.stringify(runtime, null, 2)}
            </pre>
          </Disclosure>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Fleet network</CardTitle>
          <CardDescription>
            Machines enrolled in this workspace and their private addresses.
          </CardDescription>
          <CardAction>
            <Badge
              variant={
                data.machines.some((m) => m.status === "online")
                  ? "green"
                  : "blank"
              }
            >
              {data.machines.filter((m) => m.status === "online").length} of{" "}
              {data.machines.length} online
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {data.machines.length ? (
            data.machines.map((m) => (
              <div
                key={m.id}
                className="gh-interactive flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2"
              >
                <StatusDot status={m.status} />
                <span className="text-sm font-medium">{m.report.hostname}</span>
                <Badge variant="blank">{m.location}</Badge>
                <Meta>{m.report.private_ip || "no private ip"}</Meta>
                <Meta className="ml-auto">
                  {m.roles.length ? m.roles.join(" · ") : "no roles"}
                </Meta>
              </div>
            ))
          ) : (
            <EmptyState
              icon={<Server />}
              title="No machines yet"
              description="Install the agent on a Linux machine to enroll it in your fleet."
              className="py-8"
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
export function RepositoryField({ live }: { live: boolean }) {
  const [repos, setRepos] = useState<
      { full_name: string; default_branch: string; private: boolean }[]
    >([]),
    [chosen, setChosen] = useState(""),
    [branch, setBranch] = useState("main"),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(live),
    [manual, setManual] = useState(false);
  useEffect(() => {
    if (live)
      api<{ repositories: typeof repos }>("/github/repositories")
        .then((r) => setRepos(r.repositories))
        .catch((e) => setError(e.message))
        .finally(() => setLoading(false));
  }, [live]);
  const pick = repos.length > 0 && !manual;
  return (
    <>
      <Field
        label="GitHub repository"
        hint={
          error ? (
            <>
              {error} You can enter a repository manually after connecting
              GitHub in Settings.
            </>
          ) : pick ? (
            <button
              type="button"
              className="cursor-pointer text-left text-primary hover:underline"
              onClick={() => setManual(true)}
            >
              Repository not listed? Enter it manually.
            </button>
          ) : undefined
        }
      >
        {pick ? (
          <Select
            name="repository"
            required
            value={chosen}
            onChange={(e) => {
              setChosen(e.target.value);
              const repo = repos.find((r) => r.full_name === e.target.value);
              if (repo) setBranch(repo.default_branch);
            }}
          >
            <option value="">Choose a repository</option>
            {repos.map((r) => (
              <option key={r.full_name} value={r.full_name}>
                {r.full_name} · {r.private ? "Private" : "Public"}
              </option>
            ))}
          </Select>
        ) : (
          <Input
            name="repository"
            required
            pattern="[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+"
            placeholder={loading ? "Loading repositories…" : "owner/repository"}
            value={chosen}
            onChange={(e) => {
              setChosen(e.target.value);
              const repo = repos.find((r) => r.full_name === e.target.value);
              if (repo) setBranch(repo.default_branch);
            }}
          />
        )}
      </Field>
      <Field label="Production branch">
        <Input
          name="branch"
          required
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
        />
      </Field>
    </>
  );
}
export function Placement({
  data,
  value,
}: {
  data: Snapshot;
  value?: Service["placement"];
}) {
  return (
    <Field label="Placement">
      <Select
        name="placement"
        defaultValue={
          value?.kind === "machine"
            ? `machine:${value.machine_id}`
            : (value?.kind ?? "automatic")
        }
      >
        <option value="automatic">Automatic</option>
        <option value="home">Home fleet</option>
        <option value="vps">Cloud VPS</option>
        {data.machines.map((m) => (
          <option key={m.id} value={`machine:${m.id}`}>
            {m.report.hostname} · {m.status}
          </option>
        ))}
      </Select>
    </Field>
  );
}
export function serviceFields(form: FormData) {
  const place = f(form, "placement");
  return {
    name: f(form, "name"),
    port: Number(form.get("port")),
    placement: place.startsWith("machine:")
      ? { kind: "machine", machine_id: place.slice(8) }
      : { kind: place },
    root_directory: f(form, "root_directory") || ".",
    health_path: f(form, "health_path") || "/",
    cpu_mhz: Number(form.get("cpu_mhz") || 500),
    memory_mb: Number(form.get("memory_mb") || 512),
  };
}
export function ServiceFields({
  data,
  service,
}: {
  data: Snapshot;
  service?: Service;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field
        label="Service name"
        name="name"
        value={service?.name}
        required
        placeholder="web"
        className="sm:col-span-2"
      />
      <Field label="Listening port">
        <Input
          name="port"
          type="number"
          required
          min={1}
          max={65535}
          defaultValue={service?.port ?? 3000}
        />
      </Field>
      <Field
        label="Health check path"
        name="health_path"
        value={service?.health_path ?? "/"}
        required
      />
      <div className="sm:col-span-2">
        <Placement data={data} value={service?.placement} />
      </div>
      <Eyebrow className="sm:col-span-2">Build and resources</Eyebrow>
      <Field
        label="Repository root directory"
        name="root_directory"
        value={service?.root_directory ?? "."}
        className="sm:col-span-2"
      />
      <Field label="CPU (MHz)">
        <Input
          name="cpu_mhz"
          type="number"
          min={100}
          max={128000}
          defaultValue={service?.cpu_mhz ?? 500}
        />
      </Field>
      <Field label="Memory (MB)">
        <Input
          name="memory_mb"
          type="number"
          min={64}
          max={1048576}
          defaultValue={service?.memory_mb ?? 512}
        />
      </Field>
    </div>
  );
}
export function MachineSettings({
  machine,
  refresh,
  onRemove,
}: {
  machine: Machine;
  refresh: () => Promise<unknown>;
  onRemove: () => void;
}) {
  const action = useAction();
  const facts: [string, string][] = [
    ["Private IP", machine.report.private_ip || "Not reported"],
    ["Scheduler node", machine.report.nomad_node_id || "Not reported"],
  ];
  if (machine.report.gpu != null)
    facts.push(["GPU", JSON.stringify(machine.report.gpu)]);
  if (machine.report.network != null)
    facts.push(["Network", JSON.stringify(machine.report.network)]);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Machine settings</CardTitle>
        <CardDescription>
          Placement, roles, and tags used when scheduling workloads.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            void action.run(async () => {
              await api(
                `/machines/${machine.id}`,
                {
                  location: f(form, "location"),
                  roles: form.getAll("roles"),
                  tags: f(form, "tags")
                    .split(",")
                    .map((t) => t.trim())
                    .filter(Boolean),
                },
                "PUT",
              );
              await refresh();
            });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Location">
              <Select name="location" defaultValue={machine.location}>
                <option value="home">Home fleet</option>
                <option value="vps">Cloud VPS</option>
                <option value="dedicated">Dedicated server</option>
              </Select>
            </Field>
            <Field
              label="Tags"
              name="tags"
              value={machine.tags.join(", ")}
              hint="Comma separated."
            />
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-sm leading-none font-medium">
              Roles
            </legend>
            <div className="flex flex-wrap gap-4">
              {["compute", "builder", "database"].map((role) => (
                <label
                  key={role}
                  className="flex items-center gap-2 text-sm capitalize"
                >
                  <Checkbox
                    name="roles"
                    value={role}
                    defaultChecked={machine.roles.includes(role)}
                  />
                  {role}
                </label>
              ))}
            </div>
          </fieldset>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
            {facts.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd>
                  <Meta className="break-all">{value}</Meta>
                </dd>
              </div>
            ))}
          </dl>
          <Feedback action={action} />
          <Submit busy={action.busy}>Save machine</Submit>
          <Separator />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Drains workloads and removes the machine from the fleet.
            </p>
            <Button
              variant="destructive"
              size="sm"
              disabled={action.busy}
              onClick={() => {
                if (
                  confirm(
                    `Drain and remove ${machine.report.hostname}? Persistent workloads must be removed first.`,
                  )
                )
                  void action.run(async () => {
                    await api(`/machines/${machine.id}`, undefined, "DELETE");
                    await refresh();
                    onRemove();
                  }, "Machine removed");
              }}
            >
              <Trash2 />
              Remove machine
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
