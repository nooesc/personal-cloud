import { createFileRoute } from "@tanstack/react-router";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Box,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Cloud,
  Code2,
  Copy,
  Cpu,
  Database,
  GitBranch,
  GitFork,
  Globe2,
  HardDrive,
  Layers3,
  LayoutDashboard,
  LoaderCircle,
  LockKeyhole,
  Menu,
  MemoryStick,
  Monitor,
  MoreHorizontal,
  Network,
  Plus,
  Search,
  Server,
  Settings2,
  Terminal,
  X,
} from "lucide-react";
import {
  api,
  demo,
  empty,
  size,
  type Snapshot,
  type Machine,
  type Project,
} from "../lib/data";
export const Route = createFileRoute("/")({ component: App });
type Page =
  | "Overview"
  | "Projects"
  | "Machines"
  | "Databases"
  | "Domains"
  | "Activity"
  | "Settings";
type Modal = "project" | "machine" | "login" | "service" | null;
const nav = [
  { label: "Overview", icon: LayoutDashboard },
  { label: "Projects", icon: Layers3 },
  { label: "Machines", icon: Server },
  { label: "Databases", icon: Database },
  { label: "Domains", icon: Globe2 },
] as const;
function App() {
  const [mode, setMode] = useState<"demo" | "live">("demo"),
    [page, setPage] = useState<Page>("Overview"),
    [data, setData] = useState<Snapshot>(demo),
    [modal, setModal] = useState<Modal>(null),
    [selected, setSelected] = useState<Project | null>(null),
    [machineDetail, setMachineDetail] = useState<Machine | null>(null),
    [search, setSearch] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [revealToken, setRevealToken] = useState(false),
    [busy, setBusy] = useState(false),
    [stream, setStream] = useState("Demo data"),
    [menu, setMenu] = useState(false),
    [enrollment, setEnrollment] = useState<{
      token: string;
      expires_at: string;
    } | null>(null);
  useEffect(() => {
    if (localStorage.getItem("pc-mode") === "live") {
      setData(empty);
      setMode("live");
    }
  }, []);
  useEffect(() => {
    if (machineDetail) {
      const current = data.machines.find((m) => m.id === machineDetail.id);
      if (current && current !== machineDetail) setMachineDetail(current);
    }
  }, [data, machineDetail]);
  async function refresh() {
    const next = await api<Snapshot>("/snapshot");
    setData(next);
    return next;
  }
  useEffect(() => {
    if (mode === "demo") {
      setStream("Demo data");
      return;
    }
    let cancelled = false,
      ws: WebSocket | undefined,
      retry: ReturnType<typeof setTimeout>;
    const connect = async () => {
      try {
        const next = await api<Snapshot>("/snapshot");
        if (cancelled) return;
        setData(next);
        setError("");
        setStream("Connecting");
        ws = new WebSocket(
          `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/events`,
        );
        ws.onopen = () => {
          if (!cancelled) setStream("Live updates");
        };
        ws.onmessage = (e) => {
          if (cancelled) return;
          try {
            setData(JSON.parse(e.data));
            setStream("Live updates");
          } catch {
            setStream("Update unavailable");
          }
        };
        ws.onerror = () => {
          if (!cancelled) setStream("Reconnecting");
        };
        ws.onclose = () => {
          if (!cancelled) {
            setStream("Reconnecting");
            retry = setTimeout(connect, 3000);
          }
        };
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message);
        setStream("Disconnected");
        retry = setTimeout(connect, 5000);
      }
    };
    void connect();
    return () => {
      cancelled = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, [mode]);
  useEffect(() => {
    if (!notice) return;
    const timeout = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(timeout);
  }, [notice]);
  function open(value: Modal) {
    setError("");
    setEnrollment(null);
    setRevealToken(false);
    setModal(value);
  }
  function switchMode() {
    if (mode === "demo") {
      open("login");
    } else {
      localStorage.setItem("pc-mode", "demo");
      setMode("demo");
      setData(structuredClone(demo));
      setSelected(null);
      setMachineDetail(null);
      setError("");
    }
  }
  const machines = data.machines.filter((m) =>
    `${m.report.hostname} ${m.location} ${m.roles.join(" ")} ${m.tags.join(" ")}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const projects = data.projects.filter((p) =>
    `${p.name} ${p.repository}`.toLowerCase().includes(search.toLowerCase()),
  );
  const online = data.machines.filter((m) => m.status === "online").length;
  const totals = data.machines.reduce(
    (a, m) => ({
      cpu: a.cpu + m.report.cpu_cores,
      ram: a.ram + m.report.memory_total,
      disk: a.disk + m.report.disk_total,
    }),
    { cpu: 0, ram: 0, disk: 0 },
  );
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      if (modal === "login") {
        await api("/session", { token: form.get("token") });
        setData(empty);
        setMode("live");
        await refresh();
        localStorage.setItem("pc-mode", "live");
        setModal(null);
      }
      if (modal === "project") {
        const body = {
          name: String(form.get("name")),
          repository: String(form.get("repository")),
          branch: String(form.get("branch") || "main"),
        };
        if (mode === "live") {
          await api("/projects", body);
          await refresh();
        } else {
          const p = {
            ...body,
            id: crypto.randomUUID(),
            created_at: new Date().toISOString(),
          };
          setData((d) => ({ ...d, projects: [p, ...d.projects] }));
        }
        setModal(null);
        setNotice(
          mode === "demo"
            ? "Project added to this demo session"
            : "Project created",
        );
        setPage("Projects");
      }
      if (modal === "machine") {
        const result = await api<{ token: string; expires_at: string }>(
          "/enrollment-tokens",
          {
            location: form.get("location"),
            roles: form.getAll("roles"),
            tags: String(form.get("tags") || "")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          },
        );
        setEnrollment(result);
      }
      if (modal === "service" && selected) {
        const kind = String(form.get("placement"));
        const body = {
          name: String(form.get("name")),
          port: Number(form.get("port")),
          placement: kind.startsWith("machine:")
            ? { kind: "machine", machine_id: kind.slice(8) }
            : { kind },
        };
        if (mode === "live") {
          await api(`/projects/${selected.id}/services`, body);
          await refresh();
        } else {
          setData((d) => ({
            ...d,
            services: [
              ...d.services,
              { ...body, id: crypto.randomUUID(), project_id: selected.id },
            ],
          }));
        }
        setModal(null);
        setNotice("Service configured");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice("Copied to clipboard");
    } catch {
      setError("Clipboard unavailable. Select and copy the text.");
    }
  }
  const headline =
    page === "Overview"
      ? "Your cloud, together."
      : page === "Settings"
        ? "Make yourself at home."
        : page;
  return (
    <div className="app-shell">
      <aside
        id="workspace-navigation"
        className={`sidebar ${menu ? "is-open" : ""}`}
      >
        <a className="brand" href="/" aria-label="Personal Cloud home">
          <span className="brand-mark">
            <Cloud size={23} />
          </span>
          <span>
            personal<span className="brand-light">cloud</span>
            <span className="brand-alpha">ALPHA</span>
          </span>
        </a>
        <button className="workspace" onClick={switchMode}>
          <span className="workspace-avatar">P</span>
          <span>
            Personal workspace
            <small>
              {mode === "demo" ? "Explore the demo" : "Local control plane"}
            </small>
          </span>
          <ChevronDown size={14} />
        </button>
        <div className="nav-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          {nav.map(({ label, icon: Icon }) => (
            <button
              key={label}
              className={`nav-item ${page === label ? "active" : ""}`}
              onClick={() => {
                setPage(label);
                setSelected(null);
                setMachineDetail(null);
                setMenu(false);
              }}
            >
              <Icon size={17} />
              {label}
              {label === "Machines" && (
                <span className="nav-count">{data.machines.length}</span>
              )}
              {label === "Projects" && (
                <span className="nav-count">{data.projects.length}</span>
              )}
            </button>
          ))}
          <div className="nav-divider" />
          <button
            className={`nav-item ${page === "Activity" ? "active" : ""}`}
            onClick={() => {
              setPage("Activity");
              setMenu(false);
            }}
          >
            <Activity size={17} />
            Activity
          </button>
          <button
            className={`nav-item ${page === "Settings" ? "active" : ""}`}
            onClick={() => {
              setPage("Settings");
              setMenu(false);
            }}
          >
            <Settings2 size={17} />
            Settings
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="owned-note">
            <Network size={19} />
            <strong>
              Your hardware.
              <br />
              Your little corner of the cloud.
            </strong>
            <p>Open source. Yours to run.</p>
            <a
              href="https://github.com/nooesc/personal-cloud"
              target="_blank"
              rel="noreferrer"
            >
              View on GitHub <ArrowUpRight size={13} />
            </a>
          </div>
          <button className="profile" onClick={switchMode}>
            <span className="profile-avatar">P</span>
            <span>
              Personal cloud
              <small>
                {mode === "demo" ? "Demo workspace" : "Owner workspace"}
              </small>
            </span>
            <MoreHorizontal size={18} />
          </button>
        </div>
      </aside>
      <div className="main-wrap">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            aria-label="Toggle navigation"
            aria-controls="workspace-navigation"
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
          >
            <Menu size={19} />
          </button>
          <div className="breadcrumbs">
            <Cloud size={15} />
            <span>My cloud</span>
            <ChevronRight size={12} />
            <strong>{page}</strong>
          </div>
          <div className="top-actions">
            <label className="search">
              <Search size={15} />
              <input
                aria-label="Search machines and projects"
                placeholder="Find a project or machine…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <button className={`mode-badge ${mode}`} onClick={switchMode}>
              <span className="dot" />
              {mode === "demo" ? "Demo workspace" : "Live workspace"}
              <ChevronDown size={12} />
            </button>
            <button
              className="icon-button"
              aria-label="Open setup information"
              onClick={() => setPage("Settings")}
            >
              <CircleHelp size={18} />
            </button>
          </div>
        </header>
        <main>
          {mode === "demo" && (
            <div className="demo-banner">
              <span>
                <Box size={14} /> A little cloud to explore. Everything here is
                sample data.
              </span>
              <button onClick={() => open("login")}>
                Connect your cloud <ArrowRight size={14} />
              </button>
            </div>
          )}
          <section className="page-heading">
            <div>
              <div className="eyebrow">
                {page === "Overview"
                  ? "A PLACE FOR EVERYTHING YOU BUILD"
                  : "PERSONAL CLOUD"}
              </div>
              <h1>{headline}</h1>
              <p>
                {page === "Overview"
                  ? "Home hardware and cloud machines. One place to make things run."
                  : page === "Projects"
                    ? "Your applications, and the services that bring them to life."
                    : page === "Machines"
                      ? "Every machine has a place in your cloud."
                      : page === "Settings"
                        ? "The connections and tools behind your workspace."
                        : page === "Activity"
                          ? "A record of what is happening across your cloud."
                          : "Simple, dependable building blocks for your projects."}
              </p>
            </div>
            <div className="heading-actions">
              {(page === "Overview" || page === "Machines") && (
                <button
                  className="button secondary"
                  onClick={() => open("machine")}
                >
                  <Plus size={16} />
                  Add machine
                </button>
              )}
              {(page === "Overview" || page === "Projects") && (
                <button
                  className="button primary"
                  onClick={() => open("project")}
                >
                  <Plus size={16} />
                  New project
                </button>
              )}
            </div>
          </section>
          {mode === "live" &&
            ["Reconnecting", "Disconnected", "Update unavailable"].includes(
              stream,
            ) &&
            data.generated_at && (
              <div className="alert" role="status">
                Live updates interrupted. Showing the last snapshot from{" "}
                {new Date(data.generated_at).toLocaleTimeString()}.
              </div>
            )}
          {error && !modal && (
            <div className="alert" role="alert">
              {error}
              <button onClick={() => open("login")}>Sign in</button>
            </div>
          )}
          {page === "Overview" && (
            <>
              <div className="stats">
                <Stat
                  label="Machines"
                  value={String(data.machines.length)}
                  detail={`${online} online${data.machines.length - online ? ` · ${data.machines.length - online} need attention` : ""}`}
                  icon={<Server size={17} />}
                />
                <Stat
                  label="Compute"
                  value={String(totals.cpu)}
                  unit="cores"
                  detail="Across your whole fleet"
                  icon={<Cpu size={17} />}
                />
                <Stat
                  label="Memory"
                  value={size(totals.ram).split(" ")[0]}
                  unit={size(totals.ram).split(" ")[1]}
                  detail="Room for your next idea"
                  icon={<MemoryStick size={17} />}
                />
                <Stat
                  label="Storage"
                  value={size(totals.disk).split(" ")[0]}
                  unit={size(totals.disk).split(" ")[1]}
                  detail="Capacity on connected machines"
                  icon={<HardDrive size={17} />}
                />
              </div>
              <section className="panel fleet-panel">
                <div className="section-heading">
                  <div>
                    <h2>
                      Your fleet{" "}
                      <span className="count">{data.machines.length}</span>
                    </h2>
                    <p>A bird’s-eye view of where it all runs.</p>
                  </div>
                  <span className="subtle-status">
                    <span
                      className={`dot ${stream === "Live updates" ? "green" : ""}`}
                    />
                    {stream}
                  </span>
                </div>
                {machines.length ? (
                  <>
                    <div className="fleet-topology">
                      <div className="cloud-node">
                        <Cloud size={22} />
                        <div>
                          Your cloud
                          <small>
                            {mode === "demo"
                              ? "Sample fleet topology"
                              : "Fleet inventory"}
                          </small>
                        </div>
                        <span className="node-orbit" />
                      </div>
                      <div className="topology-line" />
                      <span className="network-caption">
                        <LockKeyhole size={10} />
                        {mode === "demo"
                          ? "PRIVATE NETWORK · PREVIEW"
                          : "PRIVATE NETWORK · NOT CONFIGURED"}
                      </span>
                    </div>
                    <div className="machine-grid">
                      {machines.map((m) => (
                        <MachineCard
                          key={m.id}
                          machine={m}
                          count={
                            data.services.filter((s) => s.demo_machine === m.id)
                              .length
                          }
                          onClick={() => setMachineDetail(m)}
                        />
                      ))}
                    </div>
                  </>
                ) : (
                  <Empty
                    icon={<Server />}
                    title={
                      search
                        ? "No matching machines"
                        : "Your cloud starts with a machine"
                    }
                    description={
                      search
                        ? "Try a different hostname or tag."
                        : "Bring a home computer, a VPS, or both. Add your first machine to see its resources here."
                    }
                    action={
                      !search && (
                        <button
                          className="button secondary"
                          onClick={() => open("machine")}
                        >
                          <Plus size={15} />
                          Add your first machine
                        </button>
                      )
                    }
                  />
                )}
                <div className="panel-footer">
                  <span>
                    <span className="dot green" />
                    {mode === "demo"
                      ? "Sample fleet · no infrastructure connected"
                      : `${data.machines.length} enrolled machines · updated every 10 seconds`}
                  </span>
                  <button onClick={() => setPage("Machines")}>
                    Manage machines <ArrowRight size={14} />
                  </button>
                </div>
              </section>
              <div className="lower-grid">
                <section className="panel">
                  <div className="section-heading">
                    <h2>
                      Projects{" "}
                      <span className="count">{data.projects.length}</span>
                    </h2>
                    <button
                      className="text-button"
                      onClick={() => setPage("Projects")}
                    >
                      View all <ArrowRight size={13} />
                    </button>
                  </div>
                  <ProjectList
                    projects={projects}
                    data={data}
                    onSelect={setSelected}
                  />
                  {!projects.length && (
                    <Empty
                      icon={<Layers3 />}
                      title={
                        search
                          ? "No matching projects"
                          : "Something great starts here"
                      }
                      description="Add a GitHub repository to organize your first application."
                      action={
                        <button
                          className="button secondary"
                          onClick={() => open("project")}
                        >
                          Create project
                        </button>
                      }
                    />
                  )}
                </section>
                <section className="panel">
                  <div className="section-heading">
                    <h2>Recent activity</h2>
                    <Activity size={16} className="muted" />
                  </div>
                  <ActivityList data={data} demoMode={mode === "demo"} />
                  <div className="panel-footer">
                    <button onClick={() => setPage("Activity")}>
                      All activity <ArrowRight size={13} />
                    </button>
                  </div>
                </section>
              </div>
            </>
          )}
          {page === "Projects" && (
            <section className="panel">
              <div className="section-heading">
                <h2>
                  All projects <span className="count">{projects.length}</span>
                </h2>
                <span className="muted">GitHub repositories</span>
              </div>
              <ProjectList
                projects={projects}
                data={data}
                onSelect={setSelected}
              />
              {!projects.length && (
                <Empty
                  icon={<Layers3 />}
                  title="A home for your next project"
                  description="Start with a repository. Add its services and choose where they should run."
                  action={
                    <button
                      className="button primary"
                      onClick={() => open("project")}
                    >
                      New project
                    </button>
                  }
                />
              )}
            </section>
          )}
          {page === "Machines" && (
            <section className="panel">
              <div className="section-heading">
                <h2>Connected machines</h2>
                <span className="subtle-status">{stream}</span>
              </div>
              <div className="machine-grid machines-page">
                {machines.map((m) => (
                  <MachineCard
                    key={m.id}
                    machine={m}
                    count={
                      data.services.filter((s) => s.demo_machine === m.id)
                        .length
                    }
                    onClick={() => setMachineDetail(m)}
                  />
                ))}
              </div>
              {!machines.length && (
                <Empty
                  icon={<Server />}
                  title="Bring your own compute"
                  description="Enroll a machine and watch its inventory and health arrive in real time."
                  action={
                    <button
                      className="button primary"
                      onClick={() => open("machine")}
                    >
                      Add machine
                    </button>
                  }
                />
              )}
            </section>
          )}
          {(page === "Databases" || page === "Domains") && (
            <section className="panel future-panel">
              <Empty
                icon={page === "Databases" ? <Database /> : <Globe2 />}
                title={
                  page === "Databases"
                    ? "A steady home for your data."
                    : "Give your service an address."
                }
                description={
                  page === "Databases"
                    ? "Managed PostgreSQL is coming in the provisioning milestone. Databases will stay pinned to their machine, with explicit moves for persistent data."
                    : "Domain routing is coming with the Cloudflare controller. Connect a service to a domain, with Tunnel, DNS, and TLS managed for you."
                }
                action={
                  <span className="planned-pill">
                    Planned for V1 · not available yet
                  </span>
                }
              />
            </section>
          )}
          {page === "Activity" && (
            <section className="panel">
              <div className="section-heading">
                <h2>Workspace activity</h2>
                <span className="muted">Latest 30 events</span>
              </div>
              <ActivityList data={data} demoMode={mode === "demo"} />
            </section>
          )}
          {page === "Settings" && (
            <div className="settings-grid">
              <Integration
                icon={<GitFork size={25} />}
                title="GitHub"
                description="Repositories, pushes, and the start of every deployment."
              />
              <Integration
                icon={<Cloud size={27} />}
                title="Cloudflare"
                description="A private network, a public address, and a home for your images."
              />
              <section className="panel setup-panel">
                <Terminal size={24} />
                <h2>Local control plane</h2>
                <p>
                  This first milestone includes projects, service configuration,
                  machine enrollment, and live health reporting.
                </p>
                <p>Start the API and dashboard from your checkout:</p>
                <code>pnpm dev</code>
                <p>
                  The owner token is generated in your local <code>.env</code>.
                  Use it to connect this workspace.
                </p>
                <button
                  className="button secondary"
                  onClick={() => open("login")}
                >
                  <LockKeyhole size={15} />
                  Connect workspace
                </button>
                {mode === "live" && (
                  <button
                    className="button secondary"
                    onClick={async () => {
                      try {
                        await api("/session", undefined, "DELETE");
                        localStorage.setItem("pc-mode", "demo");
                        setMode("demo");
                        setData(structuredClone(demo));
                        setNotice("Signed out");
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    Sign out
                  </button>
                )}
              </section>
              <section className="panel setup-panel">
                <Network size={24} />
                <h2>The path to your first deploy</h2>
                <ol className="roadmap">
                  <li className="done">
                    <CheckCheck size={16} />
                    Fleet inventory & project foundation
                  </li>
                  <li>
                    <span>02</span>Machine setup & private networking
                  </li>
                  <li>
                    <span>03</span>GitHub builds & healthy deployments
                  </li>
                  <li>
                    <span>04</span>Public domains & managed Postgres
                  </li>
                </ol>
                <p>
                  Runtime provisioning, GitHub authorization, and Cloudflare
                  connections are not yet enabled.
                </p>
              </section>
            </div>
          )}
          <footer className="page-footer">
            <span>
              <Cloud size={13} /> A cloud of your own.
            </span>
            <span>
              Personal Cloud <span className="muted">/</span> v0.1.0-alpha
            </span>
          </footer>
        </main>
      </div>
      {notice && (
        <div className="toast" role="status">
          <Check size={17} />
          {notice}
        </div>
      )}
      {selected && !modal && (
        <Dialog title={selected.name} onClose={() => setSelected(null)}>
          <div className="project-detail-meta">
            <GitFork size={16} />
            {selected.repository}
            <span>
              <GitBranch size={13} />
              {selected.branch}
            </span>
          </div>
          <div className="detail-heading">
            <h3>Services</h3>
            <button
              className="button secondary small"
              onClick={() => open("service")}
            >
              <Plus size={14} />
              Add service
            </button>
          </div>
          {data.services
            .filter((s) => s.project_id === selected.id)
            .map((s) => (
              <div className="service-row" key={s.id}>
                <Box size={18} />
                <div>
                  <strong>{s.name}</strong>
                  <small>
                    Port {s.port} ·{" "}
                    {s.placement.kind === "machine"
                      ? (data.machines.find(
                          (m) => m.id === s.placement.machine_id,
                        )?.report.hostname ?? "Specific machine")
                      : s.placement.kind}{" "}
                    placement
                  </small>
                </div>
                <span className={s.demo_status ? "health-label" : "muted"}>
                  {s.demo_status ? "Sample · healthy" : "Not deployed"}
                </span>
              </div>
            ))}
          {!data.services.some((s) => s.project_id === selected.id) && (
            <p className="empty-copy">
              No services yet. Add a web application, API, or worker.
            </p>
          )}
          <div className="info-callout">
            <Code2 size={18} />
            <span>
              Automatic builds and deployment arrive in the next milestones.
              Your project and service configuration{" "}
              {mode === "live"
                ? "is saved in the control plane"
                : "stays in this demo session"}
              .
            </span>
          </div>
        </Dialog>
      )}
      {machineDetail && (
        <Dialog
          title={machineDetail.report.hostname}
          onClose={() => setMachineDetail(null)}
        >
          <div className="machine-detail-status">
            <span
              className={`dot ${machineDetail.status === "online" ? "green" : "amber"}`}
            />
            {machineDetail.status}
            <span className="tag">{machineDetail.location}</span>
          </div>
          <dl className="detail-grid">
            <dt>Operating system</dt>
            <dd>{machineDetail.report.os}</dd>
            <dt>Architecture</dt>
            <dd>{machineDetail.report.architecture}</dd>
            <dt>CPU</dt>
            <dd>
              {machineDetail.report.cpu_cores} cores ·{" "}
              {machineDetail.report.cpu_percent.toFixed(0)}% in use
            </dd>
            <dt>Memory</dt>
            <dd>
              {size(machineDetail.report.memory_used)} /{" "}
              {size(machineDetail.report.memory_total)}
            </dd>
            <dt>Storage</dt>
            <dd>
              {size(machineDetail.report.disk_used)} /{" "}
              {size(machineDetail.report.disk_total)}
            </dd>
            <dt>Roles</dt>
            <dd>{machineDetail.roles.join(", ")}</dd>
            <dt>Tags</dt>
            <dd>{machineDetail.tags.join(", ") || "None"}</dd>
            <dt>Docker</dt>
            <dd>
              {machineDetail.report.docker ? "Responding" : "Unavailable"}
            </dd>
            <dt>Nomad</dt>
            <dd>{machineDetail.report.nomad ? "Responding" : "Unavailable"}</dd>
            <dt>Last heartbeat</dt>
            <dd>
              {mode === "demo"
                ? "Sample data"
                : new Date(machineDetail.last_seen).toLocaleString()}
            </dd>
          </dl>
          {mode === "live" && (
            <div className="info-callout">
              <Network size={17} />
              <span>
                Enrollment reports machine inventory. Runtime installation and
                private networking are part of the next milestone.
              </span>
            </div>
          )}
        </Dialog>
      )}
      {modal && (
        <Dialog
          title={
            modal === "project"
              ? "Create a project"
              : modal === "machine"
                ? "Add a machine"
                : modal === "service"
                  ? "Add a service"
                  : "Connect your cloud"
          }
          onClose={() => {
            setModal(null);
            setError("");
          }}
        >
          {modal === "machine" && mode === "demo" ? (
            <>
              <p className="dialog-intro">
                Machines report to your own control plane. Connect your live
                workspace to create a secure enrollment token.
              </p>
              <div className="info-callout">
                <Server size={20} />
                <span>
                  This is a sample fleet. Connecting your workspace opens your
                  real machine inventory.
                </span>
              </div>
              <button
                className="button primary full"
                onClick={() => open("login")}
              >
                Connect workspace <ArrowRight size={16} />
              </button>
            </>
          ) : enrollment ? (
            <>
              <div className="success-heading">
                <CheckCheck size={22} />
                <div>
                  <strong>Your enrollment token is ready</strong>
                  <small>
                    One use · expires{" "}
                    {new Date(enrollment.expires_at).toLocaleTimeString()}
                  </small>
                </div>
              </div>
              <p className="dialog-intro">
                From a checkout on the machine you want to add, set{" "}
                <code>PC_ENROLL_TOKEN</code> to this token, then run the agent.
                The identity is saved locally with restricted permissions.
              </p>
              <label className="field">
                Enrollment token
                <div className="copy-field">
                  <input
                    readOnly
                    type={revealToken ? "text" : "password"}
                    value={enrollment.token}
                  />
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Copy enrollment token"
                    onClick={() => copy(enrollment.token)}
                  >
                    <Copy size={17} />
                  </button>
                </div>
              </label>
              <button
                className="text-button"
                type="button"
                onClick={() => setRevealToken(!revealToken)}
              >
                {revealToken ? "Hide token" : "Show token for manual copy"}
              </button>
              {error && (
                <div className="form-error" role="alert">
                  {error}
                </div>
              )}
              <pre className="command">
                {
                  "cargo run -p personal-cloud-agent -- --api http://127.0.0.1:4311"
                }
              </pre>
              <div className="info-callout">
                <LockKeyhole size={18} />
                <span>
                  Loopback works on this computer. A remote machine needs an
                  HTTPS control-plane URL. The agent currently reports
                  inventory; automated installation is coming next.
                </span>
              </div>
              <button
                className="button primary full"
                onClick={() => {
                  setModal(null);
                  setPage("Machines");
                }}
              >
                View machines <ArrowRight size={16} />
              </button>
            </>
          ) : (
            <form onSubmit={submit}>
              {modal === "login" && (
                <>
                  <p className="dialog-intro">
                    Connect to the local Rust control plane. Enter the owner
                    token from your checkout’s <code>.env</code> file.
                  </p>
                  <label className="field">
                    Owner token
                    <input
                      autoFocus
                      name="token"
                      type="password"
                      autoComplete="off"
                      required
                      minLength={32}
                      placeholder="PC_ADMIN_TOKEN"
                    />
                  </label>
                  <div className="info-callout">
                    <LockKeyhole size={17} />
                    <span>
                      Your token is sent to your local API. The session uses a
                      protected cookie.
                    </span>
                  </div>
                </>
              )}
              {modal === "project" && (
                <>
                  <p className="dialog-intro">
                    Give your application a home. Start with a GitHub
                    repository, then add its services.
                  </p>
                  <label className="field">
                    Project name
                    <input
                      autoFocus
                      name="name"
                      required
                      maxLength={80}
                      placeholder="My next big thing"
                    />
                  </label>
                  <label className="field">
                    GitHub repository
                    <div className="input-icon">
                      <GitFork size={17} />
                      <input
                        name="repository"
                        required
                        pattern="[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+"
                        placeholder="owner/repository"
                      />
                    </div>
                    <small>
                      Repository reference only. GitHub authorization comes in a
                      later milestone.
                    </small>
                  </label>
                  <label className="field">
                    Production branch
                    <input
                      name="branch"
                      required
                      defaultValue="main"
                      maxLength={200}
                    />
                  </label>
                  {mode === "demo" && (
                    <p className="form-note">
                      This project stays in your demo session.
                    </p>
                  )}
                </>
              )}
              {modal === "machine" && (
                <>
                  <p className="dialog-intro">
                    Choose where this machine lives and what it can do. We’ll
                    create a single-use token for the agent.
                  </p>
                  <label className="field">
                    Location
                    <select name="location">
                      <option value="home">Home fleet</option>
                      <option value="vps">Cloud VPS</option>
                      <option value="dedicated">Dedicated server</option>
                    </select>
                  </label>
                  <fieldset>
                    <legend>Machine roles</legend>
                    {["compute", "builder", "database"].map((role) => (
                      <label className="check-option" key={role}>
                        <input
                          type="checkbox"
                          name="roles"
                          value={role}
                          defaultChecked={role === "compute"}
                        />
                        <span>
                          {role.charAt(0).toUpperCase() + role.slice(1)}
                        </span>
                      </label>
                    ))}
                  </fieldset>
                  <label className="field">
                    Tags <span className="muted">optional</span>
                    <input name="tags" placeholder="home, high-memory" />
                    <small>Comma-separated labels for your machine.</small>
                  </label>
                </>
              )}
              {modal === "service" && (
                <>
                  <p className="dialog-intro">
                    Configure a component of {selected?.name}.
                  </p>
                  <label className="field">
                    Service name
                    <input
                      autoFocus
                      name="name"
                      required
                      maxLength={80}
                      placeholder="web"
                    />
                  </label>
                  <label className="field">
                    Listening port
                    <input
                      name="port"
                      type="number"
                      min={1}
                      max={65535}
                      required
                      defaultValue={3000}
                    />
                  </label>
                  <label className="field">
                    Placement
                    <select name="placement">
                      <option value="automatic">Automatic</option>
                      <option value="home">Home fleet</option>
                      <option value="vps">Cloud VPS</option>
                      {data.machines.map((m) => (
                        <option key={m.id} value={`machine:${m.id}`}>
                          {m.report.hostname}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="form-note">
                    Placement is saved as desired configuration. No workload is
                    scheduled yet.
                  </p>
                </>
              )}
              {error && (
                <div className="form-error" role="alert">
                  {error}
                </div>
              )}
              <div className="dialog-actions">
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setModal(null)}
                >
                  Cancel
                </button>
                <button className="button primary" disabled={busy}>
                  {busy ? (
                    <LoaderCircle size={15} className="spin" />
                  ) : (
                    <>
                      {modal === "login" ? (
                        <LockKeyhole size={15} />
                      ) : (
                        <Plus size={15} />
                      )}
                    </>
                  )}
                  {busy
                    ? "Working…"
                    : modal === "project"
                      ? "Create project"
                      : modal === "machine"
                        ? "Create enrollment token"
                        : modal === "service"
                          ? "Add service"
                          : "Connect workspace"}
                </button>
              </div>
            </form>
          )}
        </Dialog>
      )}
    </div>
  );
}
function Stat({
  label,
  value,
  unit,
  detail,
  icon,
}: {
  label: string;
  value: string;
  unit?: string;
  detail: string;
  icon: ReactNode;
}) {
  return (
    <div className="stat">
      <div className="stat-label">
        {label}
        {icon}
      </div>
      <div className="stat-value">
        {value}
        <span>{unit}</span>
      </div>
      <div className="stat-detail">{detail}</div>
    </div>
  );
}
function MachineCard({
  machine: m,
  count,
  onClick,
}: {
  machine: Machine;
  count: number;
  onClick: () => void;
}) {
  return (
    <button className={`machine-card ${m.status}`} onClick={onClick}>
      <div className="machine-card-top">
        <span className={`machine-icon ${m.location}`}>
          {m.location === "home" ? <Monitor size={20} /> : <Server size={20} />}
        </span>
        <span className={`location-label ${m.location}`}>
          {m.location === "vps" ? "CLOUD VPS" : m.location.toUpperCase()}
        </span>
        <span
          className={`dot ${m.status === "online" ? "green" : m.status === "offline" ? "gray" : "amber"}`}
          aria-label={m.status}
        />
      </div>
      <div className="machine-name">
        <span>{m.report.hostname}</span>
        <ChevronRight size={14} />
      </div>
      <div className="machine-spec">
        {m.report.cpu_cores} cores <span>·</span> {size(m.report.memory_total)}{" "}
        <span>·</span> {m.report.architecture}
      </div>
      <div className="usage-label">
        <span>CPU</span>
        <span>
          {m.report.cpu_percent.toFixed(0)}
          <small>%</small>
        </span>
      </div>
      <div className="meter">
        <span style={{ width: `${m.report.cpu_percent}%` }} />
      </div>
      <div className="usage-label memory-label">
        <span>Memory</span>
        <span>
          {size(m.report.memory_used)}{" "}
          <small>/ {size(m.report.memory_total)}</small>
        </span>
      </div>
      <div className="meter memory">
        <span
          style={{
            width: `${m.report.memory_total ? (m.report.memory_used / m.report.memory_total) * 100 : 0}%`,
          }}
        />
      </div>
      <div className="machine-card-footer">
        <span>
          {m.roles.map((r) => (
            <span className="role" key={r}>
              {r}
            </span>
          ))}
        </span>
        {count > 0 && (
          <span className="workload-count">
            <Box size={11} />
            {count}
          </span>
        )}
      </div>
    </button>
  );
}
function ProjectList({
  projects,
  data,
  onSelect,
}: {
  projects: Project[];
  data: Snapshot;
  onSelect: (p: Project) => void;
}) {
  return (
    <div className="project-list">
      {projects.map((p, i) => {
        const services = data.services.filter((s) => s.project_id === p.id);
        return (
          <button
            className="project-row"
            key={p.id}
            onClick={() => onSelect(p)}
          >
            <span className={`project-icon color-${i % 3}`}>
              {i % 3 === 0 ? (
                <Layers3 size={20} />
              ) : i % 3 === 1 ? (
                <Terminal size={20} />
              ) : (
                <Globe2 size={20} />
              )}
            </span>
            <span className="project-identity">
              <strong>{p.name}</strong>
              <small>
                <GitFork size={11} />
                {p.repository}
              </small>
            </span>
            <span className="project-services">
              {services.length} {services.length === 1 ? "service" : "services"}
              <small>
                {[
                  ...new Set(
                    services
                      .map(
                        (s) =>
                          data.machines.find((m) => m.id === s.demo_machine)
                            ?.report.hostname,
                      )
                      .filter(Boolean),
                  ),
                ].join(", ") || "Ready to configure"}
              </small>
            </span>
            <span
              className={`project-status ${services.some((s) => s.demo_status) ? "healthy" : ""}`}
            >
              <span className="dot" />
              {services.some((s) => s.demo_status) ? "Healthy" : "Not deployed"}
            </span>
            <ChevronRight size={15} />
          </button>
        );
      })}
    </div>
  );
}
function ActivityList({
  data,
  demoMode,
}: {
  data: Snapshot;
  demoMode: boolean;
}) {
  return (
    <div className="activity-list">
      {data.activity.map((e, i) => (
        <div className="activity-item" key={e.id}>
          <span
            className={`activity-icon ${e.kind.includes("healthy") ? "success" : ""}`}
          >
            {e.kind.startsWith("machine") ? (
              <Server size={14} />
            ) : e.kind.startsWith("deployment") ? (
              <Check size={14} />
            ) : (
              <Plus size={14} />
            )}
          </span>
          <div>
            <p>{e.message}</p>
            <small>
              {demoMode
                ? [
                    "2 minutes ago · sample",
                    "1 hour ago · sample",
                    "2 hours ago · sample",
                  ][i % 3]
                : new Date(e.created_at).toLocaleString()}
            </small>
          </div>
        </div>
      ))}
      {!data.activity.length && (
        <div className="quiet-state">
          <Activity size={23} />
          <p>Quiet for now.</p>
          <small>Your cloud’s story will appear here.</small>
        </div>
      )}
    </div>
  );
}
function Empty({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">{icon}</span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
function Integration({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <section className="panel integration-panel">
      <div className="integration-icon">{icon}</div>
      <h2>
        {title}
        <span className="tag">Not connected</span>
      </h2>
      <p>{description}</p>
      <span className="planned-pill">Connection setup coming next</span>
    </section>
  );
}
function Dialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    const previous = document.activeElement as HTMLElement;
    d?.showModal();
    d?.querySelector<HTMLInputElement>(
      'input:not([type="checkbox"]), select',
    )?.focus();
    return () => {
      d?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog-header">
        <h2 id={titleId}>{title}</h2>
        <button
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}
