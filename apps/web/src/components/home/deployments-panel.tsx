import { format } from "date-fns";
import { ArrowRight, Rocket } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import {
	HOST_PALETTE,
	hostCss,
	hostHue,
} from "../fleet/palette";
import {
	Curtain,
	Reveal,
} from "../fleet/primitives";
import {
	Bar,
	BarChart,
	type ChartConfig,
	type DitherColor,
	DitherAvatar,
	DitherGradient,
	Tooltip,
	XAxis,
} from "../dither-kit";
import { fnv1a } from "../dither-kit/pixel";
import { cn } from "../../lib/utils";
import type { Snapshot } from "../../lib/data";

export type Deployment = {
	deploymentId: string;
	status: "idle" | "running" | "done" | "error";
	title: string;
	createdAt: string;
	startedAt: string | null;
	finishedAt: string | null;
	service: {
		name: string;
		environment: string;
		projectName: string;
		projectId: string;
		serverName: string;
	};
};
type DeploymentStatus = "idle" | "running" | "done" | "error";

/** Personal-cloud deployment rows folded into the panel's view shape. */
export const toDeployments = (data: Snapshot): Deployment[] => {
	const out: Deployment[] = [];
	for (const d of data.deployments) {
		const service = data.services.find((s) => s.id === d.service_id);
		if (!service) continue;
		const project = data.projects.find((p) => p.id === service.project_id);
		if (!project) continue;
		const machine = data.machines.find(
			(m) => m.id === service.machine_id,
		);
		const status: DeploymentStatus =
			d.status === "queued" ||
			d.status === "building" ||
			d.status === "deploying"
				? "running"
				: d.status === "healthy"
					? "done"
					: d.status === "failed"
						? "error"
						: "idle";
		out.push({
			deploymentId: d.id,
			status,
			title:
				d.step && d.step !== "queued" && d.step !== "done"
					? d.step
					: "Deployment",
			createdAt: d.created_at,
			startedAt: d.created_at,
			finishedAt: d.finished_at ?? null,
			service: {
				name: service.name,
				environment: project.branch,
				projectName: project.name,
				projectId: project.id,
				serverName: machine?.report.hostname ?? "unplaced",
			},
		});
	}
	return out;
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Days in the deployments-by-day chart */
const CHART_DAYS = 14;
/** Below this many deployments a bar chart is mostly empty bins */
const CHART_MIN_DEPLOYMENTS = 10;
const RECENT_COUNT = 8;

const STATUS_LABEL: Record<DeploymentStatus, string> = {
	done: "done",
	running: "deploying",
	error: "failed",
	idle: "queued",
};

/** Dot + text colour per deployment state; null keeps the muted default. */
const statusStyle = (status: DeploymentStatus) => {
	switch (status) {
		case "done":
			return {
				dot: {
					backgroundColor: hostCss("green"),
					boxShadow: `0 0 8px ${hostCss("green", 0.6)}`,
				},
				text: undefined,
			};
		case "running":
			return {
				dot: {
					backgroundColor: hostCss("orange"),
					boxShadow: `0 0 8px ${hostCss("orange", 0.6)}`,
				},
				text: { color: hostCss("orange") },
			};
		case "error":
			return {
				dot: { backgroundColor: "var(--destructive)" },
				text: { color: "var(--destructive)" },
			};
		default:
			return {
				dot: { backgroundColor: "var(--muted-foreground)" },
				text: undefined,
			};
	}
};

/** A project's colour, stable across reloads — same palette the fleet uses for hosts. */
const projectColor = (projectName: string): DitherColor =>
	HOST_PALETTE[fnv1a(projectName) % HOST_PALETTE.length] ?? "green";

const getServiceInfo = (d: Deployment) => {
	const { name, environment, projectName, serverName } = d.service;
	return { name, environment, projectName, serverName, href: "#" };
};

/** "12s" / "3m 04s" / "1h 12m" */
const formatDuration = (ms: number) => {
	const s = Math.max(0, Math.round(ms / 1000));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
	if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
	return `${sec}s`;
};

/** "now" / "4m ago" / "3h ago" / "2d ago" — compact enough for a mono cell. */
const formatAgo = (ms: number) => {
	if (ms < 60_000) return "now";
	const m = Math.floor(ms / 60_000);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
};

/**
 * Elapsed for an in-flight deployment, wall time for a settled one. Null when
 * the record never got a start (pre-timestamp rows).
 */
const deploymentDuration = (d: Deployment, now: number): number | null => {
	const start = d.startedAt ?? d.createdAt;
	if (!start) return null;
	const startMs = new Date(start).getTime();
	if (d.status === "running") return now - startMs;
	if (!d.finishedAt) return null;
	return new Date(d.finishedAt).getTime() - startMs;
};

export interface DayBucket {
	day: string;
	deploys: number;
}

export interface Activity {
	recent: Deployment[];
	/** Since local midnight */
	today: number;
	inFlight: number;
	/** Deployments per hour over the last 24h, oldest first */
	hourly: number[];
	/** Deployments per day over the last CHART_DAYS, oldest first */
	daily: DayBucket[];
	total: number;
}

const NO_DEPLOYMENTS: Deployment[] = [];

/** Folds the deployment list into the header counts, both charts and the recent rows. */
export const bucketActivity = (
	list: Deployment[] | undefined = NO_DEPLOYMENTS,
	now: number,
): Activity => {
	const midnight = new Date(now);
	midnight.setHours(0, 0, 0, 0);
	const midnightMs = midnight.getTime();

	const hourly = new Array<number>(24).fill(0);
	const daily: DayBucket[] = [];
	for (let i = CHART_DAYS - 1; i >= 0; i--) {
		daily.push({
			day: format(midnightMs - i * DAY, "d MMM"),
			deploys: 0,
		});
	}

	let today = 0;
	let inFlight = 0;
	for (const d of list) {
		const t = new Date(d.createdAt).getTime();
		if (d.status === "running") inFlight++;
		if (t >= midnightMs) today++;
		const age = now - t;
		if (age >= 0 && age < DAY) {
			const slot = 23 - Math.floor(age / HOUR);
			hourly[slot] = (hourly[slot] ?? 0) + 1;
		}
		const daysBack =
			t >= midnightMs ? 0 : Math.floor((midnightMs - t) / DAY) + 1;
		const bucket = daily[CHART_DAYS - 1 - daysBack];
		if (bucket) bucket.deploys++;
	}

	const recent = [...list]
		.sort(
			(a, b) =>
				new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
		)
		.slice(0, RECENT_COUNT);

	return { recent, today, inFlight, hourly, daily, total: list.length };
};

/* ----------------------------------------------------------------------- */

const DEPLOY_COLUMNS =
	"grid-cols-[minmax(0,1fr)_4.5rem] sm:grid-cols-[minmax(0,1fr)_5.5rem_5rem_5rem]";
/** Feed mode sits in a ~2/5 column: name first, status and age; duration only when wide. */
const FEED_COLUMNS =
	"grid-cols-[minmax(0,1fr)_4.5rem] sm:grid-cols-[minmax(0,1fr)_5.5rem_4.5rem] 2xl:grid-cols-[minmax(0,1fr)_5.5rem_5rem_4.5rem]";

const DEPLOY_CHART_CONFIG: ChartConfig = {
	deploys: { label: "Deployments", color: "green" },
};
const DEPLOY_CHART_MARGINS = { top: 6, right: 8, bottom: 20, left: 8 };

const Cell = ({
	children,
	className,
	style,
}: {
	children: ReactNode;
	className?: string;
	style?: CSSProperties;
}) => (
	<span
		className={cn(
			"hidden truncate text-right font-mono text-xs tabular-nums text-muted-foreground sm:block",
			className,
		)}
		style={style}
	>
		{children}
	</span>
);

interface DeploymentRowProps {
	deployment: Deployment;
	now: number;
	delay: number;
	onOpen: (d: Deployment) => void;
	compact?: boolean;
}

const DeploymentRow = ({
	deployment: d,
	now,
	delay,
	onOpen,
	compact = false,
}: DeploymentRowProps) => {
	const info = getServiceInfo(d);
	if (!info) return null;
	const status = (d.status ?? "idle") as DeploymentStatus;
	const style = statusStyle(status);
	const duration = deploymentDuration(d, now);
	const createdMs = new Date(d.createdAt).getTime();
	const color = projectColor(info.projectName);

	return (
		<Reveal as="li" delay={delay}>
			<button
				type="button"
				onClick={() => onOpen(d)}
				className={cn(
					"gh-interactive grid w-full items-center gap-3 px-4 py-2.5 text-left",
					compact ? FEED_COLUMNS : DEPLOY_COLUMNS,
				)}
			>
				<span className="flex min-w-0 items-center gap-3">
					<span className="relative shrink-0">
						<DitherAvatar
							name={info.name}
							hue={hostHue(color)}
							size={28}
							bloom="low"
							className="rounded-[3px]"
						/>
						<span
							aria-hidden
							className={cn(
								"absolute -right-1 -bottom-1 size-2 rounded-full ring-2 ring-card",
								status === "running" && "animate-pulse",
							)}
							style={style.dot}
						/>
					</span>
					<span className="flex min-w-0 flex-col">
						<span className="flex min-w-0 items-baseline gap-2">
							<span className="truncate text-sm font-medium">{info.name}</span>
							{d.title && d.title !== "Deployment" && (
								<span className="hidden truncate text-[11px] text-muted-foreground/70 md:inline">
									{d.title}
								</span>
							)}
						</span>
						<span className="truncate font-mono text-[11px] text-muted-foreground">
							<span style={{ color: hostCss(color) }}>{info.projectName}</span>
							{" · "}
							{info.environment}
							{!compact && <span className="hidden lg:inline"> · {info.serverName}</span>}
						</span>
					</span>
				</span>

				<Cell style={style.text}>{STATUS_LABEL[status]}</Cell>
				<Cell className={cn(compact && "sm:hidden 2xl:block")}>
					{duration === null ? "—" : formatDuration(duration)}
				</Cell>
				<span
					className="truncate text-right font-mono text-xs tabular-nums text-muted-foreground"
					title={format(createdMs, "PPpp")}
				>
					{formatAgo(now - createdMs)}
				</span>
			</button>
		</Reveal>
	);
};

const DeploymentsEmpty = ({
	title,
	children,
	action,
}: {
	title?: string;
	children: ReactNode;
	action?: ReactNode;
}) => (
	<div className="relative flex min-h-56 flex-1 flex-col items-center justify-center gap-2 overflow-hidden p-8 text-center">
		<DitherGradient from="green" direction="up" cell={3} opacity={0.07} className="top-auto h-1/2" />
		<span
			className="relative flex size-10 items-center justify-center rounded-md border border-border bg-card"
			style={{ boxShadow: `0 0 24px ${hostCss("green", 0.18)}` }}
		>
			<Rocket className="size-4 text-muted-foreground" />
		</span>
		{title && <span className="relative mt-1 text-sm font-medium">{title}</span>}
		<span className="relative max-w-64 text-xs leading-relaxed text-muted-foreground">
			{children}
		</span>
		{action && <div className="relative mt-2 flex flex-wrap justify-center gap-2">{action}</div>}
	</div>
);

interface DeploymentsPanelProps {
	canRead: boolean;
	activity: Activity;
	now: number;
	delay: number;
	onOpen: (d: Deployment) => void;
	onViewAll: () => void;
	/**
	 * Feed mode: no chart, the panel fills its flex region and the rows scroll
	 * inside it. Shows every recent row rather than the fixed eight.
	 */
	fill?: boolean;
	/** In fill mode, the rows to list; defaults to `activity.recent`. */
	rows?: Deployment[];
	/** Buttons under the "nothing shipped" state. */
	emptyAction?: ReactNode;
}

/** The 14-day bar chart over the eight most recent deployments. */
export const DeploymentsPanel = ({
	canRead,
	activity,
	now,
	delay,
	onOpen,
	onViewAll,
	fill = false,
	rows,
	emptyAction,
}: DeploymentsPanelProps) => {
	const showChart = canRead && !fill && activity.total >= CHART_MIN_DEPLOYMENTS;
	const list = rows ?? activity.recent;
	return (
		<Reveal delay={delay} className={cn(fill && "flex min-h-0 flex-col")}>
			<section
				className={cn("gh-surface rounded-lg", fill && "flex min-h-0 flex-1 flex-col")}
				aria-label="Recent deployments"
			>
				<div className="flex items-baseline justify-between gap-3 px-4 pt-4 pb-3">
					<div className="flex flex-col gap-0.5">
						<span className="gh-eyebrow">Activity</span>
						<span className="text-sm font-medium">Recent deployments</span>
					</div>
					{canRead && (
						<button
							type="button"
							onClick={onViewAll}
							className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
						>
							view all
							<ArrowRight className="size-3" />
						</button>
					)}
				</div>

				{showChart && (
					<div className="border-t border-border px-2 pt-3">
						<div className="flex items-baseline justify-between px-2 pb-1">
							<span className="gh-eyebrow">Last {CHART_DAYS} days</span>
							<span className="font-mono text-[11px] tabular-nums text-muted-foreground">
								{activity.daily.reduce((sum, b) => sum + b.deploys, 0)} deploys
							</span>
						</div>
						<div className="relative h-28">
							<BarChart
								data={activity.daily}
								config={DEPLOY_CHART_CONFIG}
								bloom="low"
								animate={false}
								margins={DEPLOY_CHART_MARGINS}
							>
								<XAxis dataKey="day" maxTicks={7} />
								<Tooltip
									labelKey="day"
									valueFormatter={(v) => `${v} deploy${v === 1 ? "" : "s"}`}
								/>
								<Bar dataKey="deploys" variant="gradient" />
							</BarChart>
							<Curtain delay={delay + 0.1} />
						</div>
					</div>
				)}

				{!canRead ? (
					<div className="flex flex-1 flex-col border-t border-border">
						<DeploymentsEmpty>You do not have permission to view deployments.</DeploymentsEmpty>
					</div>
				) : list.length === 0 ? (
					<div className="flex flex-1 flex-col border-t border-border">
						<DeploymentsEmpty title="Nothing has shipped yet" action={emptyAction}>
							Every build, promotion and rollback lands here as it happens, with
							logs one click away.
						</DeploymentsEmpty>
					</div>
				) : (
					<>
						<div
							className={cn(
								"grid shrink-0 gap-3 border-y border-border px-4 pt-3 pb-1.5",
								fill ? FEED_COLUMNS : DEPLOY_COLUMNS,
							)}
						>
							<span className="gh-eyebrow">service</span>
							<Cell className="gh-eyebrow">status</Cell>
							<Cell className={cn("gh-eyebrow", fill && "sm:hidden 2xl:block")}>took</Cell>
							<span className="gh-eyebrow text-right">when</span>
						</div>
						<ul
							className={cn(
								"divide-y divide-border",
								fill && "min-h-0 flex-1 overflow-y-auto no-scrollbar",
							)}
						>
							{list.map((d, i) => (
								<DeploymentRow
									key={d.deploymentId}
									deployment={d}
									now={now}
									delay={delay + 0.05 + Math.min(i, 12) * 0.04}
									onOpen={onOpen}
									compact={fill}
								/>
							))}
						</ul>
					</>
				)}
			</section>
		</Reveal>
	);
};
