import { useState, type FormEvent, type ReactNode } from "react";
import { Database, Server, ShieldCheck } from "lucide-react";
import { api, type Machine, type Snapshot } from "../../lib/data";
import { cn } from "../../lib/utils";
import { BlockerAction, MACHINE_STATE, capabilityLabel, capabilityOf } from "../readiness";
import { Feedback, Field, useAction } from "../live";
import { Button } from "../ui/button";
import { Dialog, DialogFooter } from "../ui/dialog";
import { Checkbox, Input, Select } from "../ui/input";
import { Meta, StatusDot } from "../ui/misc";
import { databaseHosts, healthOf } from "./model";

const AUTOMATIC = "";

/**
 * Provision PostgreSQL. Placement is the decision that matters, so it is a
 * list the user reads rather than a dropdown: every database-capable machine
 * with what already runs there. Readiness decides who is eligible; the form
 * never guesses past it.
 */
export function ProvisionDatabase({
  data,
  live,
  refresh,
  projectId,
  onClose,
  onCreated,
}: {
  data: Snapshot;
  live: boolean;
  refresh: () => Promise<unknown>;
  /** Locks the project when opened from inside one. */
  projectId?: string;
  onClose: () => void;
  onCreated: (id: string | undefined) => void;
}) {
  const action = useAction();
  const hosts = databaseHosts(data);
  const projects = data.projects.filter((p) => !projectId || p.id === projectId);
  const [project, setProject] = useState(projectId ?? projects[0]?.id ?? "");
  const [name, setName] = useState("");
  const [machine, setMachine] = useState(AUTOMATIC);
  const bindings = new Map((data.database_bindings ?? []).map((b) => [b.service_id, b.database_id]));
  const services = data.services.filter((s) => s.project_id === project);
  const nameTaken = data.databases.some((d) => d.project_id === project && d.name === name.trim());

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    await action.run(async () => {
      const created = await api<{ id?: string }>("/databases", {
        project_id: project,
        name: name.trim(),
        machine_id: machine || undefined,
        service_ids: form.getAll("service_ids"),
      });
      await refresh();
      onCreated(created?.id);
    }, "Database provisioning requested");
  }

  return (
    <Dialog
      title="New database"
      description="PostgreSQL 17, private to your fleet network, on a volume that stays with its machine."
      onClose={onClose}
      size="wide"
    >
      <form onSubmit={submit} className="flex flex-col gap-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Project">
            <Select value={project} onChange={(e) => setProject(e.target.value)} disabled={Boolean(projectId)} required>
              {projects.map((p) => (
                <option value={p.id} key={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Name"
            hint={
              nameTaken ? (
                <span className="text-destructive">This project already has a database called {name.trim()}.</span>
              ) : (
                "Shown in dinghy only; the PostgreSQL user and database are generated."
              )
            }
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="main"
              required
              maxLength={80}
              aria-invalid={nameTaken || undefined}
              autoComplete="off"
            />
          </Field>
        </div>

        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="flex w-full items-baseline justify-between gap-3 pb-1.5 text-sm font-medium">
            Machine
            <Meta className="font-normal">placement is permanent</Meta>
          </legend>
          {hosts.blocked ? (
            <NoHost data={data} assigned={hosts.assigned} />
          ) : (
            <ul className="gh-surface divide-y divide-border overflow-hidden rounded-lg" role="radiogroup" aria-label="Machine">
              <PlacementRow
                checked={machine === AUTOMATIC}
                onSelect={() => setMachine(AUTOMATIC)}
                title="Automatic"
                detail="dinghy picks a ready database machine for you."
                icon={<ShieldCheck className="size-4 text-muted-foreground" />}
              />
              {hosts.ready.map((m) => (
                <PlacementRow
                  key={m.id}
                  checked={machine === m.id}
                  onSelect={() => setMachine(m.id)}
                  title={m.report.hostname}
                  detail={placementDetail(data, m)}
                  icon={<StatusDot status={m.status} className="mx-1" />}
                  meta={`${m.location} · ${m.report.architecture}`}
                />
              ))}
            </ul>
          )}
          {!data.readiness && !hosts.blocked && (
            <Meta>Readiness unavailable on this control plane; listed machines carry the database role.</Meta>
          )}
        </fieldset>

        {services.length > 0 && (
          <fieldset className="flex flex-col gap-2">
            <legend className="flex w-full items-baseline justify-between gap-3 pb-1.5 text-sm font-medium">
              Attach to services
              <Meta className="font-normal">optional · sets DATABASE_URL at deploy</Meta>
            </legend>
            <ul className="flex flex-col gap-1">
              {services.map((s) => {
                const elsewhere = bindings.has(s.id) ? data.databases.find((d) => d.id === bindings.get(s.id)) : undefined;
                return (
                  <li key={s.id}>
                    <label
                      className={cn(
                        "gh-interactive flex items-center gap-3 rounded-md px-2 py-1.5 text-sm",
                        elsewhere ? "cursor-not-allowed opacity-60" : "cursor-pointer",
                      )}
                    >
                      <Checkbox name="service_ids" value={s.id} disabled={Boolean(elsewhere)} />
                      <span className="min-w-0 flex-1 truncate">{s.name}</span>
                      <Meta className="shrink-0">
                        {elsewhere ? `reads ${elsewhere.name}` : s.machine_id ? "placed" : "not deployed"}
                      </Meta>
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        )}

        <Feedback action={action} />
        <DialogFooter className="items-center sm:justify-between">
          <Meta className="hidden sm:block">Credentials are generated and sealed; reveal them from the database page.</Meta>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              isLoading={action.busy}
              disabled={!live || hosts.blocked || nameTaken || !project || !name.trim()}
            >
              {!action.busy && <Database />}
              Provision PostgreSQL
            </Button>
          </div>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function placementDetail(data: Snapshot, m: Machine): string {
  const here = data.databases.filter((d) => d.machine_id === m.id);
  const healthy = here.filter((d) => healthOf(d).key === "healthy").length;
  const cap = capabilityOf(data, m.id);
  return [
    here.length === 0
      ? "no databases yet"
      : `${here.length} database${here.length === 1 ? "" : "s"}${healthy < here.length ? ` · ${here.length - healthy} not healthy` : ""}`,
    cap ? capabilityLabel(cap) : m.roles.join(" · "),
  ].join(" · ");
}

function PlacementRow({
  checked,
  onSelect,
  title,
  detail,
  meta,
  icon,
}: {
  checked: boolean;
  onSelect: () => void;
  title: string;
  detail: string;
  meta?: string;
  icon: ReactNode;
}) {
  return (
    <li>
      <label
        className={cn(
          "gh-interactive flex cursor-pointer items-center gap-3 px-3 py-2.5",
          checked && "bg-primary/[0.06]",
        )}
      >
        <input type="radio" name="machine_id" className="sr-only" checked={checked} onChange={onSelect} />
        <span
          aria-hidden
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
            checked ? "border-primary" : "border-input",
          )}
        >
          <span
            className={cn(
              "size-2 rounded-full bg-primary transition-transform motion-reduce:transition-none",
              checked ? "scale-100" : "scale-0",
            )}
          />
        </span>
        {icon}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium">{title}</span>
            {meta && <Meta className="hidden shrink-0 sm:inline">{meta}</Meta>}
          </span>
          <span className="text-xs text-muted-foreground">{detail}</span>
        </span>
      </label>
    </li>
  );
}

/** Readiness said no. Assigned-but-not-ready and missing-role are different problems with different fixes. */
function NoHost({ data, assigned }: { data: Snapshot; assigned: Machine[] }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-yellow-500/30 bg-yellow-500/[0.06] p-3 text-sm">
      <p className="flex items-start gap-2">
        <Server className="mt-0.5 size-4 shrink-0 text-yellow-500" />
        {assigned.length
          ? "The database role is assigned, but no database machine is ready yet."
          : "No machine has the database role. Assign it in Machines to choose where PostgreSQL runs."}
      </p>
      {assigned.length > 0 && (
        <ul className="flex flex-col gap-2">
          {assigned.map((m) => {
            const cap = capabilityOf(data, m.id);
            return (
              <li key={m.id} className="flex flex-col gap-0.5 rounded-md bg-background/60 px-3 py-2">
                <span className="flex items-center gap-2 font-medium">
                  <StatusDot status={cap ? MACHINE_STATE[cap.state].dot : m.status} />
                  {m.report.hostname}
                  <Meta>{capabilityLabel(cap)}</Meta>
                </span>
                <span className="text-xs text-muted-foreground">
                  {cap?.state === "reporting_only"
                    ? "Monitoring is connected. Finish installing and connecting the Nomad runtime before hosting databases."
                    : cap?.reasons.join(" ") || "Check this machine’s runtime connection and database capability in Machines."}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <div>
        <BlockerAction
          blocker={{ code: "database_machine_not_ready", message: "Check database machines", action: "check_machine" }}
        />
      </div>
    </div>
  );
}
