import { ArrowRight, Plus } from "lucide-react";
import { useContext, useMemo } from "react";
import { hostCss } from "../fleet/palette";
import { Reveal } from "../fleet/primitives";
import type { Fleet } from "../fleet/use-fleet";
import { Button } from "../ui/button";
import { DitherGradient } from "../dither-kit";
import { hosted } from "../../lib/hosted";
import type { CloudflareOverview, Project, Snapshot } from "../../lib/data";
import {
	BlockerAction,
	ReadinessActions,
	ReadinessSummary,
	SetupPath,
	setupSteps,
} from "../readiness";
import { CloudflareSection } from "../cloudflare-overview";
import {
	bucketActivity,
	DeploymentsPanel,
	toDeployments,
} from "./deployments-panel";
import { ProjectBoard } from "./project-board";
import { DeployBars, Gauge, Meter, SparkSlot, Tile, TileLink } from "./stat-tiles";
import { cn } from "../../lib/utils";

const fmtGiB = (n: number) => (n >= 100 ? Math.round(n).toString() : n.toFixed(1));

/** Reveal offsets, top to bottom. Tiles step from `tiles`; sections follow. */
const DELAY = {
	tiles: 0.05,
	tileStep: 0.04,
	fleet: 0.35,
	local: 0.65,
};


const quickLinkClass =
	"gh-interactive flex h-8 items-center gap-1.5 rounded border border-border px-2.5 font-mono text-[11px] text-muted-foreground hover:text-foreground";

/* ----------------------------------------------------------------------- */

/** "Good morning", "Good afternoon", "Good evening" by local hour, with the name when known. */
export function greeting(name: string | undefined, now = new Date()): string {
	const hour = now.getHours();
	const word =
		hour < 5 ? "Good evening" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
	return name ? `${word}, ${name}` : "Welcome back";
}

interface ShowHomeProps {
	data: Snapshot;
	/** Cloudflare's view of linked resources, when the shell has fetched it. */
	overview?: CloudflareOverview;
	live: boolean;
	refresh: () => Promise<unknown>;
	fleet: Fleet;
	/** Signed-in user's display name, when the shell knows it. */
	userName?: string;
	onNavigate: (page: "Repositories" | "Machines" | "Activity" | "Settings") => void;
	onSelectProject: (p: Project) => void;
	onNewProject: () => void;
	onAddMachine: () => void;
	/** Bumped when another page asks to open the Cloudflare organizer here. */
	organizeRequest?: number;
}

export const ShowHome = ({
	data,
	overview,
	live,
	refresh,
	fleet,
	userName,
	onNavigate,
	onSelectProject,
	onNewProject,
	onAddMachine,
	organizeRequest,
}: ShowHomeProps) => {
	const hello = greeting(userName);
	const handlers = useContext(ReadinessActions);
	const firstBlocker =
		data.readiness?.status === "blocked" ? data.readiness.blockers[0] : undefined;

	const deployments = useMemo(() => toDeployments(data), [data]);
	const dataUpdatedAt = Date.parse(data.generated_at) || Date.now();

	const totals = {
		projects: data.projects.length,
		environments: data.projects.length,
		applications: data.services.length,
		compose: 0,
		databases: data.databases.length,
		services: data.services.length + data.databases.length,
	};
	const statusBreakdown = {
		running:
			data.services.filter((s) => s.status === "healthy").length +
			data.databases.filter(
				(d) => d.status === "healthy" || d.status === "running",
			).length,
		error:
			data.services.filter(
				(s) => s.status === "failed" || s.status === "unhealthy",
			).length +
			data.databases.filter(
				(d) => d.status === "failed" || d.status === "unhealthy" || !!d.error,
			).length,
		idle: 0,
	};
	statusBreakdown.idle =
		totals.services - statusBreakdown.running - statusBreakdown.error;

	// `now` is pinned to the last fetch so the derived buckets and the "ago"
	// cells only move when the data does, not on every unrelated render.
	const now = dataUpdatedAt || Date.now();
	const activity = useMemo(
		() => bucketActivity(deployments, now),
		[deployments, now],
	);

	// The deployments panel sits under the fleet section.
	const deploymentsDelay = DELAY.fleet + 0.25;

	const steps = setupSteps(
		data,
		{ hosted, onAddMachine, onNewProject, onNavigate },
		handlers,
	);
	const doneCount = steps.filter((s) => s.done).length;
	// Until something has deployed, the page is the path to that deployment;
	// empty tiles, charts and rosters would only push the next action below the fold.
	const firstRun = !steps[steps.length - 1].done;
	const currentStep = steps.find((s) => !s.done);
	// Apps already sorted into projects from Cloudflare are a complete cloud on
	// their own; machines and GitHub deploys stay optional until wanted.
	const organizedResources = (data.project_resources ?? []).filter(
		(r) => r.project_id && !r.ignored,
	);
	const organizedProjects = new Set(organizedResources.map((r) => r.project_id)).size;
	// Machines that only report inventory do not change this; only services
	// waiting on a machine bring the setup path back to the front.
	const cloudOnly =
		hosted && live && firstRun && organizedResources.length > 0 && totals.services === 0;

	// Hosted first run leads with what is already free in the user's Cloudflare
	// account; machines and GitHub deploys are the optional path after it.
	const freeFirst = hosted && live;
	// Existing Cloudflare projects and databases already make this a working
	// workspace. Creating a database must not send its overview back to setup.
	const establishedOverview =
		(hosted && live && organizedResources.length > 0) || data.databases.length > 0;
	if (firstRun && !establishedOverview)
		return (
			<div className="flex flex-col gap-4 pb-10">
				{freeFirst && (
					<CloudflareSection
						compact
						data={data}
						refresh={refresh}
						onSelectProject={onSelectProject}
						organizeRequest={organizeRequest}
					/>
				)}
				<Reveal delay={freeFirst ? DELAY.fleet : 0}>
					<header className="gh-surface relative overflow-hidden rounded-lg">
						<DitherGradient
							from="green"
							direction="right"
							cell={3}
							opacity={0.14}
							className="w-2/3"
						/>
						<div className="relative flex flex-col gap-5 p-5">
							<div className="flex flex-wrap items-end justify-between gap-4">
								<div className="flex flex-col gap-1">
									<span className="gh-eyebrow">
										{hello} · {freeFirst ? "optional · run your own code" : "get started"}
									</span>
									<h1 className="text-lg font-semibold tracking-tight">
										{currentStep?.key === "deploy"
											? "Deploy your first application"
											: freeFirst
												? "Build and run on your own machines"
												: "Set up your cloud"}
									</h1>
									<p className="text-sm text-muted-foreground">
										{steps.length} steps · {doneCount} done
										{currentStep && ` · next: ${currentStep.label.toLowerCase()}`}
									</p>
								</div>
								<div className="flex flex-wrap items-center gap-2">
									<ReadinessSummary readiness={data.readiness} compact />
								</div>
							</div>
							<SetupPath steps={steps} readiness={data.readiness} />
						</div>
					</header>
				</Reveal>
				{deployments.length > 0 && (
					<DeploymentsPanel
						canRead
						activity={activity}
						now={now}
						delay={deploymentsDelay}
						onOpen={(d) => {
							const project = data.projects.find(
								(p) => p.id === d.service.projectId,
							);
							if (project) onSelectProject(project);
						}}
						onViewAll={() => onNavigate("Activity")}
					/>
				)}
			</div>
		);

	// Steady state: one screen. The header is a strip; below it the projects
	// board and the deployment feed split the remaining height and scroll
	// inside themselves. Machine vitals live on the Machines page; only a
	// one-line fleet summary and any blocker stay here so a broken machine
	// still interrupts the work.
	const ready = data.readiness?.counts.ready_to_run;
	const fleetLine =
		data.machines.length === 0
			? "no machines"
			: `${data.machines.length} machine${data.machines.length === 1 ? "" : "s"}` +
				(ready !== undefined ? ` · ${ready} ready` : "") +
				(fleet.summary.online < fleet.summary.total
					? ` · ${fleet.summary.total - fleet.summary.online} unreachable`
					: "");
	const attention = statusBreakdown.error;
	const status =
		attention > 0
			? { label: `${attention} need${attention === 1 ? "s" : ""} attention`, color: "var(--destructive)" }
			: activity.inFlight > 0
				? { label: `${activity.inFlight} deploying now`, color: hostCss("orange") }
				: cloudOnly
					? { label: "serving from the edge", color: hostCss("blue") }
					: totals.services > 0
						? { label: "all systems go", color: hostCss("green") }
						: { label: "nothing running yet", color: "var(--muted-foreground)" };
	const deploys14d = activity.daily.reduce((n, d) => n + d.deploys, 0);
	const unreachable = fleet.summary.total - fleet.summary.online;
	return (
		<div className="flex flex-col gap-4 lg:h-[calc(100svh-9.6rem)] lg:min-h-[34rem]">
			<Reveal className="shrink-0">
				<header className="gh-surface relative overflow-hidden rounded-lg">
					<DitherGradient
						from="green"
						direction="right"
						cell={3}
						opacity={0.14}
						className="w-2/3"
					/>
					<div className="relative flex flex-wrap items-end justify-between gap-x-6 gap-y-3 px-5 py-4">
						<div className="flex min-w-0 flex-col gap-0.5">
							<span className="gh-eyebrow">Home</span>
							<h1 className="text-lg font-semibold tracking-tight">{hello}</h1>
							<p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
								<span>
									{cloudOnly
										? `${organizedResources.length} app${organizedResources.length === 1 ? "" : "s"} from Cloudflare across ${organizedProjects} project${organizedProjects === 1 ? "" : "s"}`
										: `${totals.services} service${totals.services === 1 ? "" : "s"} across ${totals.projects} project${totals.projects === 1 ? "" : "s"}`}
								</span>
								<span className="text-border">·</span>
								<span className="inline-flex items-center gap-1.5" style={{ color: status.color }}>
									<span
										aria-hidden
										className={cn("size-1.5 rounded-full", activity.inFlight > 0 && "animate-pulse")}
										style={{ backgroundColor: status.color, boxShadow: `0 0 8px ${status.color}` }}
									/>
									{status.label}
								</span>
							</p>
						</div>
						<div className="flex flex-wrap items-center gap-2">
							{live && (
								<span className="mr-1 hidden items-center gap-1.5 font-mono text-[11px] text-muted-foreground sm:inline-flex">
									<span
										aria-hidden
										className="size-1.5 animate-pulse rounded-full"
										style={{ backgroundColor: hostCss("green"), boxShadow: `0 0 6px ${hostCss("green", 0.6)}` }}
									/>
									live
								</span>
							)}
							<button
								type="button"
								className={quickLinkClass}
								onClick={() => onNavigate("Machines")}
								title="Machine vitals, roster and fleet charts"
							>
								<span
									aria-hidden
									className="size-1.5 rounded-full"
									style={{
										backgroundColor: unreachable > 0 ? "var(--destructive)" : hostCss("green"),
									}}
								/>
								{fleetLine}
								<ArrowRight className="size-3" />
							</button>
							{firstBlocker ? (
								<BlockerAction blocker={firstBlocker} size="sm" variant="default" />
							) : (
								<Button size="sm" onClick={onNewProject}>
									<Plus />
									Deploy from GitHub
								</Button>
							)}
						</div>
					</div>
				</header>
			</Reveal>

			{data.machines.length > 0 && (
				<Reveal className="shrink-0" delay={DELAY.tiles}>
					<div className="gh-surface grid grid-cols-2 divide-x divide-y divide-border overflow-hidden rounded-lg lg:grid-cols-4 lg:divide-y-0">
						<Tile
							label="Machines"
							value={
								<>
									{fleet.summary.online}
									<span className="text-muted-foreground/60">/{fleet.summary.total}</span>
								</>
							}
							sub={
								fleet.summary.online < fleet.summary.total
									? `${fleet.summary.total - fleet.summary.online} unreachable · ${fleet.summary.containers} containers`
									: `all online · ${fleet.summary.containers} container${fleet.summary.containers === 1 ? "" : "s"}`
							}
							color={fleet.summary.online < fleet.summary.total ? "red" : "green"}
							delay={DELAY.tiles}
							onClick={() => onNavigate("Machines")}
							className="group"
						>
							<TileLink>open machines</TileLink>
						</Tile>
						<Tile
							label="CPU"
							value={
								fleet.summary.cpuAvg === null ? "—" : `${Math.round(fleet.summary.cpuAvg)}%`
							}
							sub={`average across ${fleet.summary.online} online`}
							color="blue"
							delay={DELAY.tiles + DELAY.tileStep * 1}
						>
							<SparkSlot history={fleet.summary.history.cpuAvg} color="blue" />
						</Tile>
						<Tile
							label="Memory"
							value={`${fmtGiB(fleet.summary.memUsedGiB)} GiB`}
							sub={`${fmtGiB(fleet.summary.memTotalGiB - fleet.summary.memUsedGiB)} GiB free across ${fleet.summary.online} online`}
							color="purple"
							delay={DELAY.tiles + DELAY.tileStep * 2}
						>
							<Gauge
								used={fleet.summary.memUsedGiB}
								total={fleet.summary.memTotalGiB}
								unit="GiB"
								color="purple"
							/>
						</Tile>
						<Tile
							label="Disk"
							value={
								fleet.summary.diskTotalGiB > 0
									? `${fmtGiB(fleet.summary.diskUsedGiB)} GiB`
									: "—"
							}
							sub={
								fleet.summary.diskTotalGiB > 0
									? `${fmtGiB(fleet.summary.diskTotalGiB - fleet.summary.diskUsedGiB)} GiB free on root volumes`
									: "no disk reported yet"
							}
							color="orange"
							delay={DELAY.tiles + DELAY.tileStep * 3}
						>
							<Gauge
								used={fleet.summary.diskUsedGiB}
								total={fleet.summary.diskTotalGiB}
								unit="GiB"
								color="orange"
							/>
						</Tile>
					</div>
				</Reveal>
			)}
			<Reveal className="shrink-0" delay={DELAY.tiles + DELAY.tileStep * 4}>
				<div className="gh-surface grid grid-cols-2 divide-x divide-y divide-border overflow-hidden rounded-lg lg:grid-cols-[1fr_1fr_1fr_1.35fr] lg:divide-y-0">
					<Tile
						label="Repositories"
						value={totals.projects}
						sub={`${totals.environments} environment${totals.environments === 1 ? "" : "s"}`}
						color="green"
						delay={DELAY.tiles + DELAY.tileStep * 4}
						onClick={() => onNavigate("Repositories")}
						className="group"
					>
						<TileLink>open repositories</TileLink>
					</Tile>
					<Tile
						label="Services"
						value={totals.services + organizedResources.length}
						sub={
							organizedResources.length > 0
								? "apps, databases and Cloudflare"
								: "applications and databases"
						}
						color="purple"
						delay={DELAY.tiles + DELAY.tileStep * 5}
					>
						<Meter
							parts={[
								{ label: "apps", value: totals.applications, color: "green" },
								{ label: "db", value: totals.databases, color: "purple" },
								...(organizedResources.length > 0
									? [{ label: "cloudflare", value: organizedResources.length, color: "blue" as const }]
									: []),
							]}
						/>
					</Tile>
					<Tile
						label="Running"
						value={statusBreakdown.running}
						sub={
							attention > 0
								? `${attention} errored`
								: totals.services === 0
									? "no fleet services yet"
									: `${statusBreakdown.idle} idle · nothing errored`
						}
						color={attention > 0 ? "red" : "green"}
						delay={DELAY.tiles + DELAY.tileStep * 6}
					>
						<Meter
							parts={[
								{ label: "running", value: statusBreakdown.running, color: "green" },
								{ label: "errored", value: attention, color: "red" },
								{ label: "idle", value: statusBreakdown.idle, color: "grey" },
							]}
						/>
					</Tile>
					<Tile
						label="Deploys"
						value={activity.today}
						sub={
							activity.inFlight > 0
								? `today · ${activity.inFlight} in flight · ${deploys14d} in 14 days`
								: `today · ${deploys14d} in the last 14 days`
						}
						color="orange"
						delay={DELAY.tiles + DELAY.tileStep * 7}
					>
						<DeployBars daily={activity.daily} delay={DELAY.tiles + DELAY.tileStep * 7} />
					</Tile>
				</div>
			</Reveal>
			<ProjectBoard
				data={data}
				overview={overview}
				delay={DELAY.tiles + 0.1}
				onOpen={onSelectProject}
				onViewAll={() => onNavigate("Repositories")}
				onNew={onNewProject}
			/>
		</div>
	);
};
