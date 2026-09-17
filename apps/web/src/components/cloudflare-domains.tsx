import { useEffect, useState } from "react";
import { ExternalLink, Globe } from "lucide-react";
import { api, type CloudflareOverview, type Snapshot } from "../lib/data";
import { Alert, Meta } from "./ui/misc";
import { Button } from "./ui/button";

/** Provider-owned routing, never exposed through Dinghy's managed-domain mutations. */
export function CloudflareDomains({
  data,
  projectId,
}: {
  data: Snapshot;
  projectId?: string;
}) {
  const [overview, setOverview] = useState<CloudflareOverview>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setOverview(undefined);
    setError("");
    api<CloudflareOverview>("/integrations/cloudflare/overview").then(
      (value) => {
        if (!cancelled) setOverview(value);
      },
      (reason) => {
        if (!cancelled)
          setError(
            reason instanceof Error
              ? reason.message
              : "Cloudflare domains could not be loaded.",
          );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, attempt]);
  const links = (data.project_resources ?? []).filter(
    (r) =>
      !r.ignored && r.project_id && (!projectId || r.project_id === projectId),
  );
  const connected =
    overview &&
    overview.status !== "not_connected" &&
    overview.status !== "error";
  const domains = connected
    ? (overview.domains ?? []).flatMap((d) => {
        // Named Wrangler environments are separate scripts. Never infer ownership by prefix.
        const link = links.find(
          (r) =>
            r.account_id === overview.account_id &&
            r.kind === d.kind &&
            r.name === d.name &&
            d.environment === "production",
        );
        return link
          ? [{ ...d, projectId: link.project_id, label: link.environment }]
          : [];
      })
    : [];
  // Each address source reports its own failure; a partial list stays honest
  // only when the missing source is named next to it.
  const sourceIssues = connected
    ? overview.issues.filter((i) => /^(Custom domains|workers\.dev|Pages):/.test(i))
    : [];
  const issue =
    error ||
    (!overview
      ? ""
      : !connected
        ? "Connect Cloudflare to read existing domains."
        : overview.domains == null
          ? (sourceIssues[0] ??
            "Addresses are unavailable. Refresh or check your Cloudflare token’s Workers and Pages read permissions.")
          : sourceIssues.length
            ? sourceIssues.join(" ")
            : links.some((r) => r.account_id !== overview.account_id)
              ? "Some resources belong to a different Cloudflare account; their domains are unavailable."
              : "");
  return (
    <section
      className="flex flex-col gap-3"
      aria-label="Existing Cloudflare domains"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Existing Cloudflare domains</h3>
          <p className="text-sm text-muted-foreground">
            Custom domains, workers.dev routes and Pages domains already attached
            to your resources. Routing is managed in Cloudflare.
          </p>
        </div>
        <Button
          size="xs"
          variant="outline"
          onClick={() => setAttempt((n) => n + 1)}
        >
          Refresh domains
        </Button>
      </div>
      {issue && <Alert>{issue}</Alert>}
      {!overview && !error && (
        <Meta>Reading existing domains from Cloudflare…</Meta>
      )}
      {domains.map((d) => (
        <div
          key={`${d.name}:${d.hostname}`}
          className="flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-3"
        >
          <Globe className="size-4 shrink-0 text-muted-foreground" />
          <a
            href={`https://${d.hostname}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-w-0 items-center gap-1 break-all text-sm font-medium hover:underline"
          >
            {d.hostname}
            <ExternalLink className="size-3 shrink-0" />
          </a>
          <Meta>
            {d.name} · {d.label}
          </Meta>
          <span className="ml-auto text-xs text-muted-foreground">
            Managed in Cloudflare
          </span>
        </div>
      ))}
      {connected && overview.domains != null && !domains.length && !issue && (
        <p className="text-sm text-muted-foreground">
          No addresses reported for the resources linked here.
        </p>
      )}
    </section>
  );
}
