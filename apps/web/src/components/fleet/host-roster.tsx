import type { ReactNode } from "react";
import { DitherAvatar } from "../dither-kit";
import { cn } from "../../lib/utils";
import { hostCss, hostHue } from "./palette";
import { Reveal } from "./primitives";
import { type FleetHostView, formatUptime, GIB } from "./use-fleet";
import { diskPercent, pressureColor, pressureOf, pressureText, type Workloads, workloadsLabel } from "./workloads";

/** Uptime and load only take room when at least one host reports them. */
const columns = (vitals: boolean) =>
	vitals
		? "grid-cols-[minmax(0,1fr)_7rem] sm:grid-cols-[minmax(0,1fr)_5rem_5rem_8rem_13rem]"
		: "grid-cols-[minmax(0,1fr)_7rem] sm:grid-cols-[minmax(0,1fr)_8rem_13rem]";

/** GiB below a tebibyte, TiB with one decimal above — keeps 1.9 TB roots readable. */
const formatBytes = (bytes: number) =>
	bytes >= GIB * 1024
		? `${(bytes / (GIB * 1024)).toFixed(1)} TiB`
		: `${(bytes / GIB).toFixed(0)} GiB`;

interface CellProps {
	children: ReactNode;
	className?: string;
}

const Cell = ({ children, className }: CellProps) => (
	<span
		className={cn(
			"hidden text-right font-mono text-xs tabular-nums text-muted-foreground sm:block",
			className,
		)}
	>
		{children}
	</span>
);

interface HostRowProps {
	host: FleetHostView;
	workloads: Workloads | undefined;
	vitals: boolean;
	selected: boolean;
	dimmed: boolean;
	isolatable: boolean;
	delay: number;
	onSelect: (key: string | null) => void;
	onSpotlight: (key: string | null) => void;
}

const HostRow = ({
	host,
	workloads,
	vitals: showVitals,
	selected,
	dimmed,
	isolatable,
	delay,
	onSelect,
	onSpotlight,
}: HostRowProps) => {
	const { status } = host;
	const vitals = status.state === "online" ? status.sample : null;
	const diskPct = diskPercent(vitals);
	const disk = pressureOf(diskPct);
	const pending = status.state === "checking" ? "…" : "—";

	const dot =
		status.state === "online"
			? { backgroundColor: hostCss(host.color), boxShadow: `0 0 8px ${hostCss(host.color, 0.6)}` }
			: status.state === "unreachable"
				? { backgroundColor: "var(--destructive)" }
				: { backgroundColor: "var(--muted-foreground)" };

	return (
		<Reveal as="li" delay={delay}>
			{/* Dimming lives one level down: motion owns the li's inline opacity. */}
			<div
				className={cn(
					"transition-opacity duration-150",
					dimmed && "opacity-50",
				)}
			>
				<button
					type="button"
					disabled={!isolatable}
					aria-pressed={selected}
					onClick={() => onSelect(selected ? null : host.key)}
					onPointerEnter={() => onSpotlight(host.key)}
					onPointerLeave={() => onSpotlight(null)}
					onFocus={() => onSpotlight(host.key)}
					onBlur={() => onSpotlight(null)}
					className={cn(
						"gh-interactive grid w-full items-center gap-3 px-4 py-2.5 text-left disabled:cursor-default",
						columns(showVitals),
					)}
					style={{
						backgroundColor: selected ? hostCss(host.color, 0.08) : undefined,
						boxShadow: selected ? `inset 2px 0 0 ${hostCss(host.color)}` : undefined,
					}}
				>
					<span className="flex min-w-0 items-center gap-3">
						<span className="relative shrink-0">
							<DitherAvatar
								name={host.name}
								hue={hostHue(host.color)}
								size={28}
								bloom="low"
								className="rounded-[3px]"
							/>
							<span
								aria-hidden
								className={cn(
									"absolute -right-1 -bottom-1 size-2 rounded-full ring-2 ring-card",
									status.state === "checking" && "animate-pulse",
								)}
								style={dot}
							/>
						</span>
						<span className="flex min-w-0 flex-col">
							<span className="flex min-w-0 items-baseline gap-2">
								<span className="truncate text-sm font-medium">{host.name}</span>
								{host.aliases.length > 0 && (
									<span
										className="truncate text-[11px] text-muted-foreground/70"
										title={`Also registered as ${host.aliases.join(", ")}`}
									>
										+{host.aliases.length} alias
										{host.aliases.length === 1 ? "" : "es"}
									</span>
								)}
								{status.state === "unreachable" && (
									<span className="shrink-0 rounded-sm bg-destructive/15 px-1 font-mono text-[10px] uppercase tracking-[0.08em] text-destructive">
										unreachable
									</span>
								)}
							</span>
							<span className="truncate font-mono text-[11px] text-muted-foreground">
								{host.ip}
								{status.state === "online" && (
									<span className="hidden sm:inline">
										{" "}
										· {status.sample.cpuCount} cpu ·{" "}
										{(status.sample.memTotalBytes / GIB).toFixed(0)} GiB
									</span>
								)}
							</span>
						</span>
					</span>

					{showVitals && (
						<>
							<Cell>{vitals?.uptimeSec != null ? formatUptime(vitals.uptimeSec) : pending}</Cell>
							<Cell>{vitals?.loadAvg1 != null ? vitals.loadAvg1.toFixed(2) : pending}</Cell>
						</>
					)}
					<Cell className={workloads && !workloads.services.length && !workloads.databases.length ? "text-muted-foreground/70" : undefined}>
						{workloads ? workloadsLabel(workloads) : pending}
					</Cell>

					<span className="flex flex-col gap-1">
						<span className="flex items-baseline justify-between gap-2 font-mono text-[11px] tabular-nums text-muted-foreground">
							<span className="gh-eyebrow">disk</span>
							<span className={cn("whitespace-nowrap", pressureText(disk))}>
								{diskPct === null
									? pending
									: `${diskPct.toFixed(0)}% · ${formatBytes(vitals?.diskUsedBytes ?? 0)} / ${formatBytes(vitals?.diskTotalBytes ?? 0)}`}
							</span>
						</span>
						<span className="h-1 w-full overflow-hidden rounded-full bg-muted">
							<span
								className="block h-full rounded-full transition-[width] duration-700"
								style={{
									width: `${diskPct ?? 0}%`,
									backgroundColor: pressureColor(disk, hostCss(host.color)),
									boxShadow: disk === "ok" ? `0 0 6px ${hostCss(host.color, 0.5)}` : undefined,
								}}
							/>
						</span>
					</span>
				</button>
				{status.state === "unreachable" && (
					<p
						className="break-words px-4 pb-2.5 pl-14 font-mono text-[11px] text-destructive/80"
						title={status.error}
					>
						{status.error}
					</p>
				)}
			</div>
		</Reveal>
	);
};

interface HostRosterProps {
	hosts: FleetHostView[];
	/** Placed workloads by host key; undefined while the snapshot is empty. */
	workloads: Record<string, Workloads>;
	chartKeys: string[];
	selected: string | null;
	delay: number;
	onSelect: (key: string | null) => void;
	onSpotlight: (key: string | null) => void;
}

export const HostRoster = ({
	hosts,
	workloads,
	chartKeys,
	selected,
	delay,
	onSelect,
	onSpotlight,
}: HostRosterProps) => {
	const vitals = hosts.some(
		(h) => h.status.state === "online" && (h.status.sample.uptimeSec != null || h.status.sample.loadAvg1 != null),
	);
	return (
	<Reveal delay={delay}>
		<section className="gh-surface rounded-lg" aria-label="Host roster">
			<div className="flex items-baseline justify-between gap-3 px-4 pt-4 pb-3">
				<div className="flex flex-col gap-0.5">
					<span className="gh-eyebrow">Roster</span>
					<span className="text-sm font-medium">
						{hosts.length} host{hosts.length === 1 ? "" : "s"}
					</span>
				</div>
				<span className="font-mono text-[11px] text-muted-foreground">
					one row per endpoint · click to isolate
				</span>
			</div>
			<div
				className={cn(
					"grid gap-3 border-b border-border px-4 pb-1.5",
					columns(vitals),
				)}
			>
				<span className="gh-eyebrow">host</span>
				{vitals && (
					<>
						<Cell className="gh-eyebrow">uptime</Cell>
						<Cell className="gh-eyebrow">load</Cell>
					</>
				)}
				<Cell className="gh-eyebrow">runs</Cell>
				<span />
			</div>
			<ul className="divide-y divide-border">
				{hosts.map((host, i) => (
					<HostRow
						key={host.key}
						host={host}
						workloads={workloads[host.key]}
						vitals={vitals}
						selected={selected === host.key}
						dimmed={selected !== null && selected !== host.key}
						isolatable={chartKeys.includes(host.key)}
						delay={delay + 0.05 + i * 0.04}
						onSelect={onSelect}
						onSpotlight={onSpotlight}
					/>
				))}
			</ul>
		</section>
	</Reveal>
	);
};
