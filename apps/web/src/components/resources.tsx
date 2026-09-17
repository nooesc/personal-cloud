import { CloudflareDomains } from "./cloudflare-domains";
import { useState } from "react";
import { ExternalLink, Globe, Plus, X } from "lucide-react";
import { api, platformZone, type Snapshot } from "../lib/data";
import { cn } from "../lib/utils";
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
import { Input, Select, fieldClasses } from "./ui/input";
import { Alert, EmptyState, Meta, StatusDot } from "./ui/misc";
import { slug } from "./service-fields";
import {
  Feedback,
  Field,
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
/**
 * Hosted workspaces publish under the platform zone: the user picks the left
 * label and the zone is fixed. The form still receives the full hostname via
 * the hidden input. The suggested label follows `defaultLabel` until the user
 * edits it. Self-hosted keeps the free hostname field.
 */
export function HostnameField({
  data,
  defaultLabel = "",
  name = "hostname",
}: {
  data: Snapshot;
  defaultLabel?: string;
  name?: string;
}) {
  const zone = platformZone(data),
    [edited, setEdited] = useState<string>(),
    label = edited ?? defaultLabel;
  if (!zone)
    return (
      <Field
        label="Public address"
        hint="A hostname in your connected Cloudflare zone."
      >
        <Input
          name={name}
          required
          placeholder="app.example.com"
          pattern="[A-Za-z0-9.-]+\.[A-Za-z]{2,}"
        />
      </Field>
    );
  return (
    <Field label="Public address">
      <div className="flex w-full">
        <input
          data-slot="input"
          value={label}
          onChange={(e) => setEdited(e.target.value.toLowerCase())}
          required
          pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"
          placeholder="my-app"
          autoCapitalize="none"
          spellCheck={false}
          className={cn(fieldClasses, "flex-1 rounded-r-none border-r-0")}
        />
        <span className="flex shrink-0 items-center rounded-r-lg border border-l-0 border-input bg-muted px-2 font-mono text-xs text-muted-foreground">
          .{zone}
        </span>
        <input type="hidden" name={name} value={label && `${label}.${zone}`} />
      </div>
    </Field>
  );
}
export function Domains({
  data,
  refresh,
  live,
  projectId,
  onNavigate,
}: {
  projectId?: string;
  onNavigate?: (page: "Repositories") => void;
} & LiveProps) {
  const hasCloudflare = (data.project_resources ?? []).some(
    (r) =>
      !r.ignored && r.project_id && (!projectId || r.project_id === projectId),
  );
  const action = useAction(),
    [creating, setCreating] = useState(false);
  const services = data.services.filter(
      (s) => !projectId || s.project_id === projectId,
    ),
    eligible = services.filter(
      (s) => s.status === "healthy" || s.status === "running",
    ),
    domains = data.domains.filter(
      (d) => !projectId || services.some((s) => s.id === d.service_id),
    ),
    suggested = slug(
      data.projects.find((p) => p.id === (projectId ?? eligible[0]?.project_id))
        ?.name ?? "",
    );
  return (
    <Card>
      <CardHeader className="flex flex-col gap-2 sm:grid">
        <CardTitle>Public addresses</CardTitle>
        <CardDescription>
          Existing Cloudflare addresses and public URLs managed by Dinghy.
        </CardDescription>
        <CardAction>
          <Button
            size="sm"
            variant={creating ? "outline" : "default"}
            disabled={!live}
            onClick={() => setCreating(!creating)}
          >
            {creating ? <X /> : <Plus />}
            {creating ? "Cancel" : "Add public address"}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {hasCloudflare && (
          <CloudflareDomains data={data} projectId={projectId} />
        )}
        <Feedback action={action} />
        {creating && !eligible.length && (
          <Alert>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span>
                Deploy a service first. Public addresses attach to a healthy
                deployment.
              </span>
              {onNavigate && (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => onNavigate("Repositories")}
                >
                  Open repositories
                </Button>
              )}
            </div>
          </Alert>
        )}
        {creating && eligible.length > 0 && (
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
              }, "Public address requested");
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Service">
                <Select required name="service_id">
                  <option value="">Choose a service</option>
                  {eligible.map((s) => (
                    <option key={s.id} value={s.id}>
                      {data.projects.find((p) => p.id === s.project_id)?.name} /{" "}
                      {s.name} : {s.port}
                    </option>
                  ))}
                </Select>
              </Field>
              <HostnameField data={data} defaultLabel={suggested} />
            </div>
            <Submit busy={action.busy}>Add public address</Submit>
          </form>
        )}
        {domains.map((d) => {
          const service = data.services.find((s) => s.id === d.service_id),
            project = data.projects.find((p) => p.id === service?.project_id);
          return (
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
                → {project ? `${project.name} / ` : ""}
                {service?.name ?? d.service_id}
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
                      }, "Public address removed");
                  }}
                >
                  Remove
                </Button>
              </div>
              {d.error && (
                <p className="basis-full text-xs text-destructive">{d.error}</p>
              )}
            </div>
          );
        })}
        {!domains.length && !creating && !hasCloudflare && (
          <EmptyState
            icon={<Globe />}
            title="Give your app an address"
            description="Once a service is healthy, add a public address here."
          />
        )}
      </CardContent>
    </Card>
  );
}
