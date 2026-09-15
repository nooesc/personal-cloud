import { useState } from "react";
import { Database, Globe2, Plus } from "lucide-react";
import { api } from "../lib/data";
import {
  Feedback,
  Field,
  Secret,
  Submit,
  useAction,
  type LiveProps,
} from "./live";
export function Databases({
  data,
  refresh,
  live,
  projectId,
}: { projectId?: string } & LiveProps) {
  const action = useAction(),
    [creating, setCreating] = useState(false),
    [secret, setSecret] = useState<{ id: string; value: string }>();
  const databases = data.databases.filter(
    (d) => !projectId || d.project_id === projectId,
  );
  return (
    <section className="resource-panel">
      <div className="section-heading">
        <div>
          <h2>
            PostgreSQL <span className="count">{databases.length}</span>
          </h2>
          <p>Private, persistent, and pinned to its machine.</p>
        </div>
        <button
          className="button primary small"
          disabled={!live}
          onClick={() => setCreating(!creating)}
        >
          <Plus size={14} />
          {creating ? "Cancel" : "New database"}
        </button>
      </div>
      <Feedback action={action} />
      {creating && (
        <form
          className="resource-form"
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
          <Field label="Project">
            <select required name="project_id" defaultValue={projectId}>
              {data.projects
                .filter((p) => !projectId || p.id === projectId)
                .map((p) => (
                  <option value={p.id} key={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field
            label="Database name"
            name="name"
            required
            placeholder="postgres"
          />
          <Field label="Machine">
            <select name="machine_id">
              <option value="">Automatic · healthy database machine</option>
              {data.machines
                .filter(
                  (m) => m.roles.includes("database") && m.status === "online",
                )
                .map((m) => (
                  <option value={m.id} key={m.id}>
                    {m.report.hostname}
                  </option>
                ))}
            </select>
          </Field>
          <p className="form-note">
            Placement is permanent. Personal Cloud never automatically moves
            database data.
          </p>
          <Submit busy={action.busy}>Provision PostgreSQL</Submit>
        </form>
      )}
      {databases.map((d) => (
        <article className="resource-card" key={d.id}>
          <div className="detail-heading">
            <h3>
              <Database size={17} />
              {d.name}
            </h3>
            <span className={`status-pill ${d.status ?? "pending"}`}>
              {d.status ?? "Provisioning"}
            </span>
          </div>
          <p className="muted">
            {data.projects.find((p) => p.id === d.project_id)?.name} ·{" "}
            {data.machines.find((m) => m.id === d.machine_id)?.report
              .hostname ?? "Awaiting placement"}
          </p>
          {d.error && <div className="form-error">{d.error}</div>}
          <div className="action-row">
            {["failed", "degraded"].includes(d.status ?? "") && (
              <button
                className="button secondary small"
                disabled={action.busy || !live}
                onClick={() =>
                  action.run(async () => {
                    await api(`/databases/${d.id}/retry`, {});
                    await refresh();
                  }, "Database recovery requested on its existing machine")
                }
              >
                Retry database
              </button>
            )}
            <button
              className="button secondary small"
              disabled={action.busy || !live}
              onClick={() =>
                action.run(async () => {
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
                }, "")
              }
            >
              Reveal connection
            </button>
            {secret?.id === d.id && (
              <button
                className="text-button"
                onClick={() => setSecret(undefined)}
              >
                Hide
              </button>
            )}
          </div>
          {secret?.id === d.id && <Secret value={secret.value} />}
          <form
            className="attach-form"
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
            <Field label="Attach to service">
              <select required name="service_id">
                <option value="">Select a service</option>
                {data.services
                  .filter((s) => s.project_id === d.project_id)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Submit busy={action.busy || !live}>Attach</Submit>
          </form>
          <button
            className="text-button danger"
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
            Remove database
          </button>
        </article>
      ))}
      {!databases.length && !creating && (
        <div className="empty-state">
          <span className="empty-icon">
            <Database />
          </span>
          <h3>A steady home for your data</h3>
          <p>
            Provision PostgreSQL on a database machine, then attach its
            connection to an application.
          </p>
          {!data.projects.length && (
            <small>Create a project first to add its database.</small>
          )}
        </div>
      )}
    </section>
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
    <section className="resource-panel">
      <div className="section-heading">
        <div>
          <h2>
            Public domains <span className="count">{domains.length}</span>
          </h2>
          <p>A secure public address for your service.</p>
        </div>
        <button
          className="button primary small"
          disabled={!live}
          onClick={() => setCreating(!creating)}
        >
          <Plus size={14} />
          {creating ? "Cancel" : "Expose service"}
        </button>
      </div>
      <Feedback action={action} />
      {creating && (
        <form
          className="resource-form"
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
          <Field label="Service">
            <select required name="service_id">
              <option value="">Select a healthy service</option>
              {services
                .filter((s) => s.status === "healthy" || s.status === "running")
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {data.projects.find((p) => p.id === s.project_id)?.name} /{" "}
                    {s.name} : {s.port}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Hostname">
            <input
              name="hostname"
              required
              placeholder="app.example.com"
              pattern="[A-Za-z0-9.-]+\.[A-Za-z]{2,}"
            />
          </Field>
          <p className="form-note">
            Use a hostname in your connected Cloudflare zone. We configure the
            tunnel, DNS, and HTTPS.
          </p>
          <Submit busy={action.busy}>Expose service</Submit>
        </form>
      )}
      {domains.map((d) => (
        <article className="resource-card" key={d.id}>
          <div className="detail-heading">
            <h3>
              <Globe2 size={17} />
              <a
                href={`https://${d.hostname}`}
                target="_blank"
                rel="noreferrer"
              >
                {d.hostname} ↗
              </a>
            </h3>
            <span className={`status-pill ${d.status ?? "pending"}`}>
              {d.status ?? "Provisioning"}
            </span>
          </div>
          <p className="muted">
            Routes to{" "}
            {data.services.find((s) => s.id === d.service_id)?.name ??
              d.service_id}
          </p>
          {d.error && <div className="form-error">{d.error}</div>}
          <button
            className="text-button danger"
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
            Remove domain
          </button>
        </article>
      ))}
      {!domains.length && !creating && (
        <div className="empty-state">
          <span className="empty-icon">
            <Globe2 />
          </span>
          <h3>Give your service an address</h3>
          <p>
            Deploy a healthy service, then expose it through your connected
            Cloudflare domain.
          </p>
        </div>
      )}
    </section>
  );
}
