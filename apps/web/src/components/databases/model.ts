import type {
  DatabaseInstance,
  Machine,
  MachineCapability,
  Project,
  Service,
  Snapshot,
} from "../../lib/data";
import { capabilityOf } from "../readiness";

/**
 * What the controller's `status` means to a person. `dot` keys into
 * `statusDot`; `tone` picks the badge and hairline colour.
 */
export type Health = {
  key: string;
  label: string;
  dot: string;
  tone: "healthy" | "busy" | "attention" | "quiet";
  /** True while the controller is still working on it. */
  active: boolean;
  /** True when the user can ask the controller to try again on the same machine. */
  retryable: boolean;
};

const HEALTH: Record<string, Omit<Health, "key">> = {
  healthy: { label: "Healthy", dot: "healthy", tone: "healthy", active: false, retryable: false },
  pending: { label: "Provisioning", dot: "pending", tone: "busy", active: true, retryable: false },
  provisioning: { label: "Provisioning", dot: "provisioning", tone: "busy", active: true, retryable: false },
  restoring: { label: "Restoring", dot: "pending", tone: "busy", active: true, retryable: false },
  deleting: { label: "Removing", dot: "pending", tone: "quiet", active: true, retryable: false },
  degraded: { label: "Degraded", dot: "degraded", tone: "attention", active: false, retryable: true },
  failed: { label: "Failed", dot: "failed", tone: "attention", active: false, retryable: true },
  unavailable: { label: "Unavailable", dot: "failed", tone: "attention", active: false, retryable: true },
  restore_failed: { label: "Restore failed", dot: "failed", tone: "attention", active: false, retryable: false },
};

export function healthOf(db: DatabaseInstance): Health {
  const key = (db.status ?? "pending").toLowerCase();
  const known = HEALTH[key];
  return known
    ? { key, ...known }
    : { key, label: key.replaceAll("_", " "), dot: "idle", tone: "quiet", active: false, retryable: false };
}

/** The controller's step inside a provisioning run, in words. */
export function phaseLabel(db: DatabaseInstance): string | null {
  switch (db.phase) {
    case "submit":
      return "Submitting the PostgreSQL job to the scheduler";
    case "retry":
      return "Restarting PostgreSQL on its original machine";
    case "probe_submit":
    case "probe":
      return "Waiting for an authenticated query to succeed";
    case "probe_cleanup":
      return "Verified · cleaning up the probe";
    case "delete":
      return "Stopping PostgreSQL and detaching services";
    default:
      return null;
  }
}

/** Provisioning as three stops; which one is lit comes from status and phase. */
export type Stop = { key: "submit" | "run" | "verify"; label: string; state: "done" | "active" | "failed" | "todo" };
export function stopsOf(db: DatabaseInstance): Stop[] {
  const h = healthOf(db);
  const failed = h.tone === "attention";
  const at =
    h.key === "healthy"
      ? 3
      : db.phase === "probe_submit" || db.phase === "probe" || db.phase === "probe_cleanup"
        ? 2
        : db.phase === "submit" || db.phase === "retry" || h.active || failed
          ? 1
          : 0;
  const stops: [Stop["key"], string][] = [
    ["submit", "Scheduled"],
    ["run", "Running"],
    ["verify", "Verified"],
  ];
  return stops.map(([key, label], i) => {
    const n = i + 1;
    let state: Stop["state"] = "todo";
    if (n < at || at === 3) state = "done";
    else if (n === at) state = failed ? "failed" : "active";
    return { key, label, state };
  });
}

export function engineLabel(db: DatabaseInstance): string {
  const engine = db.engine === "postgresql" || !db.engine ? "PostgreSQL" : db.engine;
  return db.version ? `${engine} ${db.version}` : engine;
}

export type Placement = {
  machine: Machine | undefined;
  capability: MachineCapability | undefined;
  /** Hostname, or what the row should say instead. */
  label: string;
  /** The machine left the workspace while the database still points at it. */
  orphaned: boolean;
};
export function placementOf(data: Snapshot, db: DatabaseInstance): Placement {
  const machine = db.machine_id ? data.machines.find((m) => m.id === db.machine_id) : undefined;
  return {
    machine,
    capability: machine ? capabilityOf(data, machine.id) : undefined,
    label: machine ? machine.report.hostname : db.machine_id ? "Machine no longer in workspace" : "Awaiting placement",
    orphaned: Boolean(db.machine_id && !machine),
  };
}

/** Services reading this database, from the snapshot's bindings. */
export function attachedServices(data: Snapshot, db: DatabaseInstance): Service[] {
  const ids = new Set((data.database_bindings ?? []).filter((b) => b.database_id === db.id).map((b) => b.service_id));
  return data.services.filter((s) => ids.has(s.id));
}

/** Project services that could still be attached: same project, no database yet. */
export function attachableServices(data: Snapshot, db: DatabaseInstance): { service: Service; bound?: DatabaseInstance }[] {
  const bindings = new Map((data.database_bindings ?? []).map((b) => [b.service_id, b.database_id]));
  return data.services
    .filter((s) => s.project_id === db.project_id && bindings.get(s.id) !== db.id)
    .map((service) => ({ service, bound: data.databases.find((d) => d.id === bindings.get(service.id)) }));
}

/** Whether the control plane reports attachments at all; older ones do not. */
export const reportsBindings = (data: Snapshot) => Array.isArray(data.database_bindings);

export function projectOf(data: Snapshot, db: DatabaseInstance): Project | undefined {
  return data.projects.find((p) => p.id === db.project_id);
}

/** Machines that can take a new database right now, with the reason when none can. */
export type DatabaseHosts = {
  ready: Machine[];
  assigned: Machine[];
  /** Readiness said no machine can host; distinguishes "assigned but not ready" from "no role". */
  blocked: boolean;
};
export function databaseHosts(data: Snapshot): DatabaseHosts {
  const assigned = data.machines.filter((m) => m.roles.includes("database"));
  const ready = data.readiness
    ? data.machines.filter((m) => capabilityOf(data, m.id)?.can_database)
    : assigned;
  return { ready, assigned, blocked: Boolean(data.readiness) && ready.length === 0 };
}

export const DATABASE_LIMITS = {
  backupBytes: 100 * 1024 * 1024,
};

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  return `${(n / 1024 ** 3).toFixed(2)} GiB`;
}
