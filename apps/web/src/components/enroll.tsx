import { useEffect, useState, type FormEvent } from "react";
import { ArrowRight, Check, Copy, Plus, RefreshCw, Server } from "lucide-react";
import {
  api,
  type Enrollment,
  type Snapshot,
} from "../lib/data";
import { cn } from "../lib/utils";
import { Disclosure, Field, Feedback, useAction } from "./live";
import {
  MACHINE_STATE,
  capabilityLabel,
  capabilityOf,
} from "./readiness";
import { Collecting, Reveal } from "./fleet/primitives";
import { Button } from "./ui/button";
import { Checkbox, Input, Select, Textarea } from "./ui/input";
import { Alert, EmptyState, Eyebrow, Meta, StatusDot } from "./ui/misc";

/** An enrollment token as returned by POST /enrollment-tokens, kept in memory only. */
export type EnrollmentToken = {
  id: string;
  token: string;
  expires_at: string;
  endpoint?: string;
};

const ROLE_COPY: Record<string, { label: string; detail: string }> = {
  compute: { label: "Run applications", detail: "Hosts your services." },
  builder: {
    label: "Build images",
    detail: "Turns your repositories into runnable images.",
  },
  database: { label: "Host databases", detail: "Keeps PostgreSQL data here." },
};

export function installCommand(t: EnrollmentToken): string {
  return `curl -fsSL '${location.origin}/install.sh' | sudo env PC_API='${location.origin}' PC_ENROLL_TOKEN='${t.token}'${t.endpoint ? ` PC_WIREGUARD_ENDPOINT='${t.endpoint}'` : ""} sh`;
}

/** `host:port` or `[ipv6]:port`; the port must be 1..65535. */
export function validEndpoint(value: string): boolean {
  const m = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+):(\d{1,5})$/.exec(value);
  if (!m) return false;
  const port = Number(m[2]);
  return port >= 1 && port <= 65535;
}

function useNow(everyMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

function countdown(iso: string, now: number): string | null {
  const left = Math.floor((Date.parse(iso) - now) / 1000);
  if (left <= 0) return null;
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

export function isWaiting(e: Enrollment, now = Date.now()): boolean {
  return e.status === "waiting" && Date.parse(e.expires_at) > now;
}

async function copyText(value: string) {
  await navigator.clipboard.writeText(value);
}

/**
 * The recommended roles come from the control plane (readiness.recommended_roles);
 * when it does not publish readiness, fall back to "compute + builder unless a
 * machine already has the builder role" — a role default, not a readiness claim.
 */
function recommendedRoles(data: Snapshot): string[] {
  if (data.readiness) return data.readiness.recommended_roles;
  return data.machines.some((m) => m.roles.includes("builder"))
    ? ["compute"]
    : ["compute", "builder"];
}

/**
 * Add-a-machine dialog body. One intent (run apps on a Linux server), the
 * platform requirements stated before the command, roles recommended by the
 * control plane, network/location/tags behind Advanced. After the token is
 * created it stays on the install step and watches the snapshot until the
 * machine checks in and reports what it can do.
 */
export function Enroll({
  data,
  onToken,
  onWatch,
  onDeploy,
}: {
  data: Snapshot;
  onToken: (token: EnrollmentToken) => void;
  /** Close and show the Machines page. */
  onWatch: () => void;
  /** Close and start the deploy flow. */
  onDeploy: () => void;
}) {
  const action = useAction();
  const [current, setCurrent] = useState<EnrollmentToken | null>(null);
  const [copied, setCopied] = useState(false);
  const recommended = recommendedRoles(data);
  const firstServer = !data.machines.some((m) => m.report.private_ip);
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const endpoint = String(form.get("wireguard_endpoint") || "").trim();
    await action.run(async () => {
      if (endpoint && !validEndpoint(endpoint))
        throw new Error(
          "Use a hostname or IP followed by a port, like vps.example.com:51820 or [2001:db8::1]:51820.",
        );
      const roles = form.getAll("roles").map(String);
      if (!roles.length)
        throw new Error("Choose at least one thing this machine may do.");
      // The guided command installs the runtime; the control plane treats a
      // fresh install missing it as "checking" for a while instead of "failed".
      const result = await api<EnrollmentToken>("/enrollment-tokens", {
        location: form.get("location"),
        roles,
        tags: String(form.get("tags") || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        setup_intent: "runtime",
      });
      const token = { ...result, endpoint: endpoint || undefined };
      onToken(token);
      setCurrent(token);
      setCopied(false);
    }, "");
  }
  if (current)
    return (
      <InstallStep
        data={data}
        token={current}
        copied={copied}
        onCopied={() => setCopied(true)}
        onRenew={() => setCurrent(null)}
        onWatch={onWatch}
        onDeploy={onDeploy}
      />
    );
  return (
    <form onSubmit={create} className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Connect a Linux server and it can run your applications. You will get
        one command to run on it.
      </p>
      <div className="gh-surface flex flex-col gap-2 rounded-lg p-3">
        <Eyebrow>Works on</Eyebrow>
        <ul className="flex flex-wrap gap-1.5" aria-label="Supported systems">
          {[
            "Ubuntu 22.04 / 24.04",
            "Debian 12 / 13",
            "x86-64 or ARM64",
            "root or sudo",
          ].map((item) => (
            <li
              key={item}
              className="rounded-sm border border-border bg-muted px-1.5 py-px font-mono text-[10px] text-muted-foreground"
            >
              {item}
            </li>
          ))}
        </ul>
        <Meta>
          The server must reach this address: {location.origin}. Other systems,
          like macOS, cannot run applications here.
        </Meta>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Recommended for this machine</span>
        <ul className="flex flex-col gap-1">
          {recommended.map((role) => (
            <li key={role} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
              <Check className="size-3.5 self-center text-primary" />
              <span className="whitespace-nowrap">{ROLE_COPY[role]?.label ?? role}</span>
              <Meta>{ROLE_COPY[role]?.detail}</Meta>
            </li>
          ))}
        </ul>
        <Meta>
          {data.readiness
            ? recommended.includes("builder")
              ? "No connected machine can build yet, so this one will."
              : "A machine already builds for you; this one only runs apps."
            : "Readiness unavailable; using the default roles. Adjust under Advanced."}
        </Meta>
      </div>
      <Disclosure title="Advanced">
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 text-sm leading-none font-medium">
            What this machine may do
          </legend>
          {Object.entries(ROLE_COPY).map(([role, copy]) => (
            <label key={role} className="flex items-center gap-2 text-sm">
              <Checkbox
                name="roles"
                value={role}
                defaultChecked={recommended.includes(role)}
              />
              {copy.label}
              <Meta>{copy.detail}</Meta>
            </label>
          ))}
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Where it lives">
            <Select name="location" defaultValue="home">
              <option value="home">Home</option>
              <option value="vps">Cloud VPS</option>
              <option value="dedicated">Dedicated server</option>
            </Select>
          </Field>
          <Field label="Tags" name="tags" placeholder="gpu, high-memory" hint="Comma separated." />
        </div>
        <Field
          label="Reachable address (optional)"
          hint={
            firstServer
              ? "Only needed when machines on other networks must reach this one: a public hostname or IP with UDP port 51820 open."
              : "Only needed when machines on other networks must reach this one. A single-network fleet can leave this empty."
          }
        >
          <Input name="wireguard_endpoint" placeholder="vps.example.com:51820" />
        </Field>
      </Disclosure>
      <Feedback action={action} />
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="submit" isLoading={action.busy}>
          {action.busy ? "Preparing…" : "Get the install command"}
          {!action.busy && <ArrowRight />}
        </Button>
      </div>
    </form>
  );
}

function InstallStep({
  data,
  token,
  copied,
  onCopied,
  onRenew,
  onWatch,
  onDeploy,
}: {
  data: Snapshot;
  token: EnrollmentToken;
  copied: boolean;
  onCopied: () => void;
  onRenew: () => void;
  onWatch: () => void;
  onDeploy: () => void;
}) {
  const now = useNow();
  const [copyError, setCopyError] = useState("");
  const command = installCommand(token);
  const enrollment = data.enrollments?.find((e) => e.id === token.id);
  const machine = enrollment?.machine_id
    ? data.machines.find((m) => m.id === enrollment.machine_id)
    : undefined;
  const left = countdown(token.expires_at, now);
  const expired = !machine && !left;
  return (
    <div className="flex flex-col gap-4">
      {machine ? (
        <ConnectedMachine data={data} machineId={machine.id} />
      ) : expired ? (
        <Alert variant="destructive">
          <span className="font-medium">This command expired</span>
          <Meta className="text-destructive/80">
            Commands work for 15 minutes. Generate a new one and run it again.
          </Meta>
        </Alert>
      ) : (
        <div
          role="status"
          className="gh-surface flex flex-wrap items-center gap-3 rounded-lg px-3 py-2.5"
        >
          <StatusDot status="pending" />
          <span className="text-sm font-medium">Waiting for the machine to check in</span>
          <Meta className="ml-auto">command valid {left}</Meta>
        </div>
      )}
      {!machine && !expired && (
        <>
          <ol className="flex flex-col gap-1 text-sm">
            <li className="flex gap-2">
              <Meta className="w-4 text-foreground">1</Meta>
              Open a terminal on the server as root or with sudo.
            </li>
            <li className="flex gap-2">
              <Meta className="w-4 text-foreground">2</Meta>
              Paste the command. It installs the runtime and connects the machine.
            </li>
            <li className="flex gap-2">
              <Meta className="w-4 text-foreground">3</Meta>
              Leave this open. Installing the runtime can take a few minutes;
              the machine appears here as soon as it checks in.
            </li>
          </ol>
          <div className="flex flex-col gap-2">
            <label htmlFor="install-command" className="text-sm font-medium">
              Install command
            </label>
            <Textarea
              id="install-command"
              readOnly
              rows={4}
              value={command}
              onFocus={(e) => e.currentTarget.select()}
              className="font-mono text-xs"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={() =>
                  copyText(command).then(onCopied, () =>
                    setCopyError("Clipboard unavailable. Select the text and copy it."),
                  )
                }
              >
                {copied ? <Check /> : <Copy />}
                {copied ? "Copied" : "Copy command"}
              </Button>
              <Meta>Single use · contains a secret, share it only with your server.</Meta>
            </div>
            {copyError && <Meta className="text-destructive">{copyError}</Meta>}
          </div>
        </>
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {expired ? (
          <Button onClick={onRenew}>
            <RefreshCw />
            New command
          </Button>
        ) : (
          <>
            <Button variant="outline" onClick={onWatch}>
              {machine ? "Open machines" : "Watch on Machines"}
              <ArrowRight />
            </Button>
            {machine && data.readiness?.status === "ready" && (
              <Button onClick={onDeploy}>
                <Plus />
                Deploy from GitHub
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** The finish line: agent connected → runtime ready → ready to deploy, from readiness only. */
function ConnectedMachine({
  data,
  machineId,
}: {
  data: Snapshot;
  machineId: string;
}) {
  const machine = data.machines.find((m) => m.id === machineId);
  const cap = capabilityOf(data, machineId);
  const steps: { label: string; state: "done" | "running" | "failed" | "idle"; detail?: string }[] = [
    { label: `${machine?.report.hostname ?? "Machine"} connected`, state: "done" },
    !cap
      ? { label: "Runtime", state: "idle", detail: "Readiness unavailable" }
      : cap.state === "checking"
        ? { label: "Runtime ready", state: "running", detail: cap.reasons[0] ?? "Checking…" }
        : cap.state === "reporting_only" || cap.state === "offline"
          ? { label: "Runtime ready", state: "failed", detail: cap.reasons[0] }
          : { label: "Runtime ready", state: "done" },
    !cap
      ? { label: "Ready to deploy", state: "idle" }
      : cap.state === "ready"
        ? { label: capabilityLabel(cap), state: "done" }
        : cap.state === "needs_setup"
          ? { label: "Ready to deploy", state: "failed", detail: cap.reasons[0] }
          : { label: "Ready to deploy", state: "idle" },
  ];
  return (
    <div className="gh-surface flex flex-col gap-3 rounded-lg p-3">
      <div className="flex items-center gap-2">
        <StatusDot status={cap ? MACHINE_STATE[cap.state].dot : "idle"} />
        <span className="text-sm font-medium">{machine?.report.hostname}</span>
        <Meta className="ml-auto">{cap ? MACHINE_STATE[cap.state].label : "Readiness unavailable"}</Meta>
      </div>
      <ol className="flex flex-col gap-2">
        {steps.map((step) => (
          <li key={step.label} className="flex items-start gap-3">
            <StatusDot status={step.state === "running" ? "running" : step.state} className="mt-1.5" />
            <div className="flex min-w-0 flex-col">
              <span className={cn("text-sm", step.state === "failed" && "text-destructive", step.state === "idle" && "text-muted-foreground")}>
                {step.label}
              </span>
              {step.detail && <Meta>{step.detail}</Meta>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * A card in the Machines grid for every enrollment still waiting for its
 * machine. Survives refresh through snapshot.enrollments; the command itself
 * is only available in the session that created it.
 */
export function PendingMachineCard({
  enrollment,
  token,
  delay,
  onRevoke,
  onNew,
}: {
  enrollment: Enrollment;
  token: EnrollmentToken | undefined;
  delay: number;
  /** Revoke this unused command (DELETE /enrollment-tokens/:id). */
  onRevoke: () => Promise<void>;
  /** Open the add-machine dialog for a replacement command. */
  onNew: () => void;
}) {
  const now = useNow();
  const action = useAction();
  const [copied, setCopied] = useState(false);
  const left = countdown(enrollment.expires_at, now);
  if (!left) return null;
  return (
    <Reveal as="li" delay={delay} className="min-w-0">
      <article className="gh-surface flex h-full flex-col gap-3 rounded-lg border-dashed p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-[3px] bg-muted text-muted-foreground">
              <Server className="size-4" />
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[15px] font-medium leading-tight">New machine</span>
              <span className="gh-eyebrow font-mono">waiting for check-in</span>
            </div>
          </div>
          <Meta className="shrink-0 tabular-nums">expires in {left}</Meta>
        </div>
        <Collecting className="h-9" hint="run the install command on the server" />
        <Feedback action={action} />
        <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-border pt-3">
          {token ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                copyText(installCommand(token)).then(
                  () => setCopied(true),
                  () => setCopied(false),
                )
              }
            >
              {copied ? <Check /> : <Copy />}
              {copied ? "Copied" : "Copy install command"}
            </Button>
          ) : (
            <>
              <Meta>Command from another session</Meta>
              <Button
                size="sm"
                variant="outline"
                isLoading={action.busy}
                onClick={() => void action.run(async () => {
                  await onRevoke();
                  onNew();
                }, "")}
              >
                New command
              </Button>
            </>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-muted-foreground"
            disabled={action.busy}
            onClick={() => void action.run(onRevoke, "")}
          >
            Cancel
          </Button>
        </div>
      </article>
    </Reveal>
  );
}

export function MachinesEmpty({ onAdd }: { onAdd: () => void }) {
  return (
    <EmptyState
      icon={<Server />}
      title="Connect your first machine"
      description="Run one command on a Linux server. It checks in here once the installer finishes and tells you what it can do."
      action={
        <Button size="sm" onClick={onAdd}>
          <Plus />
          Add a machine
        </Button>
      }
    />
  );
}
