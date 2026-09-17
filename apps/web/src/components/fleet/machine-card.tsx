import { motion, useReducedMotion } from "motion/react";
import type { CSSProperties, ReactNode } from "react";
import type { Machine, MachineCapability } from "../../lib/data";
import { cn } from "../../lib/utils";
import { DitherAvatar, DitherGradient } from "../dither-kit";
import { Database } from "lucide-react";
import { Button } from "../ui/button";
import { StatusDot } from "../ui/misc";
import { type HostColor, hostColorAt, hostCss, hostHue } from "./palette";
import { Collecting, Reveal } from "./primitives";
import { MACHINE_STATE } from "../readiness";
import { Spark } from "./spark";
import {
	diskPercent,
	memPercent,
	pressureColor,
	pressureOf,
	pressureText,
	type Workloads,
	workloadsLabel,
} from "./workloads";
import {
	type FleetHostView,
	formatUptime,
	GIB,
	type Sample,
} from "./use-fleet";

/**
 * `online` has a live sample, `unreachable` failed its last poll, `pending`
 * has never answered (no fleet host yet, or still being checked).
 */
type MachineState = "online" | "unreachable" | "pending";

const STATE_DOT: Record<MachineState, CSSProperties> = {
	online: {
		backgroundColor: hostCss("green"),
		boxShadow: `0 0 8px ${hostCss("green", 0.6)}`,
	},
	unreachable: { backgroundColor: "var(--destructive)" },
	pending: { backgroundColor: "var(--muted-foreground)" },
};

const STATE_LABEL: Record<MachineState, string> = {
	online: "reachable",
	unreachable: "unreachable",
	pending: "pending",
};

/** GiB below a tebibyte, TiB with one decimal above. */
const formatBytes = (bytes: number) =>
	bytes >= GIB * 1024
		? `${(bytes / (GIB * 1024)).toFixed(1)} TiB`
		: `${(bytes / GIB).toFixed(0)} GiB`;

const chipClass =
	"shrink-0 rounded-sm border px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.08em]";

/** Capability chip tone per server-computed machine state. */
const CAPABILITY_CHIP: Record<MachineCapability["state"], string> = {
 apple_ready: "border-primary/30 bg-primary/10 text-primary",
	ready: "border-primary/30 bg-primary/10 text-primary",
	checking: "border-yellow-500/30 text-yellow-500",
	needs_setup: "border-destructive/30 text-destructive",
	offline: "border-destructive/30 text-destructive",
	reporting_only: "border-border bg-muted text-muted-foreground",
};

interface VitalProps {
	label: string;
	children: ReactNode;
}

const Vital = ({ label, children }: VitalProps) => (
	<span className="flex min-w-0 flex-col gap-0.5">
		<span className="gh-eyebrow">{label}</span>
		<span className="whitespace-nowrap font-mono text-xs tabular-nums">
			{children}
		</span>
	</span>
);

interface VitalsBandProps {
	sample: Sample;
	cpuHistory: number[];
	color: HostColor;
}

/** Live readings for a reachable host: the numbers, a CPU spark, the disk bar. */
const VitalsBand = ({ sample, cpuHistory, color }: VitalsBandProps) => {
	const diskPct = diskPercent(sample);
	const disk = pressureOf(diskPct);
	const mem = pressureOf(memPercent(sample));
	return (
		<div className="flex flex-col gap-2.5 rounded border border-border bg-background/40 p-3">
			<div className="flex flex-wrap gap-x-5 gap-y-2">
				<Vital label="cpu">
					{sample.cpuPercent === null
						? "—"
						: `${sample.cpuPercent.toFixed(0)}%`}
					<span className="text-muted-foreground"> / {sample.cpuCount}c</span>
				</Vital>
				<Vital label="mem">
					<span className={pressureText(mem)}>{(sample.memUsedBytes / GIB).toFixed(1)}</span>
					<span className="text-muted-foreground">
						{" "}
						/ {(sample.memTotalBytes / GIB).toFixed(0)} GiB
					</span>
				</Vital>
				<Vital label="load">
					{sample.loadAvg1 === null ? "—" : sample.loadAvg1.toFixed(2)}
				</Vital>
				<Vital label="up">
					{sample.uptimeSec === null ? "—" : formatUptime(sample.uptimeSec)}
				</Vital>
			</div>
			<span className="block h-7">
				{cpuHistory.length < 2 ? (
					<Collecting className="h-full" hint="collecting cpu" />
				) : (
					<Spark data={cpuHistory} color={color} />
				)}
			</span>
			<span className="flex flex-col gap-1">
				<span className="flex items-baseline justify-between gap-2 font-mono text-[11px] tabular-nums text-muted-foreground">
					<span className="gh-eyebrow">disk</span>
					<span className={cn("whitespace-nowrap", pressureText(disk))}>
						{diskPct === null
							? "—"
							: `${diskPct.toFixed(0)}% · ${formatBytes(sample.diskUsedBytes ?? 0)} / ${formatBytes(sample.diskTotalBytes ?? 0)}`}
					</span>
				</span>
				<span className="h-1 w-full overflow-hidden rounded-full bg-muted">
					<span
						className="block h-full rounded-full transition-[width] duration-700"
						style={{
							width: `${diskPct ?? 0}%`,
							backgroundColor: pressureColor(disk, hostCss(color)),
							boxShadow: disk === "ok" ? `0 0 6px ${hostCss(color, 0.5)}` : undefined,
						}}
					/>
				</span>
			</span>
		</div>
	);
};

interface MachineCardProps {
	machine: Machine;
	/** The fleet host polling this machine, when the sampler knows it. */
	host: FleetHostView | undefined;
	/** Server-computed capability; undefined when the control plane does not publish readiness. */
	capability?: MachineCapability;
	/** CPU % per fleet sample for the matched host; empty when there is none. */
	cpuHistory: number[];
	/** Services and databases placed here. */
	workloads: Workloads;
	/** Opens the service's project with that service focused. */
	onOpenService: (projectId: string, serviceId: string) => void;
	/** Position in the grid; picks the palette slot for a machine the fleet hasn't coloured yet. */
	index: number;
	delay: number;
	onOpen: () => void;
}

export const MachineCard = ({
	machine,
	host,
	capability,
	cpuHistory,
	workloads,
	index,
	delay,
	onOpen,
	onOpenService,
}: MachineCardProps) => {
	const reduce = useReducedMotion();
	const state: MachineState =
		!host || host.status.state === "checking" ? "pending" : host.status.state;
	const color = host?.color ?? hostColorAt(index);
	const name = machine.report.hostname;

	return (
		<Reveal as="li" delay={delay} className="min-w-0">
			<motion.article
				whileHover={reduce ? undefined : { y: -2 }}
				transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
				className="gh-surface group relative flex h-full flex-col overflow-hidden rounded-lg"
			>
				<DitherGradient
					from={color}
					direction="left"
					cell={3}
					opacity={0.16}
					className="top-0 right-0 bottom-auto left-auto h-28 w-48 opacity-70 transition-opacity duration-300 [mask-image:linear-gradient(to_bottom,#000,transparent)] group-hover:opacity-100"
				/>

				<div className="relative flex flex-col gap-3 p-4">
					<div className="flex items-start justify-between gap-3">
						<div className="flex min-w-0 items-center gap-3">
							<span className="relative shrink-0">
								<DitherAvatar
									name={name}
									hue={hostHue(color)}
									size={36}
									bloom="low"
									className="rounded-[3px]"
								/>
								<span
									role="img"
									aria-label={STATE_LABEL[state]}
									title={STATE_LABEL[state]}
									className={cn(
										"absolute -right-1 -bottom-1 size-2.5 rounded-full ring-2 ring-card",
										state === "pending" && "animate-pulse",
									)}
									style={STATE_DOT[state]}
								/>
							</span>
							<div className="flex min-w-0 flex-col gap-0.5">
								<span className="flex min-w-0 items-baseline gap-2">
									<span className="truncate text-[15px] font-medium leading-tight">
										{name}
									</span>
									{state === "unreachable" && (
										<span className="shrink-0 rounded-sm bg-destructive/15 px-1 font-mono text-[10px] uppercase tracking-[0.08em] text-destructive">
											unreachable
										</span>
									)}
								</span>
								<span className="gh-eyebrow flex flex-wrap items-center gap-1.5 font-mono">
									{machine.report.private_ip && (
										<>
											<span className="normal-case">
												{machine.report.private_ip}
											</span>
											<span aria-hidden="true">·</span>
										</>
									)}
									<span>{machine.location}</span>
									{machine.roles.length > 0 && (
										<>
											<span aria-hidden="true">·</span>
											<span className="normal-case">
												{machine.roles.join(", ")}
											</span>
										</>
									)}
								</span>
							</div>
						</div>
						<div className="flex shrink-0 items-center gap-1.5 self-start">
							<span
								className={cn(
									chipClass,
									machine.location === "home"
										? "border-border bg-muted text-muted-foreground"
										: "border-primary/30 bg-primary/10 text-primary",
								)}
							>
								{machine.location}
							</span>
							{capability ? (
								<span
									title={MACHINE_STATE[capability.state].label}
									className={cn(chipClass, CAPABILITY_CHIP[capability.state])}
								>
									{MACHINE_STATE[capability.state].short}
								</span>
							) : (
								<span
									title="Readiness unavailable"
									className={cn(
										chipClass,
										"border-border text-muted-foreground",
									)}
								>
									unknown
								</span>
							)}
						</div>
					</div>

					{host?.status.state === "online" ? (
						<VitalsBand
							sample={host.status.sample}
							cpuHistory={cpuHistory}
							color={color}
						/>
					) : host?.status.state === "unreachable" ? (
						<p
							className="break-words font-mono text-[11px] text-destructive/80"
							title={host.status.error}
						>
							{host.status.error}
						</p>
					) : (
						<Collecting className="h-9" hint="no vitals yet" />
					)}

					<div className="flex flex-col gap-1.5">
						<span className="flex items-baseline justify-between gap-2 font-mono text-[11px] text-muted-foreground">
							<span className="gh-eyebrow">runs</span>
							<span className="tabular-nums">
								{workloadsLabel(workloads)}
								{workloads.deploying > 0 && (
									<span className="text-yellow-500"> · {workloads.deploying} deploying</span>
								)}
							</span>
						</span>
						{(workloads.services.length > 0 || workloads.databases.length > 0) && (
							<ul className="flex flex-wrap gap-1.5" aria-label="Workloads">
								{workloads.services.map((w) => (
									<li key={w.service.id}>
										<button
											type="button"
											disabled={!w.project}
											onClick={() => w.project && onOpenService(w.project.id, w.service.id)}
											title={w.project ? `${w.project.name} › ${w.service.name}` : w.service.name}
											className="gh-interactive inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/70 bg-background/60 px-2 py-0.5 font-mono text-[11px] hover:border-primary/50 hover:text-primary disabled:hover:border-border/70 disabled:hover:text-inherit"
										>
											<StatusDot
												status={w.deploying ? "deploying" : (w.service.status ?? "idle")}
												className="size-1.5"
											/>
											<span className="truncate">{w.service.name}</span>
										</button>
									</li>
								))}
								{workloads.databases.map((d) => (
									<li key={d.id}>
										<span
											title={`${d.name} · pinned to this machine${d.status ? ` · ${d.status}` : ""}`}
											className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/70 bg-background/40 px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
										>
											<Database className="size-3 shrink-0" />
											<span className="truncate">{d.name}</span>
										</span>
									</li>
								))}
							</ul>
						)}
					</div>

					{capability && capability.state !== "ready" && capability.state !== "apple_ready" && capability.reasons[0] && (
						<p className="flex items-start gap-2 text-[12px] text-muted-foreground">
							<StatusDot status={MACHINE_STATE[capability.state].dot} className="mt-1.5 shrink-0" />
							<span>{capability.reasons[0]}</span>
						</p>
					)}
				</div>

				<div className="relative mt-auto border-t border-border px-4 py-3">
					<Button size="sm" variant={capability?.state === "needs_setup" ? "default" : "outline"} onClick={onOpen}>
						{capability?.state === "needs_setup" ? "Finish setup" : "Manage"}
					</Button>
				</div>
			</motion.article>
		</Reveal>
	);
};
