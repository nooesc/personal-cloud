import { useEffect, useState } from "react";
import {
  Box,
  Check,
  GitBranch,
  GitFork,
  LoaderCircle,
  Plus,
  Rocket,
} from "lucide-react";
import { api, type Deployment, type Project, type Service } from "../lib/data";
import {
  Feedback,
  Field,
  Secret,
  ServiceFields,
  Submit,
  serviceFields,
  useAction,
  type LiveProps,
} from "./live";
import { Databases, Domains } from "./resources";
export function ProjectDetail({
  project,
  data,
  refresh,
  live,
  addService,
  onRemove,
}: {
  project: Project;
  addService: () => void;
  onRemove: () => void;
} & LiveProps) {
  const [tab, setTab] = useState("Services"),
    [serviceId, setServiceId] = useState<string>(),
    action = useAction();
  const services = data.services.filter((s) => s.project_id === project.id),
    service = services.find((s) => s.id === serviceId);
  return (
    <>
      <div className="project-detail-meta">
        <GitFork size={16} />
        {project.repository}
        <span>
          <GitBranch size={13} />
          {project.branch}
        </span>
      </div>
      <div className="tabs" role="tablist" aria-label="Project sections">
        {["Services", "Environment", "Databases", "Domains"].map((t) => (
          <button
            role="tab"
            aria-selected={tab === t}
            key={t}
            className={tab === t ? "active" : ""}
            onClick={() => {
              setTab(t);
              setServiceId(undefined);
            }}
          >
            {t}
          </button>
        ))}
      </div>
      {!live && (
        <p className="form-note">
          This is sample data. Connect your live workspace to run deployments
          and change infrastructure.
        </p>
      )}
      {tab === "Services" &&
        (service ? (
          <>
            <button
              className="text-button"
              onClick={() => setServiceId(undefined)}
            >
              ← All services
            </button>
            <ServiceDetail
              service={service}
              data={data}
              refresh={refresh}
              live={live}
              onRemove={() => setServiceId(undefined)}
            />
          </>
        ) : (
          <>
            <div className="detail-heading">
              <h3>Services</h3>
              <button className="button secondary small" onClick={addService}>
                <Plus size={14} />
                Add service
              </button>
            </div>
            {services.map((s) => (
              <button
                key={s.id}
                className="service-row service-select"
                onClick={() => setServiceId(s.id)}
              >
                <Box size={18} />
                <div>
                  <strong>{s.name}</strong>
                  <small>
                    Port {s.port} ·{" "}
                    {data.machines.find(
                      (m) => m.id === (s.machine_id ?? s.demo_machine),
                    )?.report.hostname ?? s.placement.kind}
                  </small>
                </div>
                <span
                  className={`status-pill ${s.status ?? s.demo_status ?? "pending"}`}
                >
                  {s.status ?? s.demo_status ?? "Not deployed"}
                </span>
              </button>
            ))}
            {!services.length && (
              <div className="quiet-state">
                <Box />
                <p>Add the first service to {project.name}.</p>
                <small>
                  We build from your repository and run it on your fleet.
                </small>
              </div>
            )}
            <div className="danger-zone">
              <button
                className="text-button danger"
                disabled={!live || action.busy}
                onClick={() => {
                  if (
                    confirm(
                      `Delete project ${project.name} and stop its services? Database volumes are preserved.`,
                    )
                  )
                    void action.run(async () => {
                      await api(`/projects/${project.id}`, undefined, "DELETE");
                      await refresh();
                      onRemove();
                    }, "Project deleted");
                }}
              >
                Delete project
              </button>
              <Feedback action={action} />
            </div>
          </>
        ))}
      {tab === "Environment" && <Environment project={project} live={live} />}{" "}
      {tab === "Databases" && (
        <Databases
          data={data}
          refresh={refresh}
          live={live}
          projectId={project.id}
        />
      )}{" "}
      {tab === "Domains" && (
        <Domains
          data={data}
          refresh={refresh}
          live={live}
          projectId={project.id}
        />
      )}
    </>
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
    <>
      <p className="dialog-intro">
        Encrypted variables are applied on the next deployment. Reveal a value
        only when you need it.
      </p>
      {loading && <p role="status">Loading environment…</p>}
      <div className="stack">
        {variables.map((v) => (
          <div className="variable-row" key={v.key}>
            <div>
              <code>{v.key}</code>
              <small>Updated {new Date(v.updated_at).toLocaleString()}</small>
            </div>
            {secret?.key === v.key ? (
              <>
                <Secret value={secret.value} />
                <button
                  className="text-button"
                  onClick={() => setSecret(undefined)}
                >
                  Hide
                </button>
              </>
            ) : (
              <>
                <span className="muted">••••••••</span>
                <button
                  className="text-button"
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
                </button>
              </>
            )}
            <button
              className="text-button danger"
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
            </button>
          </div>
        ))}
      </div>
      {!variables.length && !loading && (
        <p className="empty-copy">No variables yet.</p>
      )}
      <form
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
        <h3>Add or update variable</h3>
        <div className="form-columns">
          <Field label="Key">
            <input
              name="key"
              required
              pattern="[A-Za-z_][A-Za-z0-9_]*"
              placeholder="API_KEY"
            />
          </Field>
          <Field label="Value" name="value" type="password" />
        </div>
        <Submit busy={action.busy || !live}>Save variable</Submit>
      </form>
      <Feedback action={action} />
    </>
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
  onRemove,
}: { service: Service; onRemove: () => void } & LiveProps) {
  const [tab, setTab] = useState("Deployments"),
    [selected, setSelected] = useState<string>(),
    [deployment, setDeployment] = useState<Deployment>(),
    [lines, setLines] = useState<unknown[]>([]),
    [metrics, setMetrics] = useState<Record<string, unknown>>({}),
    [readError, setReadError] = useState(""),
    [loading, setLoading] = useState(false),
    action = useAction();
  const deployments = data.deployments
      .filter((d) => d.service_id === s.id)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)),
    active = selected ?? deployments[0]?.id ?? s.current_deployment_id,
    deploying = deployments.some((d) =>
      ["queued", "building", "deploying"].includes(d.status),
    );
  useEffect(() => {
    if (!live || !["Logs", "Metrics"].includes(tab)) return;
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
    <div className="stack">
      <div className="detail-heading">
        <div>
          <h3>{s.name}</h3>
          <small className="muted">
            {s.address ?? "No running address"} · Port {s.port}
          </small>
        </div>
        <button
          className="button primary"
          disabled={!live || action.busy || deploying}
          onClick={() =>
            action.run(async () => {
              const d = await api<Deployment>(`/services/${s.id}/deploy`, {});
              setSelected(undefined);
              setTab("Deployments");
              await refresh();
            }, "Deployment queued")
          }
        >
          <Rocket size={15} />
          Deploy latest
        </button>
      </div>
      <div className="service-metadata">
        <span className={`status-pill ${s.status ?? "pending"}`}>
          {s.status ?? s.demo_status ?? "Not deployed"}
        </span>
        <span>
          {data.machines.find((m) => m.id === s.machine_id)?.report.hostname ??
            "Awaiting placement"}
        </span>
        <code>
          {s.image_digest
            ? `${s.image_digest.slice(0, 34)}…`
            : "No image deployed"}
        </code>
      </div>
      <Feedback action={action} />
      <div className="tabs" role="tablist" aria-label="Service sections">
        {["Deployments", "Logs", "Metrics", "Configuration"].map((t) => (
          <button
            role="tab"
            aria-selected={tab === t}
            key={t}
            className={tab === t ? "active" : ""}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === "Deployments" && (
        <>
          {deployment && (
            <section className="deployment-progress">
              <div className="detail-heading">
                <h3>Deployment {deployment.id.slice(0, 8)}</h3>
                <span className={`status-pill ${deployment.status}`}>
                  {deployment.status}
                </span>
              </div>
              <p className="muted">
                {deployment.step?.replaceAll("_", " ")}{" "}
                {deployment.commit_sha &&
                  `· ${deployment.commit_sha.slice(0, 8)}`}
              </p>
              <BuildProgress deployment={deployment} />
            </section>
          )}
          {deployments.map((d) => (
            <div className="deployment-row" key={d.id}>
              <button className="text-button" onClick={() => setSelected(d.id)}>
                <code>{d.commit_sha?.slice(0, 8) ?? d.id.slice(0, 8)}</code>
                <span>{d.status}</span>
                <small>{new Date(d.created_at).toLocaleString()}</small>
              </button>
              <button
                className="button secondary small"
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
                        ? "This deployment has no immutable image"
                        : "Deploy this exact image without rebuilding"
                }
                onClick={() => {
                  if (
                    confirm("Roll back to this deployment’s immutable image?")
                  )
                    void action.run(async () => {
                      const next = await api<Deployment>(
                        `/services/${s.id}/rollback`,
                        { deployment_id: d.id },
                      );
                      setSelected(undefined);
                      await refresh();
                    }, "Rollback queued");
                }}
              >
                Rollback
              </button>
            </div>
          ))}
          {!deployments.length && (
            <div className="quiet-state">
              <Rocket />
              <p>No deployments yet</p>
              <small>
                Deploy latest builds your production branch and starts the
                service.
              </small>
            </div>
          )}
          <details>
            <summary>Deploy an existing image</summary>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const form = new FormData(e.currentTarget);
                void action.run(async () => {
                  const d = await api<Deployment>(`/services/${s.id}/deploy`, {
                    image: form.get("image"),
                  });
                  setSelected(undefined);
                  await refresh();
                }, "Image deployment queued");
              }}
            >
              <Field label="Immutable image digest">
                <input
                  name="image"
                  required
                  placeholder="registry/app@sha256:…"
                  pattern=".+@sha256:[a-fA-F0-9]{64}"
                />
              </Field>
              <Submit busy={action.busy || !live}>Deploy image</Submit>
            </form>
          </details>
        </>
      )}
      {tab === "Metrics" && (
        <ServiceMetrics metrics={metrics} status={s.status} loading={loading} />
      )}
      {tab === "Logs" && (
        <>
          <div className="detail-heading">
            <h3>Service logs</h3>
            <small className="muted">Live runtime updates</small>
          </div>
          <pre className="log-output" aria-label="Service logs">
            {lines.length
              ? lines.map(logText).join("\n")
              : loading
                ? "Loading logs…"
                : "No log lines available."}
          </pre>
        </>
      )}
      {readError && tab !== "Configuration" && (
        <div className="form-error" role="alert">
          {readError}
        </div>
      )}
      {tab === "Configuration" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            void action.run(async () => {
              await api(`/services/${s.id}`, serviceFields(form), "PUT");
              await refresh();
            }, "Configuration saved. Deploy to apply changes.");
          }}
        >
          <ServiceFields data={data} service={s} />
          <Submit busy={action.busy || !live}>Save configuration</Submit>
          <div className="danger-zone">
            <button
              type="button"
              className="text-button danger"
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
              Delete service
            </button>
          </div>
        </form>
      )}
    </div>
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
        <ol className="build-steps">
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
                className={
                  failed ? "failed" : running ? "running" : "completed"
                }
              >
                {failed ? (
                  <span className="step-failed">!</span>
                ) : running ? (
                  <LoaderCircle className="spin" size={15} />
                ) : (
                  <Check size={15} />
                )}
                <div>
                  {step.message ?? step.name ?? step.step}
                  <small>
                    {failed ? "Failed" : running ? "In progress" : "Complete"}
                  </small>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="form-note">
          Waiting for build progress from the control plane.
        </p>
      )}
      {deployment.error && (
        <div className="form-error" role="alert">
          {deployment.error}
        </div>
      )}
      {logs.length > 0 || deployment.logs?.length ? (
        <details className="build-log-details">
          <summary>
            Build output · {logs.length + (deployment.logs?.length ?? 0)} lines
          </summary>
          <pre className="log-output" aria-label="Deployment logs">
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
  status,
  loading,
}: {
  metrics: Record<string, unknown>;
  status?: string;
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
  return (
    <>
      <div className="detail-heading">
        <h3>Service health and resources</h3>
        <span className={`status-pill ${status ?? "pending"}`}>
          {status ?? "Not deployed"}
        </span>
      </div>
      {waiting && (
        <p className="form-note" role="status">
          Waiting for first measurement
        </p>
      )}
      <div className="metrics-grid">
        {[
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
            "Received / sent · unavailable when not reported",
          ],
          [
            "Restarts",
            typeof metrics.restarts === "number"
              ? String(metrics.restarts)
              : "—",
            "Current allocation",
          ],
        ].map(([label, value, detail]) => (
          <div key={label} className="metric-card">
            <span>{label}</span>
            <strong>{value}</strong>
            <small>{detail}</small>
          </div>
        ))}
      </div>
      {Object.keys(metrics).length ? (
        <details>
          <summary>Allocation resource details</summary>
          <pre className="log-output">{JSON.stringify(metrics, null, 2)}</pre>
        </details>
      ) : (
        <p className="form-note">
          {loading
            ? "Loading runtime metrics…"
            : "No runtime metrics reported."}
        </p>
      )}
    </>
  );
}
