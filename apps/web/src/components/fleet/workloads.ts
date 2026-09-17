import type {
  DatabaseInstance,
  Project,
  Service,
  Snapshot,
} from "../../lib/data";
import type { Sample } from "./use-fleet";

/*
 * What a machine is for, from the workspace snapshot: the services and
 * databases placed on it and whether anything is mid-deploy. Nothing here is
 * inferred from Nomad or Docker counts; a machine with containers but no
 * placed service is "idle" to the user.
 */

export type Workload = {
  service: Service;
  project: Project | undefined;
  /** The service's newest deployment is still running. */
  deploying: boolean;
};

export type Workloads = {
  services: Workload[];
  databases: DatabaseInstance[];
  deploying: number;
};

const ACTIVE = new Set([
  "queued",
  "pending",
  "building",
  "deploying",
  "provisioning",
  "running",
]);

export function workloadsOf(data: Snapshot, machineId: string): Workloads {
  const services = data.services
    .filter(
      (s) => s.machine_id === machineId || s.placement.machine_id === machineId,
    )
    .map((service) => {
      const latest = data.deployments
        .filter((d) => d.service_id === service.id)
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
      return {
        service,
        project: data.projects.find((p) => p.id === service.project_id),
        deploying: Boolean(
          latest && !latest.finished_at && ACTIVE.has(latest.status),
        ),
      };
    })
    .sort((a, b) => a.service.name.localeCompare(b.service.name));
  const databases = data.databases.filter((d) => d.machine_id === machineId);
  return {
    services,
    databases,
    deploying: services.filter((w) => w.deploying).length,
  };
}

/** "2 services · 1 database"; "idle" when nothing is placed here. */
export function workloadsLabel(w: Workloads): string {
  const parts: string[] = [];
  if (w.services.length)
    parts.push(
      `${w.services.length} service${w.services.length === 1 ? "" : "s"}`,
    );
  if (w.databases.length)
    parts.push(
      `${w.databases.length} database${w.databases.length === 1 ? "" : "s"}`,
    );
  return parts.join(" · ") || "idle";
}

/** Fill level a bar escalates at: amber from 80 %, destructive from 90 %. */
export type Pressure = "ok" | "warn" | "critical";

export function pressureOf(pct: number | null): Pressure {
  if (pct === null) return "ok";
  return pct >= 90 ? "critical" : pct >= 80 ? "warn" : "ok";
}

/** Bar colour for a pressure level; `fallback` is the host colour for a calm bar. */
export const pressureColor = (p: Pressure, fallback: string) =>
  p === "critical"
    ? "var(--destructive)"
    : p === "warn"
      ? "var(--color-yellow-500)"
      : fallback;

export const pressureText = (p: Pressure) =>
  p === "critical" ? "text-destructive" : p === "warn" ? "text-yellow-500" : "";

export function diskPercent(sample: Sample | null | undefined): number | null {
  return sample &&
    sample.diskUsedBytes !== null &&
    sample.diskTotalBytes !== null &&
    sample.diskTotalBytes > 0
    ? (sample.diskUsedBytes / sample.diskTotalBytes) * 100
    : null;
}

export function memPercent(sample: Sample | null | undefined): number | null {
  return sample && sample.memTotalBytes > 0
    ? (sample.memUsedBytes / sample.memTotalBytes) * 100
    : null;
}

/** One line per host that is under pressure or unreachable, for the page's attention strip. */
export function attentionOf(
  name: string,
  sample: Sample | null | undefined,
  unreachable: string | null,
): string | null {
  if (unreachable) return `${name} is unreachable`;
  const disk = diskPercent(sample),
    mem = memPercent(sample);
  const notes: string[] = [];
  if (pressureOf(disk) !== "ok") notes.push(`disk ${disk!.toFixed(0)}%`);
  if (pressureOf(mem) !== "ok") notes.push(`memory ${mem!.toFixed(0)}%`);
  return notes.length ? `${name} · ${notes.join(", ")}` : null;
}
