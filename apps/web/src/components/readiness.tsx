import { createContext, useContext, type ReactNode } from "react";
import { ArrowRight, Check, RefreshCw } from "lucide-react";
import type {
  Blocker,
  MachineCapability,
  MachineState,
  Readiness,
  ReadinessAction,
  Snapshot,
} from "../lib/data";
import { providerStatus } from "../lib/data";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Meta, StatusDot } from "./ui/misc";

/**
 * Readiness is computed by the control plane only (snapshot.readiness). This
 * module renders it; it never derives "can deploy" from machines or statuses
 * itself, so every surface agrees with the deploy gate.
 */

export type ReadinessHandlers = Record<ReadinessAction, () => void>;
/** The shell provides the contextual fix for each blocker action. */
export const ReadinessActions = createContext<ReadinessHandlers | null>(null);

export const ACTION_LABEL: Record<ReadinessAction, string> = {
  connect_github: "Choose repositories",
  add_machine: "Add a machine",
  configure_runtime: "Set up the runtime",
  check_machine: "Check machines",
  retry: "Check again",
};

export const MACHINE_STATE: Record<
  MachineState,
  { label: string; dot: string; short: string }
> = {
  apple_ready: { label: "Ready for Apple jobs", short: "Apple ready", dot: "healthy" },
  ready: { label: "Ready to deploy", short: "ready", dot: "healthy" },
  checking: { label: "Checking", short: "checking", dot: "pending" },
  needs_setup: { label: "Needs setup", short: "needs setup", dot: "degraded" },
  reporting_only: {
    label: "Monitoring only",
    short: "monitoring",
    dot: "idle",
  },
  offline: { label: "Offline", short: "offline", dot: "offline" },
};

export type ReadinessStatus = Readiness["status"] | "unavailable";

export function capabilityOf(
  data: Snapshot,
  machineId: string,
): MachineCapability | undefined {
  return data.readiness?.machines.find((m) => m.machine_id === machineId);
}

/** What a machine can do, in words a user can act on. */
export function capabilityLabel(c: MachineCapability | undefined): string {
  if (!c) return "Readiness unavailable";
  if (c.state !== "ready") return MACHINE_STATE[c.state].label;
  const can = [
    c.can_run && "run apps",
    c.can_build && "build",
    c.can_database && "host databases",
  ].filter(Boolean);
  return can.length ? `Ready · ${can.join(" · ")}` : "Ready";
}

export function summarize(readiness: Readiness | undefined): {
  status: ReadinessStatus;
  headline: string;
  detail: string;
} {
  if (!readiness)
    return {
      status: "unavailable",
      headline: "Readiness unavailable",
      detail:
        "This control plane does not report deployment readiness. Deploy to find out.",
    };
  const { counts } = readiness;
  const fleet =
    counts.connected === 0
      ? "No machines connected"
      : `${counts.ready_to_run} of ${counts.connected} connected machine${counts.connected === 1 ? "" : "s"} can run apps`;
  if (readiness.status === "ready")
    return { status: "ready", headline: "Ready to deploy", detail: fleet };
  if (readiness.status === "checking")
    return {
      status: "checking",
      headline: "Checking your fleet",
      detail: readiness.blockers[0]?.message ?? fleet,
    };
  const n = readiness.blockers.length;
  return {
    status: "blocked",
    headline:
      n === 1 ? "One thing before you deploy" : `${n} things before you deploy`,
    detail: fleet,
  };
}
/** "checked 12s ago", or "not yet checked" before the first observation. */
export function checkedLabel(iso: string | null, now = Date.now()): string {
  if (!iso) return "not yet checked";
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (seconds < 5) return "checked just now";
  if (seconds < 60) return `checked ${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `checked ${Math.floor(seconds / 60)}m ago`;
  return `checked ${Math.floor(seconds / 3600)}h ago`;
}

const badgeVariant: Record<ReadinessStatus, "green" | "yellow" | "red" | "blank"> =
  { ready: "green", checking: "yellow", blocked: "red", unavailable: "blank" };
const badgeText: Record<ReadinessStatus, string> = {
  ready: "ready to deploy",
  checking: "checking",
  blocked: "not ready",
  unavailable: "readiness unavailable",
};

export function ReadinessBadge({
  readiness,
  className,
}: {
  readiness: Readiness | undefined;
  className?: string;
}) {
  const status = readiness?.status ?? "unavailable";
  return (
    <Badge variant={badgeVariant[status]} className={className}>
      {badgeText[status]}
    </Badge>
  );
}

export function BlockerAction({
  blocker,
  size = "xs",
  variant = "outline",
}: {
  blocker: Blocker;
  size?: "xs" | "sm";
  variant?: "outline" | "default";
}) {
  const handlers = useContext(ReadinessActions);
  if (!handlers) return null;
  return (
    <Button
      size={size}
      variant={variant}
      onClick={() => handlers[blocker.action]()}
    >
      {blocker.action === "retry" && <RefreshCw />}
      {ACTION_LABEL[blocker.action]}
      {blocker.action !== "retry" && <ArrowRight />}
    </Button>
  );
}

/** Blockers as rows: the plain-language reason and the one action that fixes it. */
export function BlockerList({
  blockers,
  className,
}: {
  blockers: Blocker[];
  className?: string;
}) {
  if (!blockers.length) return null;
  return (
    <ol className={cn("flex flex-col gap-2", className)}>
      {blockers.map((b) => (
        <li
          key={b.code}
          className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-border px-3 py-2"
        >
          <StatusDot
            status={b.action === "retry" ? "pending" : "degraded"}
            className="shrink-0"
          />
          <span className="min-w-40 flex-1 text-sm">{b.message}</span>
          <BlockerAction blocker={b} />
        </li>
      ))}
    </ol>
  );
}

/**
 * The one readiness statement every surface shares: status dot, headline,
 * fleet counts, then the blockers with their fixes. `compact` drops the
 * blocker rows (the badge and headline still tell the truth).
 */
export function ReadinessSummary({
  readiness,
  compact,
  className,
  children,
}: {
  readiness: Readiness | undefined;
  compact?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const handlers = useContext(ReadinessActions);
  const s = summarize(readiness);
  const dot =
    s.status === "ready"
      ? "healthy"
      : s.status === "checking"
        ? "pending"
        : s.status === "blocked"
          ? "degraded"
          : "idle";
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StatusDot status={dot} />
        <span className="text-sm font-medium">{s.headline}</span>
        <Meta>{s.detail}</Meta>
        {readiness && (
          <Meta className="ml-auto flex items-center gap-1.5">
            {checkedLabel(readiness.checked_at)}
            {handlers && (
              <button
                type="button"
                onClick={handlers.retry}
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                <RefreshCw className="size-3" />
                recheck
              </button>
            )}
          </Meta>
        )}
      </div>
      {!compact && readiness && <BlockerList blockers={readiness.blockers} />}
      {children}
    </div>
  );
}

/**
 * For forms whose result cannot deploy yet. Never blocks saving; it says what
 * deploying will need and offers the fix in place.
 */
export function ReadinessGate({
  readiness,
  intent = "Deploying",
}: {
  readiness: Readiness | undefined;
  intent?: string;
}) {
  if (!readiness || readiness.status === "ready") return null;
  return (
    <div
      role="status"
      className="flex flex-col gap-2 rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-3"
    >
      <span className="text-sm">
        {readiness.status === "checking"
          ? `${intent} will wait while we check your fleet.`
          : `You can save this now. ${intent} needs:`}
      </span>
      <BlockerList blockers={readiness.blockers} />
    </div>
  );
}

/* ----------------------------------------------------------------------- */

export type SetupStep = {
  key: "github" | "cloudflare" | "machine" | "deploy";
  label: string;
  detail: string;
  done: boolean;
  note?: string;
  /** Blocker actions that belong to this step; their rows render inside it. */
  actions: ReadinessAction[];
  cta: string;
  go: () => void;
};

/**
 * The path to a first deployment. One derivation for the Overview hero and
 * the Settings checklist: GitHub access, a machine that can run apps, then the
 * deploy. Self-hosted control planes add their Cloudflare step.
 */
export function setupSteps(
  data: Snapshot,
  nav: {
    hosted: boolean;
    onAddMachine: () => void;
    onNewProject: () => void;
    onNavigate: (page: "Settings") => void;
  },
  handlers: ReadinessHandlers | null,
): SetupStep[] {
  const counts = data.readiness?.counts;
  return [
    {
      key: "github",
      label: "GitHub repositories",
      detail: "Choose the repositories this cloud may deploy.",
      done: providerStatus(data.integrations.github) === "connected",
      actions: ["connect_github"],
      cta: "Choose repositories",
      go: () => (handlers ? handlers.connect_github() : nav.onNavigate("Settings")),
    },
    ...(nav.hosted
      ? []
      : [
          {
            key: "cloudflare" as const,
            label: "Cloudflare",
            detail: "Public addresses, tunnel and image storage.",
            done: providerStatus(data.integrations.cloudflare) === "connected",
            actions: [],
            cta: "Connect Cloudflare",
            go: () => nav.onNavigate("Settings"),
          },
        ]),
    {
      key: "machine",
      label: "A machine that can run apps",
      detail: "A Linux server you own or rent, connected with one command.",
      done: (counts?.ready_to_run ?? 0) > 0,
      note: counts ? undefined : "readiness unavailable",
      actions: ["add_machine", "check_machine", "configure_runtime", "retry"],
      cta: "Add a machine",
      go: nav.onAddMachine,
    },
    {
      key: "deploy",
      label: "First deployment",
      detail: "Pick a repository; it builds and runs on your machine.",
      done: data.services.some((s) => s.status === "healthy"),
      actions: [],
      cta: "Deploy from GitHub",
      go: nav.onNewProject,
    },
  ];
}

/**
 * The hero form of the setup path: every step on its own row, the current
 * step opened with its blockers (and their fixes) or its one call to action.
 */
export function SetupPath({
  steps,
  readiness,
  className,
}: {
  steps: SetupStep[];
  readiness: Readiness | undefined;
  className?: string;
}) {
  const handlers = useContext(ReadinessActions);
  const current = steps.find((s) => !s.done);
  return (
    <ol className={cn("flex flex-col gap-2", className)}>
      {steps.map((step, i) => {
        const active = step === current;
        const blockers =
          readiness?.blockers.filter((b) => step.actions.includes(b.action)) ?? [];
        const checking =
          active && step.key === "machine" && readiness?.status === "checking";
        return (
          <li
            key={step.key}
            aria-current={active ? "step" : undefined}
            className={cn(
              "flex flex-col gap-3 rounded-lg border px-4 py-3 transition-colors",
              active
                ? "border-primary/40 bg-primary/5"
                : "border-border bg-background/40",
              !active && !step.done && "opacity-60",
            )}
          >
            <div className="flex items-start gap-3">
              <span
                className={cn(
                  "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full font-mono text-[11px] tabular-nums",
                  step.done
                    ? "bg-primary text-primary-foreground"
                    : active
                      ? "bg-primary/15 text-primary ring-1 ring-primary/40"
                      : "bg-muted text-muted-foreground",
                )}
              >
                {step.done ? <Check className="size-3" /> : i + 1}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium">{step.label}</span>
                <Meta>{step.done ? "Done" : step.detail}</Meta>
                {step.note && !step.done && <Meta>{step.note}</Meta>}
              </div>
              {active && !blockers.length && !checking && (
                <Button size="sm" onClick={step.go} className="shrink-0">
                  {step.cta}
                  <ArrowRight />
                </Button>
              )}
            </div>
            {active && checking && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-8">
                <StatusDot status="pending" />
                <span className="text-sm">Checking your fleet</span>
                {readiness && (
                  <Meta className="flex items-center gap-1.5">
                    {checkedLabel(readiness.checked_at)}
                    {handlers && (
                      <button
                        type="button"
                        onClick={handlers.retry}
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                      >
                        <RefreshCw className="size-3" />
                        recheck
                      </button>
                    )}
                  </Meta>
                )}
              </div>
            )}
            {active && blockers.length > 0 && (
              <BlockerList blockers={blockers} className="pl-8" />
            )}
          </li>
        );
      })}
    </ol>
  );
}
