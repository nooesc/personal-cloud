import { fail, type Doc } from "../core";

export function immutableImage(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-fA-F0-9]{64}$/.test(value) ||
    value.length > 512
  )
    fail(400, "Deployments require an immutable sha256 image digest");
  return value;
}
export function placement(value: unknown): Doc {
  const p = value as Doc;
  if (
    !p ||
    !["automatic", "home", "vps", "machine"].includes(p.kind) ||
    (p.kind === "machine" &&
      (typeof p.machine_id !== "string" ||
        !/^[a-f0-9-]{36}$/.test(p.machine_id)))
  )
    fail(400, "Invalid placement");
  return {
    kind: p.kind,
    ...(p.kind === "machine" ? { machine_id: p.machine_id } : {}),
  };
}
export function validateService(input: Doc): Doc {
  const port = Number(input.port ?? 3000),
    cpu = Number(input.cpu_mhz ?? 500),
    memory = Number(input.memory_mb ?? 256);
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !Number.isInteger(cpu) ||
    cpu < 100 ||
    cpu > 128000 ||
    !Number.isInteger(memory) ||
    memory < 64 ||
    memory > 1048576
  )
    fail(400, "Invalid port, CPU or memory");
  const root = input.root_directory ?? ".",
    health = input.health_path ?? "/",
    arch = input.architecture ?? "auto";
  if (
    typeof root !== "string" ||
    !root ||
    root.length > 200 ||
    root.startsWith("/") ||
    root.split(/[\\/]/).includes("..") ||
    /[\x00-\x1f]/.test(root)
  )
    fail(400, "Root directory must stay inside the repository");
  if (
    typeof health !== "string" ||
    !health.startsWith("/") ||
    health.length > 200 ||
    /[\x00-\x1f]/.test(health)
  )
    fail(400, "Health path must begin with /");
  if (!["auto", "amd64", "arm64"].includes(arch))
    fail(400, "Unsupported architecture");
  return {
    port,
    cpu_mhz: cpu,
    memory_mb: memory,
    root_directory: root,
    health_path: health,
    architecture: arch,
    placement: placement(input.placement ?? { kind: "automatic" }),
    auto_deploy: input.auto_deploy !== false,
  };
}
export const constraint = (key: string, value: string): Doc => ({
  LTarget: key,
  Operand: "=",
  RTarget: value,
});
export function ready(node: Doc, role: string): boolean {
  return (
    node.Status === "ready" &&
    node.SchedulingEligibility === "eligible" &&
    node.Drain !== true &&
    node.Meta?.[`pc_${role}`] === "true" &&
    node.Drivers?.docker?.Healthy === true
  );
}
export function fits(node: Doc, p: Doc): boolean {
  return (
    p.kind === "automatic" ||
    (p.kind === "machine"
      ? node.Meta?.pc_machine_id === p.machine_id
      : node.Meta?.pc_location === p.kind)
  );
}
function base(
  job: string,
  type: string,
  group: Doc,
  constraints: Doc[],
  dc = "dc1",
): Doc {
  return {
    Job: {
      ID: job,
      Name: job,
      Type: type,
      Datacenters: [dc],
      Meta: { pc_managed: "true" },
      Constraints: constraints,
      TaskGroups: [group],
    },
  };
}
const logs = { MaxFiles: 2, MaxFileSizeMB: 5 };
const retry = {
  Attempts: 3,
  Interval: 60000000000,
  Delay: 5000000000,
  Mode: "delay",
};
export function applicationJob(d: Doc, s: Doc, env: Doc, registry: Doc): Doc {
  immutableImage(d.image_digest);
  const constraints = [
    constraint("${attr.cpu.arch}", d.architecture),
    constraint("${meta.pc_compute}", "true"),
  ];
  if (s.placement.kind === "machine")
    constraints.push(
      constraint("${meta.pc_machine_id}", s.placement.machine_id),
    );
  if (["home", "vps"].includes(s.placement.kind))
    constraints.push(constraint("${meta.pc_location}", s.placement.kind));
  const config: Doc = {
    image: d.image_digest,
    ports: ["http"],
    cap_drop: ["ALL"],
  };
  if (registry.registry_username && registry.registry_password) {
    let host: string | undefined;
    try {
      host = new URL(registry.registry_url).host;
    } catch {
      /* No valid credential origin: anonymous pull only. */
    }
    if (host && d.image_digest.startsWith(`${host}/`))
      config.auth = {
        username: registry.registry_username,
        password: registry.registry_password,
      };
  }
  return base(
    d.job_id,
    "service",
    {
      Name: "app",
      Count: 1,
      Networks: [
        {
          Mode: "host",
          DynamicPorts: [
            { Label: "http", To: s.port, HostNetwork: "pc_private" },
          ],
        },
      ],
      RestartPolicy: retry,
      ReschedulePolicy: {
        Unlimited: true,
        Delay: 5000000000,
        DelayFunction: "exponential",
        MaxDelay: 60000000000,
      },
      Update: {
        MaxParallel: 1,
        HealthCheck: "checks",
        MinHealthyTime: 10000000000,
        HealthyDeadline: 180000000000,
        AutoRevert: true,
      },
      Tasks: [
        {
          Name: "app",
          Driver: "docker",
          Config: config,
          Env: { ...env, PORT: String(s.port) },
          Resources: { CPU: s.cpu_mhz, MemoryMB: s.memory_mb },
          LogConfig: logs,
          Services: [
            {
              Name: `pc-${s.id}`,
              Provider: "nomad",
              PortLabel: "http",
              Checks: [
                {
                  Name: "ready",
                  Type: "http",
                  Header: { Connection: ["close"] },
                  Path: s.health_path,
                  Interval: 5000000000,
                  Timeout: 2000000000,
                },
              ],
            },
          ],
        },
      ],
    },
    constraints,
    d.datacenter,
  );
}
export function buildJob(
  d: Doc,
  s: Doc,
  p: Doc,
  cfg: Doc,
  source: string,
): Doc {
  const registry = new URL(cfg.registry_url),
    prefix = (cfg.repository_prefix ?? "personal-cloud").replace(
      /^\/+|\/+$/g,
      "",
    );
  const env: Doc = {
    PC_REPOSITORY: p.repository,
    PC_COMMIT: d.commit_sha,
    PC_IMAGE_TAG: `${registry.host}/${prefix}/${s.id}:${d.id}`,
    PC_REGISTRY_HOST: registry.host,
    PC_SERVICE_ID: s.id,
    PC_ROOT_DIRECTORY: s.root_directory,
    PC_PLATFORM: `linux/${d.architecture}`,
    PC_INSECURE_REGISTRY: String(cfg.allow_insecure_registry === true),
    BUILDKIT_HOST: cfg.buildkit_address ?? "tcp://127.0.0.1:1234",
  };
  if (source) env.PC_SOURCE_TOKEN = source;
  if (cfg.registry_username) env.PC_REGISTRY_USERNAME = cfg.registry_username;
  if (cfg.registry_password) env.PC_REGISTRY_PASSWORD = cfg.registry_password;
  return base(
    d.build_job_id,
    "batch",
    {
      Name: "build",
      Count: 1,
      RestartPolicy: { Attempts: 0, Mode: "fail" },
      ReschedulePolicy: { Attempts: 0, Unlimited: false },
      Tasks: [
        {
          Name: "build",
          Driver: "docker",
          Config: {
            image:
              cfg.builder_image ??
              "ghcr.io/nooesc/personal-cloud-builder:latest",
            network_mode: "host",
            force_pull: false,
          },
          Env: env,
          Resources: { CPU: 1000, MemoryMB: 1024 },
          LogConfig: logs,
        },
      ],
    },
    [
      constraint("${meta.pc_builder}", "true"),
      constraint("${attr.cpu.arch}", d.architecture),
      constraint("${node.unique.id}", d.builder_node_id),
    ],
    d.builder_datacenter,
  );
}
export function databaseJob(db: Doc, uri: string): Doc {
  const url = new URL(uri),
    network = db.port
      ? {
          Mode: "host",
          ReservedPorts: [
            {
              Label: "postgres",
              Value: db.port,
              To: 5432,
              HostNetwork: "pc_private",
            },
          ],
        }
      : {
          Mode: "host",
          DynamicPorts: [
            { Label: "postgres", To: 5432, HostNetwork: "pc_private" },
          ],
        };
  return base(
    db.job_id,
    "service",
    {
      Name: "postgres",
      Count: 1,
      Networks: [network],
      RestartPolicy: retry,
      ReschedulePolicy: { Attempts: 0, Unlimited: false },
      Disconnect: { Replace: false },
      Update: {
        MaxParallel: 1,
        Canary: 0,
        AutoRevert: false,
        HealthCheck: "checks",
        MinHealthyTime: 5000000000,
        HealthyDeadline: 180000000000,
        ProgressDeadline: 240000000000,
      },
      Tasks: [
        {
          Name: "postgres",
          Driver: "docker",
          Config: {
            image: "postgres:17-alpine",
            ports: ["postgres"],
            volume_driver: "local",
            volumes: [`${db.volume_name}:/var/lib/postgresql/data`],
            args: ["postgres", "-c", "password_encryption=scram-sha-256"],
          },
          Env: {
            POSTGRES_USER: decodeURIComponent(url.username),
            POSTGRES_PASSWORD: decodeURIComponent(url.password),
            POSTGRES_DB: url.pathname.slice(1),
            POSTGRES_INITDB_ARGS: "--auth-host=scram-sha-256",
          },
          Services: [
            {
              Name: db.job_id,
              Provider: "nomad",
              PortLabel: "postgres",
              Checks: [
                {
                  Name: "postgres-tcp",
                  Type: "tcp",
                  Interval: 5000000000,
                  Timeout: 2000000000,
                },
              ],
            },
          ],
          Resources: { CPU: 500, MemoryMB: 512 },
          LogConfig: logs,
          KillTimeout: 30000000000,
        },
      ],
    },
    [
      constraint("${node.unique.id}", db.nomad_node_id),
      constraint("${meta.pc_machine_id}", db.machine_id),
      constraint("${meta.pc_database}", "true"),
    ],
    db.datacenter,
  );
}
export function databaseProbe(db: Doc, uri: string): Doc {
  const url = new URL(uri);
  return base(
    db.probe_job_id,
    "batch",
    {
      Name: "probe",
      Count: 1,
      RestartPolicy: { Attempts: 0, Mode: "fail" },
      ReschedulePolicy: { Attempts: 0, Unlimited: false },
      Tasks: [
        {
          Name: "probe",
          Driver: "docker",
          Config: {
            image: "postgres:17-alpine",
            network_mode: "host",
            command: "psql",
            args: ["-w", "-v", "ON_ERROR_STOP=1", "-tAc", "SELECT 1"],
          },
          Env: {
            PGHOST: url.hostname,
            PGPORT: url.port || "5432",
            PGUSER: decodeURIComponent(url.username),
            PGPASSWORD: decodeURIComponent(url.password),
            PGDATABASE: url.pathname.slice(1),
            PGCONNECT_TIMEOUT: "5",
          },
          Resources: { CPU: 100, MemoryMB: 64 },
          LogConfig: { MaxFiles: 1, MaxFileSizeMB: 1 },
        },
      ],
    },
    [constraint("${node.unique.id}", db.nomad_node_id)],
    db.datacenter,
  );
}
export function privateAddress(address: string): boolean {
  if (/^(fc|fd)[a-f0-9:]+$/i.test(address) || address === "::1") return true;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) return false;
  const p = address.split(".").map(Number);
  if (p.length !== 4 || p.some((v) => !Number.isInteger(v) || v < 0 || v > 255))
    return false;
  return (
    p[0] === 10 ||
    p[0] === 127 ||
    (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) ||
    (p[0] === 192 && p[1] === 168)
  );
}
export function redact(message: string, values: unknown[]): string {
  let result = message;
  for (const value of values
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .sort((a, b) => b.length - a.length))
    result = result.split(value).join("[redacted]");
  return result;
}
