import { useEffect, useState } from "react";
import { api } from "../lib/data";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Feedback, useAction } from "./live";
type Backup = {
  id: string;
  kind: string;
  status: string;
  created_at: string;
  size?: number;
  error?: string;
  target_database_id?: string;
};
type State = {
  policy: { enabled: boolean; keep: number; error?: string };
  backups: Backup[];
};
export function DatabaseBackups({
  databaseId,
  live,
  refresh,
}: {
  databaseId: string;
  live: boolean;
  refresh: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false),
    [state, setState] = useState<State>(),
    [error, setError] = useState<string>(),
    [name, setName] = useState("Restored database");
  const action = useAction();
  const base = `/databases/${databaseId}/backups`;
  async function load() {
    try {
      setState(await api<State>(base));
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Backup history unavailable");
    }
  }
  useEffect(() => {
    if (!open) return;
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [open, databaseId]);
  const run = (fn: () => Promise<unknown>, message: string) =>
    action.run(async () => {
      await fn();
      await load();
      await refresh();
    }, message);
  return (
    <div className="basis-full space-y-3">
      <Button variant="outline" size="xs" onClick={() => setOpen(!open)}>
        {open ? "Hide backups" : "Backups & restore"}
      </Button>
      {open && (
        <section
          className="space-y-3 rounded-md border border-border p-4"
          aria-label="Database backups"
        >
          <div>
            <h4 className="font-medium">Database backups</h4>
            <p className="text-sm text-muted-foreground">
              Private daily PostgreSQL snapshots. Restores create a separate
              database and leave the original untouched.
            </p>
            <p className="text-xs text-muted-foreground">
              Up to 100 MiB per compressed backup. Point-in-time recovery is not
              included.
            </p>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {state && (
            <>
              <div className="flex flex-wrap gap-2 items-center">
                <Button
                  size="sm"
                  disabled={!live || action.busy}
                  onClick={() => run(() => api(base, {}), "Backup queued")}
                >
                  Back up now
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!live || action.busy}
                  onClick={() =>
                    run(
                      () =>
                        api(
                          `${base}/policy`,
                          { enabled: !state.policy.enabled, keep: state.policy.keep },
                          "PUT",
                        ),
                      "Backup schedule updated",
                    )
                  }
                >
                  {state.policy.enabled
                    ? "Disable daily backups"
                    : "Enable daily backups"}
                </Button>
                <span className="text-sm text-muted-foreground">
                  {state.policy.enabled
                    ? `Daily · keep ${state.policy.keep} successful copies`
                    : "Schedule off"}
                </span>
              </div>
              {state.policy.error && (
                <p role="alert" className="text-destructive text-sm">
                  {state.policy.error}
                </p>
              )}
              <label className="block space-y-1 text-sm">
                Name for a restored copy
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={80}
                />
              </label>
              {!state.backups.length && (
                <p className="text-sm text-muted-foreground">
                  No backups yet. Start one to protect this database.
                </p>
              )}
              {state.backups.slice(0, 20).map((b) => (
                <div
                  key={b.id}
                  className="flex flex-wrap gap-2 items-center border-t border-border pt-3 text-sm"
                >
                  <span className="capitalize">
                    {b.kind} · {b.status}
                  </span>
                  <time className="text-muted-foreground">
                    {new Date(b.created_at).toLocaleString()}
                  </time>
                  {b.size !== undefined && (
                    <span>{(b.size / 1024).toFixed(1)} KiB</span>
                  )}
                  {b.kind === "backup" && b.status === "succeeded" && (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={!live || action.busy || !name.trim()}
                      onClick={() =>
                        run(
                          () => api(`${base}/${b.id}/restore`, { name }),
                          "Restore queued into a new database",
                        )
                      }
                    >
                      Restore a copy
                    </Button>
                  )}
                  {b.kind === "backup" &&
                    ["succeeded", "failed"].includes(b.status) && (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={!live || action.busy}
                        onClick={() => {
                          if (
                            confirm(
                              "Permanently delete this backup copy? The running database is unchanged.",
                            )
                          )
                            void run(
                              () => api(`${base}/${b.id}`, undefined, "DELETE"),
                              "Backup deletion queued",
                            );
                        }}
                      >
                        Delete copy
                      </Button>
                    )}
                  {b.error && (
                    <p role="alert" className="basis-full text-destructive">
                      {b.error}
                    </p>
                  )}
                  {b.kind === "restore" && b.status === "succeeded" && (
                    <p className="basis-full text-muted-foreground">
                      Restored database is ready. Attach services explicitly
                      when you want to use it.
                    </p>
                  )}
                </div>
              ))}
            </>
          )}
          <Feedback action={action} />
        </section>
      )}
    </div>
  );
}
