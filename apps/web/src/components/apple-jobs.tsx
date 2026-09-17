import { useEffect, useState } from "react";
import { api, type Project, type Snapshot } from "../lib/data";
import { Button } from "./ui/button";
import { Input, Select } from "./ui/input";
import { Alert, Meta } from "./ui/misc";
import { Field } from "./live";
type Job = {
  id: string;
  status: string;
  scheme: string;
  commit: string;
  action: string;
  created_at: string;
  log?: string;
  error?: string;
  reconcile_error?: string;
  has_artifact: boolean;
};
export function AppleJobs({
  project,
  data,
}: {
  project: Project;
  data: Snapshot;
}) {
  const [jobs, setJobs] = useState<Job[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [machine, setMachine] = useState("");
  const macs = data.machines.filter((m) =>
    data.readiness?.machines.some((c) => c.machine_id === m.id && c.can_apple),
  );
  const selected = macs.find((m) => m.id === machine) ?? macs[0];
  async function refresh() {
    try {
      setJobs(
        (await api<{ jobs: Job[] }>(`/projects/${project.id}/apple-jobs`)).jobs,
      );
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => {
    let done = false;
    const load = async () => {
      try {
        const v = await api<{ jobs: Job[] }>(
          `/projects/${project.id}/apple-jobs`,
        );
        if (!done) {
          setJobs(v.jobs);
          setError("");
        }
      } catch (e) {
        if (!done) setError(String(e));
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      done = true;
      clearInterval(timer);
    };
  }, [project.id]);
  return (
    <section className="flex flex-col gap-5">
      <div>
        <h2 className="text-lg font-semibold">Apple builds & tests</h2>
        <p className="text-sm text-muted-foreground">
          Build an exact commit and run iOS simulator tests on your Mac. Nomad
          schedules one Apple job per Mac at a time; signing is disabled.
        </p>
      </div>
      {error && <Alert>{error}</Alert>}
      {!selected && (
        <Alert>
          No Mac is ready for Apple jobs. Join it to your Nomad cluster, enable
          the native Apple helper, and install Xcode with an iOS Simulator
          runtime.
        </Alert>
      )}
      {!project.repository && (
        <Alert>Link a GitHub repository to run Apple jobs.</Alert>
      )}
      {selected && project.repository && (
        <form
          className="grid gap-4 rounded-lg border border-border p-4 sm:grid-cols-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            setBusy(true);
            setError("");
            try {
              await api(`/projects/${project.id}/apple-jobs`, {
                machine_id: selected.id,
                commit: f.get("commit"),
                scheme: f.get("scheme"),
                container: f.get("container"),
                action: f.get("action"),
                simulator: f.get("simulator"),
              });
              await refresh();
            } catch (err) {
              setError(String(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Mac">
            <Select
              value={selected.id}
              onChange={(e) => setMachine(e.target.value)}
            >
              {macs.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.report.hostname}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Simulator">
            <Select key={selected.id} name="simulator">
              {selected.report.apple?.simulators.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {s.runtime.split(".").pop()}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Commit SHA">
            <Input
              required
              name="commit"
              pattern="[a-fA-F0-9]{40}"
              placeholder="Full 40-character commit SHA"
            />
          </Field>
          <Field label="Xcode scheme">
            <Input required name="scheme" placeholder="MyApp" />
          </Field>
          <Field label="Project or workspace path">
            <Input
              required
              name="container"
              placeholder="ios/MyApp.xcworkspace"
            />
          </Field>
          <Field label="Action">
            <Select name="action">
              <option value="test">Build and test</option>
              <option value="build">Build only</option>
            </Select>
          </Field>
          <p className="text-xs text-muted-foreground sm:col-span-2">
            Runs repository build scripts as the Mac user. Only run code you
            trust on your own machine. Results may include screenshots and test
            attachments.
          </p>
          <Button disabled={busy} type="submit">
            {busy ? "Checking repository…" : "Queue Apple job"}
          </Button>
        </form>
      )}
      <div className="flex flex-col gap-3">
        {jobs.map((j) => (
          <article
            key={j.id}
            className="flex flex-col gap-2 rounded-lg border border-border p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong>
                {j.scheme} · {j.action}
              </strong>
              <span className="text-sm capitalize">
                {j.status.replaceAll("_", " ")}
              </span>
            </div>
            <Meta>
              {j.commit.slice(0, 12)} ·{" "}
              {new Date(j.created_at).toLocaleString()}
            </Meta>
            {j.error && <Alert>{j.error}</Alert>}
            {j.reconcile_error && <Alert>{j.reconcile_error}</Alert>}
            {j.log && (
              <details>
                <summary className="cursor-pointer text-sm">Build log</summary>
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">
                  {j.log}
                </pre>
              </details>
            )}
            <div className="flex gap-3">
              {j.has_artifact && (
                <a
                  className="text-sm text-primary underline"
                  href={`/api/projects/${project.id}/apple-jobs/${j.id}/artifact`}
                >
                  Download Xcode results
                </a>
              )}
              {["queued", "running", "cancelling"].includes(j.status) && (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={j.status === "cancelling"}
                  onClick={async () => {
                    try {
                      await api(
                        `/projects/${project.id}/apple-jobs/${j.id}`,
                        undefined,
                        "DELETE",
                      );
                      await refresh();
                    } catch (e) {
                      setError(String(e));
                    }
                  }}
                >
                  {j.status === "cancelling" ? "Stopping…" : "Cancel job"}
                </Button>
              )}
            </div>
          </article>
        ))}
        {!jobs.length && <Meta>No Apple jobs yet.</Meta>}
      </div>
    </section>
  );
}
