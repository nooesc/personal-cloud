import { hosted, type HostedSession } from "../lib/hosted";
import { WorkspacePicker } from "../components/workspaces";
import { GitHubAvatar, GitHubSignIn, githubMessages } from "../components/github";
import { createFileRoute, Outlet, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  Activity,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronRight,
  ChevronsUpDown,
  Cloud,
  Database,
  Globe2,
  Layers3,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  PanelLeft,
  Plus,
  Server,
  Settings2,
  X,
} from "lucide-react";
import {
  api,
  ApiError,
  empty,
  type CloudflareOverview,
  type Snapshot,
  type Machine,
  type Project,
} from "../lib/data";
import { cn } from "../lib/utils";
import { Setup, MachineSettings } from "../components/live";
import { NewProjectFlow } from "../components/new-project";
import { ServiceFields, serviceFields } from "../components/service-fields";
import { ProjectPage } from "../components/project-page";
import type { ProjectTab } from "../components/project";
import { Domains } from "../components/resources";
import { Databases } from "../components/databases";
import { DatabaseDetail } from "../components/databases/detail";
import { useFleet } from "../components/fleet/use-fleet";
import { FleetSection } from "../components/fleet/fleet-section";
import { workloadsOf } from "../components/fleet/workloads";
import { MachineCard } from "../components/fleet/machine-card";
import { HostDetail } from "../components/fleet/host-detail";
import { ShowHome } from "../components/home/show-home";
import { Repositories } from "../components/repositories";
import { projectHues } from "../components/project-summary";
import { Enroll, MachinesEmpty, PendingMachineCard, isWaiting, type EnrollmentToken } from "../components/enroll";
import { ReadinessActions, capabilityOf, type ReadinessHandlers } from "../components/readiness";
import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import {
  Input,
  Label,
} from "../components/ui/input";
import { Dialog, DialogFooter } from "../components/ui/dialog";
import {
  Alert,
  EmptyState,
  Meta,
  Separator,
  StatusDot,
  statusDot,
} from "../components/ui/misc";
import { TimeBadge } from "../components/ui/time-badge";
import { DitherAvatar, DitherGradient } from "../components/dither-kit";
export const Route = createFileRoute("/_shell")({ component: App });
type Page =
  | "Overview"
  | "Repositories"
  | "Machines"
  | "Databases"
  | "Domains"
  | "Activity"
  | "Settings";
type Modal = "project" | "machine" | "login" | "service" | null;
const nav = [
  { label: "Overview", icon: LayoutDashboard },
  { label: "Repositories", icon: Layers3 },
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
  Repositories: "Where your source lives and how it maps onto projects.",
  Machines: "Every machine has a place in your cloud.",
  Databases: "Simple, dependable building blocks for your projects.",
  Domains: "Simple, dependable building blocks for your projects.",
  Activity: "A record of what is happening across your cloud.",
  Settings: "The connections and tools behind your workspace.",
};
const VERSION = "v0.3.0";
function App() {
  const [session, setSession] = useState<HostedSession | null>(null);
  const [page, setPage] = useState<Page>("Overview"),
    [data, setData] = useState<Snapshot>(empty),
    [modal, setModal] = useState<Modal>(hosted ? "login" : null),
    [machineDetail, setMachineDetail] = useState<Machine | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [githubNotice, setGithubNotice] = useState(""),
    [tokens, setTokens] = useState<Record<string, EnrollmentToken>>({}),
    [busy, setBusy] = useState(false),
    [stream, setStream] = useState("Connecting"),
    [menu, setMenu] = useState(false),
    [collapsed, setCollapsed] = useState(false),
    [userMenu, setUserMenu] = useState(false);
  const [routeReady, setRouteReady] = useState(false),
    [organizeRequest, setOrganizeRequest] = useState(0),
    [overview, setOverview] = useState<CloudflareOverview>();
  // The open project lives in the path; its section and open service in the
  // search, so every view of a project is a link. Databases work the same way.
  const navigate = useNavigate();
  const { projectId, databaseId } = useParams({ strict: false });
  const projectSearch = useSearch({ strict: false }) as { tab?: ProjectTab; service?: string };
  const openProject = (p: Project, service?: string) =>
    void navigate({
      to: "/projects/$projectId",
      params: { projectId: p.id },
      search: service ? { service } : {},
    });
  const openDatabase = (id: string) =>
    void navigate({ to: "/databases/$databaseId", params: { databaseId: id } });
  const closeProject = () => void navigate({ to: "/" });
  const closeDatabase = () => void navigate({ to: "/" });
  // What each machine runs, keyed by machine id (the fleet host key).
  const workloads = Object.fromEntries(data.machines.map((m) => [m.id, workloadsOf(data, m.id)]));
  const userMenuRef = useRef<HTMLDivElement>(null);
  // Cards join the connected account's addresses and traffic onto linked
  // resources; the list renders first and fills in when Cloudflare answers.
  const linked = (data.project_resources ?? []).some((r) => r.project_id && !r.ignored);
  useEffect(() => {
    if ((page !== "Repositories" && page !== "Overview" && !projectId) || !linked) return;
    let cancelled = false;
    api<CloudflareOverview>("/integrations/cloudflare/overview")
      .then((o) => {
        if (!cancelled) setOverview(o);
      })
      .catch(() => {
        if (!cancelled) setOverview(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [page, projectId, linked]);
  useEffect(() => {
    const params = new URLSearchParams(location.hash.slice(1));
    const savedPage = params.get("page");
    const githubResult = params.get("github_error") || params.get("github");
    if (githubResult && githubMessages[githubResult])
      setGithubNotice(githubMessages[githubResult]);
    // Older links carried the project in the hash; they now land on its page.
    const legacyProject = params.get("project");
    if (legacyProject)
      void navigate({ to: "/projects/$projectId", params: { projectId: legacyProject }, replace: true });
    setRouteReady(true);
    if (
      [
        "Overview",
        "Repositories",
        "Machines",
        "Databases",
        "Domains",
        "Activity",
        "Settings",
      ].includes(savedPage ?? "")
    )
      setPage(savedPage as Page);

  }, []);
  useEffect(() => {
    if (!routeReady || projectId || databaseId) return;
    history.replaceState(null, "", `#page=${page}`);
  }, [page, routeReady, projectId, databaseId]);
  // A project page sits under Repositories in the navigation; a database page under Databases.
  useEffect(() => {
    if (projectId) setPage("Repositories");
  }, [projectId]);
  useEffect(() => {
    if (databaseId) setPage("Databases");
  }, [databaseId]);
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
          if (e instanceof ApiError && e.status === 401) { setSession(null); setData(empty); setModal("login"); }
        }
      } finally { fetchingUpdate = false; }
    };
    const connect = async () => {
      try {
        const activeSession = hosted ? await api<HostedSession>("/session") : null;
        if (cancelled) return;
        setSession(activeSession);
        if (hosted && activeSession?.user) setModal(current => current === "login" ? null : current);
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
        if (e instanceof ApiError && e.status === 401) { setSession(null); setData(empty); setModal("login"); }
        else setError((e as Error).message);
        retry = setTimeout(connect, e instanceof ApiError && e.status === 503 ? 60000 : 5000);
      }
    };
    void connect();
    return () => {
      cancelled = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, []);
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
  const signedIn = hosted ? Boolean(session?.user) : Boolean(data.generated_at);
  const fleet = useFleet({ enabled: signedIn, scope: session?.workspace.id });
  const pendingEnrollments = (data.enrollments ?? []).filter((e) =>
    isWaiting(e),
  );
  // The open project always renders from the latest snapshot.
  const current = projectId ? (data.projects.find((p) => p.id === projectId) ?? null) : null;
  function open(value: Modal) {
    setError("");
    setModal(value);
  }
  async function signOut() {
    try {
      await api("/session", undefined, "DELETE");
      if (hosted) { window.history.replaceState(null, "", "/"); window.location.reload(); return; }
      setData(empty);
      closeProject();
      setModal("login");
      setNotice("Signed out");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function go(next: Page) {
    setPage(next);
    if (projectId) closeProject();
    if (databaseId) closeDatabase();
    setMachineDetail(null);
    setMenu(false);
  }
  /** Revoke an unused install command. 404 means it is already gone; 409 means its machine connected. */
  async function revokeEnrollment(id: string) {
    try {
      await api(`/enrollment-tokens/${id}`, undefined, "DELETE");
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) {
        void refresh();
        throw e;
      }
    }
    setTokens(({ [id]: _, ...rest }) => rest);
    setData((d) => ({
      ...d,
      enrollments: (d.enrollments ?? []).filter((e) => e.id !== id),
    }));
    void refresh();
  }
  /** The contextual fix for each readiness blocker; every surface renders blockers through these. */
  const readinessHandlers: ReadinessHandlers = {
    connect_github: () =>
      void api<{ url: string }>("/github/app/install", {}).then(
        (r) => window.location.assign(r.url),
        (e) => {
          go("Settings");
          setError((e as Error).message);
        },
      ),
    add_machine: () => open("machine"),
    configure_runtime: () => go("Settings"),
    check_machine: () => go("Machines"),
    retry: () => void refresh(),
  };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      if (modal === "login") {
        await api("/session", { token: form.get("token") });
        setData(empty);
        await refresh();
        setModal(null);
      }
      if (modal === "project") {
        const body = {
          name: String(form.get("name")),
          repository: String(form.get("repository")),
          branch: String(form.get("branch") || "main"),
        };
        await api("/projects", body);
        await refresh();
        setModal(null);
        setNotice("Project created");
        setPage("Repositories");
      }
      if (modal === "service" && current) {
        const body = serviceFields(form);
        await api(`/projects/${current.id}/services`, body);
        await refresh();
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
  const live = signedIn;
  const brand = (
    <a
      href="/"
      aria-label="dinghy home"
      className="flex min-w-0 items-center gap-2 text-sm font-medium leading-none text-foreground"
    >
      <span className="flex size-6 shrink-0 items-center justify-center rounded-sm border border-border/60 bg-card">
        <Cloud className="size-4 text-primary" />
      </span>
      <span className="truncate">dinghy</span>
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
  if (!signedIn) {
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
            dinghy · {VERSION}
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
          "gh-interactive flex h-8 w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm outline-hidden hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring",
          active && "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
        )}
      >
        <Icon className={cn("size-4", active && "text-primary")} />
        <span className="flex-1 truncate">{label}</span>
        {count !== undefined && <Meta>{count}</Meta>}
      </button>
    );
  };
  return (
    <ReadinessActions.Provider value={readinessHandlers}>
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
          "fixed inset-y-0 left-0 z-40 flex w-[19.5rem] max-w-[85vw] flex-col text-sidebar-foreground transition-transform duration-200 lg:sticky lg:top-0 lg:h-svh lg:shrink-0 lg:translate-x-0 lg:p-2",
          menu ? "translate-x-0" : "-translate-x-full",
          collapsed && "lg:hidden",
        )}
      >
        <div
          data-sidebar="sidebar"
          className="flex size-full flex-col bg-sidebar lg:rounded-lg lg:shadow-sm lg:ring-1 lg:ring-sidebar-border"
        >
        <div className="flex shrink-0 items-center justify-between gap-2 p-2">
          <div className="gh-interactive flex h-12 w-full items-center gap-2 overflow-hidden rounded-md p-2 text-sm">
            {brand}
          </div>
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
              Home
            </div>
            {nav.map(({ label, icon }) =>
              navButton(
                label,
                icon,
                label === "Machines"
                  ? data.machines.length
                  : label === "Repositories"
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
              Settings
            </div>
            {system.map(({ label, icon }) => navButton(label, icon))}
          </div>
          <div className="flex flex-col gap-0.5">
            <div
              data-slot="sidebar-group-label"
              className="gh-eyebrow flex h-8 items-center px-2"
            >
              Extra
            </div>
            <a
              href="https://github.com/nooesc/personal-cloud"
              target="_blank"
              rel="noopener noreferrer"
              data-slot="sidebar-menu-button"
              className="gh-interactive flex h-8 w-full items-center gap-2 overflow-hidden rounded-md p-2 text-sm outline-hidden hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            >
              <BookOpen className="size-4 text-muted-foreground" />
              <span>Documentation</span>
            </a>
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
            className="gh-interactive flex h-12 w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm outline-hidden hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring data-[active=true]:bg-sidebar-accent"
          >
            {session?.user.login ? (
              <GitHubAvatar login={session.user.login} size={32} className="rounded-md" />
            ) : (
              <DitherAvatar
                name="dinghy"
                animate={false}
                className="size-8 shrink-0 rounded-md ring-1 ring-border"
              />
            )}
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-sm font-medium text-foreground">
                {session?.user.login ?? "dinghy"}
              </span>
              <Meta className="truncate">
                {session?.workspace.name ?? (hosted ? "Your workspace" : "Owner workspace")}
              </Meta>
            </span>
            <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
          </button>
        </div>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center gap-2 border-b border-border/60">
          <div className="flex w-full items-center justify-between px-4 sm:px-6">
            <div className="flex items-center gap-2 text-sm">
              <Button
                variant="ghost"
                size="icon-sm"
                className="-ml-1 text-muted-foreground"
                aria-label="Toggle navigation"
                aria-controls="workspace-navigation"
                aria-expanded={!collapsed}
                onClick={() => {
                  if (window.matchMedia("(min-width: 64rem)").matches)
                    setCollapsed((v) => !v);
                  else setMenu(!menu);
                }}
              >
                <PanelLeft />
              </Button>
              <Separator orientation="vertical" className="mr-2 h-4 bg-border/60" />
              <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => go(page)}
                  className={cn(
                    "flex items-center gap-1.5 text-sm font-medium",
                    projectId || databaseId ? "text-muted-foreground hover:text-foreground" : "text-foreground",
                  )}
                >
                  {page}
                </button>
                {(projectId || databaseId) && (
                  <>
                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
                    <span className="truncate text-sm font-medium text-foreground">
                      {projectId
                        ? (current?.name ?? "Project")
                        : (data.databases.find((d) => d.id === databaseId)?.name ?? "Database")}
                    </span>
                  </>
                )}
              </nav>
            </div>
            <TimeBadge anchor={live ? data.generated_at : null} />
          </div>
        </header>
        <main className="flex w-full min-w-0 flex-1 flex-col gap-6 px-4 pb-6 pt-4 sm:px-6">
          {!projectId && !databaseId && page !== "Overview" && page !== "Databases" && (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex flex-col gap-1">
                <h1 className="text-xl font-semibold tracking-tight">{page}</h1>
                <p className="text-sm text-muted-foreground">
                  {descriptions[page]}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {page === "Machines" && (
                  <Button size="sm" onClick={() => open("machine")}>
                    <Plus />
                    Add a machine
                  </Button>
                )}
              </div>
            </div>
          )}
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
          {projectId ? (
            current ? (
              <ProjectPage
                project={current}
                data={data}
                overview={overview}
                hue={projectHues(data.projects)[current.id] ?? 150}
                live={live}
                refresh={refresh}
                tab={projectSearch.tab}
                onTab={(tab) =>
                  void navigate({
                    to: "/projects/$projectId",
                    params: { projectId: current.id },
                    search: { tab },
                    replace: true,
                  })
                }
                serviceId={projectSearch.service}
                onService={(service) =>
                  void navigate({
                    to: "/projects/$projectId",
                    params: { projectId: current.id },
                    search: { tab: projectSearch.tab, service },
                    replace: true,
                  })
                }
                addService={() => open("service")}
                onRemoved={closeProject}
                onOrganize={
                  hosted && data.capabilities?.project_organization
                    ? () => {
                        go("Overview");
                        setOrganizeRequest((n) => n + 1);
                      }
                    : undefined
                }
                onOpenDatabase={openDatabase}
              />
            ) : data.generated_at ? (
              <EmptyState
                icon={<Layers3 />}
                title="This project is not in your workspace"
                description="It may have been removed, or the link belongs to another workspace."
                action={
                  <Button size="sm" variant="outline" onClick={() => go("Repositories")}>
                    All repositories
                  </Button>
                }
              />
            ) : null
          ) : null}
          <Outlet />
          {fleet.error && (page === "Overview" || page === "Machines") && (
            <p role="status" className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">{fleet.error}</p>
          )}

          {!projectId && !databaseId && page === "Overview" && (
            <ShowHome
              data={data}
              overview={overview}
              live={live}
              refresh={refresh}
              fleet={fleet}
              onNavigate={go}
              onSelectProject={openProject}
              onNewProject={() => open("project")}
              onAddMachine={() => open("machine")}
              organizeRequest={organizeRequest}
              userName={session?.user.login}
            />
          )}
          {!projectId && !databaseId && page === "Repositories" && (
            <Repositories
              data={data}
              live={live}
              refresh={refresh}
              onSelectProject={openProject}
              onNewProject={() => open("project")}
              organizeRequest={organizeRequest}
            />
          )}
          {page === "Machines" && (
            <>
              {data.machines.length > 0 && (
                <FleetSection fleet={fleet} workloads={workloads} delay={0.05} />
              )}
              {data.machines.length || pendingEnrollments.length ? (
                <ul className="grid w-full grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-4">
                  {data.machines.map((m, i) => {
                    const host = fleet.hosts.find((h) => h.key === m.id);
                    return (
                      <MachineCard
                        key={m.id}
                        machine={m}
                        host={host}
                        capability={capabilityOf(data, m.id)}
                        cpuHistory={
                          host
                            ? fleet.samples.map(
                                (sample) => sample.readings[host.key]?.cpu ?? 0,
                              )
                            : []
                        }
                        workloads={workloads[m.id]}
                        index={i}
                        delay={0.1 + Math.min(i, 12) * 0.04}
                        onOpen={() => setMachineDetail(m)}
                        onOpenService={(pid, sid) => {
                          const p = data.projects.find((x) => x.id === pid);
                          if (p) openProject(p, sid);
                        }}
                      />
                    );
                  })}
                  {pendingEnrollments.map((e, i) => (
                    <PendingMachineCard
                      key={e.id}
                      enrollment={e}
                      token={tokens[e.id]}
                      delay={0.1 + Math.min(data.machines.length + i, 12) * 0.04}
                      onRevoke={() => revokeEnrollment(e.id)}
                      onNew={() => open("machine")}
                    />
                  ))}
                </ul>
              ) : (
                <MachinesEmpty onAdd={() => open("machine")} />
              )}
            </>
          )}
          {page === "Databases" && !databaseId && (
            <Databases data={data} refresh={refresh} live={live} onOpen={openDatabase} onNavigate={go} />
          )}
          {databaseId && (
            <DatabaseDetail
              key={`${session?.workspace.id ?? ""}:${databaseId}`}
              data={data}
              live={live}
              refresh={refresh}
              databaseId={databaseId}
              onBack={() => go("Databases")}
              onOpenDatabase={openDatabase}
              onOpenProject={(pid, sid) => {
                const p = data.projects.find((x) => x.id === pid);
                if (p) openProject(p, sid);
              }}
              onOpenMachines={() => go("Machines")}
            />
          )}
          {page === "Domains" && (
            <Domains data={data} refresh={refresh} live={live} onNavigate={go} />
          )}
          {page === "Activity" && (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-3">
                <CardTitle className="text-[15px]">Workspace activity</CardTitle>
                <Meta>Latest 30 events</Meta>
              </CardHeader>
              <CardContent className="px-3 pb-3">
                <ActivityList data={data} />
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
              onAddMachine={() => open("machine")}
              onNewProject={() => open("project")}
              onNavigate={(p) => go(p)}
            />
          )}
          <footer className="mt-auto flex items-center justify-between gap-4 pt-2">
            <Meta>A cloud of your own.</Meta>
            <Meta>dinghy · {VERSION}</Meta>
          </footer>
        </main>
      </div>
      {toasts}
      {machineDetail && (
        <Dialog
          title={machineDetail.report.hostname}
          onClose={() => setMachineDetail(null)}
        >
          <HostDetail
            host={fleet.hosts.find((h) => h.key === machineDetail.id)}
            machine={machineDetail}
            capability={capabilityOf(data, machineDetail.id)}
            live={live}
          />
          {live && (
            <MachineSettings
              machine={machineDetail}
              capability={capabilityOf(data, machineDetail.id)}
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
              ? "Deploy from GitHub"
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
          {modal === "machine" ? (
            <Enroll
              data={data}
              onToken={(t) => {
                setTokens((all) => ({ ...all, [t.id]: t }));
                // Show the pending card at once; the next snapshot carries the same record.
                setData((d) => ({
                  ...d,
                  enrollments: [
                    { id: t.id, expires_at: t.expires_at, status: "waiting", machine_id: null },
                    ...(d.enrollments ?? []).filter((e) => e.id !== t.id),
                  ],
                }));
                void refresh();
              }}
              onWatch={() => {
                setModal(null);
                setPage("Machines");
              }}
              onDeploy={() => open("project")}
            />
          ) : modal === "project" ? (
            <NewProjectFlow
              data={data}
              refresh={refresh}
              live={live}
              onDone={(project, serviceId) => {
                setModal(null);
                openProject(project, serviceId ?? undefined);
              }}
              onCancel={() => setModal(null)}
            />
          ) : (
            <form onSubmit={submit} className="flex flex-col gap-4">
              {modal === "login" && (
                <>
                  {loginFields}
                </>
              )}
              {modal === "service" && (
                <>
                  <p className="text-sm text-muted-foreground">
                    Configure a component of {current?.name}.
                  </p>
                  <ServiceFields data={data} mode="create" />
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
    </ReadinessActions.Provider>
  );
}
function activityStatus(kind: string) {
  const state = kind.split(".").pop() ?? "";
  if (state in statusDot) return state;
  return state === "created" || state === "joined" ? "done" : "idle";
}
function ActivityList({
  data,
}: {
  data: Snapshot;
}) {
  return (
    <div className="flex flex-col">
      {data.activity.map((e) => (
        <div
          key={e.id}
          className="flex items-start gap-3 border-b border-border px-3 py-2.5 last:border-0"
        >
          <StatusDot status={activityStatus(e.kind)} className="mt-1.5" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="text-sm">{e.message}</p>
            <Meta>
              {new Date(e.created_at).toLocaleString()}
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
