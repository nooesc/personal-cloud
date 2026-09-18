export type Report = {
  apple?: { enabled: boolean; xcode: string | null; simulators: {id:string; name:string; runtime:string}[] };
  hostname: string;
  os: string;
  architecture: string;
  cpu_cores: number;
  cpu_percent: number;
  memory_total: number;
  memory_used: number;
  disk_total: number;
  disk_used: number;
  docker: boolean;
  nomad: boolean;
  nomad_node_id?: string;
  private_ip?: string;
  gpu?: unknown;
  network?: unknown;
};
export type Machine = {
  id: string;
  location: "home" | "vps" | "dedicated";
  roles: string[];
  tags: string[];
  report: Report;
  last_seen: string;
  status: "online" | "degraded" | "offline";
};
export type Project = {
  id: string;
  name: string;
  repository: string;
  branch: string;
  created_at: string;
};
export type Service = {
  id: string;
  project_id: string;
  name: string;
  port: number;
  placement: { kind: string; machine_id?: string };
  status?: string;
  current_deployment_id?: string;
  image_digest?: string;
  machine_id?: string;
  address?: string;
  root_directory?: string;
  health_path?: string;
  cpu_mhz?: number;
  memory_mb?: number;
};
export type Activity = {
  id: number;
  kind: string;
  message: string;
  created_at: string;
};
export type Deployment = {
  id: string;
  service_id: string;
  status: string;
  step?: string;
  commit_sha?: string;
  image_digest?: string;
  error?: string;
  created_at: string;
  updated_at?: string;
  finished_at?: string;
  steps?: { name?: string; step?: string; status?: string; message?: string }[];
  logs?: unknown[];
};
export type DatabaseInstance = {
  id: string;
  project_id: string;
  name: string;
  machine_id?: string;
  status?: string;
  error?: string;
  /** Present on hosted control planes; self-hosted V1 runs PostgreSQL 17 only. */
  engine?: string;
  version?: string;
  /** Controller step within the current status (`submit`, `probe_submit`, `ready`, `retry`, `delete`). */
  phase?: string;
  address?: string;
  port?: number;
  volume_name?: string;
  nomad_node_id?: string;
  created_at?: string;
  updated_at?: string;
  /** When PostgreSQL last accepted an authenticated query from the controller. */
  last_verified_at?: string;
  /** Set while this database is a restore destination; `restore_failed` / `restoring` statuses follow it. */
  restore_id?: string;
};
/** A service reads DATABASE_URL from one database; at most one binding per service. */
export type DatabaseBinding = { service_id: string; database_id: string };
export type Domain = {
  id: string;
  service_id: string;
  hostname: string;
  status?: string;
  error?: string;
};
export type Provider = {
  mode?: string;
  status: string;
  login?: string;
  account_id?: string;
  zone_id?: string;
  zone_name?: string | null;
  bucket?: string;
};
export type ReadinessAction =
  | "connect_github"
  | "add_machine"
  | "configure_runtime"
  | "check_machine"
  | "retry";
export type Blocker = { code: string; message: string; action: ReadinessAction };
export type MachineState =
  | "apple_ready"
  | "offline"
  | "reporting_only"
  | "checking"
  | "ready"
  | "needs_setup";
export type MachineCapability = {
  machine_id: string;
  state: MachineState;
  can_run: boolean;
  can_build: boolean;
  can_database: boolean;
  can_apple?: boolean;
  reasons: string[];
};
/** The control plane's single answer to "can this workspace deploy?" (contract: apps/control-cloud/src/readiness.ts). */
export type Readiness = {
  status: "ready" | "blocked" | "checking";
  checked_at: string | null;
  counts: { connected: number; ready_to_run: number; ready_to_build: number };
  blockers: Blocker[];
  machines: MachineCapability[];
  recommended_roles: string[];
};
export type Repository = {
  id?: number;
  full_name: string;
  name?: string;
  private: boolean;
  default_branch: string;
  description?: string | null;
};
/** A pending or recently used enrollment token, without the secret. */
export type Enrollment = {
  id: string;
  expires_at: string;
  status: "waiting" | "connected";
  machine_id: string | null;
};
/** GET /integrations/cloudflare/overview: the account's Workers and Pages, read-only. */
/** A hostname Cloudflare reports as attached: Worker custom domains, workers.dev routes, Pages custom domains. */
export type CloudflareDomain = {
  kind: "worker" | "pages";
  name: string;
  hostname: string;
  environment: string;
};
export type CloudflareWorker = {
  name: string;
  modified_at: string | null;
  dashboard_url: string;
  /** 24h sampled Cloudflare estimates; null = unavailable, 0 = observed zero. */
  requests: number | null;
  errors: number | null;
  subrequests: number | null;
  /** Hourly sampled requests, oldest first, 24 buckets; null when Cloudflare did not report them. */
  series: number[] | null;
  /** Version upload times in the last 14 days, newest first; null when not read. */
  changes: string[] | null;
};
export type CloudflarePage = {
  name: string;
  url: string | null;
  dashboard_url: string;
  production_branch: string | null;
  deployment_status: string | null;
  modified_at: string | null;
  /** Production deployment times in the last 14 days, newest first; null when not read. */
  changes: string[] | null;
};
/**
 * A discovered Cloudflare resource's place in this workspace. Unassigned
 * resources have no record; ignored ones keep `project_id: null`.
 */
export type ResourceEnvironment = "production" | "development" | "staging" | "preview";
export type ProjectResource = {
  id: string;
  account_id: string;
  kind: "worker" | "pages";
  name: string;
  project_id: string | null;
  environment: ResourceEnvironment;
  ignored: boolean;
  updated_at: string;
};
export type Organization = { revision: string; resources: ProjectResource[] };
export type Assignment = {
  kind: ProjectResource["kind"];
  name: string;
  project_id?: string | null;
  project_name?: string;
  environment: ResourceEnvironment;
  ignored?: boolean;
};
export type CloudflareOverview = {
  status: "not_connected" | "connected" | "partial" | "error";
  account_id: string | null;
  checked_at: string | null;
  window: { start: string; end: string } | null;
  domains?: CloudflareDomain[] | null;
  workers: CloudflareWorker[];
  pages: CloudflarePage[];
  issues: string[];
  /** Absent on control planes without project organization. */
  organization?: Organization;
};
export type DatabaseAccount = { id: string; provider: "neon" | "convex"; name: string; scope_id: string; checked_at: string };
export type ProviderResource = { runtime?: {job_id: string; machine_id: string; node_id: string; image: string; data_path: string; status: string; allocation_id: string | null; checked_at: string}; site_url?: string | null; dashboard_url?: string | null; check_error?: string | null; last_check_at?: string; id: string; provider: "neon" | "convex" | "convex_self_hosted"; name: string; project_id: string; account_id?: string; provider_project_id?: string; branch_id?: string; database_name?: string; role_name?: string; url?: string; address?: string; deployment?: string; environment?: string; checked_at: string };
export type DatabaseProviders = { accounts: DatabaseAccount[]; resources: ProviderResource[]; bindings: { id: string; service_id: string; resource_id: string; variable: string }[] };
export type Snapshot = {
  database_providers?: DatabaseProviders;
  machines: Machine[];
  projects: Project[];
  services: Service[];
  deployments: Deployment[];
  databases: DatabaseInstance[];
  /** Absent on control planes predating attachment reporting. */
  database_bindings?: DatabaseBinding[];
  domains: Domain[];
  activity: Activity[];
  integrations: { github: string | Provider; cloudflare: string | Provider };
  /** Absent on control planes that do not publish readiness (legacy self-hosted). */
  readiness?: Readiness;
  enrollments?: Enrollment[];
  runtime?: Record<string, unknown>;
  /** Saved Cloudflare resource links; hosted control planes only. */
  project_resources?: ProjectResource[];
  capabilities?: { project_organization?: boolean; apple_jobs?: boolean };
  generated_at: string;
};
const GB = 1024 ** 3;
export const empty: Snapshot = {
  machines: [],
  projects: [],
  services: [],
  deployments: [],
  databases: [],
  domains: [],
  activity: [],
  integrations: { github: "not_connected", cloudflare: "not_connected" },
  generated_at: "",
};
export function size(bytes: number) {
  return bytes >= 1024 ** 4
    ? `${(bytes / 1024 ** 4).toFixed(1)} TB`
    : `${(bytes / GB).toFixed(bytes / GB < 10 ? 1 : 0)} GB`;
}
export async function api<T>(
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    cache: "no-store",
    method: method ?? (body ? "POST" : "GET"),
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const data = await response
      .json()
      .catch(() => ({ error: "Control plane unavailable" }));
    throw new ApiError(
      data.error ?? `Request failed (${response.status})`,
      response.status,
      data.readiness,
    );
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return text ? JSON.parse(text) : (undefined as T);
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    /** Deploy gates answer 409/503 with the readiness that blocked them. */
    public readiness?: Readiness,
  ) {
    super(message);
  }
}
/** The platform zone public hostnames must live under, when the control plane publishes one. */
export function platformZone(data: Snapshot): string | null {
  const cf = data.integrations.cloudflare;
  return typeof cf === "string" ? null : (cf.zone_name ?? null);
}
export function providerStatus(value: string | Provider | undefined): string {
  return typeof value === "string" ? value : (value?.status ?? "not_connected");
}
