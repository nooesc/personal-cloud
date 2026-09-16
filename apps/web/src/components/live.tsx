import { GitHubAppPanel } from "./github";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  Check,
  Copy,
  LoaderCircle,
  RefreshCw,
  Rocket,
  Trash2,
} from "lucide-react";
import {
  api,
  type Snapshot,
  type Project,
  type Service,
  type Deployment,
  type Machine,
  type Provider,
} from "../lib/data";
export type LiveProps = {
  data: Snapshot;
  refresh: () => Promise<unknown>;
  live: boolean;
};
export function useAction() {
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
export function Feedback({ action }: { action: ReturnType<typeof useAction> }) {
  return (
    <>
      {action.error && (
        <div className="form-error" role="alert">
          {action.error}
        </div>
      )}
      {action.message && (
        <div className="success-message" role="status">
          <Check size={14} />
          {action.message}
        </div>
      )}
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
    <button className="button primary" disabled={busy}>
      {busy ? <LoaderCircle size={15} className="spin" /> : null}
      {busy ? "Working…" : children}
    </button>
  );
}
export function Field({
  label,
  name,
  value,
  type = "text",
  required = false,
  placeholder,
  children,
}: {
  label: string;
  name?: string;
  value?: string | number;
  type?: string;
  required?: boolean;
  placeholder?: string;
  children?: ReactNode;
}) {
  return (
    <label className="field">
      {label}
      {children ?? (
        <input
          name={name}
          defaultValue={value}
          type={type}
          required={required}
          placeholder={placeholder}
          autoComplete={type === "password" ? "new-password" : undefined}
        />
      )}
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
    <div>
      <div className="copy-field">
        <input aria-label="Revealed secret" readOnly value={value} />
        <button
          type="button"
          className="icon-button"
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
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </button>
      </div>
      {error && <small>{error}</small>}
    </div>
  );
}
function status(value: string | Provider | undefined) {
  return typeof value === "string" ? value : (value?.status ?? "not_connected");
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
  return (
    <div className="settings-grid">
      <section className="panel setup-panel setup-summary">
        <span className="eyebrow">YOUR FIRST DEPLOYMENT</span>
        <h2>Connect your cloud</h2>
        <p>
          Connect your source and Cloudflare, then add a machine. Your projects
          and credentials stay in your control plane.
        </p>
        <div className="setup-checks">
          {[
            ["GitHub", status(data.integrations.github) === "connected"],
            [
              "Cloudflare",
              status(data.integrations.cloudflare) === "connected",
            ],
            ["Machine", data.machines.some((m) => m.status === "online")],
            ["Application", data.services.some((s) => s.status === "healthy")],
          ].map(([label, done], i) => (
            <span key={String(label)} className={done ? "complete" : ""}>
              <b>{done ? <Check size={14} /> : i + 1}</b>
              {label}
            </span>
          ))}
        </div>
        <div className="action-row">
          <button className="button secondary" onClick={signIn}>
            Owner sign in
          </button>
          <button className="text-button" onClick={explore}>
            Explore sample workspace
          </button>
          {live && data.generated_at && (
            <button className="text-button" onClick={signOut}>
              Sign out
            </button>
          )}
        </div>
        <Feedback action={action} />
      </section>
      <section className="panel setup-panel">
        <h2>
          GitHub{" "}
          <span className="tag">
            {status(data.integrations.github).replaceAll("_", " ")}
          </span>
        </h2>
        <GitHubAppPanel live={live && !!data.generated_at} refresh={refresh} />
        {(typeof data.integrations.github === "string" ||
          data.integrations.github.mode !== "github_app") && (
          <details>
            <summary>Advanced: personal access token</summary>
            <form onSubmit={(e) => save(e, "/integrations/github")}>
              <Field
                label="GitHub access token"
                name="token"
                type="password"
                required
                placeholder="github_pat_…"
              />
              <p className="form-note">
                Grant repository contents read access. Repository administration
                enables automatic webhook setup; otherwise the control plane
                polls for pushes.
              </p>
              <Submit busy={action.busy || !live}>Connect GitHub</Submit>
            </form>
            {status(data.integrations.github) === "connected" && (
              <details>
                <summary>Webhook connection</summary>
                <p className="form-note">
                  For a public control plane, register the payload URL and
                  secret in your repository.
                </p>
                <button
                  className="button secondary small"
                  onClick={() =>
                    action.run(
                      async () =>
                        setWebhook(await api("/integrations/github/webhook")),
                      "Webhook details loaded",
                    )
                  }
                >
                  Reveal webhook details
                </button>
                {webhook && (
                  <div className="stack">
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
                    <button
                      className="text-button"
                      onClick={() => setWebhook(undefined)}
                    >
                      Hide details
                    </button>
                  </div>
                )}
              </details>
            )}
          </details>
        )}
      </section>
      <section className="panel setup-panel">
        <h2>
          Cloudflare{" "}
          <span className="tag">
            {status(data.integrations.cloudflare).replaceAll("_", " ")}
          </span>
        </h2>
        <p>Your domains and private image storage, connected in one place.</p>
        <form onSubmit={(e) => save(e, "/integrations/cloudflare")}>
          <Field
            label="Cloudflare API token"
            name="token"
            type="password"
            required
          />
          <button
            className="button secondary small"
            type="button"
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
          </button>
          <div className="form-columns">
            <Field label="Account" name="account_id" required>
              {discovery ? (
                <select name="account_id" required>
                  {discovery.accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              ) : undefined}
            </Field>
            <Field label="Domain zone" name="zone_id" required>
              {discovery ? (
                <select name="zone_id" required>
                  {discovery.zones.map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.name}
                    </option>
                  ))}
                </select>
              ) : undefined}
            </Field>
          </div>
          <details open>
            <summary>Image storage credentials</summary>
            <p className="form-note">
              Use an R2 bucket and its S3 API credentials. Personal Cloud
              configures the image registry for you.
            </p>
            <Field
              label="R2 bucket"
              name="bucket"
              required
              placeholder="personal-cloud-images"
            />
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
          </details>
          <Submit busy={action.busy || !live}>Connect Cloudflare</Submit>
        </form>
      </section>
      <section className="panel setup-panel runtime-panel">
        <h2>
          Cluster connection{" "}
          <span className="tag">
            {String(runtime.status ?? "checking").replaceAll("_", " ")}
          </span>
        </h2>
        <p>
          Your first installed Linux machine connects automatically and
          coordinates your fleet. Connect Cloudflare, then set up image storage
          to start deploying.
        </p>
        {runtime.error != null && (
          <div className="form-error" role="alert">
            {String(runtime.error)}
          </div>
        )}
        <details>
          <summary>Advanced cluster connection</summary>
          <form
            key={String(runtime.nomad_url ?? "new")}
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
              label="Scheduler token (leave blank to keep saved token)"
              name="nomad_token"
              type="password"
            />
            <details>
              <summary>Advanced runtime settings</summary>
              <Field
                label="Image registry address"
                name="registry_url"
                value={String(runtime.registry_url ?? "http://10.77.0.2:5000")}
                placeholder="http://10.77.0.2:5000"
              />
              <Field
                label="Registry username"
                name="registry_username"
                value={String(runtime.registry_username ?? "")}
              />
              <Field
                label="Registry password (leave blank to keep)"
                name="registry_password"
                type="password"
              />
              <Field
                label="BuildKit address"
                name="buildkit_address"
                value={String(
                  runtime.buildkit_address ?? "tcp://127.0.0.1:1234",
                )}
                placeholder="tcp://10.77.0.2:1234"
              />
              <label className="check-option">
                <input
                  type="checkbox"
                  name="allow_insecure_registry"
                  defaultChecked={runtime.allow_insecure_registry === true}
                />
                Allow HTTP registry on trusted private network
              </label>
            </details>
            <Submit busy={action.busy || !live}>Save cluster connection</Submit>
          </form>
        </details>
        <div className="action-row">
          <button
            className="button secondary small"
            disabled={!live || action.busy}
            onClick={() =>
              action.run(
                async () => setRuntime(await api("/runtime")),
                "Diagnostics refreshed",
              )
            }
          >
            <RefreshCw size={14} />
            Check connection
          </button>
          <button
            className="button secondary small"
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
          </button>
        </div>
        <details>
          <summary>Runtime diagnostics</summary>
          <pre className="log-output">{JSON.stringify(runtime, null, 2)}</pre>
        </details>
      </section>
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
    [loading, setLoading] = useState(live);
  useEffect(() => {
    if (live)
      api<{ repositories: typeof repos }>("/github/repositories")
        .then((r) => setRepos(r.repositories))
        .catch((e) => setError(e.message))
        .finally(() => setLoading(false));
  }, [live]);
  return (
    <>
      <Field label="GitHub repository">
        <>
          <input
            name="repository"
            required
            list="github-repositories"
            pattern="[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+"
            placeholder={loading ? "Loading repositories…" : "owner/repository"}
            value={chosen}
            onChange={(e) => {
              setChosen(e.target.value);
              const repo = repos.find((r) => r.full_name === e.target.value);
              if (repo) setBranch(repo.default_branch);
            }}
          />
          <datalist id="github-repositories">
            {repos.map((r) => (
              <option key={r.full_name} value={r.full_name}>
                {r.private ? "Private" : "Public"}
              </option>
            ))}
          </datalist>
        </>
      </Field>
      {error && (
        <p className="form-note">
          {error} You can enter a repository manually after connecting GitHub in
          Settings.
        </p>
      )}
      <Field label="Production branch">
        <input
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
      <select
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
      </select>
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
    <>
      <Field
        label="Service name"
        name="name"
        value={service?.name}
        required
        placeholder="web"
      />
      <div className="form-columns">
        <Field label="Listening port">
          <input
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
      </div>
      <Placement data={data} value={service?.placement} />
      <details>
        <summary>Build and resources</summary>
        <Field
          label="Repository root directory"
          name="root_directory"
          value={service?.root_directory ?? "."}
        />
        <div className="form-columns">
          <Field label="CPU (MHz)">
            <input
              name="cpu_mhz"
              type="number"
              min={100}
              max={128000}
              defaultValue={service?.cpu_mhz ?? 500}
            />
          </Field>
          <Field label="Memory (MB)">
            <input
              name="memory_mb"
              type="number"
              min={64}
              max={1048576}
              defaultValue={service?.memory_mb ?? 512}
            />
          </Field>
        </div>
      </details>
    </>
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
  return (
    <form
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
      <Field label="Location">
        <select name="location" defaultValue={machine.location}>
          <option value="home">Home fleet</option>
          <option value="vps">Cloud VPS</option>
          <option value="dedicated">Dedicated server</option>
        </select>
      </Field>
      <fieldset>
        <legend>Roles</legend>
        {["compute", "builder", "database"].map((role) => (
          <label key={role} className="check-option">
            <input
              type="checkbox"
              name="roles"
              value={role}
              defaultChecked={machine.roles.includes(role)}
            />
            {role}
          </label>
        ))}
      </fieldset>
      <Field label="Tags" name="tags" value={machine.tags.join(", ")} />
      <dl className="detail-grid">
        <dt>Private IP</dt>
        <dd>{machine.report.private_ip || "Not reported"}</dd>
        <dt>Scheduler node</dt>
        <dd>{machine.report.nomad_node_id || "Not reported"}</dd>
        {machine.report.gpu != null && (
          <>
            <dt>GPU</dt>
            <dd>{JSON.stringify(machine.report.gpu)}</dd>
          </>
        )}
        {machine.report.network != null && (
          <>
            <dt>Network</dt>
            <dd>{JSON.stringify(machine.report.network)}</dd>
          </>
        )}
      </dl>
      <Feedback action={action} />
      <div className="action-row">
        <Submit busy={action.busy}>Save machine</Submit>
        <button
          className="text-button danger"
          type="button"
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
          Remove machine
        </button>
      </div>
    </form>
  );
}
