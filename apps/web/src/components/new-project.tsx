import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import {
  ApiError,
  api,
  platformZone,
  type Project,
  type Readiness,
  type Service,
} from "../lib/data";
import { hosted } from "../lib/hosted";
import { cn } from "../lib/utils";
import { Field, useAction, type LiveProps } from "./live";
import { ReadinessGate, ReadinessSummary } from "./readiness";
import { HostnameField } from "./resources";
import {
  RepositoryField,
  ServiceFields,
  serviceFields,
  slug,
  type RepositoryChoice,
} from "./service-fields";
import { Button } from "./ui/button";
import { DialogFooter } from "./ui/dialog";
import { Checkbox, Input, Label } from "./ui/input";
import { Alert, Eyebrow, Meta, StatusDot } from "./ui/misc";

type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";
type Steps = Record<"project" | "service" | "deploy", StepStatus>;
type Publishing =
  | "idle"
  | "waiting"
  | "publishing"
  | "done"
  | "skipped"
  | "failed";

const NOT_PUBLISHED =
  "Not published — add a public address from the service once it is healthy.";

function Step({
  status,
  label,
  children,
}: {
  status: StepStatus | "waiting";
  label: ReactNode;
  children?: ReactNode;
}) {
  const dot =
    status === "running"
      ? "running"
      : status === "waiting"
        ? "deploying"
        : status === "done"
          ? "done"
          : status === "failed"
            ? "failed"
            : "idle";
  return (
    <li className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <StatusDot status={dot} />
        <span
          className={cn(
            "text-sm",
            (status === "pending" || status === "skipped") &&
              "text-muted-foreground",
          )}
        >
          {label}
        </span>
      </div>
      {children && <div className="flex flex-col gap-2 pl-5">{children}</div>}
    </li>
  );
}

/**
 * One continuous path from repository to running app. Readiness is never
 * computed here: the form trusts `data.readiness`, and a refused deployment
 * shows the readiness the control plane answered with.
 */
export function NewProjectFlow({
  data,
  refresh,
  live,
  onDone,
  onCancel,
}: LiveProps & {
  onDone: (project: Project, serviceId?: string) => void;
  onCancel: () => void;
}) {
  const zone = platformZone(data),
    readiness = data.readiness,
    willDeploy = !readiness || readiness.status === "ready",
    action = useAction(),
    [name, setName] = useState(""),
    [nameTouched, setNameTouched] = useState(false),
    [publish, setPublish] = useState(false),
    [phase, setPhase] = useState<"form" | "progress">("form"),
    [steps, setSteps] = useState<Steps>({
      project: "pending",
      service: "pending",
      deploy: "pending",
    }),
    [created, setCreated] = useState<{ project: Project; service?: Service }>(),
    [blocked, setBlocked] = useState<Readiness>(),
    [deployError, setDeployError] = useState(""),
    [hostname, setHostname] = useState(""),
    [publishing, setPublishing] = useState<Publishing>("idle"),
    [publishError, setPublishError] = useState(""),
    [domainId, setDomainId] = useState<string>(),
    [deployIntent, setDeployIntent] = useState(false),
    publishStarted = useRef(false);
  const serviceId = created?.service?.id,
    watchedStatus = data.services.find((s) => s.id === serviceId)?.status,
    firstDeployFailed =
      watchedStatus !== "healthy" &&
      data.deployments.some(
        (d) => d.service_id === serviceId && d.status === "failed",
      );
  useEffect(() => {
    if (publishing !== "waiting" || !serviceId || publishStarted.current)
      return;
    if (firstDeployFailed) {
      setPublishing("skipped");
      return;
    }
    if (watchedStatus !== "healthy") return;
    publishStarted.current = true;
    setPublishing("publishing");
    // 202: the address is requested, not live. Snapshots carry it to healthy or failed.
    api<{ id: string }>("/domains", { service_id: serviceId, hostname })
      .then(async (d) => {
        setDomainId(d.id);
        await refresh();
      })
      .catch((e) => {
        setPublishError(e instanceof Error ? e.message : String(e));
        setPublishing("failed");
      });
  }, [publishing, serviceId, watchedStatus, firstDeployFailed, hostname, refresh]);
  const domain = domainId ? data.domains.find((d) => d.id === domainId) : undefined;
  useEffect(() => {
    if (publishing !== "publishing" || !domain) return;
    if (domain.status === "healthy" || domain.status === "active")
      setPublishing("done");
    else if (domain.error || domain.status === "failed" || domain.status === "unhealthy") {
      setPublishError(domain.error ?? `Address ${domain.status}`);
      setPublishing("failed");
    }
  }, [publishing, domain]);

  function pickRepository(repo: RepositoryChoice | null) {
    if (!nameTouched) setName(repo?.name ?? "");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget),
      project = {
        name: String(form.get("project_name")),
        repository: String(form.get("repository")),
        branch: String(form.get("branch") || "main"),
      },
      service = serviceFields(form),
      wanted = publish ? String(form.get("hostname") || "") : "";
    setHostname(wanted);
    setBlocked(undefined);
    setDeployError("");
    setPhase("progress");
    setDeployIntent(willDeploy);
    await action.run(async () => {
      let step: keyof Steps = "project";
      try {
        let row = created?.project;
        if (!row) {
          setSteps({ project: "running", service: "pending", deploy: "pending" });
          row = await api<Project>("/projects", project);
          setCreated({ project: row });
        }
        step = "service";
        setSteps({ project: "done", service: "running", deploy: "pending" });
        const svc = await api<Service>(
          `/projects/${row.id}/services`,
          service,
        );
        setCreated({ project: row, service: svc });
        await refresh();
        // Intent is fixed at submit; readiness may change while this runs.
        if (!willDeploy) {
          setSteps({ project: "done", service: "done", deploy: "skipped" });
          setBlocked(readiness);
          if (wanted) setPublishing("skipped");
          return;
        }
        step = "deploy";
        setSteps({ project: "done", service: "done", deploy: "running" });
        try {
          await api(`/services/${svc.id}/deploy`, {});
        } catch (e) {
          setSteps({ project: "done", service: "done", deploy: "failed" });
          if (e instanceof ApiError && e.readiness) setBlocked(e.readiness);
          else setDeployError(e instanceof Error ? e.message : String(e));
          if (wanted) setPublishing("skipped");
          return;
        }
        setSteps({ project: "done", service: "done", deploy: "done" });
        if (wanted) setPublishing("waiting");
      } catch (e) {
        setSteps((s) => ({ ...s, [step]: "failed" }));
        throw e;
      }
    }, "");
  }

  const submitLabel = willDeploy ? "Create and deploy" : "Create without deploying";
  return (
    <>
      <form
        hidden={phase !== "form"}
        className="flex flex-col gap-4"
        onSubmit={submit}
      >
        <p className="text-sm text-muted-foreground">
          Pick a repository. We build it, run it on your machines and can give
          it a public address.
        </p>
        <ReadinessGate readiness={readiness} intent="Deploying" />
        <RepositoryField live={live} onChange={pickRepository} />
        <Field label="Project name">
          <Input
            name="project_name"
            required
            maxLength={80}
            placeholder="my-app"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameTouched(e.target.value !== "");
            }}
          />
        </Field>
        <ServiceFields data={data} mode="create" />
        <div className="flex flex-col gap-3">
          <Eyebrow>Public address</Eyebrow>
          {zone === null && hosted ? (
            <Meta>
              Public addresses become available once domains are configured.
            </Meta>
          ) : (
            <>
              <Label className="font-normal">
                <Checkbox
                  name="publish"
                  checked={publish}
                  onChange={(e) => setPublish(e.target.checked)}
                />
                Give it a public address
              </Label>
              {zone === null && (
                <span className="text-xs text-muted-foreground">
                  Uses your connected Cloudflare zone.
                </span>
              )}
              {publish && <HostnameField data={data} defaultLabel={slug(name)} />}
            </>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={!live} isLoading={action.busy}>
            {submitLabel}
          </Button>
        </DialogFooter>
      </form>
      {phase === "progress" && (
        <div className="flex flex-col gap-4">
          <ol className="flex flex-col gap-3" aria-live="polite">
            <Step status={steps.project} label="Creating project" />
            <Step status={steps.service} label="Adding service" />
            {steps.deploy === "skipped" ? (
              <Step status="skipped" label="Deployment not started">
                {blocked && <ReadinessSummary readiness={blocked} />}
              </Step>
            ) : (
              deployIntent && (
                <Step status={steps.deploy} label="Starting first deployment">
                  {blocked && <ReadinessSummary readiness={blocked} />}
                  {deployError && (
                    <Alert variant="destructive">{deployError}</Alert>
                  )}
                </Step>
              )
            )}
            {publishing === "waiting" && (
              <Step
                status="waiting"
                label="Waiting for the first healthy deployment…"
              >
                <Meta>Leave this open to publish {hostname} automatically.</Meta>
              </Step>
            )}
            {publishing === "publishing" && (
              <Step status="running" label={`Publishing ${hostname}`}>
                <Meta>
                  {domain?.status
                    ? `Provisioning · ${domain.status.replaceAll("_", " ")}`
                    : "Requesting the address…"}
                </Meta>
              </Step>
            )}
            {publishing === "done" && (
              <Step
                status="done"
                label={
                  <>
                    Published at{" "}
                    <a
                      href={`https://${hostname}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      https://{hostname}
                      <ExternalLink className="size-3" />
                    </a>
                  </>
                }
              />
            )}
            {publishing === "skipped" && (
              <Step status="skipped" label={<Meta>{NOT_PUBLISHED}</Meta>} />
            )}
            {publishing === "failed" && (
              <Step status="failed" label={`Could not publish ${hostname}`}>
                <Alert variant="destructive">{publishError}</Alert>
                <Meta>{NOT_PUBLISHED}</Meta>
              </Step>
            )}
          </ol>
          {action.error && <Alert variant="destructive">{action.error}</Alert>}
          <DialogFooter>
            {action.error && !created?.service && (
              <Button variant="outline" onClick={() => setPhase("form")}>
                Try again
              </Button>
            )}
            {created?.service && (
              <Button
                onClick={() => onDone(created.project, created.service?.id)}
              >
                Open project
              </Button>
            )}
          </DialogFooter>
        </div>
      )}
    </>
  );
}
