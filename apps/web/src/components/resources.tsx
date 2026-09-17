import { hosted } from "../lib/hosted";
import { DatabaseBackups } from "./database-backups";
import { useState } from "react";
import { Database, ExternalLink, Globe, Plus, X } from "lucide-react";
import { api } from "../lib/data";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card";
import { Input, Select } from "./ui/input";
import { EmptyState, Meta, StatusDot } from "./ui/misc";
import {
  Feedback,
  Field,
  Secret,
  Submit,
  useAction,
  type LiveProps,
} from "./live";
const rowClass =
  "gh-interactive flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2";
function statusVariant(status?: string) {
  return status === "healthy" || status === "active" || status === "running"
    ? "green"
    : status === "failed" || status === "degraded" || status === "unhealthy"
      ? "red"
      : "yellow";
}
export function Databases({
  data,
  refresh,
  live,
  projectId,
}: { projectId?: string } & LiveProps) {
  const action = useAction(),
    [creating, setCreating] = useState(false),
    [attaching, setAttaching] = useState<string>(),
    [secret, setSecret] = useState<{ id: string; value: string }>();
  const databases = data.databases.filter(
    (d) => !projectId || d.project_id === projectId,
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Databases</CardTitle>
        <CardDescription>
          PostgreSQL, private and persistent, pinned to its machine.
        </CardDescription>
        <CardAction>
          <Button
            size="sm"
            variant={creating ? "outline" : "default"}
            disabled={!live}
            onClick={() => setCreating(!creating)}
          >
            {creating ? <X /> : <Plus />}
            {creating ? "Cancel" : "New database"}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Feedback action={action} />
        {creating && (
          <form
            className="flex flex-col gap-4 rounded-lg border border-border p-4"
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              void action.run(async () => {
                await api("/databases", {
                  project_id: form.get("project_id"),
                  name: form.get("name"),
                  machine_id: form.get("machine_id") || undefined,
                  service_ids: form.getAll("service_ids"),
                });
                await refresh();
                setCreating(false);
              }, "Database provisioning requested");
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Project">
                <Select required name="project_id" defaultValue={projectId}>
                  {data.projects
                    .filter((p) => !projectId || p.id === projectId)
                    .map((p) => (
                      <option value={p.id} key={p.id}>
                        {p.name}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field
                label="Database name"
                name="name"
                required
                placeholder="postgres"
              />
              <Field
                label="Machine"
                className="sm:col-span-2"
                hint="Placement is permanent. Personal Cloud never automatically moves database data."
              >
                <Select name="machine_id">
                  <option value="">Automatic · healthy database machine</option>
                  {data.machines
                    .filter(
                      (m) =>
                        m.roles.includes("database") && m.status === "online",
                    )
                    .map((m) => (
                      <option value={m.id} key={m.id}>
                        {m.report.hostname}
                      </option>
                    ))}
                </Select>
              </Field>
            </div>
            <Submit busy={action.busy}>Provision PostgreSQL</Submit>
          </form>
        )}
        {databases.map((d) => (
          <div className={rowClass} key={d.id}>
            <StatusDot status={d.status ?? "pending"} />
            <span className="text-sm font-medium">{d.name}</span>
            <Meta>
              {data.projects.find((p) => p.id === d.project_id)?.name} ·{" "}
              {data.machines.find((m) => m.id === d.machine_id)?.report
                .hostname ?? "Awaiting placement"}
            </Meta>
            <Badge variant={statusVariant(d.status)} className="capitalize">
              {d.status ?? "Provisioning"}
            </Badge>
            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              {["failed", "degraded"].includes(d.status ?? "") && (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={action.busy || !live}
                  onClick={() =>
                    action.run(async () => {
                      await api(`/databases/${d.id}/retry`, {});
                      await refresh();
                    }, "Database recovery requested on its existing machine")
                  }
                >
                  Retry
                </Button>
              )}
              <Button
                size="xs"
                variant="outline"
                disabled={action.busy || !live}
                onClick={() => {
                  if (secret?.id === d.id) {
                    setSecret(undefined);
                    return;
                  }
                  void action.run(async () => {
                    const result = await api<Record<string, string>>(
                      `/databases/${d.id}/connection`,
                    );
                    setSecret({
                      id: d.id,
                      value:
                        result.connection_string ??
                        result.database_url ??
                        result.url ??
                        JSON.stringify(result),
                    });
                  }, "");
                }}
              >
                {secret?.id === d.id ? "Hide connection" : "Reveal connection"}
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={action.busy || !live}
                onClick={() =>
                  setAttaching(attaching === d.id ? undefined : d.id)
                }
              >
                Attach
              </Button>
              <Button
                size="xs"
                variant="destructive"
                disabled={action.busy || !live}
                onClick={() => {
                  if (
                    confirm(
                      `Stop and remove database ${d.name}? Its persistent volume will be preserved.`,
                    )
                  )
                    void action.run(async () => {
                      await api(`/databases/${d.id}`, undefined, "DELETE");
                      setSecret(undefined);
                      await refresh();
                    }, "Database removed; persistent volume preserved");
                }}
              >
                Remove
              </Button>
            </div>
            {hosted && (
              <DatabaseBackups
                databaseId={d.id}
                live={live}
                refresh={refresh}
              />
            )}
            {d.error && (
              <p className="basis-full text-xs text-destructive">{d.error}</p>
            )}
            {secret?.id === d.id && (
              <div className="basis-full">
                <Secret value={secret.value} />
              </div>
            )}
            {attaching === d.id && (
              <form
                className="flex basis-full flex-wrap items-end gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = new FormData(e.currentTarget);
                  void action.run(async () => {
                    await api(`/databases/${d.id}/attach`, {
                      service_id: form.get("service_id"),
                    });
                    await refresh();
                  }, "DATABASE_URL attached. Redeploy the service to apply it.");
                }}
              >
                <Field label="Attach to service" className="min-w-48 flex-1">
                  <Select required name="service_id" size="sm">
                    <option value="">Select a service</option>
                    {data.services
                      .filter((s) => s.project_id === d.project_id)
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                  </Select>
                </Field>
                <Submit busy={action.busy || !live}>Attach</Submit>
              </form>
            )}
          </div>
        ))}
        {!databases.length && !creating && (
          <EmptyState
            icon={<Database />}
            title="A steady home for your data"
            description={
              data.projects.length
                ? "Provision PostgreSQL on a database machine, then attach its connection to an application."
                : "Create a project first to add its database."
            }
          />
        )}
      </CardContent>
    </Card>
  );
}
export function Domains({
  data,
  refresh,
  live,
  projectId,
}: { projectId?: string } & LiveProps) {
  const action = useAction(),
    [creating, setCreating] = useState(false);
  const services = data.services.filter(
      (s) => !projectId || s.project_id === projectId,
    ),
    domains = data.domains.filter(
      (d) => !projectId || services.some((s) => s.id === d.service_id),
    );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Domains</CardTitle>
        <CardDescription>
          A secure public address for your service.
        </CardDescription>
        <CardAction>
          <Button
            size="sm"
            variant={creating ? "outline" : "default"}
            disabled={!live}
            onClick={() => setCreating(!creating)}
          >
            {creating ? <X /> : <Plus />}
            {creating ? "Cancel" : "Expose service"}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Feedback action={action} />
        {creating && (
          <form
            className="flex flex-col gap-4 rounded-lg border border-border p-4"
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              void action.run(async () => {
                await api("/domains", {
                  service_id: form.get("service_id"),
                  hostname: form.get("hostname"),
                });
                await refresh();
                setCreating(false);
              }, "Domain provisioning requested");
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Service">
                <Select required name="service_id">
                  <option value="">Select a healthy service</option>
                  {services
                    .filter(
                      (s) => s.status === "healthy" || s.status === "running",
                    )
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {data.projects.find((p) => p.id === s.project_id)?.name}{" "}
                        / {s.name} : {s.port}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field
                label="Hostname"
                hint="Use a hostname in your connected Cloudflare zone. We configure the tunnel, DNS, and HTTPS."
              >
                <Input
                  name="hostname"
                  required
                  placeholder="app.example.com"
                  pattern="[A-Za-z0-9.-]+\.[A-Za-z]{2,}"
                />
              </Field>
            </div>
            <Submit busy={action.busy}>Expose service</Submit>
          </form>
        )}
        {domains.map((d) => (
          <div className={rowClass} key={d.id}>
            <StatusDot status={d.status ?? "pending"} />
            <a
              href={`https://${d.hostname}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-sm font-medium hover:underline"
            >
              {d.hostname}
              <ExternalLink className="size-3 text-muted-foreground" />
            </a>
            <Meta>
              routes to{" "}
              {data.services.find((s) => s.id === d.service_id)?.name ??
                d.service_id}
            </Meta>
            <Badge variant={statusVariant(d.status)} className="capitalize">
              {d.status ?? "Provisioning"}
            </Badge>
            <div className="ml-auto">
              <Button
                size="xs"
                variant="destructive"
                disabled={action.busy || !live}
                onClick={() => {
                  if (
                    confirm(
                      `Remove public routing for ${d.hostname}? The service keeps running.`,
                    )
                  )
                    void action.run(async () => {
                      await api(`/domains/${d.id}`, undefined, "DELETE");
                      await refresh();
                    }, "Domain removed");
                }}
              >
                Remove
              </Button>
            </div>
            {d.error && (
              <p className="basis-full text-xs text-destructive">{d.error}</p>
            )}
          </div>
        ))}
        {!domains.length && !creating && (
          <EmptyState
            icon={<Globe />}
            title="Give your service an address"
            description="Deploy a healthy service, then expose it through your connected Cloudflare domain."
          />
        )}
      </CardContent>
    </Card>
  );
}
