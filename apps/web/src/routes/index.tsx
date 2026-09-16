import { hosted, type HostedSession } from "../lib/hosted";
import { WorkspacePicker } from "../components/workspaces";
import { GitHubSignIn, githubMessages } from "../components/github";
import { createFileRoute } from "@tanstack/react-router";
import {
  useEffect,
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
  ChevronRight,
  ChevronsUpDown,
  CircleHelp,
  Cloud,
  Copy,
  Cpu,
  Database,
  GitFork,
  Globe2,
  HardDrive,
  Layers3,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  Menu,
  MemoryStick,
  Plus,
  Search,
  Server,
  Settings2,
  X,
} from "lucide-react";
import {
  api,
  ApiError,
  demo,
  empty,
  size,
  type Snapshot,
  type Machine,
  type Project,
} from "../lib/data";
import { cn } from "../lib/utils";
import {
  Setup,
  RepositoryField,
  ServiceFields,
  serviceFields,
  MachineSettings,
} from "../components/live";
import { ProjectDetail } from "../components/project";
import { Databases, Domains } from "../components/resources";
import {
  FleetPanel,
  MachineDetailBody,
  useFleetHistory,
} from "../components/fleet";
import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import {
  Checkbox,
  Input,
  Label,
  Select,
  Textarea,
  fieldClasses,
} from "../components/ui/input";
import { Dialog, DialogFooter } from "../components/ui/dialog";
import {
  Alert,
  EmptyState,
  Eyebrow,
  Meta,
  StatusDot,
  statusDot,
} from "../components/ui/misc";
import { DitherAvatar, DitherGradient } from "../components/dither-kit";
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
const system = [
  { label: "Activity", icon: Activity },
  { label: "Settings", icon: Settings2 },
] as const;
const descriptions: Record<Page, string> = {
  Overview: "Home hardware and cloud machines, one place to make things run.",
  Projects: "Your applications and the services that bring them to life.",
  Machines: "Every machine has a place in your cloud.",
  Databases: "Simple, dependable building blocks for your projects.",
  Domains: "Simple, dependable building blocks for your projects.",
  Activity: "A record of what is happening across your cloud.",
  Settings: "The connections and tools behind your workspace.",
};
const VERSION = "v0.3.0";
function App() {
  const [session, setSession] = useState<HostedSession | null>(null);
  const [mode, setMode] = useState<"demo" | "live">("live"),
    [page, setPage] = useState<Page>("Overview"),
    [data, setData] = useState<Snapshot>(empty),
    [modal, setModal] = useState<Modal>(hosted ? "login" : null),
    [selected, setSelected] = useState<Project | null>(null),
    [machineDetail, setMachineDetail] = useState<Machine | null>(null),
    [search, setSearch] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [githubNotice, setGithubNotice] = useState(""),
    [revealToken, setRevealToken] = useState(false),
    [busy, setBusy] = useState(false),
    [stream, setStream] = useState("Connecting"),
    [menu, setMenu] = useState(false),
    [userMenu, setUserMenu] = useState(false),
    [enrollment, setEnrollment] = useState<{
      token: string;
      expires_at: string;
      endpoint?: string;
    } | null>(null);
  const [routeReady, setRouteReady] = useState(false),
    [pendingProject, setPendingProject] = useState<string | null>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const params = new URLSearchParams(location.hash.slice(1));
    const savedPage = params.get("page");
    const githubResult = params.get("github_error") || params.get("github");
    if (githubResult && githubMessages[githubResult])
      setGithubNotice(githubMessages[githubResult]);
    setPendingProject(params.get("project"));
    setRouteReady(true);
    if (
      [
        "Overview",
        "Projects",
        "Machines",
        "Databases",
        "Domains",
        "Activity",
        "Settings",
      ].includes(savedPage ?? "")
    )
      setPage(savedPage as Page);
    if (params.get("mode") === "demo") {
      setMode("demo");
      setData(structuredClone(demo));
    }
  }, []);
  useEffect(() => {
    if (!routeReady || pendingProject) return;
    const params = new URLSearchParams();
    params.set("page", page);
    if (selected) params.set("project", selected.id);
    if (mode === "demo") params.set("mode", "demo");
    history.replaceState(null, "", `#${params}`);
  }, [page, selected, mode, routeReady, pendingProject]);
  useEffect(() => {
    if (pendingProject && data.generated_at) {
      setSelected(data.projects.find((p) => p.id === pendingProject) ?? null);
      setPendingProject(null);
    }
  }, [pendingProject, data]);
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
    let fetchingUpdate = false, updatePending = false;
    const refreshFromEvent = async () => {
      updatePending = true;
      if (fetchingUpdate) return;
      fetchingUpdate = true;
      try {
        while (updatePending && !cancelled) {
          updatePending = false;
          const next = await api<Snapshot>("/snapshot");
          if (!cancelled) { setData(next); setStream("Live updates"); }
        }
      } catch (e) {
        if (!cancelled) {
          setStream("Update unavailable");
          if (e instanceof ApiError && e.status === 401) { setData(empty); setModal("login"); }
        }
      } finally { fetchingUpdate = false; }
    };
    const connect = async () => {
      try {
        const activeSession = hosted ? await api<HostedSession>("/session") : null;
        const next = await api<Snapshot>("/snapshot");
        if (cancelled) return;
        setSession(activeSession);
        setData(next);
        if (hosted) setModal(current => current === "login" ? null : current);
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
            const message = JSON.parse(e.data);
            if (hosted && message.type === "changed") void refreshFromEvent();
            else if (Array.isArray(message.machines)) {
              setData(message);
              setStream("Live updates");
            }
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
        setStream("Disconnected");
        // No session yet is the sign-in state, not a failure worth an alert.
        if (e instanceof ApiError && e.status === 401) setModal("login");
        else setError((e as Error).message);
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
  useEffect(() => {
    if (!userMenu) return;
    const onDown = (e: PointerEvent) => {
      if (!userMenuRef.current?.contains(e.target as Node)) setUserMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setUserMenu(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [userMenu]);
  const signedIn = Boolean(data.generated_at);
  // Live but signed out: don't poll (401) and don't synthesize demo curves.
  const fleetHistory = useFleetHistory(
    mode === "live",
    data.machines,
    mode !== "live" || signedIn,
  );
  function open(value: Modal) {
    setError("");
    setEnrollment(null);
    setRevealToken(false);
    setModal(value);
  }
  function exploreDemo() {
    setMode("demo");
    setData(structuredClone(demo));
    setSelected(null);
    setMachineDetail(null);
    setError("");
    setModal(null);
  }
  async function signOut() {
    try {
      await api("/session", undefined, "DELETE");
      if (hosted) { window.history.replaceState(null, "", "/"); window.location.reload(); return; }
      setData(empty);
      setSelected(null);
      setModal("login");
      setNotice("Signed out");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function switchMode() {
    if (mode === "demo") {
      open("login");
    } else {
      setPage("Settings");
    }
  }
  function go(next: Page) {
    setPage(next);
    setSelected(null);
    setMachineDetail(null);
    setMenu(false);
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
        const endpoint = String(form.get("wireguard_endpoint") || "");
        if (endpoint && !/^[A-Za-z0-9.:[\]_-]+$/.test(endpoint))
          throw new Error(
            "Use a hostname or IP and port for the public network endpoint.",
          );
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
        setEnrollment({
          ...result,
          endpoint: String(form.get("wireguard_endpoint") || ""),
        });
      }
      if (modal === "service" && selected) {
        const body = serviceFields(form);
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
  const live = mode === "live";
  const installCommand = enrollment
    ? `curl -fsSL '${location.origin}/install.sh' | sudo env PC_API='${location.origin}' PC_ENROLL_TOKEN='${enrollment.token}'${enrollment.endpoint ? ` PC_WIREGUARD_ENDPOINT='${enrollment.endpoint}'` : ""} sh`
    : "";
  const brand = (
    <a
      href="/"
      aria-label="Personal Cloud home"
      className="flex min-w-0 items-center gap-2.5 text-sm font-semibold tracking-tight text-foreground"
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-primary/15 text-primary">
        <Cloud className="size-4" />
      </span>
      <span className="truncate">Personal Cloud</span>
      <Badge
        variant="blank"
        className="h-4 px-1 text-[9px] tracking-[0.08em] text-muted-foreground"
      >
        ALPHA
      </Badge>
    </a>
  );
  const toasts = (githubNotice || notice) && (
    <div className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col items-stretch gap-2 sm:left-auto sm:right-4 sm:w-auto sm:max-w-sm sm:items-end">
      {githubNotice && (
        <div
          data-slot="toast"
          role="status"
          className="pointer-events-auto flex items-center gap-2 px-3 py-2 text-sm"
        >
          <span className="flex-1">{githubNotice}</span>
          <Button
            size="xs"
            variant="ghost"
            aria-label="Dismiss GitHub message"
            onClick={() => setGithubNotice("")}
          >
            Dismiss
          </Button>
        </div>
      )}
      {notice && (
        <div
          data-slot="toast"
          role="status"
          className="pointer-events-auto flex items-center gap-2 px-3 py-2 text-sm"
        >
          <Check data-icon className="size-4" />
          {notice}
        </div>
      )}
    </div>
  );
  const loginFields = (
    <>
      <GitHubSignIn />
      {!hosted && <>
      <div className="flex flex-col gap-2">
        <Label htmlFor="owner-token">Owner token</Label>
        <Input
          id="owner-token"
          autoFocus
          name="token"
          type="password"
          autoComplete="off"
          required
          minLength={32}
          placeholder="PC_ADMIN_TOKEN"
        />
      </div>
      <Alert className="text-muted-foreground">
        <LockKeyhole />
        Your token is sent only to this workspace. The session uses a protected
        cookie.
      </Alert>
      </>}
    </>
  );
  if (live && modal === "login" && !signedIn) {
    return (
      <div className="grid min-h-screen lg:grid-cols-2">
        <div className="relative hidden flex-col justify-between overflow-hidden border-r border-border bg-sidebar p-10 lg:flex">
          <div className="relative z-10 text-base">{brand}</div>
          <div className="relative z-10 flex flex-col items-center gap-6 text-center">
            <p className="text-lg text-muted-foreground">
              Your hardware. Your cloud.
            </p>
          </div>
          <div aria-hidden className="absolute inset-x-0 bottom-0 h-40">
            <DitherGradient
              from="green"
              to="transparent"
              direction="up"
              opacity={0.35}
            />
          </div>
          <Meta className="relative z-10 text-foreground/70">
            Personal Cloud · {VERSION}
          </Meta>
        </div>
        <div className="flex flex-col items-center justify-center px-4 py-10">
          <div className="flex w-full max-w-sm flex-col gap-6">
            <div className="lg:hidden">{brand}</div>
            <div className="flex flex-col gap-1">
              <h1 className="text-xl font-semibold tracking-tight">
                Connect your cloud
              </h1>
              <p className="text-sm text-muted-foreground">
                Sign in to the control plane that runs your machines and
                projects.
              </p>
            </div>
            <form onSubmit={submit} className="flex flex-col gap-4">
              {loginFields}
              {error && <Alert variant="destructive">{error}</Alert>}
              {!hosted && <Button type="submit" className="w-full" isLoading={busy}>
                {!busy && <LockKeyhole />}
                {busy ? "Working…" : "Connect workspace"}
              </Button>}
              <Button
                type="button"
                variant="link"
                size="sm"
                onClick={exploreDemo}
              >
                Explore sample workspace
              </Button>
            </form>
          </div>
        </div>
        {toasts}
      </div>
    );
  }
  const navButton = (
    label: Page,
    Icon: typeof LayoutDashboard,
    count?: number,
  ) => {
    const active = page === label;
    return (
      <button
        key={label}
        type="button"
        data-slot="sidebar-menu-button"
        data-active={active}
        aria-current={active ? "page" : undefined}
        onClick={() => go(label)}
        className={cn(
          "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
          active
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
        )}
      >
        <Icon className={cn("size-4", active && "text-primary")} />
        <span className="flex-1 truncate">{label}</span>
        {count !== undefined && <Meta>{count}</Meta>}
      </button>
    );
  };
  return (
    <div className="flex min-h-screen">
      {menu && (
        <div
          aria-hidden
          className="fixed inset-0 z-30 bg-black/40 backdrop-blur-[2px] lg:hidden"
          onClick={() => setMenu(false)}
        />
      )}
      <aside
        id="workspace-navigation"
        data-slot="sidebar-inner"
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-[19.5rem] max-w-[85vw] flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-transform duration-200 lg:sticky lg:top-0 lg:h-screen lg:shrink-0 lg:translate-x-0",
          menu ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex h-12 shrink-0 items-center justify-between gap-2 px-4">
          {brand}
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground lg:hidden"
            aria-label="Close navigation"
            onClick={() => setMenu(false)}
          >
            <X />
          </Button>
        </div>
        <nav
          aria-label="Main navigation"
          className="flex flex-1 flex-col gap-4 overflow-y-auto px-3 py-2"
        >
          <div className="flex flex-col gap-0.5">
            <div
              data-slot="sidebar-group-label"
              className="gh-eyebrow flex h-8 items-center px-2"
            >
              Workspace
            </div>
            {nav.map(({ label, icon }) =>
              navButton(
                label,
                icon,
                label === "Machines"
                  ? data.machines.length
                  : label === "Projects"
                    ? data.projects.length
                    : undefined,
              ),
            )}
          </div>
          <div className="flex flex-col gap-0.5">
            <div
              data-slot="sidebar-group-label"
              className="gh-eyebrow flex h-8 items-center px-2"
            >
              System
            </div>
            {system.map(({ label, icon }) => navButton(label, icon))}
          </div>
        </nav>
        <div className="relative border-t border-sidebar-border p-3" ref={userMenuRef}>
          {userMenu && (
            <div
              role="menu"
              aria-label="Workspace menu"
              className="gh-surface absolute inset-x-3 bottom-full z-50 mb-1 flex flex-col gap-0.5 rounded-lg p-1 text-sm text-foreground"
            >
              <span className="gh-eyebrow px-2 py-1.5">Workspace</span>
              {hosted && session && <WorkspacePicker session={session} />}
              <button
                type="button"
                role="menuitem"
                className="gh-interactive flex h-8 items-center gap-2 rounded-md px-2 text-left"
                onClick={() => {
                  setUserMenu(false);
                  if (mode === "demo") open("login");
                  else exploreDemo();
                }}
              >
                {mode === "demo" ? (
                  <LockKeyhole className="size-4 text-muted-foreground" />
                ) : (
                  <Box className="size-4 text-muted-foreground" />
                )}
                {mode === "demo" ? "Connect workspace" : "Switch to demo"}
              </button>
              {live && (
                <button
                  type="button"
                  role="menuitem"
                  className="gh-interactive flex h-8 items-center gap-2 rounded-md px-2 text-left"
                  onClick={() => {
                    setUserMenu(false);
                    void signOut();
                  }}
                >
                  <LogOut className="size-4 text-muted-foreground" />
                  Sign out
                </button>
              )}
              <a
                role="menuitem"
                href="https://github.com/nooesc/personal-cloud"
                target="_blank"
                rel="noreferrer"
                className="gh-interactive flex h-8 items-center gap-2 rounded-md px-2"
              >
                <ArrowUpRight className="size-4 text-muted-foreground" />
                View on GitHub
              </a>
            </div>
          )}
          <button
            type="button"
            data-slot="sidebar-menu-button"
            data-active={userMenu}
            aria-haspopup="menu"
            aria-expanded={userMenu}
            onClick={() => setUserMenu((v) => !v)}
            className="flex w-full items-center gap-3 rounded-md p-2 text-left outline-none hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <DitherAvatar
              name="Personal Cloud"
              animate={false}
              className="size-8 shrink-0 rounded-md ring-1 ring-border"
            />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-sm font-medium text-foreground">
                Personal Cloud
              </span>
              <Meta className="truncate">
                {mode === "demo" ? "Demo workspace" : session?.workspace.name ?? (hosted ? "Your workspace" : "Owner workspace")}
              </Meta>
            </span>
            <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
          </button>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-3 border-b border-border bg-background px-4 sm:px-6">
          <Button
            variant="ghost"
            size="icon-sm"
            className="-ml-2 text-muted-foreground lg:hidden"
            aria-label="Toggle navigation"
            aria-controls="workspace-navigation"
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
          >
            <Menu />
          </Button>
          <nav
            aria-label="Breadcrumb"
            className="flex min-w-0 items-center gap-1.5"
          >
            <Meta className="hidden sm:inline">My cloud</Meta>
            <ChevronRight className="hidden size-3 text-muted-foreground sm:inline" />
            <span className="truncate text-sm font-medium">{page}</span>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <div className="relative hidden w-full max-w-xs sm:block">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label="Search machines and projects"
                placeholder="Find a project or machine…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 pl-8"
              />
            </div>
            <button
              type="button"
              onClick={switchMode}
              aria-label={
                mode === "demo"
                  ? "Demo workspace. Connect your cloud"
                  : "Live workspace. Open settings"
              }
              className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              <Badge
                variant={
                  mode === "demo"
                    ? "blank"
                    : stream === "Live updates"
                      ? "green"
                      : "yellow"
                }
                className="h-6 px-2"
              >
                <StatusDot
                  status={
                    mode === "demo"
                      ? "idle"
                      : stream === "Live updates"
                        ? "online"
                        : "degraded"
                  }
                  className="size-1.5"
                />
                {mode === "demo"
                  ? "Demo workspace"
                  : stream === "Live updates"
                    ? "Live workspace"
                    : stream}
              </Badge>
            </button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              aria-label="Open setup information"
              onClick={() => setPage("Settings")}
            >
              <CircleHelp />
            </Button>
          </div>
        </header>
        <main className="flex min-w-0 flex-1 flex-col gap-6 p-4 sm:p-6 lg:p-8">
          {mode === "demo" && (
            <Alert className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <Box className="text-muted-foreground" />
              <span className="min-w-40 flex-1">
                A little cloud to explore. Everything here is sample data.
              </span>
              <Button size="xs" variant="outline" onClick={() => open("login")}>
                Connect your cloud <ArrowRight />
              </Button>
            </Alert>
          )}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex flex-col gap-1">
              <h1 className="text-xl font-semibold tracking-tight">{page}</h1>
              <p className="text-sm text-muted-foreground">
                {descriptions[page]}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {(page === "Overview" || page === "Machines") && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => open("machine")}
                >
                  <Plus />
                  Add machine
                </Button>
              )}
              {(page === "Overview" || page === "Projects") && (
                <Button size="sm" onClick={() => open("project")}>
                  <Plus />
                  New project
                </Button>
              )}
            </div>
          </div>
          {live &&
            ["Reconnecting", "Disconnected", "Update unavailable"].includes(
              stream,
            ) &&
            data.generated_at && (
              <Alert>
                Live updates interrupted. Showing the last snapshot from{" "}
                {new Date(data.generated_at).toLocaleTimeString()}.
              </Alert>
            )}
          {error && !modal && (
            <Alert
              variant="destructive"
              className="flex flex-wrap items-center gap-x-3 gap-y-2"
            >
              <span className="min-w-40 flex-1">{error}</span>
              <Button size="xs" variant="outline" onClick={() => open("login")}>
                Sign in
              </Button>
            </Alert>
          )}
          {page === "Overview" && (
            <>
              {live &&
                !data.services.some((s) => s.status === "healthy") && (
                  <Card className="flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex flex-col gap-1.5">
                      <Eyebrow>Let’s get your cloud running</Eyebrow>
                      <span className="text-[15px] font-medium">
                        {data.machines.length
                          ? "Your fleet is here. Give it something to run."
                          : "Start with the things you already own."}
                      </span>
                      <p className="text-sm text-muted-foreground">
                        {hosted ? "Choose your repositories, add a Linux machine, then" : "Connect GitHub and Cloudflare, add a Linux machine, then"}{" "}
                        deploy your first application.
                      </p>
                    </div>
                    <Button
                      size="sm"
                      className="shrink-0"
                      onClick={() => setPage("Settings")}
                    >
                      Set up your cloud <ArrowRight />
                    </Button>
                  </Card>
                )}
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <Stat
                  label="Machines"
                  value={String(data.machines.length)}
                  detail={`${online} online${data.machines.length - online ? ` · ${data.machines.length - online} need attention` : ""}`}
                  icon={<Server />}
                />
                <Stat
                  label="Compute"
                  value={String(totals.cpu)}
                  unit="cores"
                  detail="Across your whole fleet"
                  icon={<Cpu />}
                />
                <Stat
                  label="Memory"
                  value={size(totals.ram).split(" ")[0]}
                  unit={size(totals.ram).split(" ")[1]}
                  detail="Room for your next idea"
                  icon={<MemoryStick />}
                />
                <Stat
                  label="Storage"
                  value={size(totals.disk).split(" ")[0]}
                  unit={size(totals.disk).split(" ")[1]}
                  detail="Capacity on connected machines"
                  icon={<HardDrive />}
                />
              </div>
              <FleetPanel
                machines={machines}
                services={data.services}
                live={live}
                stream={stream}
                onSelect={setMachineDetail}
                onAdd={() => open("machine")}
                search={search}
                history={fleetHistory}
              />
              <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <CardTitle className="text-[15px]">Projects</CardTitle>
                      <Meta>{data.projects.length}</Meta>
                    </div>
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => setPage("Projects")}
                    >
                      View all <ArrowRight />
                    </Button>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-1 px-3 pb-3">
                    <ProjectList
                      projects={projects}
                      data={data}
                      onSelect={setSelected}
                    />
                    {!projects.length && (
                      <EmptyState
                        icon={<Layers3 />}
                        title={
                          search
                            ? "No matching projects"
                            : "Something great starts here"
                        }
                        description="Add a GitHub repository to organize your first application."
                        action={
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => open("project")}
                          >
                            Create project
                          </Button>
                        }
                      />
                    )}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between gap-3">
                    <CardTitle className="text-[15px]">Recent activity</CardTitle>
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => setPage("Activity")}
                    >
                      All activity <ArrowRight />
                    </Button>
                  </CardHeader>
                  <CardContent className="px-3 pb-3">
                    <ActivityList data={data} demoMode={mode === "demo"} />
                  </CardContent>
                </Card>
              </div>
            </>
          )}
          {page === "Projects" && (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <CardTitle className="text-[15px]">All projects</CardTitle>
                  <Meta>{projects.length}</Meta>
                </div>
                <Meta>GitHub repositories</Meta>
              </CardHeader>
              <CardContent className="flex flex-col gap-1 px-3 pb-3">
                <ProjectList
                  projects={projects}
                  data={data}
                  onSelect={setSelected}
                />
                {!projects.length && (
                  <EmptyState
                    icon={<Layers3 />}
                    title="A home for your next project"
                    description="Start with a repository. Add its services and choose where they should run."
                    action={
                      <Button size="sm" onClick={() => open("project")}>
                        New project
                      </Button>
                    }
                  />
                )}
              </CardContent>
            </Card>
          )}
          {page === "Machines" && (
            <FleetPanel
              machines={machines}
              services={data.services}
              live={live}
              stream={stream}
              onSelect={setMachineDetail}
              onAdd={() => open("machine")}
              search={search}
              history={fleetHistory}
            />
          )}
          {page === "Databases" && (
            <Databases data={data} refresh={refresh} live={live} />
          )}
          {page === "Domains" && (
            <Domains data={data} refresh={refresh} live={live} />
          )}
          {page === "Activity" && (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-3">
                <CardTitle className="text-[15px]">Workspace activity</CardTitle>
                <Meta>Latest 30 events</Meta>
              </CardHeader>
              <CardContent className="px-3 pb-3">
                <ActivityList data={data} demoMode={mode === "demo"} />
              </CardContent>
            </Card>
          )}
          {page === "Settings" && (
            <Setup
              data={data}
              refresh={refresh}
              live={live}
              signIn={() => open("login")}
              signOut={signOut}
              explore={exploreDemo}
            />
          )}
          <footer className="mt-auto flex items-center justify-between gap-4 pt-2">
            <Meta>A cloud of your own.</Meta>
            <Meta>Personal Cloud · {VERSION}</Meta>
          </footer>
        </main>
      </div>
      {toasts}
      {selected && !modal && (
        <Dialog
          size="wide"
          title={selected.name}
          onClose={() => setSelected(null)}
        >
          <ProjectDetail
            project={selected}
            data={data}
            refresh={refresh}
            live={live}
            addService={() => open("service")}
            onRemove={() => setSelected(null)}
          />
        </Dialog>
      )}
      {machineDetail && (
        <Dialog
          title={machineDetail.report.hostname}
          onClose={() => setMachineDetail(null)}
        >
          <MachineDetailBody
            machine={machineDetail}
            live={live}
            history={fleetHistory[machineDetail.id]}
          />
          {live && (
            <MachineSettings
              machine={machineDetail}
              refresh={refresh}
              onRemove={() => setMachineDetail(null)}
            />
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
            <div className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">
                Machines report to your own control plane. Connect your live
                workspace to create a secure enrollment token.
              </p>
              <Alert>
                <Server className="text-muted-foreground" />
                This is a sample fleet. Connecting your workspace opens your
                real machine inventory.
              </Alert>
              <Button className="w-full" onClick={() => open("login")}>
                Connect workspace <ArrowRight />
              </Button>
            </div>
          ) : enrollment ? (
            <div className="flex flex-col gap-4">
              <Alert variant="success">
                <span className="font-medium">
                  Your enrollment token is ready
                </span>
                <Meta className="text-primary/80">
                  One use · expires{" "}
                  {new Date(enrollment.expires_at).toLocaleTimeString()}
                </Meta>
              </Alert>
              <p className="text-sm text-muted-foreground">
                Run the installer on your Linux machine. It installs the
                runtime, creates its private identity, and starts reporting to
                your cloud.
              </p>
              <div className="flex flex-col gap-2">
                <Label htmlFor="enrollment-token">Enrollment token</Label>
                <div className="flex gap-2">
                  <input
                    id="enrollment-token"
                    readOnly
                    type={revealToken ? "text" : "password"}
                    value={enrollment.token}
                    className={cn(fieldClasses, "font-mono text-xs")}
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Copy enrollment token"
                    onClick={() => copy(enrollment.token)}
                  >
                    <Copy />
                  </Button>
                </div>
                <Button
                  variant="link"
                  size="xs"
                  className="self-start px-0"
                  onClick={() => setRevealToken(!revealToken)}
                >
                  {revealToken ? "Hide token" : "Show token for manual copy"}
                </Button>
              </div>
              {error && <Alert variant="destructive">{error}</Alert>}
              <div className="flex flex-col gap-2">
                <Label htmlFor="install-command">Install command</Label>
                <Textarea
                  id="install-command"
                  readOnly
                  rows={5}
                  value={installCommand}
                  className="font-mono text-xs"
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="self-start"
                  onClick={() => copy(installCommand)}
                >
                  <Copy />
                  Copy installer command
                </Button>
              </div>
              <Alert className="text-muted-foreground">
                <LockKeyhole />
                Ubuntu 22.04/24.04 or Debian 12/13 with systemd. Run on the
                machine you want to enroll. Your control plane URL must be
                reachable from that machine.
              </Alert>
              <Button
                className="w-full"
                onClick={() => {
                  setModal(null);
                  setPage("Machines");
                }}
              >
                View machines <ArrowRight />
              </Button>
            </div>
          ) : (
            <form onSubmit={submit} className="flex flex-col gap-4">
              {modal === "login" && (
                <>
                  {loginFields}
                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    className="self-start px-0"
                    onClick={exploreDemo}
                  >
                    Explore sample workspace
                  </Button>
                </>
              )}
              {modal === "project" && (
                <>
                  <p className="text-sm text-muted-foreground">
                    Give your application a home. Start with a GitHub
                    repository, then add its services.
                  </p>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="project-name">Project name</Label>
                    <Input
                      id="project-name"
                      autoFocus
                      name="name"
                      required
                      maxLength={80}
                      placeholder="My next big thing"
                    />
                  </div>
                  <RepositoryField live={live} />
                  {mode === "demo" && (
                    <p className="text-xs text-muted-foreground">
                      This project stays in your demo session.
                    </p>
                  )}
                </>
              )}
              {modal === "machine" && (
                <>
                  <p className="text-sm text-muted-foreground">
                    Choose where this machine lives and what it can do. We’ll
                    create a single-use token for the agent.
                  </p>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="machine-location">Location</Label>
                    <Select id="machine-location" name="location">
                      <option value="home">Home fleet</option>
                      <option value="vps">Cloud VPS</option>
                      <option value="dedicated">Dedicated server</option>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="machine-endpoint">
                      Public network endpoint <Meta>optional</Meta>
                    </Label>
                    <Input
                      id="machine-endpoint"
                      name="wireguard_endpoint"
                      placeholder="vps.example.com:51820"
                    />
                    <p className="text-xs text-muted-foreground">
                      For your first server, use a reachable hostname or IP with
                      UDP port 51820 so remote machines can join. A single
                      machine can run without this.
                    </p>
                  </div>
                  <fieldset className="flex flex-col gap-3">
                    <legend className="mb-3 text-sm font-medium leading-none">
                      Machine roles
                    </legend>
                    <div className="flex flex-wrap gap-x-5 gap-y-2">
                      {["compute", "builder", "database"].map((role) => (
                        <Label key={role} className="font-normal">
                          <Checkbox
                            name="roles"
                            value={role}
                            defaultChecked={
                              role === "compute" ||
                              (role === "builder" &&
                                data.machines.length === 0)
                            }
                          />
                          {role.charAt(0).toUpperCase() + role.slice(1)}
                        </Label>
                      ))}
                    </div>
                  </fieldset>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="machine-tags">
                      Tags <Meta>optional</Meta>
                    </Label>
                    <Input
                      id="machine-tags"
                      name="tags"
                      placeholder="home, high-memory"
                    />
                    <p className="text-xs text-muted-foreground">
                      Comma-separated labels for your machine.
                    </p>
                  </div>
                </>
              )}
              {modal === "service" && (
                <>
                  <p className="text-sm text-muted-foreground">
                    Configure a component of {selected?.name}.
                  </p>
                  <ServiceFields data={data} />
                  <p className="text-xs text-muted-foreground">
                    After creating the service, deploy its production branch
                    from the service details.
                  </p>
                </>
              )}
              {error && <Alert variant="destructive">{error}</Alert>}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setModal(null)}
                >
                  Cancel
                </Button>
                {!(hosted && modal === "login") && <Button type="submit" isLoading={busy}>
                  {!busy &&
                    (modal === "login" ? <LockKeyhole /> : <Plus />)}
                  {busy
                    ? "Working…"
                    : modal === "project"
                      ? "Create project"
                      : modal === "machine"
                        ? "Create enrollment token"
                        : modal === "service"
                          ? "Add service"
                          : "Connect workspace"}
                </Button>}
              </DialogFooter>
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
    <Card className="gap-3 p-6">
      <div className="flex items-start justify-between gap-2">
        <span className="gh-eyebrow">{label}</span>
        <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-2xl font-semibold tracking-tight tabular-nums">
          {value}
        </span>
        {unit && <Meta>{unit}</Meta>}
      </div>
      <Meta className="truncate">{detail}</Meta>
    </Card>
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
    <>
      {projects.map((p) => {
        const services = data.services.filter((s) => s.project_id === p.id);
        const hosts = [
          ...new Set(
            services
              .map(
                (s) =>
                  data.machines.find(
                    (m) => m.id === (s.machine_id ?? s.demo_machine),
                  )?.report.hostname,
              )
              .filter(Boolean),
          ),
        ].join(", ");
        const healthy =
          services.length > 0 &&
          services.every((s) => (s.status ?? s.demo_status) === "healthy");
        const health = healthy
          ? { status: "healthy", label: "Healthy" }
          : services.some(
                (s) => s.status === "failed" || s.status === "unhealthy",
              )
            ? { status: "failed", label: "Needs attention" }
            : services.some((s) => s.status && s.status !== "not_deployed")
              ? { status: "deploying", label: "Deploying" }
              : { status: "idle", label: "Not deployed" };
        return (
          <button
            type="button"
            key={p.id}
            onClick={() => onSelect(p)}
            className="gh-interactive flex w-full items-center gap-3 rounded-md border border-transparent px-3 py-2.5 text-left"
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
              <Layers3 className="size-4" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="truncate text-[15px] font-medium leading-none">
                {p.name}
              </span>
              <Meta className="flex items-center gap-1 truncate">
                <GitFork className="size-3 shrink-0" />
                <span className="truncate">{p.repository}</span>
              </Meta>
            </span>
            <span className="hidden shrink-0 flex-col items-end gap-1 sm:flex">
              <span className="text-sm tabular-nums">
                {services.length}{" "}
                {services.length === 1 ? "service" : "services"}
              </span>
              <Meta className="max-w-48 truncate">
                {hosts || "Ready to configure"}
              </Meta>
            </span>
            <span
              className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
              title={health.label}
            >
              <StatusDot status={health.status} />
              <span className="hidden md:inline">{health.label}</span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          </button>
        );
      })}
    </>
  );
}
function activityStatus(kind: string) {
  const state = kind.split(".").pop() ?? "";
  if (state in statusDot) return state;
  return state === "created" || state === "joined" ? "done" : "idle";
}
function ActivityList({
  data,
  demoMode,
}: {
  data: Snapshot;
  demoMode: boolean;
}) {
  return (
    <div className="flex flex-col">
      {data.activity.map((e, i) => (
        <div
          key={e.id}
          className="flex items-start gap-3 border-b border-border px-3 py-2.5 last:border-0"
        >
          <StatusDot status={activityStatus(e.kind)} className="mt-1.5" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="text-sm">{e.message}</p>
            <Meta>
              {demoMode
                ? [
                    "2 minutes ago · sample",
                    "1 hour ago · sample",
                    "2 hours ago · sample",
                  ][i % 3]
                : new Date(e.created_at).toLocaleString()}
            </Meta>
          </div>
        </div>
      ))}
      {!data.activity.length && (
        <EmptyState
          icon={<Activity />}
          title="Quiet for now."
          description="Your cloud’s story will appear here."
          className="py-10"
        />
      )}
    </div>
  );
}
