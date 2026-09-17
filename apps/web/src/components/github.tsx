import { hosted } from "../lib/hosted";
import { useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronRight,
  ExternalLink,
  RefreshCw,
} from "lucide-react";
import { api } from "../lib/data";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Alert, Meta, Separator } from "./ui/misc";
import { Feedback, Field, useAction } from "./live";

type Installation = {
  id: number;
  account_login: string;
  account_type: string;
  repository_selection: string;
};
type AppStatus = {
  configured: boolean;
  name: string | null;
  identity: { login: string; user_id: number } | null;
  user_connected: boolean;
  installations: Installation[];
};
export const githubMessages: Record<string, string> = {
  registered:
    "GitHub App registered. Link your GitHub account next to enable sign-in.",
  connected:
    "GitHub identity verified. Choose repositories, or refresh access if the app is already installed.",
  unlinked:
    "GitHub sign-in unlinked and its sessions revoked. Use your owner token to link another account.",
  installed:
    "Repository access connected. You can now select a repository for your project.",
  registration:
    "GitHub App registration did not finish. Return to Settings and try again.",
  wrong_account:
    "That GitHub account is not this workspace’s owner. Use the linked account or your owner recovery token.",
  cancelled: "GitHub authorization was cancelled. Your workspace is unchanged.",
  signin:
    "GitHub sign-in expired or could not be verified. Start again from this browser.",
  installation:
    "Repository access has not been verified yet. An organization owner may need to approve the request. Refresh access after approval.",
};
async function authorize(purpose: "login" | "link") {
  const result = await api<{ url: string }>("/github/auth/start", { purpose });
  window.location.assign(result.url);
}
function GitHubGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className={cn("size-4", className)}
    >
      <path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.7 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3" />
    </svg>
  );
}
/**
 * GitHub's public avatar for a user or organization. Loaded straight from
 * GitHub so it is always their current picture; falls back to the glyph
 * when the account is private, renamed, or offline.
 */
export function GitHubAvatar({
  login,
  size = 32,
  className,
}: {
  login: string;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [login]);
  return (
    <span
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted ring-1 ring-border",
        className,
      )}
      style={{ width: size, height: size }}
    >
      {failed ? (
        <GitHubGlyph className="size-1/2 text-muted-foreground" />
      ) : (
        <img
          src={`https://github.com/${encodeURIComponent(login)}.png?size=${size * 2}`}
          width={size}
          height={size}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="size-full object-cover"
        />
      )}
    </span>
  );
}
const ACCOUNT_KIND = {
  Organization: "Organization",
  User: "Personal",
} as const;
function accountKind(type: string) {
  return type === "Organization" ? ACCOUNT_KIND.Organization : ACCOUNT_KIND.User;
}
function installationUrl(i: Installation) {
  return i.account_type === "Organization"
    ? `https://github.com/organizations/${encodeURIComponent(i.account_login)}/settings/installations/${i.id}`
    : `https://github.com/settings/installations/${i.id}`;
}
export function GitHubSignIn() {
  const [loadFailed, setLoadFailed] = useState(false);
  const [status, setStatus] = useState<{
    enabled: boolean;
    configured: boolean;
  } | null>(null);
  const action = useAction();
  useEffect(() => {
    void api<{ enabled: boolean; configured: boolean }>("/github/auth")
      .then(setStatus)
      .catch(() => setLoadFailed(true));
  }, []);
  return (
    <div className="flex flex-col gap-3">
      {status?.enabled ? (
        <>
          <Button
            variant="outline"
            className="w-full"
            isLoading={action.busy}
            onClick={() => void action.run(() => authorize("login"))}
          >
            {!action.busy && <GitHubGlyph />}
            {action.busy ? "Opening GitHub…" : "Continue with GitHub"}
          </Button>
          <p className="text-xs text-muted-foreground">
            {hosted ? "Sign in or create your account. Repository access is chosen separately." : "Only the GitHub account linked by this workspace’s owner can sign in."}
          </p>
          {!hosted && <div className="flex items-center gap-3">
            <Separator className="flex-1" />
            <span className="gh-eyebrow">or use your owner recovery token</span>
            <Separator className="flex-1" />
          </div>}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          {hosted ? (status ? "GitHub sign-in is being configured by the service operator. Please try again shortly." : loadFailed ? "Sign-in is temporarily unavailable. Refresh this page to retry." : "Checking GitHub sign-in…") : "Use your owner token for the first sign-in. You can enable GitHub sign-in in Settings."}
        </p>
      )}
      <Feedback action={action} />
    </div>
  );
}
export function GitHubAppPanel({
  live,
  refresh,
}: {
  live: boolean;
  refresh: () => Promise<unknown>;
}) {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [organization, setOrganization] = useState("");
  const [available, setAvailable] = useState<Installation[] | null>(null);
  const [chosen, setChosen] = useState<number[]>([]);
  const [recoveryToken, setRecoveryToken] = useState("");
  const [loadError, setLoadError] = useState("");
  const action = useAction();
  async function load() {
    setStatus(await api<AppStatus>("/github/app"));
    setLoadError("");
  }
  useEffect(() => {
    if (live)
      void load().catch(() => setLoadError("Sign in to manage GitHub access."));
  }, [live]);
  async function register() {
    const result = await api<{ action: string; manifest: unknown }>(
      "/github/app/manifest",
      { organization },
    );
    // GitHub's manifest protocol requires a native form POST; no credentials are in it.
    const form = document.createElement("form");
    form.method = "POST";
    form.action = result.action;
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = "manifest";
    input.value = JSON.stringify(result.manifest);
    form.append(input);
    document.body.append(form);
    form.submit();
  }
  const steps: [string, boolean][] = status
    ? [
        ...(!hosted ? [["Register app", status.configured] as [string, boolean]] : []),
        [hosted ? "Signed in" : "Link identity", !!status.identity],
        ["Choose repositories", status.installations.length > 0],
      ]
    : [];
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Sign in with GitHub, then choose the personal and organization
        repositories this cloud can deploy.
      </p>
      {loadError && <Alert variant="destructive">{loadError}</Alert>}
      {!live ? (
        <p className="text-xs text-muted-foreground">
          Connect your live workspace to set up GitHub.
        </p>
      ) : !status ? (
        !loadError && (
          <p className="text-xs text-muted-foreground">
            Checking GitHub connection…
          </p>
        )
      ) : (
        <>
          <ol
            className="flex flex-wrap gap-2"
            aria-label="GitHub setup progress"
          >
            {steps.map(([label, done], i) => (
              <li
                key={label}
                className="gh-surface flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs"
              >
                <span
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-full font-mono text-[11px] tabular-nums",
                    done
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {done ? <Check className="size-3" /> : i + 1}
                </span>
                <span className="truncate">{label}</span>
              </li>
            ))}
          </ol>
          {!status.configured && hosted ? (
            <Alert>Repository access is being configured by the service operator. You can still enroll machines in your workspace.</Alert>
          ) : !status.configured ? (
            <>
              <div className="flex flex-col gap-1">
                <span className="text-[15px] font-medium">
                  A GitHub App for your cloud
                </span>
                <p className="text-xs text-muted-foreground">
                  Create an app owned by your GitHub account or organization.
                  GitHub will ask you to name it. Connection details are saved
                  securely without copying keys.
                </p>
              </div>
              <Field
                label="App owner organization (optional)"
                hint="Requests read access to repository contents and metadata, plus push events. You choose the repositories during installation."
              >
                <Input
                  value={organization}
                  onChange={(e) => setOrganization(e.target.value)}
                  placeholder="Leave blank for your personal account"
                  autoComplete="off"
                />
              </Field>
              <Button
                size="sm"
                className="self-start"
                isLoading={action.busy}
                onClick={() => void action.run(register)}
              >
                {!action.busy && <GitHubGlyph />}
                Register GitHub App
                <ArrowRight />
              </Button>
            </>
          ) : (
            <>
              <div className="gh-surface relative flex items-center gap-3 overflow-hidden rounded-lg px-3 py-3">
                {status.identity ? (
                  <GitHubAvatar login={status.identity.login} size={40} className="ring-2 ring-primary/40" />
                ) : (
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted">
                    <GitHubGlyph className="size-5 text-muted-foreground" />
                  </span>
                )}
                <div className="flex min-w-0 flex-col">
                  <span className="flex items-center gap-1.5 truncate text-sm font-medium">
                    {status.identity ? (
                      <a
                        href={`https://github.com/${encodeURIComponent(status.identity.login)}`}
                        target="_blank"
                        rel="noreferrer"
                        className="truncate hover:underline"
                      >
                        {status.identity.login}
                      </a>
                    ) : (
                      status.name || "GitHub App registered"
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {status.identity
                      ? (hosted ? "Your GitHub account" : "Linked workspace owner")
                      : "Link the account you’ll use to sign in"}
                  </span>
                </div>
                <span className="ml-auto flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      status.user_connected
                        ? "bg-primary shadow-[0_0_6px_var(--color-primary)]"
                        : "bg-muted-foreground/50",
                    )}
                  />
                  {status.user_connected
                    ? "linked"
                    : status.identity
                      ? "reconnect"
                      : "not linked"}
                </span>
              </div>
              {!status.identity || !status.user_connected ? (
                <>
                  {status.identity && (
                    <p className="text-xs text-muted-foreground">
                      Reconnect @{status.identity.login} to refresh your
                      repository access.
                    </p>
                  )}
                  <Button
                    size="sm"
                    className="self-start"
                    isLoading={action.busy}
                    onClick={() => void action.run(() => authorize("link"))}
                  >
                    {!action.busy && <GitHubGlyph />}
                    {status.identity
                      ? "Reconnect GitHub"
                      : "Link my GitHub account"}
                  </Button>
                </>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(async () => {
                          const r = await api<{ url: string }>(
                            "/github/app/install",
                            {},
                          );
                          window.location.assign(r.url);
                        })
                      }
                    >
                      Choose repositories
                      <ExternalLink />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(async () => {
                          const result = await api<{ available_installations?: Installation[] }>("/github/app/sync", {});
                          if (hosted && result.available_installations) {
                            setAvailable(result.available_installations);
                            setChosen(result.available_installations.filter(i => status.installations.some(current => current.id === i.id)).map(i => i.id));
                          }
                          await load();
                          await refresh();
                        }, "Repository access refreshed")
                      }
                    >
                      <RefreshCw />
                      Refresh access
                    </Button>
                  </div>
                  {status.installations.length === 0 && (
                    <Alert>
                      No repository accounts connected yet. Install the app on
                      your personal account or an organization, then select the
                      repositories to deploy.
                    </Alert>
                  )}
                </>
              )}
              {hosted && available && <section className="flex flex-col gap-3 rounded-lg border border-border p-3" aria-label="Repository accounts for this workspace">
                <div className="flex flex-col gap-1">
                  <h3 className="text-sm font-medium">Repository accounts for this workspace</h3>
                  <p className="text-xs text-muted-foreground">Choose existing GitHub App installations to connect here. Access in your other workspaces stays unchanged.</p>
                </div>
                {available.length === 0 ? <p className="text-xs text-muted-foreground">No available installations. Use Choose repositories to install the app on your account or organization.</p> : available.map(installation => <label key={installation.id} className="gh-interactive flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-sm">
                  <input type="checkbox" className="size-4 shrink-0 accent-primary" checked={chosen.includes(installation.id)} disabled={action.busy}
                    onChange={event => setChosen(current => event.target.checked ? [...current, installation.id] : current.filter(id => id !== installation.id))} />
                  <GitHubAvatar login={installation.account_login} size={24} />
                  <span className="min-w-0 truncate font-medium">{installation.account_login}</span>
                  <Meta>{accountKind(installation.account_type)}</Meta>
                </label>)}
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={action.busy || available.length === 0} onClick={() => {
                    if (!chosen.length && !window.confirm("Remove your repository account grants from this workspace? Existing applications keep running; new source deployments may need repository access restored.")) return;
                    void action.run(async () => {
                      await api("/github/app/sync", {installation_ids: chosen});
                      await load(); await refresh(); setAvailable(null);
                    }, "Workspace repository accounts saved");
                  }}>Save workspace access</Button>
                  <Button size="sm" variant="ghost" disabled={action.busy} onClick={() => setAvailable(null)}>Cancel</Button>
                </div>
              </section>}
              {status.installations.length > 0 && (
                <ul
                  className="gh-surface divide-y divide-border overflow-hidden rounded-lg"
                  aria-label="Connected GitHub accounts"
                >
                  {status.installations.map((i) => (
                    <li key={i.id}>
                      <a
                        href={installationUrl(i)}
                        target="_blank"
                        rel="noreferrer"
                        className="gh-interactive group flex items-center gap-3 px-3 py-2.5"
                      >
                        <GitHubAvatar login={i.account_login} size={32} />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-sm font-medium">{i.account_login}</span>
                          <span className="truncate font-mono text-[11px] text-muted-foreground">
                            {accountKind(i.account_type)}
                            {" · "}
                            {i.repository_selection === "all" ? "all repositories" : "selected repositories"}
                          </span>
                        </span>
                        <span className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground transition-colors group-hover:text-foreground">
                          manage
                          <ExternalLink className="size-3" />
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-muted-foreground">
                Organization access may require an owner’s approval. After
                approval or changes in GitHub, use Refresh access. Installing
                the app does not give organization members access to this
                workspace.
              </p>
              {!hosted && <details className="group rounded-lg border border-border">
                <summary className="gh-interactive flex cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium select-none [&::-webkit-details-marker]:hidden">
                  <ChevronRight className="size-4 text-muted-foreground transition-transform group-open:rotate-90" />
                  Owner recovery and reconnection
                </summary>
                <div className="flex flex-col gap-4 border-t border-border p-4">
                  <Button
                    size="sm"
                    variant="outline"
                    className="self-start"
                    disabled={action.busy}
                    onClick={() => void action.run(() => authorize("link"))}
                  >
                    Reconnect GitHub
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    Keep PC_ADMIN_TOKEN from .env.production safe. It can sign
                    in if GitHub is unavailable. Changing the linked GitHub
                    owner requires that recovery token; repository permissions
                    are managed in GitHub.
                  </p>
                  {status.identity && (
                    <>
                      <Field label="Owner recovery token">
                        <Input
                          type="password"
                          value={recoveryToken}
                          onChange={(e) => setRecoveryToken(e.target.value)}
                          autoComplete="off"
                          placeholder="PC_ADMIN_TOKEN"
                        />
                      </Field>
                      <Button
                        size="sm"
                        variant="destructive"
                        className="self-start"
                        disabled={action.busy || recoveryToken.length < 32}
                        onClick={() => {
                          if (
                            !window.confirm(
                              "Unlink GitHub sign-in and revoke GitHub browser sessions? Running apps stay online. Repository deployment access must be connected again.",
                            )
                          )
                            return;
                          void action.run(async () => {
                            const token = recoveryToken;
                            setRecoveryToken("");
                            const response = await fetch(
                              "/api/github/app/identity",
                              {
                                method: "DELETE",
                                headers: { Authorization: `Bearer ${token}` },
                              },
                            );
                            if (!response.ok) {
                              const r = await response.json();
                              throw new Error(
                                r.error || "Could not unlink GitHub",
                              );
                            }
                            window.location.assign(
                              "/#page=Settings&github=unlinked",
                            );
                          });
                        }}
                      >
                        Unlink GitHub sign-in
                      </Button>
                    </>
                  )}
                </div>
              </details>}
            </>
          )}
        </>
      )}
      <Feedback action={action} />
    </div>
  );
}
