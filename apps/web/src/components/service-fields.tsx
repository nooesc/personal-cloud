import { useContext, useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { api, type Repository, type Service, type Snapshot } from "../lib/data";
import { Disclosure, Field, useAction } from "./live";
import { ReadinessActions, capabilityLabel, capabilityOf } from "./readiness";
import { Button } from "./ui/button";
import { Input, Select } from "./ui/input";
import { Alert, Meta } from "./ui/misc";

export type RepositoryChoice = {
  full_name: string;
  default_branch: string;
  name: string;
};

const FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** A hostname-safe label for suggested public addresses. */
export function slug(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .replace(/-$/, "");
}

function f(form: FormData, key: string) {
  return String(form.get(key) || "");
}

export function RepositoryField({
  live,
  onChange,
}: {
  live: boolean;
  onChange?: (repo: RepositoryChoice | null) => void;
}) {
  const [repos, setRepos] = useState<Repository[]>([]),
    [chosen, setChosen] = useState(""),
    [branch, setBranch] = useState("main"),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(live),
    [loaded, setLoaded] = useState(false),
    [manual, setManual] = useState(false),
    handlers = useContext(ReadinessActions),
    install = useAction();
  useEffect(() => {
    if (!live) return;
    let ended = false;
    api<{ repositories: Repository[] }>("/github/repositories")
      .then((r) => {
        if (ended) return;
        setRepos(r.repositories);
        setLoaded(true);
      })
      .catch((e) => {
        if (!ended) setError(e.message);
      })
      .finally(() => {
        if (!ended) setLoading(false);
      });
    return () => {
      ended = true;
    };
  }, [live]);
  const pick = repos.length > 0 && !manual,
    none = loaded && repos.length === 0 && !error;
  function choose(value: string) {
    setChosen(value);
    const repo = repos.find((r) => r.full_name === value);
    if (repo) {
      setBranch(repo.default_branch);
      onChange?.({
        full_name: repo.full_name,
        default_branch: repo.default_branch,
        name: repo.name ?? repo.full_name.slice(repo.full_name.indexOf("/") + 1),
      });
    } else if (FULL_NAME.test(value)) {
      onChange?.({
        full_name: value,
        default_branch: "main",
        name: value.slice(value.indexOf("/") + 1),
      });
    } else onChange?.(null);
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field
        label="GitHub repository"
        hint={
          error ? (
            <>
              {error} You can enter a repository manually after connecting
              GitHub in{" "}
              {handlers ? (
                <Button
                  variant="link"
                  size="xs"
                  className="h-auto p-0 text-xs"
                  onClick={handlers.connect_github}
                >
                  Settings
                </Button>
              ) : (
                "Settings"
              )}
              .
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
            onChange={(e) => choose(e.target.value)}
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
            onChange={(e) => choose(e.target.value)}
          />
        )}
      </Field>
      <Field label="Branch">
        <Input
          name="branch"
          required
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
        />
      </Field>
      {none && (
        <Alert className="sm:col-span-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span>No repositories connected yet.</span>
            <Button
              size="xs"
              variant="outline"
              isLoading={install.busy}
              onClick={() =>
                install.run(async () => {
                  const r = await api<{ url: string }>(
                    "/github/app/install",
                    {},
                  );
                  window.location.assign(r.url);
                })
              }
            >
              Choose repositories
              <ArrowRight />
            </Button>
            <Meta>or type an owner/repository you have access to</Meta>
          </div>
          {install.error && (
            <span className="text-xs text-destructive">{install.error}</span>
          )}
        </Alert>
      )}
    </div>
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
            {m.report.hostname} · {capabilityLabel(capabilityOf(data, m.id))}
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
  mode,
}: {
  data: Snapshot;
  service?: Service;
  mode: "create" | "edit";
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Service name"
          name="name"
          value={service?.name ?? "web"}
          required
          placeholder="web"
        />
        <Field
          label="Listening port"
          hint="The port your app listens on. Most frameworks use 3000, 8080 or 8000."
        >
          <Input
            name="port"
            type="number"
            required
            min={1}
            max={65535}
            defaultValue={service?.port ?? 3000}
          />
        </Field>
      </div>
      <Disclosure title="Advanced" defaultOpen={mode === "edit"}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Health check path"
            name="health_path"
            value={service?.health_path ?? "/"}
            required
          />
          <Field
            label="Repository root directory"
            name="root_directory"
            value={service?.root_directory ?? "."}
            hint="For monorepos, the folder that contains this service."
          />
          <div className="sm:col-span-2">
            <Placement data={data} value={service?.placement} />
          </div>
          <Field label="CPU (MHz)" hint="500 MHz is plenty for most web apps.">
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
      </Disclosure>
    </div>
  );
}
