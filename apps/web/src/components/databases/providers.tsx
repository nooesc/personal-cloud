import { useEffect, useRef, useState, type FormEvent } from "react";
import { Cloud, Link2, Plus, Server } from "lucide-react";
import {
  api,
  type Snapshot,
  type DatabaseAccount,
  type ProviderResource,
} from "../../lib/data";
import { Field, Feedback, useAction } from "../live";
import { Button } from "../ui/button";
import { Dialog, DialogFooter } from "../ui/dialog";
import { Input, Select } from "../ui/input";
import { Meta } from "../ui/misc";
import { ago } from "../project-summary";
const base = "/database-providers";
const label = (p: string) =>
  p === "neon"
    ? "Neon"
    : p === "convex"
      ? "Convex Cloud"
      : "Convex · self-hosted";
type Props = {
  data: Snapshot;
  refresh: () => Promise<unknown>;
  live: boolean;
  projectId?: string;
  settings?: boolean;
};
export function DatabaseProviderPanel(props: Props) {
  const { data, live, refresh, projectId, settings } = props;
  const [dialog, setDialog] = useState<"account" | "link" | "self" | null>(
    null,
  );
  const [resource, setResource] = useState<string>();
  const [rotate, setRotate] = useState<DatabaseAccount>();
  const state = data.database_providers;
  const action = useAction();
  if (!state) return null;
  const resources = state.resources.filter(
    (r) => !projectId || r.project_id === projectId,
  );
  return (
    <section className="gh-surface min-w-0 rounded-lg lg:col-span-2">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-4">
        <div>
          <span className="gh-eyebrow">Connected backends</span>
          <h2 className="mt-1 font-semibold">Your accounts. Your projects.</h2>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            Connect a Neon organization or Convex team once, then choose the
            resources your apps use.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!live}
            onClick={() => setDialog("account")}
          >
            <Plus />
            Connect account
          </Button>
          {!settings && (
            <>
              <Button
                size="sm"
                disabled={
                  !live || !state.accounts.length || !data.projects.length
                }
                onClick={() => setDialog("link")}
              >
                <Link2 />
                Link resource
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!live || !data.projects.length}
                onClick={() => setDialog("self")}
              >
                <Server />
                Self-hosted Convex
              </Button>
            </>
          )}
        </div>
      </header>
      <div className="flex flex-col gap-4 p-4">
        <Feedback action={action} />
        {!state.accounts.length ? (
          <p className="text-sm text-muted-foreground">
            No provider accounts connected. Your existing fleet databases stay
            independent.
          </p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {state.accounts.map((a) => (
              <li
                key={a.id}
                className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
              >
                <div className="min-w-0">
                  <span className="flex items-center gap-2 font-medium">
                    <Cloud className="size-4 text-primary" />
                    {a.name}
                  </span>
                  <p className="mt-1 break-all text-xs text-muted-foreground">
                    {label(a.provider)} · {a.scope_id}
                  </p>
                  <Meta>Access checked {ago(a.checked_at)}</Meta>
                </div>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!live}
                    onClick={() => setRotate(a)}
                  >
                    Replace key
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={
                      !live ||
                      state.resources.some((r) => r.account_id === a.id)
                    }
                    onClick={() =>
                      void action.run(async () => {
                        await api(
                          `${base}/accounts/${a.id}`,
                          undefined,
                          "DELETE",
                        );
                        await refresh();
                      }, "Account disconnected; provider data preserved")
                    }
                  >
                    Disconnect
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {!settings && (
          <>
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium">Linked resources</h3>
              <Meta>
                {resources.length} linked · data stays with its provider
              </Meta>
            </div>
            {resources.length ? (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {resources.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      className="gh-interactive flex w-full flex-wrap items-center justify-between gap-2 p-3 text-left"
                      onClick={() => setResource(r.id)}
                    >
                      <div className="min-w-0">
                        <span className="font-medium">{r.name}</span>
                        <p className="break-all text-xs text-muted-foreground">
                          {label(r.provider)} ·{" "}
                          {r.database_name ?? r.deployment ?? r.url}
                        </p>
                      </div>
                      <Meta>
                        {data.projects.find((p) => p.id === r.project_id)?.name}{" "}
                        ·{" "}
                        {
                          state.bindings.filter((b) => b.resource_id === r.id)
                            .length
                        }{" "}
                        attached
                      </Meta>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                Link an existing database or deployment to a Dinghy project.
                Linking does not move or copy data.
              </p>
            )}
          </>
        )}
      </div>
      {dialog === "account" && (
        <ConnectAccount {...props} onClose={() => setDialog(null)} />
      )}
      {dialog === "link" && (
        <LinkResource {...props} onClose={() => setDialog(null)} />
      )}
      {dialog === "self" && (
        <SelfHosted {...props} onClose={() => setDialog(null)} />
      )}
      {rotate && (
        <RotateKey
          {...props}
          account={rotate}
          onClose={() => setRotate(undefined)}
        />
      )}
      {resource && state.resources.find((r) => r.id === resource) && (
        <ResourceDetail
          key={resource}
          {...props}
          resource={state.resources.find((r) => r.id === resource)!}
          onClose={() => setResource(undefined)}
        />
      )}
    </section>
  );
}
function ConnectAccount({ refresh, onClose }: Props & { onClose: () => void }) {
  const [provider, setProvider] = useState("neon"),
    action = useAction();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    await action.run(async () => {
      await api(`${base}/accounts`, { ...f, provider });
      await refresh();
      onClose();
    });
  }
  return (
    <Dialog
      title="Connect a provider account"
      description="One encrypted credential for organization-wide discovery. Only selected resources are linked to your apps."
      onClose={onClose}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Provider">
          <Select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          >
            <option value="neon">Neon</option>
            <option value="convex">Convex Cloud</option>
          </Select>
        </Field>
        <Field label="Connection name">
          <Input name="name" placeholder="My team" maxLength={80} required />
        </Field>
        <Field
          label={provider === "neon" ? "Organization ID" : "Team ID"}
          hint={
            provider === "neon"
              ? "Use an organization API key, or a personal key with access to this organization."
              : "Use a team access token, not a deployment key. Your numeric team ID is shown when creating the token."
          }
        >
          <Input
            key={provider}
            name="scope_id"
            placeholder={provider === "neon" ? "org-…" : "12345"}
            required
          />
        </Field>
        <Field label={provider === "neon" ? "API key" : "Team access token"}>
          <Input
            key={provider}
            name="api_key"
            type="password"
            autoComplete="off"
            required
          />
        </Field>
        <p className="text-xs text-muted-foreground">
          Create credentials in{" "}
          <a
            className="underline"
            href={
              provider === "neon"
                ? "https://console.neon.tech"
                : "https://dashboard.convex.dev"
            }
            target="_blank"
            rel="noreferrer"
          >
            {label(provider)} ↗
          </a>
          . Dinghy validates access before saving. This key is never injected
          into an app.
        </p>
        <Feedback action={action} />
        <DialogFooter>
          <Button variant="outline" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={action.busy}>Connect account</Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
function RotateKey({
  refresh,
  onClose,
  account,
}: Props & { onClose: () => void; account: DatabaseAccount }) {
  const action = useAction();
  return (
    <Dialog title={`Replace ${account.name} credential`} onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          const api_key = new FormData(e.currentTarget).get("api_key");
          void action.run(async () => {
            await api(
              `${base}/accounts/${account.id}/credential`,
              { api_key },
              "PUT",
            );
            await refresh();
            onClose();
          });
        }}
      >
        <Field
          label="New account key"
          hint="The replacement must still access this organization. Existing app connection credentials are unchanged."
        >
          <Input name="api_key" type="password" autoComplete="off" required />
        </Field>
        <Feedback action={action} />
        <DialogFooter>
          <Button type="submit" disabled={action.busy}>Verify and replace</Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
type Item = {
  id: string;
  name: string;
  environment?: string;
  is_default?: boolean;
};
type Page = {
  items: Item[];
  next_cursor?: string | null;
  roles?: { name: string }[];
};
function useProviderPage(path: string | undefined) {
  const [page, setPage] = useState<Page>({ items: [] }),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const turn = ++generation.current;
    setPage({ items: [] });
    setError("");
    if (!path) {
      setBusy(false);
      return;
    }
    setBusy(true);
    void api<Page>(path)
      .then((v) => {
        if (generation.current === turn) setPage(v);
      })
      .catch((e) => {
        if (generation.current === turn) setError(String(e.message));
      })
      .finally(() => {
        if (generation.current === turn) setBusy(false);
      });
    return () => {
      generation.current++;
    };
  }, [path, revision]);
  async function more() {
    if (!path || !page.next_cursor || busy) return;
    const turn = generation.current;
    setBusy(true);
    setError("");
    try {
      const v = await api<Page>(
        `${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(page.next_cursor)}`,
      );
      if (generation.current === turn)
        setPage((p) => ({
          ...v,
          items: [
            ...p.items,
            ...v.items.filter((i) => !p.items.some((old) => old.id === i.id)),
          ],
        }));
    } catch (e) {
      if (generation.current === turn) setError((e as Error).message);
    } finally {
      if (generation.current === turn) setBusy(false);
    }
  }
  return { ...page, error, busy, more, retry: () => setRevision((n) => n + 1) };
}
function PageState({ page }: { page: ReturnType<typeof useProviderPage> }) {
  return (
    <>
      {page.busy && <Meta>Loading provider resources…</Meta>}
      {page.error && (
        <div role="alert" className="text-sm text-destructive">
          {page.error}{" "}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={page.retry}
          >
            Retry
          </Button>
        </div>
      )}
      {!page.busy && !page.error && !page.items.length && (
        <Meta>No resources found.</Meta>
      )}
      {page.next_cursor && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={page.busy}
          onClick={() => void page.more()}
        >
          Load more
        </Button>
      )}
    </>
  );
}
function ProjectSelect({ data, projectId }: Props) {
  return (
    <Field label="Dinghy project">
      <Select
        name="project_id"
        defaultValue={projectId ?? data.projects[0]?.id}
        disabled={!!projectId}
      >
        {data.projects
          .filter((p) => !projectId || p.id === projectId)
          .map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
      </Select>
    </Field>
  );
}
function LinkResource(props: Props & { onClose: () => void }) {
  const { data, refresh, onClose } = props,
    accounts = data.database_providers!.accounts;
  const [accountId, setAccount] = useState(accounts[0]?.id ?? ""),
    [project, setProject] = useState(""),
    [branch, setBranch] = useState(""),
    [selected, setSelected] = useState("");
  const a = accounts.find((a) => a.id === accountId),
    action = useAction();
  const projects = useProviderPage(
    a ? `${base}/accounts/${a.id}/projects` : undefined,
  );
  const options = useProviderPage(
    a && project
      ? `${base}/accounts/${a.id}/resources?project_id=${encodeURIComponent(project)}`
      : undefined,
  );
  const databases = useProviderPage(
    a?.provider === "neon" && project && branch
      ? `${base}/accounts/${a.id}/resources?project_id=${encodeURIComponent(project)}&branch_id=${encodeURIComponent(branch)}`
      : undefined,
  );
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    await action.run(async () => {
      await api(`${base}/resources`, {
        ...f,
        project_id: props.projectId ?? f.project_id,
        account_id: accountId,
        provider_project_id: project,
        branch_id: branch,
        database_name: selected,
        deployment: selected,
      });
      await refresh();
      onClose();
    });
  }
  const ready =
    !!selected &&
    !projects.busy &&
    !options.busy &&
    !databases.busy &&
    !projects.error &&
    !options.error &&
    !databases.error;
  return (
    <Dialog
      title="Link a provider resource"
      description="Browse your account and choose an existing resource. Provider data and billing stay with the provider."
      onClose={onClose}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Account">
          <Select
            value={accountId}
            onChange={(e) => {
              setAccount(e.target.value);
              setProject("");
              setBranch("");
              setSelected("");
            }}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {label(a.provider)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Provider project">
          <Select
            value={project}
            required
            onChange={(e) => {
              setProject(e.target.value);
              setBranch("");
              setSelected("");
            }}
          >
            <option value="">Choose a project</option>
            {projects.items.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          <PageState page={projects} />
        </Field>
        {project && (
          <Field label={a?.provider === "neon" ? "Branch" : "Deployment"}>
            <Select
              value={a?.provider === "neon" ? branch : selected}
              required
              onChange={(e) => {
                if (a?.provider === "neon") {
                  setBranch(e.target.value);
                  setSelected("");
                } else setSelected(e.target.value);
              }}
            >
              <option value="">
                Choose {a?.provider === "neon" ? "a branch" : "a deployment"}
              </option>
              {options.items.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.environment
                    ? ` · ${p.environment}`
                    : p.is_default
                      ? " · default"
                      : ""}
                </option>
              ))}
            </Select>
            <PageState page={options} />
          </Field>
        )}
        {a?.provider === "neon" && branch && (
          <>
            <Field label="Database">
              <Select
                value={selected}
                required
                onChange={(e) => setSelected(e.target.value)}
              >
                <option value="">Choose a database</option>
                {databases.items.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
              <PageState page={databases} />
            </Field>
            <Field label="PostgreSQL role">
              <Select name="role_name" key={branch} required defaultValue="">
                <option value="">Choose a role</option>
                {databases.roles?.map((r) => (
                  <option key={r.name}>{r.name}</option>
                ))}
              </Select>
            </Field>
          </>
        )}
        <ProjectSelect {...props} />
        <Field label="Name in Dinghy">
          <Input
            name="name"
            placeholder="Application backend"
            maxLength={80}
            required
          />
        </Field>
        <Feedback action={action} />
        <DialogFooter>
          <Button variant="outline" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!ready || action.busy}>Link resource</Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
function SelfHosted(props: Props & { onClose: () => void }) {
  const action = useAction();
  return (
    <Dialog
      title="Connect self-hosted Convex"
      description="Connect a running Convex backend through its public HTTPS address. Dinghy will not install or move the backend."
      onClose={props.onClose}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          const f = Object.fromEntries(new FormData(e.currentTarget));
          void action.run(async () => {
            await api(`${base}/resources`, {
              ...f,
              provider: "convex_self_hosted",
              project_id: props.projectId ?? f.project_id,
            });
            await props.refresh();
            props.onClose();
          });
        }}
      >
        <ProjectSelect {...props} />
        <Field label="Name">
          <Input name="name" required maxLength={80} />
        </Field>
        <Field label="Backend URL">
          <Input
            name="url"
            type="url"
            placeholder="https://convex.example.com"
            required
          />
        </Field>
        <Field
          label="Admin key"
          hint="Stored encrypted for explicit CLI connection reveal. Never injected into an app or browser bundle."
        >
          <Input name="admin_key" type="password" autoComplete="off" required />
        </Field>
        <Feedback action={action} />
        <DialogFooter>
          <Button type="submit" disabled={action.busy}>Verify and connect</Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
function ResourceDetail({
  data,
  live,
  refresh,
  resource: r,
  onClose,
}: Props & { resource: ProviderResource; onClose: () => void }) {
  const action = useAction(),
    [connection, setConnection] = useState<Record<string, string>>();
  const state = data.database_providers!,
    readers = state.bindings.filter((b) => b.resource_id === r.id);
  const services = data.services.filter(
    (s) =>
      s.project_id === r.project_id &&
      !readers.some((b) => b.service_id === s.id),
  );
  return (
    <Dialog
      title={r.name}
      description={`${label(r.provider)} · linked ${ago(r.checked_at)}. Provider access was checked; application query health is not monitored here.`}
      onClose={onClose}
    >
      <div className="flex flex-col gap-4">
        <p className="break-all text-sm text-muted-foreground">
          {r.url ?? `${r.database_name} · ${r.branch_id} · ${r.address}`}
        </p>
        <h3 className="text-sm font-medium">Attached services</h3>
        {readers.length ? (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {readers.map((b) => (
              <li
                className="flex flex-wrap items-center justify-between gap-2 p-3"
                key={b.id}
              >
                <span className="text-sm">
                  {data.services.find((s) => s.id === b.service_id)?.name ??
                    "Removed service"}
                  <Meta className="block">{b.variable}</Meta>
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!live || action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      await api(`${base}/resources/${r.id}/detach`, {
                        service_id: b.service_id,
                      });
                      await refresh();
                    })
                  }
                >
                  Detach
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <Meta>No services attached.</Meta>
        )}
        {!!services.length && (
          <form
            className="flex flex-col gap-3 rounded-lg border border-border p-3"
            onSubmit={(e) => {
              e.preventDefault();
              const f = Object.fromEntries(new FormData(e.currentTarget));
              void action.run(async () => {
                await api(`${base}/resources/${r.id}/attach`, f);
                await refresh();
              });
            }}
          >
            <Field label="Attach a service">
              <Select name="service_id">
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            {r.provider !== "neon" && (
              <Field label="URL variable">
                <Select name="variable">
                  <option>CONVEX_URL</option>
                  <option>NEXT_PUBLIC_CONVEX_URL</option>
                  <option>VITE_CONVEX_URL</option>
                  <option>PUBLIC_CONVEX_URL</option>
                </Select>
              </Field>
            )}
            <p className="text-xs text-muted-foreground">
              {r.provider === "neon"
                ? "Sets DATABASE_URL on the next app deployment."
                : "Sets the URL at runtime on the next deployment. Frontends that compile their URL into JavaScript also need this value configured in their build."}
            </p>
            <Button type="submit" size="sm" disabled={!live || action.busy}>
              Attach
            </Button>
          </form>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={!live || action.busy}
            onClick={() => {
              if (connection) setConnection(undefined);
              else
                void action.run(async () =>
                  setConnection(
                    await api<Record<string, string>>(
                      `${base}/resources/${r.id}/connection`,
                    ),
                  ),
                );
            }}
          >
            {connection ? "Hide connection" : "Reveal connection"}
          </Button>
          <Button
            variant="outline"
            disabled={!live || !!readers.length || action.busy}
            onClick={() =>
              void action.run(async () => {
                await api(`${base}/resources/${r.id}`, undefined, "DELETE");
                await refresh();
                onClose();
              })
            }
          >
            Unlink from Dinghy
          </Button>
        </div>
        {connection && (
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">
            {Object.entries(connection)
              .map(([k, v]) => `${k}=${v}`)
              .join("\n")}
          </pre>
        )}
        <p className="text-xs text-muted-foreground">
          Unlinking preserves the remote backend and its data. Backups and
          recovery remain with the provider or self-hosted backend operator.
        </p>
        <Feedback action={action} />
      </div>
    </Dialog>
  );
}
