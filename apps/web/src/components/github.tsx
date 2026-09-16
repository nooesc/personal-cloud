import { useEffect, useState } from "react";
import {
  GitBranch,
  ExternalLink,
  Check,
  RefreshCw,
  ArrowRight,
} from "lucide-react";
import { api } from "../lib/data";
import { Feedback, useAction } from "./live";

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
export function GitHubSignIn() {
  const [status, setStatus] = useState<{
    enabled: boolean;
    configured: boolean;
  } | null>(null);
  const action = useAction();
  useEffect(() => {
    void api<{ enabled: boolean; configured: boolean }>("/github/auth")
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);
  return (
    <div className="github-signin">
      {status?.enabled ? (
        <>
          <button
            type="button"
            className="button primary full"
            disabled={action.busy}
            onClick={() => void action.run(() => authorize("login"))}
          >
            <GitBranch size={18} />{" "}
            {action.busy ? "Opening GitHub…" : "Sign in with GitHub"}
          </button>
          <p className="form-note">
            Only the GitHub account linked by this workspace’s owner can sign
            in.
          </p>
          <div className="signin-divider">
            <span>or use your owner recovery token</span>
          </div>
        </>
      ) : (
        <p className="dialog-intro">
          Use your owner token for the first sign-in. You can enable GitHub
          sign-in in Settings.
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
  return (
    <div className="github-access">
      <p>
        Sign in with GitHub, then choose the personal and organization
        repositories this cloud can deploy.
      </p>
      {loadError && (
        <div className="form-error" role="alert">
          {loadError}
        </div>
      )}
      {!live ? (
        <p className="form-note">
          Connect your live workspace to set up GitHub.
        </p>
      ) : !status ? (
        <p className="form-note">
          {loadError ? "" : "Checking GitHub connection…"}
        </p>
      ) : (
        <>
          <ol className="github-steps" aria-label="GitHub setup progress">
            {[
              ["Register app", status.configured],
              ["Link identity", !!status.identity],
              ["Choose repositories", status.installations.length > 0],
            ].map(([label, done], i) => (
              <li key={String(label)} className={done ? "complete" : ""}>
                <b>{done ? <Check size={13} /> : i + 1}</b>
                {label}
              </li>
            ))}
          </ol>
          {!status.configured ? (
            <>
              <h3>A GitHub App for your cloud</h3>
              <p className="form-note">
                Create an app owned by your GitHub account or organization.
                GitHub will ask you to name it. Connection details are saved
                securely without copying keys.
              </p>
              <label className="field">
                App owner organization <span className="muted">(optional)</span>
                <input
                  value={organization}
                  onChange={(e) => setOrganization(e.target.value)}
                  placeholder="Leave blank for your personal account"
                  autoComplete="off"
                />
              </label>
              <p className="form-note">
                Requests read access to repository contents and metadata, plus
                push events. You choose the repositories during installation.
              </p>
              <button
                className="button primary"
                disabled={action.busy}
                onClick={() => void action.run(register)}
              >
                <GitBranch size={16} /> Register GitHub App{" "}
                <ArrowRight size={15} />
              </button>
            </>
          ) : (
            <>
              <div className="github-identity">
                <GitBranch size={23} />
                <div>
                  <strong>
                    {status.identity
                      ? `@${status.identity.login}`
                      : status.name || "GitHub App registered"}
                  </strong>
                  <p className="form-note">
                    {status.identity
                      ? "Linked workspace owner"
                      : "Link the account you’ll use to sign in"}
                  </p>
                </div>
              </div>
              {!status.identity || !status.user_connected ? (
                <>
                  {status.identity && (
                    <p className="form-note">
                      Reconnect @{status.identity.login} to refresh your
                      repository access.
                    </p>
                  )}
                  <button
                    className="button primary"
                    disabled={action.busy}
                    onClick={() => void action.run(() => authorize("link"))}
                  >
                    <GitBranch size={16} />
                    {status.identity
                      ? "Reconnect GitHub"
                      : "Link my GitHub account"}
                  </button>
                </>
              ) : (
                <>
                  <div className="action-row">
                    <button
                      className="button primary"
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
                      Choose repositories <ExternalLink size={14} />
                    </button>
                    <button
                      className="button secondary"
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(async () => {
                          await api("/github/app/sync", {});
                          await load();
                          await refresh();
                        }, "Repository access refreshed")
                      }
                    >
                      <RefreshCw size={14} /> Refresh access
                    </button>
                  </div>
                  {status.installations.length === 0 && (
                    <div className="info-callout">
                      <span>
                        No repository accounts connected yet. Install the app on
                        your personal account or an organization, then select
                        the repositories to deploy.
                      </span>
                    </div>
                  )}
                </>
              )}
              {status.installations.length > 0 && (
                <div
                  className="github-accounts"
                  aria-label="Connected GitHub accounts"
                >
                  {status.installations.map((i) => (
                    <div className="github-account" key={i.id}>
                      <div>
                        <strong>{i.account_login}</strong>
                        <p className="form-note">
                          {i.account_type === "Organization"
                            ? "Organization"
                            : "Personal account"}{" "}
                          ·{" "}
                          {i.repository_selection === "all"
                            ? "All repositories"
                            : "Selected repositories"}
                        </p>
                      </div>
                      <a
                        className="button secondary small"
                        href={
                          i.account_type === "Organization"
                            ? `https://github.com/organizations/${encodeURIComponent(i.account_login)}/settings/installations/${i.id}`
                            : `https://github.com/settings/installations/${i.id}`
                        }
                        target="_blank"
                        rel="noreferrer"
                      >
                        Manage <ExternalLink size={13} />
                      </a>
                    </div>
                  ))}
                </div>
              )}
              <p className="form-note">
                Organization access may require an owner’s approval. After
                approval or changes in GitHub, use Refresh access. Installing
                the app does not give organization members access to this
                workspace.
              </p>
              <details>
                <summary>Owner recovery and reconnection</summary>
                <button
                  className="button secondary small"
                  disabled={action.busy}
                  onClick={() => void action.run(() => authorize("link"))}
                >
                  Reconnect GitHub
                </button>
                <p className="form-note">
                  Keep PC_ADMIN_TOKEN from .env.production safe. It can sign in
                  if GitHub is unavailable. Changing the linked GitHub owner
                  requires that recovery token; repository permissions are
                  managed in GitHub.
                </p>
                {status.identity && (
                  <>
                    <label className="field">
                      Owner recovery token
                      <input
                        type="password"
                        value={recoveryToken}
                        onChange={(e) => setRecoveryToken(e.target.value)}
                        autoComplete="off"
                        placeholder="PC_ADMIN_TOKEN"
                      />
                    </label>
                    <button
                      className="button secondary small"
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
                    </button>
                  </>
                )}
              </details>
            </>
          )}
        </>
      )}
      <Feedback action={action} />
    </div>
  );
}
