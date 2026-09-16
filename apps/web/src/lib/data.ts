export type Report = {
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
  demo_machine?: string;
  demo_status?: string;
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
};
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
  zone_name?: string;
  bucket?: string;
};
export type Snapshot = {
  machines: Machine[];
  projects: Project[];
  services: Service[];
  deployments: Deployment[];
  databases: DatabaseInstance[];
  domains: Domain[];
  activity: Activity[];
  integrations: { github: string | Provider; cloudflare: string | Provider };
  runtime?: Record<string, unknown>;
  generated_at: string;
};
const GB = 1024 ** 3;
const machine = (
  id: string,
  hostname: string,
  location: Machine["location"],
  cores: number,
  ram: number,
  disk: number,
  cpu: number,
  used: number,
  roles: string[],
  status: Machine["status"] = "online",
): Machine => ({
  id,
  location,
  roles,
  tags: location === "home" ? ["home-lab"] : ["us-east"],
  last_seen: "2026-09-15T14:00:00Z",
  status,
  report: {
    hostname,
    os: "Ubuntu 24.04",
    architecture: location === "home" ? "arm64" : "amd64",
    cpu_cores: cores,
    cpu_percent: cpu,
    memory_total: ram * GB,
    memory_used: used * GB,
    disk_total: disk * GB,
    disk_used: disk * 0.22 * GB,
    docker: true,
    nomad: status === "online",
  },
});
export const demo: Snapshot = {
  machines: [
    machine("m1", "studio", "home", 16, 64, 2000, 22, 12, [
      "compute",
      "builder",
    ]),
    machine("m2", "mini", "home", 10, 32, 1000, 11, 5.2, ["compute"]),
    machine("m3", "vps-east", "vps", 4, 8, 160, 47, 3.8, ["compute"]),
    machine("m4", "db-01", "vps", 4, 16, 320, 18, 6.4, ["database"]),
  ],
  projects: [
    {
      id: "p1",
      name: "Intake",
      repository: "example/intake",
      branch: "main",
      created_at: "2026-09-15T14:00:00Z",
    },
    {
      id: "p2",
      name: "Social scraper",
      repository: "example/social-scraper",
      branch: "main",
      created_at: "2026-09-15T13:00:00Z",
    },
    {
      id: "p3",
      name: "Personal website",
      repository: "example/website",
      branch: "main",
      created_at: "2026-09-15T12:00:00Z",
    },
  ],
  services: [
    {
      id: "s1",
      project_id: "p1",
      name: "web",
      port: 3000,
      placement: { kind: "automatic" },
      demo_machine: "m3",
      demo_status: "healthy",
    },
    {
      id: "s2",
      project_id: "p1",
      name: "api",
      port: 3001,
      placement: { kind: "vps" },
      demo_machine: "m3",
      demo_status: "healthy",
    },
    {
      id: "s3",
      project_id: "p2",
      name: "worker",
      port: 8080,
      placement: { kind: "home" },
      demo_machine: "m1",
      demo_status: "healthy",
    },
    {
      id: "s4",
      project_id: "p3",
      name: "web",
      port: 3000,
      placement: { kind: "automatic" },
      demo_machine: "m2",
      demo_status: "healthy",
    },
  ],
  deployments: [],
  databases: [],
  domains: [],
  activity: [
    {
      id: 3,
      kind: "deployment.healthy",
      message: "Intake / web deployed successfully",
      created_at: "2026-09-15T14:00:00Z",
    },
    {
      id: 2,
      kind: "machine.joined",
      message: "mini joined your cloud",
      created_at: "2026-09-15T13:00:00Z",
    },
    {
      id: 1,
      kind: "project.created",
      message: "Personal website added to your cloud",
      created_at: "2026-09-15T12:00:00Z",
    },
  ],
  integrations: { github: "not_connected", cloudflare: "not_connected" },
  generated_at: "2026-09-15T14:00:00Z",
};
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
  ) {
    super(message);
  }
}
