import { useMemo, useState } from "react";
import { EyeOff, RefreshCw, Sparkles, Undo2 } from "lucide-react";
import {
  api,
  ApiError,
  type Assignment,
  type CloudflareOverview,
  type Organization,
  type Project,
  type ProjectResource,
  type ResourceEnvironment,
} from "../lib/data";
import { cn } from "../lib/utils";
import { Feedback, useAction } from "./live";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog, DialogFooter } from "./ui/dialog";
import { Input, Select } from "./ui/input";
import { Eyebrow, Meta } from "./ui/misc";

export const ENVIRONMENTS: ResourceEnvironment[] = [
  "production",
  "development",
  "staging",
  "preview",
];
export const KIND_LABEL = { worker: "Worker", pages: "Pages" } as const;

/** A resource Cloudflare reported, before or after it has a home here. */
export type Discovered = {
  kind: ProjectResource["kind"];
  name: string;
  /** Saved earlier but not in Cloudflare's current listing. */
  missing?: boolean;
};

export const resourceKey = (r: Discovered) => `${r.kind}:${r.name}`;

/**
 * Where a resource should live, as the user sees it: an existing project, a
 * project to create by name, or nowhere.
 */
export type Home =
  | { type: "existing"; id: string }
  | { type: "new"; name: string }
  | { type: "none" };

export type Row = {
  kind: ProjectResource["kind"];
  name: string;
  home: Home;
  environment: ResourceEnvironment;
  ignored: boolean;
  /** The saved record, when one exists. Saved links always beat suggestions. */
  saved?: ProjectResource;
  /** True when the home/environment came from the name, not from the user or a record. */
  suggested: boolean;
  /** Explicit edits, including leaving a newly discovered resource unassigned. */
  touched?: boolean;
  /** Saved earlier but absent from Cloudflare's current listing; can only be released. */
  missing: boolean;
  /** Why no home was suggested, when a guess would have been unsafe. */
  note?: string;
  /**
   * The group the row was shown under when the dialog opened. Fixed for the
   * life of the dialog so editing a name never moves or remounts the row.
   */
  group: string;
};

const IGNORED_GROUP = "\u0000ignored";
const UNASSIGNED_GROUP = "\u0001unassigned";

const ENV_SUFFIX: [RegExp, ResourceEnvironment][] = [
  [/[-_.](prod|production|live)$/i, "production"],
  [/[-_.](dev|develop|development|sandbox)$/i, "development"],
  [/[-_.](stg|stage|staging|qa|test|testing)$/i, "staging"],
  [/[-_.](preview|previews|pr|pr-?\d+|canary|beta|next)$/i, "preview"],
];
const ENV_PREFIX: [RegExp, ResourceEnvironment][] = [
  [/^(dev|development)[-_.]/i, "development"],
  [/^(stg|staging|qa|test)[-_.]/i, "staging"],
  [/^(preview|canary|beta)[-_.]/i, "preview"],
  [/^(prod|production)[-_.]/i, "production"],
];

/** Split "shop-api-staging" into its project stem and environment. */
export function parseName(name: string): { stem: string; environment: ResourceEnvironment } {
  for (const [re, environment] of ENV_SUFFIX) {
    if (re.test(name)) return { stem: name.replace(re, ""), environment };
  }
  for (const [re, environment] of ENV_PREFIX) {
    if (re.test(name)) return { stem: name.replace(re, ""), environment };
  }
  return { stem: name, environment: "production" };
}

/** Humanise a stem for a new project name: "shop-api" -> "shop-api" (kept literal, trimmed). */
const projectName = (stem: string) => stem.replace(/^[-_.]+|[-_.]+$/g, "") || stem;

export function suggest(
  discovered: Discovered[],
  saved: ProjectResource[],
  projects: Project[],
): Row[] {
  const byKey = new Map(saved.map((r) => [resourceKey(r), r]));
  const byName = new Map<string, Project[]>();
  for (const p of projects) {
    const k = p.name.toLowerCase();
    byName.set(k, [...(byName.get(k) ?? []), p]);
  }
  const groupOf = (home: Home, ignored: boolean) =>
    ignored ? IGNORED_GROUP : home.type === "none" ? UNASSIGNED_GROUP : homeLabel(home, projects).toLowerCase();
  return discovered.map((d) => {
    const record = byKey.get(resourceKey(d));
    if (record) {
      const home: Home = record.project_id ? { type: "existing", id: record.project_id } : { type: "none" };
      return {
        kind: d.kind,
        name: d.name,
        home,
        environment: record.environment,
        ignored: record.ignored,
        saved: record,
        suggested: false,
        missing: Boolean(d.missing),
        note: d.missing ? "Cloudflare no longer lists this; unassign or ignore it." : undefined,
        group: groupOf(home, record.ignored),
      };
    }
    const { stem, environment } = parseName(d.name);
    const name = projectName(stem);
    const matches = byName.get(name.toLowerCase()) ?? [];
    // Two projects with the same name: never guess between them.
    const home: Home =
      matches.length > 1
        ? { type: "none" }
        : matches.length === 1
          ? { type: "existing", id: matches[0].id }
          : { type: "new", name };
    return {
      kind: d.kind,
      name: d.name,
      home,
      environment,
      ignored: false,
      suggested: matches.length <= 1,
      missing: false,
      note: matches.length > 1 ? `${matches.length} projects are named "${name}"; choose one.` : undefined,
      group: groupOf(home, false),
    };
  });
}

/** True when saving this row would change what the control plane has. */
export function changed(row: Row): boolean {
  const s = row.saved;
  if (!s) return Boolean(row.touched) || row.home.type !== "none" || row.ignored;
  if (row.ignored !== s.ignored) return true;
  if (row.environment !== s.environment) return true;
  const savedHome = s.project_id ?? null;
  const home = row.home.type === "existing" ? row.home.id : row.home.type === "new" ? `new:${row.home.name}` : null;
  return home !== savedHome;
}

export function toAssignment(row: Row): Assignment {
  const base = { kind: row.kind, name: row.name, environment: row.environment, ignored: row.ignored };
  if (row.ignored) return { ...base, project_id: null };
  if (row.home.type === "existing") return { ...base, project_id: row.home.id };
  if (row.home.type === "new") return { ...base, project_name: row.home.name };
  return { ...base, project_id: null };
}

/** The label a group of rows sorts and displays under. */
export function homeLabel(home: Home, projects: Project[]): string {
  if (home.type === "existing") return projects.find((p) => p.id === home.id)?.name ?? "Project";
  if (home.type === "new") return home.name;
  return "Unassigned";
}

const NEW = "__new__";
const NONE = "__none__";

function HomeField({
  row,
  projects,
  onChange,
}: {
  row: Row;
  projects: Project[];
  onChange: (home: Home) => void;
}) {
  const value = row.home.type === "existing" ? row.home.id : row.home.type === "new" ? NEW : NONE;
  // A resource Cloudflare no longer lists can only be released; the control
  // plane refuses to assign it until it is reported again.
  const current = row.saved?.project_id;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Select
        size="sm"
        aria-label={`Project for ${row.name}`}
        value={value}
        disabled={row.ignored}
        onChange={(e) => {
          const v = e.target.value;
          if (v === NONE) onChange({ type: "none" });
          else if (v === NEW) onChange({ type: "new", name: row.home.type === "new" ? row.home.name : projectName(parseName(row.name).stem) });
          else onChange({ type: "existing", id: v });
        }}
      >
        <option value={NONE}>Leave unassigned</option>
        {!row.missing && <option value={NEW}>New project…</option>}
        {projects.length > 0 && (
          <optgroup label="Existing projects">
            {projects
              .filter((p) => !row.missing || p.id === current)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </optgroup>
        )}
      </Select>
      {row.home.type === "new" && !row.ignored && (
        <Input
          aria-label={`New project name for ${row.name}`}
          value={row.home.name}
          required
          maxLength={80}
          placeholder="Project name"
          className="h-9 text-sm"
          onChange={(e) => onChange({ type: "new", name: e.target.value })}
        />
      )}
    </div>
  );
}

/**
 * Sort Cloudflare resources into projects. Suggestions are only a starting
 * point; anything already saved is shown as saved and never overwritten by
 * a guess. Saving posts one batch; nothing here writes to Cloudflare.
 */
export function OrganizeDialog({
  overview,
  organization,
  projects,
  onClose,
  onSaved,
  onReload,
}: {
  overview: CloudflareOverview;
  organization: Organization;
  projects: Project[];
  onClose: () => void;
  onSaved: (result: { projects: Project[]; organization: Organization }) => void;
  /** Re-read Cloudflare and the workspace, then remount this dialog on the fresh copy. */
  onReload: () => Promise<unknown>;
}) {
  const discovered = useMemo<Discovered[]>(() => {
    const live: Discovered[] = [
      ...overview.workers.map((w) => ({ kind: "worker" as const, name: w.name })),
      ...overview.pages.map((p) => ({ kind: "pages" as const, name: p.name })),
    ];
    // Links saved for this account that Cloudflare no longer reports still
    // need a way out; links from other accounts are not this dialog's to touch.
    const seen = new Set(live.map(resourceKey));
    for (const r of organization.resources)
      if (r.account_id === overview.account_id && !seen.has(resourceKey(r)) && (r.project_id || r.ignored))
        live.push({ kind: r.kind, name: r.name, missing: true });
    return live;
  }, [overview, organization.resources]);
  const initial = useMemo(
    () => suggest(discovered, organization.resources, projects),
    [discovered, organization.resources, projects],
  );
  const [rows, setRows] = useState<Row[]>(initial);
  const [stale, setStale] = useState(false);
  const [reloading, setReloading] = useState(false);
  const action = useAction();

  const update = (key: string, patch: Partial<Row>) =>
    setRows((all) => all.map((r) => (resourceKey(r) === key ? { ...r, ...patch, suggested: false, touched: true } : r)));

  const dirty = rows.filter(changed);
  const suggestedCount = rows.filter((r) => r.suggested && r.home.type !== "none").length;
  const savedCount = rows.filter((r) => r.saved).length;
  const invalid = rows.find((r) => !r.ignored && r.home.type === "new" && !r.home.name.trim());

  // Group for display by intended home; ignored rows sit last.
  // Groups are fixed at open (see Row.group); rows keep their slot while edited.
  const groups = useMemo(() => {
    const map = new Map<string, Row[]>();
    for (const r of rows) map.set(r.group, [...(map.get(r.group) ?? []), r]);
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [rows]);
  const groupTitle = (id: string, group: Row[]) => {
    if (id === UNASSIGNED_GROUP) return "Unassigned";
    const active = group.filter((r) => !r.ignored && r.home.type !== "none");
    if (!active.length) return id;
    const labels = new Set(active.map((r) => homeLabel(r.home, projects).toLowerCase()));
    return labels.size > 1 ? "Mixed projects" : homeLabel(active[0].home, projects);
  };

  async function save() {
    if (invalid) return;
    await action.run(async () => {
      try {
        const result = await api<{ projects: Project[]; organization: Organization }>(
          "/integrations/cloudflare/organize",
          {
            account_id: overview.account_id,
            revision: organization.revision,
            assignments: dirty.map(toAssignment),
          },
        );
        onSaved(result);
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) setStale(true);
        throw e;
      }
    }, "");
  }

  return (
    <Dialog
      title="Organize your Cloudflare apps"
      description="Group what already runs in your account into projects. Nothing changes in Cloudflare; this only decides how dinghy shows them."
      onClose={onClose}
      size="wide"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <Meta>{rows.length} resources</Meta>
          {suggestedCount > 0 && (
            <Meta className="inline-flex items-center gap-1 text-primary">
              <Sparkles className="size-3" />
              {suggestedCount} suggested from names
            </Meta>
          )}
          {savedCount > 0 && <Meta>{savedCount} already saved</Meta>}
          <Meta>{dirty.length} to save</Meta>
        </div>

        {rows.length === 0 ? (
          <Meta>Cloudflare reported nothing to organize.</Meta>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
            {groups.map(([id, group]) => (
              <section key={id} className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  {id === IGNORED_GROUP ? (
                    <Eyebrow className="inline-flex items-center gap-1">
                      <EyeOff className="size-3" /> Ignored
                    </Eyebrow>
                  ) : (
                    <Eyebrow>{groupTitle(id, group)}</Eyebrow>
                  )}
                  <Meta>{group.length}</Meta>
                  {id !== IGNORED_GROUP &&
                    id !== UNASSIGNED_GROUP &&
                    group.every((r) => r.home.type === "new") && (
                      <Badge variant="blank">new project</Badge>
                    )}
                </div>
                <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
                  {group.map((r) => {
                    const key = resourceKey(r);
                    return (
                      <li
                        key={key}
                        className={cn(
                          "grid gap-2 p-3 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_9rem_auto] sm:items-start",
                          r.ignored && "opacity-70",
                        )}
                      >
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-sm font-medium">{r.name}</span>
                            <Badge variant="outline" className="shrink-0">
                              {KIND_LABEL[r.kind]}
                            </Badge>
                            {r.missing && (
                              <Badge variant="blank" className="shrink-0">
                                not reported
                              </Badge>
                            )}
                          </span>
                          <Meta className={cn(r.note && "text-yellow-600 dark:text-yellow-500")}>
                            {r.note
                              ? r.note
                              : r.saved
                                ? changed(r)
                                  ? "saved · edited"
                                  : r.saved.ignored
                                    ? "ignored"
                                    : r.saved.project_id
                                      ? "saved"
                                      : "unassigned · kept"
                                : r.ignored
                                  ? "will be ignored"
                                  : r.home.type === "none"
                                    ? "unassigned"
                                    : r.suggested
                                      ? "suggestion"
                                      : r.home.type === "new"
                                        ? "new project"
                                        : "edited"}
                          </Meta>
                        </div>
                        <HomeField
                          row={r}
                          projects={projects}
                          onChange={(home) => update(key, { home })}
                        />
                        <Select
                          size="sm"
                          aria-label={`Environment for ${r.name}`}
                          value={r.environment}
                          disabled={r.ignored || r.missing}
                          onChange={(e) =>
                            update(key, { environment: e.target.value as ResourceEnvironment })
                          }
                        >
                          {ENVIRONMENTS.map((env) => (
                            <option key={env} value={env}>
                              {env}
                            </option>
                          ))}
                        </Select>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="justify-self-start text-muted-foreground sm:justify-self-end"
                          aria-pressed={r.ignored}
                          onClick={() => update(key, { ignored: !r.ignored })}
                        >
                          {r.ignored ? <Undo2 /> : <EyeOff />}
                          {r.ignored ? "Include" : "Ignore"}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}

        {stale && (
          <div className="flex flex-wrap items-center gap-3">
            <Meta className="text-destructive">
              Cloudflare's inventory or this connection changed while you were editing. Reload to
              organize the current list; your unsaved edits are discarded.
            </Meta>
            <Button
              type="button"
              size="sm"
              variant="outline"
              isLoading={reloading}
              onClick={() => {
                setReloading(true);
                void onReload().finally(() => setReloading(false));
              }}
            >
              <RefreshCw />
              Reload
            </Button>
          </div>
        )}
        <Feedback action={action} />
        <DialogFooter className="items-center">
          <Meta className="mr-auto">Free to organize · no Cloudflare changes</Meta>
          <Button type="button" variant="outline" onClick={onClose}>
            Skip for now
          </Button>
          <Button
            type="button"
            isLoading={action.busy}
            disabled={dirty.length === 0 || Boolean(invalid) || stale}
            onClick={() => void save()}
          >
            Save {dirty.length > 0 ? `${dirty.length} ` : ""}
            {dirty.length === 1 ? "change" : "changes"}
          </Button>
        </DialogFooter>
      </div>
    </Dialog>
  );
}
