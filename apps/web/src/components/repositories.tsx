import { useState } from "react";
import { ArrowUpRight, GitBranch, GitFork, Plus } from "lucide-react";
import { hosted } from "../lib/hosted";
import type { Project, Snapshot } from "../lib/data";
import { CloudflareSection } from "./cloudflare-overview";
import { GitHubAppPanel } from "./github";
import { Reveal } from "./fleet/primitives";
import { LinkRepository, projectResources } from "./project-resources";
import { ProjectMark, projectHues } from "./project-summary";
import { Button } from "./ui/button";
import { Eyebrow, Meta } from "./ui/misc";

/**
 * Where source comes from and where it goes: repository access, every
 * project's linked repository and branch, and the Cloudflare organizer that
 * sorts what already runs into projects. Nothing here deploys.
 */
export function Repositories({
  data,
  live,
  refresh,
  onSelectProject,
  onNewProject,
  organizeRequest,
}: {
  data: Snapshot;
  live: boolean;
  refresh: () => Promise<unknown>;
  onSelectProject: (p: Project) => void;
  onNewProject: () => void;
  organizeRequest: number;
}) {
  const [linking, setLinking] = useState<string | null>(null);
  const hues = projectHues(data.projects);
  const projects = [...data.projects].sort((a, b) => {
    // Unlinked projects first: they are the ones with something to do here.
    const la = a.repository ? 1 : 0;
    const lb = b.repository ? 1 : 0;
    return la - lb || a.name.localeCompare(b.name);
  });
  return (
    <div className="flex flex-col gap-6">
      <Reveal>
        <section className="gh-surface rounded-lg" aria-labelledby="repo-access-heading">
          <div className="flex flex-col gap-0.5 px-4 pt-4 pb-3">
            <Eyebrow>GitHub</Eyebrow>
            <h2 id="repo-access-heading" className="text-[15px] font-medium">
              Repository access
            </h2>
          </div>
          <div className="border-t border-border p-4">
            <GitHubAppPanel live={live} refresh={refresh} />
          </div>
        </section>
      </Reveal>

      <Reveal delay={0.08}>
        <section className="gh-surface rounded-lg" aria-labelledby="linked-heading">
          <div className="flex flex-wrap items-end justify-between gap-3 px-4 pt-4 pb-3">
            <div className="flex flex-col gap-0.5">
              <Eyebrow>Source</Eyebrow>
              <h2 id="linked-heading" className="text-[15px] font-medium">
                Linked repositories
              </h2>
            </div>
            <Button size="sm" onClick={onNewProject}>
              <Plus />
              New project
            </Button>
          </div>
          {projects.length === 0 ? (
            <p className="border-t border-border px-4 py-8 text-center text-sm text-muted-foreground">
              No projects yet. Start one from a repository, or organize what already runs on
              Cloudflare below.
            </p>
          ) : (
            <ul className="divide-y divide-border border-t border-border">
              {projects.map((p) => {
                const linked = projectResources(data, p.id).length;
                const services = data.services.filter((s) => s.project_id === p.id).length;
                return (
                  <li key={p.id} className="flex flex-col">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                      <button
                        type="button"
                        onClick={() => onSelectProject(p)}
                        className="group flex min-w-0 flex-1 items-center gap-3 text-left"
                      >
                        <ProjectMark name={p.name} hue={hues[p.id] ?? 150} size={32} />
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="flex items-center gap-1 text-sm font-medium leading-tight">
                            <span className="truncate">{p.name}</span>
                            <ArrowUpRight className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                          </span>
                          <Meta className="truncate">
                            {[
                              services ? `${services} service${services === 1 ? "" : "s"}` : "",
                              linked ? `${linked} on Cloudflare` : "",
                            ]
                              .filter(Boolean)
                              .join(" · ") || "empty project"}
                          </Meta>
                        </span>
                      </button>
                      {p.repository ? (
                        <a
                          href={`https://github.com/${p.repository}`}
                          target="_blank"
                          rel="noreferrer"
                          className="flex min-w-0 items-center gap-3 rounded-sm font-mono text-[12px] text-muted-foreground transition-colors hover:text-foreground"
                        >
                          <span className="flex min-w-0 items-center gap-1.5">
                            <GitFork className="size-3.5 shrink-0" />
                            <span className="truncate">{p.repository}</span>
                          </span>
                          <span className="flex shrink-0 items-center gap-1.5">
                            <GitBranch className="size-3.5" />
                            {p.branch}
                          </span>
                          <ArrowUpRight className="size-3 shrink-0" />
                        </a>
                      ) : (
                        <Button
                          size="xs"
                          variant={linking === p.id ? "ghost" : "outline"}
                          onClick={() => setLinking(linking === p.id ? null : p.id)}
                          disabled={!live}
                        >
                          <GitFork />
                          {linking === p.id ? "Cancel" : "Link repository"}
                        </Button>
                      )}
                    </div>
                    {linking === p.id && (
                      <div className="px-4 pb-4">
                        <LinkRepository
                          project={p}
                          live={live}
                          refresh={refresh}
                          onDone={() => setLinking(null)}
                        />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </Reveal>

      {hosted && live && (
        <CloudflareSection
          data={data}
          refresh={refresh}
          onSelectProject={onSelectProject}
          delay={0.16}
          organizeRequest={organizeRequest}
        />
      )}
    </div>
  );
}
