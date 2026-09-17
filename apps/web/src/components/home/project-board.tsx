import { ArrowRight, Plus } from "lucide-react";
import { Reveal } from "../fleet/primitives";
import { ProjectCards } from "../project-cards";
import { summarize } from "../project-summary";
import { Button } from "../ui/button";
import type { CloudflareOverview, Project, Snapshot } from "../../lib/data";

interface ProjectBoardProps {
	data: Snapshot;
	overview?: CloudflareOverview;
	delay: number;
	onOpen: (p: Project) => void;
	onViewAll: () => void;
	onNew: () => void;
}

/** Sort key: anything failing first, then deploying, healthy, idle. */
const RANK: Record<string, number> = { failed: 0, unhealthy: 0, deploying: 1, building: 1, healthy: 2 };

/**
 * The work, front and centre: the same project cards the rest of the app
 * uses, in a region that scrolls inside itself so the page never does.
 * Projects needing attention float to the top.
 */
export const ProjectBoard = ({ data, overview, delay, onOpen, onViewAll, onNew }: ProjectBoardProps) => {
	const projects = [...data.projects].sort((a, b) => {
		const ra = RANK[summarize(data, a, overview).health?.status ?? ""] ?? 3;
		const rb = RANK[summarize(data, b, overview).health?.status ?? ""] ?? 3;
		return ra - rb || a.name.localeCompare(b.name);
	});
	return (
		<Reveal delay={delay} className="flex min-h-0 flex-col">
			<section
				className="gh-surface flex min-h-0 flex-1 flex-col rounded-lg"
				aria-label="Projects"
			>
				<div className="flex shrink-0 items-baseline justify-between gap-3 px-4 pt-4 pb-3">
					<div className="flex items-baseline gap-2">
						<span className="text-sm font-medium">Projects</span>
						<span className="font-mono text-[11px] tabular-nums text-muted-foreground">
							{projects.length}
						</span>
					</div>
					<button
						type="button"
						onClick={onViewAll}
						className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
					>
						repositories
						<ArrowRight className="size-3" />
					</button>
				</div>
				{projects.length === 0 ? (
					<div className="flex flex-1 flex-col items-center justify-center gap-3 border-t border-border p-10 text-center text-sm text-muted-foreground">
						Nothing to run yet.
						<Button size="sm" onClick={onNew}>
							<Plus />
							Deploy from GitHub
						</Button>
					</div>
				) : (
					<div className="min-h-0 flex-1 overflow-y-auto border-t border-border p-3 no-scrollbar">
						<ProjectCards
							projects={projects}
							data={data}
							overview={overview}
							onSelect={onOpen}
							className="sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
						/>
					</div>
				)}
			</section>
		</Reveal>
	);
};
