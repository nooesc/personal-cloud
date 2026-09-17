import { organize, withOrganization } from "./project-organization";
import {
  body,
  fail,
  id,
  json,
  requireUser,
  text,
  type Doc,
  type WorkspaceContext,
} from "./core";

const CONNECTION = "cloudflare-overview-account";
const CACHE = "cloudflare-overview";
const CACHE_SCHEMA = 4;
/** Per-resource checks (workers.dev route, versions, Pages deployments) are one request each; beyond this the rest are reported unchecked. */
const RESOURCE_CHECKS = 200;
const RESOURCE_CONCURRENCY = 8;
/** Hourly request buckets on each Worker and the deployment window on every resource. */
const SERIES_HOURS = 24;
const CHANGES_DAYS = 14;
const TTL = 60_000;
type Credentials = { account_id: string; token: string };
const blank = () => ({
  status: "not_connected",
  account_id: null,
  checked_at: null,
  window: null,
  workers: [],
  pages: [],
  domains: null,
  issues: [],
});
const stamp = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : null;
const validHostname = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 253 &&
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(
    value,
  );
const metric = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;

// Provider errors can include request details: never forward their bodies or credentials.
async function provider(
  credentials: Credentials,
  path: string,
  payload?: unknown,
  deadline?: AbortSignal,
): Promise<Doc> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method: payload ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${credentials.token}`,
      "Content-Type": "application/json",
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
    signal: deadline
      ? AbortSignal.any([deadline, AbortSignal.timeout(12_000)])
      : AbortSignal.timeout(12_000),
    // workerd supports only manual/follow; reject redirects via the status check below.
    redirect: "manual",
  });
  if (!response.ok)
    throw new Error(
      response.status === 401 || response.status === 403
        ? "Access denied. Check the token's account and read permissions."
        : response.status === 429
          ? "Cloudflare rate limit reached. Try again in a minute."
          : `Cloudflare returned HTTP ${response.status}.`,
    );
  const result = (await response.json()) as Doc;
  if (result.success === false || result.errors?.length)
    throw new Error(
      "Cloudflare could not read this data. Check token permissions.",
    );
  return result;
}
const problem = (label: string, error: unknown) =>
  `${label}: ${error instanceof Error && /^(Access denied|Cloudflare)/.test(error.message) ? error.message : "Temporarily unavailable. Try again shortly."}`;

export async function fetchCloudflareOverview(
  credentials: Credentials,
): Promise<Doc> {
  const deadline = AbortSignal.timeout(25_000);
  const end = new Date(),
    start = new Date(end.getTime() - 86400_000);
  const account = credentials.account_id.toLowerCase();
  const base = `/accounts/${account}`;
  const dashboard = `https://dash.cloudflare.com/${account}`;
  const result: Doc = {
    ...blank(),
    account_id: account,
    checked_at: end.toISOString(),
    window: { start: start.toISOString(), end: end.toISOString() },
  };
  let readable = 0;
  // Domains come from three provider sources; the list is null only when none answered.
  const domains: Doc[] = [];
  let domainsRead = false;
  await Promise.all([
    (async () => {
      try {
        const response = await provider(
          credentials,
          `${base}/workers/domains`,
          undefined,
          deadline,
        );
        if (!Array.isArray(response.result))
          throw new Error("Cloudflare returned an invalid domains response.");
        for (const d of response.result) {
          if (
            typeof d.service !== "string" ||
            !validHostname(d.hostname) ||
            typeof d.environment !== "string"
          )
            throw new Error(
              "Cloudflare returned incomplete domain associations.",
            );
          domains.push({
            kind: "worker",
            name: d.service,
            hostname: d.hostname.toLowerCase(),
            environment: d.environment,
          });
        }
        domainsRead = true;
      } catch (error) {
        result.issues.push(problem("Custom domains", error));
      }
    })(),
    (async () => {
      try {
        const response = await provider(
          credentials,
          `${base}/workers/scripts`,
          undefined,
          deadline,
        );
        if (!Array.isArray(response.result))
          throw new Error("Cloudflare returned an invalid Workers response.");
        readable++;
        result.workers = response.result
          .filter((w: Doc) => typeof w.id === "string")
          .slice(0, 1000)
          .map((w: Doc) => ({
            name: w.id,
            modified_at: stamp(w.modified_on),
            dashboard_url: `${dashboard}/workers/services/view/${encodeURIComponent(w.id)}/production`,
            requests: null,
            errors: null,
            subrequests: null,
            series: null,
            changes: null,
          }));
        if (response.result.length > 1000)
          result.issues.push("Workers: Showing the first 1,000 scripts.");
      } catch (error) {
        result.issues.push(problem("Workers", error));
      }
    })(),
    (async () => {
      try {
        for (let page = 1; page <= 10; page++) {
          const response = await provider(
            credentials,
            `${base}/pages/projects?per_page=10&page=${page}`,
            undefined,
            deadline,
          );
          if (!Array.isArray(response.result))
            throw new Error("Cloudflare returned an invalid Pages response.");
          if (page === 1) {
            readable++;
            domainsRead = true;
          }
          for (const p of response.result) {
            if (typeof p.name !== "string") continue;
            const deployment = p.canonical_deployment;
            result.pages.push({
              name: p.name,
              url:
                typeof p.subdomain === "string" &&
                /^[a-z0-9.-]+\.pages\.dev$/i.test(p.subdomain)
                  ? `https://${p.subdomain}`
                  : null,
              dashboard_url: `${dashboard}/pages/view/${encodeURIComponent(p.name)}`,
              production_branch:
                typeof p.production_branch === "string"
                  ? p.production_branch
                  : null,
              deployment_status:
                typeof deployment?.latest_stage?.status === "string"
                  ? deployment.latest_stage.status
                  : null,
              modified_at: stamp(
                deployment?.modified_on ?? deployment?.created_on,
              ),
              changes: null,
            });
            // The project lists its attached hostnames; pages.dev is already `url`.
            if (Array.isArray(p.domains))
              for (const hostname of p.domains)
                if (validHostname(hostname) && !/\.pages\.dev$/i.test(hostname))
                  domains.push({
                    kind: "pages",
                    name: p.name,
                    hostname: hostname.toLowerCase(),
                    environment: "production",
                  });
          }
          if (
            response.result.length < 10 ||
            (Number.isFinite(response.result_info?.total_pages) &&
              page >= response.result_info.total_pages)
          )
            break;
          if (page === 10)
            result.issues.push("Pages: Showing the first 100 projects.");
        }
      } catch (error) {
        result.issues.push(problem("Pages", error));
      }
    })(),
  ]);
  // Everything below depends on the inventory; it shares the remaining deadline.
  const enrich: Promise<void>[] = [];
  const changesSince = end.getTime() - CHANGES_DAYS * 86400_000;
  /** Timestamps within the change window, newest first, from a provider list. */
  const stamps = (items: unknown, at: (d: Doc) => unknown): string[] =>
    (Array.isArray(items) ? items : [])
      .map((d: Doc) => stamp(at(d)))
      .filter((s): s is string => s !== null && Date.parse(s) >= changesSince)
      .sort((a, b) => Date.parse(b) - Date.parse(a));
  /** Run one provider check per resource, bounded; the count left unchecked is the caller's to report. */
  async function each<T extends Doc>(
    items: T[],
    check: (item: T) => Promise<void>,
  ): Promise<number> {
    const checked = items.slice(0, RESOURCE_CHECKS);
    let unchecked = items.length - checked.length;
    let next = 0;
    await Promise.all(
      Array.from({ length: RESOURCE_CONCURRENCY }, async () => {
        while (next < checked.length) {
          try {
            await check(checked[next++]);
          } catch {
            unchecked++;
          }
        }
      }),
    );
    return unchecked;
  }
  const report = (label: string, unchecked: number) => {
    if (unchecked)
      result.issues.push(
        `${label}: ${unchecked} ${unchecked === 1 ? "resource" : "resources"} not checked.`,
      );
  };
  // workers.dev routes: the account subdomain plus one enabled-check per script,
  // so a disabled route is never claimed as an address.
  if (result.workers.length)
    enrich.push(
      (async () => {
        try {
          const response = await provider(
            credentials,
            `${base}/workers/subdomain`,
            undefined,
            deadline,
          );
          const subdomain = response.result?.subdomain;
          if (typeof subdomain !== "string" || !/^[a-z0-9-]+$/i.test(subdomain))
            throw new Error(
              "Cloudflare returned an invalid workers.dev subdomain.",
            );
          const unchecked = await each(result.workers, async (worker) => {
            const state = await provider(
              credentials,
              `${base}/workers/scripts/${encodeURIComponent(worker.name)}/subdomain`,
              undefined,
              deadline,
            );
            if (state.result?.enabled === true)
              domains.push({
                kind: "worker",
                name: worker.name,
                hostname:
                  `${worker.name}.${subdomain}.workers.dev`.toLowerCase(),
                environment: "production",
              });
          });
          domainsRead = true;
          report("workers.dev", unchecked);
        } catch (error) {
          result.issues.push(problem("workers.dev", error));
        }
      })(),
    );
  // Uploads: each script's versions and each Pages project's production
  // deployments inside the change window. Missing lists stay null.
  if (result.workers.length)
    enrich.push(
      (async () => {
        report(
          "Worker versions",
          await each(result.workers, async (worker) => {
            const response = await provider(
              credentials,
              `${base}/workers/scripts/${encodeURIComponent(worker.name)}/versions?per_page=50`,
              undefined,
              deadline,
            );
            const items = response.result?.items ?? response.result;
            if (!Array.isArray(items))
              throw new Error(
                "Cloudflare returned an invalid versions response.",
              );
            worker.changes = stamps(
              items,
              (v) => v.metadata?.created_on ?? v.created_on,
            );
          }),
        );
      })(),
    );
  if (result.pages.length)
    enrich.push(
      (async () => {
        report(
          "Pages deployments",
          await each(result.pages, async (page) => {
            const response = await provider(
              credentials,
              `${base}/pages/projects/${encodeURIComponent(page.name)}/deployments?per_page=25&env=production`,
              undefined,
              deadline,
            );
            if (!Array.isArray(response.result))
              throw new Error(
                "Cloudflare returned an invalid deployments response.",
              );
            page.changes = stamps(
              response.result.filter((d: Doc) => d.environment !== "preview"),
              (d) => d.created_on,
            );
          }),
        );
      })(),
    );
  if (result.workers.length)
    enrich.push(
      (async () => {
        try {
          // Group by script only: no time/status dimensions that could truncate a busy day's rows.
          const response = await provider(
            credentials,
            "/graphql",
            {
              query: `query Overview($account: string, $start: string, $end: string) { viewer { accounts(filter: {accountTag: $account}) { workersInvocationsAdaptive(limit: 10000, filter: {datetime_geq: $start, datetime_leq: $end}) { dimensions { scriptName } sum { requests errors subrequests } } } } }`,
              variables: {
                account,
                start: start.toISOString(),
                end: end.toISOString(),
              },
            },
            deadline,
          );
          const rows =
            response.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive;
          if (!Array.isArray(rows) || rows.length >= 10000)
            throw new Error(
              "Cloudflare analytics is unavailable or exceeds the query limit.",
            );
          const sums = new Map<string, Doc>();
          for (const row of rows) {
            const name = row.dimensions?.scriptName;
            if (
              typeof name !== "string" ||
              ["requests", "errors", "subrequests"].some(
                (k) => metric(row.sum?.[k]) === null,
              )
            )
              throw new Error("Cloudflare returned incomplete analytics.");
            const previous = sums.get(name) ?? {
              requests: 0,
              errors: 0,
              subrequests: 0,
            };
            for (const key of ["requests", "errors", "subrequests"])
              previous[key] += row.sum[key];
            sums.set(name, previous);
          }
          for (const worker of result.workers)
            Object.assign(
              worker,
              sums.get(worker.name) ?? {
                requests: 0,
                errors: 0,
                subrequests: 0,
              },
            );
        } catch (error) {
          result.issues.push(problem("Worker analytics", error));
        }
      })(),
    );
  // Hourly shape, separate from the totals so a truncated hourly result
  // never distorts the sums: one bucket per hour ending now, oldest first.
  if (result.workers.length)
    enrich.push(
      (async () => {
        try {
          const response = await provider(
            credentials,
            "/graphql",
            {
              query: `query Series($account: string, $start: string, $end: string) { viewer { accounts(filter: {accountTag: $account}) { workersInvocationsAdaptive(limit: 10000, filter: {datetime_geq: $start, datetime_leq: $end}) { dimensions { scriptName datetimeHour } sum { requests } } } } }`,
              variables: {
                account,
                start: start.toISOString(),
                end: end.toISOString(),
              },
            },
            deadline,
          );
          const rows =
            response.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive;
          if (!Array.isArray(rows) || rows.length >= 10000)
            throw new Error(
              "Cloudflare hourly analytics is unavailable or exceeds the query limit.",
            );
          const lastHour = Math.floor(end.getTime() / 3600_000);
          const series = new Map<string, number[]>();
          for (const row of rows) {
            const name = row.dimensions?.scriptName;
            const hour = Date.parse(row.dimensions?.datetimeHour);
            const requests = metric(row.sum?.requests);
            if (
              typeof name !== "string" ||
              !Number.isFinite(hour) ||
              requests === null
            )
              throw new Error(
                "Cloudflare returned incomplete hourly analytics.",
              );
            const index =
              SERIES_HOURS - 1 - (lastHour - Math.floor(hour / 3600_000));
            if (index < 0 || index >= SERIES_HOURS) continue;
            const buckets = series.get(name) ?? new Array(SERIES_HOURS).fill(0);
            buckets[index] += requests;
            series.set(name, buckets);
          }
          for (const worker of result.workers)
            worker.series =
              series.get(worker.name) ?? new Array(SERIES_HOURS).fill(0);
        } catch (error) {
          result.issues.push(problem("Worker hourly analytics", error));
        }
      })(),
    );
  await Promise.all(enrich);
  if (domainsRead) {
    const seen = new Set<string>();
    result.domains = domains.filter((d) => {
      const key = `${d.kind}:${d.name}:${d.hostname}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  result.status =
    readable === 0 ? "error" : result.issues.length ? "partial" : "connected";
  result.workers.sort((a: Doc, b: Doc) => a.name.localeCompare(b.name));
  result.pages.sort((a: Doc, b: Doc) => a.name.localeCompare(b.name));
  return result;
}

/** One instance per workspace Durable Object; no cross-tenant credential or response cache. */
export class CloudflareOverview {
  private flight?: { revision: string; promise: Promise<Doc> };
  private mutation = false;
  async handle(
    request: Request,
    ctx: WorkspaceContext,
  ): Promise<Response | null> {
    const path = new URL(request.url).pathname;
    if (
      ![
        "/api/integrations/cloudflare/overview",
        "/api/integrations/cloudflare/account",
        "/api/integrations/cloudflare/organize",
      ].includes(path)
    )
      return null;
    requireUser(ctx);
    if (path.endsWith("/overview") && request.method === "GET")
      return json(withOrganization(ctx, await this.read(ctx)));
    if (path.endsWith("/organize")) {
      if (request.method !== "POST") fail(405, "Method not allowed");
      const input = await body(request);
      const revision = ctx.store.get("settings", CONNECTION)?.revision;
      const overview = await this.read(ctx);
      if (ctx.store.get("settings", CONNECTION)?.revision !== revision)
        fail(409, "Cloudflare connection changed. Refresh to continue.");
      return json(organize(ctx, input, overview));
    }
    if (!path.endsWith("/account")) fail(405, "Method not allowed");
    if (request.method === "DELETE") {
      ctx.store.put("settings", CONNECTION, { revision: id(), disabled: true });
      ctx.store.delete("observations", CACHE);
      ctx.broadcast();
      return json(withOrganization(ctx, blank()));
    }
    if (request.method !== "POST") fail(405, "Method not allowed");
    if (this.mutation)
      fail(409, "A Cloudflare connection is already being checked");
    this.mutation = true;
    const previousRevision = ctx.store.get("settings", CONNECTION)?.revision;
    try {
      const input = await body(request);
      const account = text(input.account_id, 32);
      if (!/^[a-f0-9]{32}$/i.test(account))
        fail(400, "Use the 32-character Cloudflare account ID");
      const credentials = {
        account_id: account.toLowerCase(),
        token: text(input.api_token, 4096),
      };
      const overview = await fetchCloudflareOverview(credentials);
      if (overview.status === "error")
        fail(
          400,
          "Cannot read Workers or Pages. Check the account ID and token read permissions.",
        );
      const encrypted = await ctx.seal(CONNECTION, JSON.stringify(credentials));
      if (ctx.store.get("settings", CONNECTION)?.revision !== previousRevision)
        fail(409, "Connection changed. Please try again.");
      const revision = id();
      ctx.store.put("settings", CONNECTION, { revision, encrypted });
      ctx.store.put("observations", CACHE, {
        revision,
        schema: CACHE_SCHEMA,
        value: overview,
      });
      ctx.broadcast();
      return json(withOrganization(ctx, overview));
    } finally {
      this.mutation = false;
    }
  }
  private async read(ctx: WorkspaceContext): Promise<Doc> {
    const setting = ctx.store.get("settings", CONNECTION);
    if (setting?.disabled) return blank();
    const legacy = !setting
      ? ctx.store.get("settings", "legacy-cloudflare")
      : undefined;
    if (!setting?.encrypted && !legacy?.encrypted) return blank();
    const stored = setting ?? legacy;
    if (!stored?.encrypted) return blank();
    const revision: string = setting?.revision ?? `legacy:${stored.encrypted}`;
    const cache = ctx.store.get("observations", CACHE);
    if (
      cache &&
      cache.revision === revision &&
      cache.schema === CACHE_SCHEMA &&
      Date.now() - Date.parse(cache.value.checked_at) < TTL
    )
      return cache.value;
    if (this.flight && this.flight.revision === revision)
      return this.flight.promise;
    const promise = (async () => {
      const credentials = JSON.parse(
        await ctx.open(
          setting ? CONNECTION : "legacy-cloudflare",
          stored.encrypted,
        ),
      ) as Credentials;
      if (!/^[a-f0-9]{32}$/i.test(credentials.account_id) || !credentials.token)
        fail(409, "Reconnect your Cloudflare account");
      const value = await fetchCloudflareOverview(credentials);
      const current = ctx.store.get("settings", CONNECTION);
      if (
        (current?.revision ??
          `legacy:${ctx.store.get("settings", "legacy-cloudflare")?.encrypted}`) !==
        revision
      )
        fail(409, "Cloudflare connection changed. Refresh to continue.");
      ctx.store.put("observations", CACHE, {
        revision,
        schema: CACHE_SCHEMA,
        value,
      });
      return value;
    })();
    this.flight = { revision, promise };
    try {
      return await promise;
    } finally {
      if (this.flight?.promise === promise) this.flight = undefined;
    }
  }
}
