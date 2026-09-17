import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import {
	Bar,
	BarChart,
	type ChartConfig,
	type DitherColor,
	Tooltip,
} from "../dither-kit";
import { hostCss } from "../fleet/palette";
import { Curtain, Reveal } from "../fleet/primitives";
import { Spark } from "../fleet/spark";
import { cn } from "../../lib/utils";
import type { DayBucket } from "./deployments-panel";

/**
 * One cell of the stat strip: a coloured hairline, eyebrow, big number, one
 * line of context and a footer slot (meter, chart or link) that bottom-aligns
 * across the row.
 */
export const Tile = ({
	label,
	value,
	sub,
	color,
	delay,
	children,
	className,
	onClick,
}: {
	label: string;
	value: ReactNode;
	sub: ReactNode;
	color: DitherColor;
	delay: number;
	children?: ReactNode;
	className?: string;
	/** Whole tile becomes a button when set. */
	onClick?: () => void;
}) => {
	const body = (
		<>
			<span
				aria-hidden
				className="pointer-events-none absolute inset-x-0 top-0 h-px"
				style={{
					background: `linear-gradient(90deg, ${hostCss(color, 0.9)}, ${hostCss(color, 0.25)} 55%, transparent)`,
				}}
			/>
			<span className="gh-eyebrow">{label}</span>
			<span className="mt-1 text-[28px] font-semibold leading-none tabular-nums tracking-tight">
				{value}
			</span>
			<span className="mt-1.5 truncate text-[11px] text-muted-foreground">{sub}</span>
			<div className="mt-auto flex min-h-8 w-full items-end pt-3">{children}</div>
		</>
	);
	const cls = cn(
		"relative flex min-h-[8.25rem] w-full flex-col px-4 pt-4 pb-3 text-left",
		onClick && "gh-interactive cursor-pointer",
		className,
	);
	return (
		<Reveal delay={delay} className="flex min-w-0">
			{onClick ? (
				<button type="button" onClick={onClick} className={cls}>
					{body}
				</button>
			) : (
				<div className={cls}>{body}</div>
			)}
		</Reveal>
	);
};

/** Segmented bar with a legend; zero-total renders the track alone. */
export const Meter = ({
	parts,
}: {
	parts: { label: string; value: number; color: DitherColor }[];
}) => {
	const total = parts.reduce((n, p) => n + p.value, 0);
	return (
		<div className="flex w-full flex-col gap-2">
			<div className="flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-border/60">
				{total > 0 &&
					parts
						.filter((p) => p.value > 0)
						.map((p) => (
							<span
								key={p.label}
								className="h-full"
								style={{
									width: `${(p.value / total) * 100}%`,
									backgroundColor: hostCss(p.color),
									boxShadow: `0 0 8px ${hostCss(p.color, 0.5)}`,
								}}
							/>
						))}
			</div>
			<ul className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
				{parts.map((p) => (
					<li key={p.label} className="flex items-center gap-1.5">
						<span
							aria-hidden
							className="size-1.5 rounded-[2px]"
							style={{
								backgroundColor: p.value > 0 ? hostCss(p.color) : "var(--border)",
							}}
						/>
						<span className={cn("tabular-nums", p.value > 0 && "text-foreground")}>
							{p.value}
						</span>
						{p.label}
					</li>
				))}
			</ul>
		</div>
	);
};

/**
 * One resource against its capacity: a fill bar with the used/total legend.
 * `pct` beyond 85 warms the fill so a full disk reads at a glance.
 */
export const Gauge = ({
	used,
	total,
	unit,
	color,
}: {
	used: number;
	total: number;
	unit: string;
	color: DitherColor;
}) => {
	const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
	const fill: DitherColor = pct >= 90 ? "red" : pct >= 75 ? "orange" : color;
	return (
		<div className="flex w-full flex-col gap-2">
			<div className="h-1.5 w-full overflow-hidden rounded-full bg-border/60">
				<span
					className="block h-full rounded-full transition-[width] duration-700 ease-out"
					style={{
						width: `${pct}%`,
						backgroundColor: hostCss(fill),
						boxShadow: `0 0 8px ${hostCss(fill, 0.5)}`,
					}}
				/>
			</div>
			<span className="flex items-baseline justify-between font-mono text-[11px] tabular-nums text-muted-foreground">
				<span>
					<span className="text-foreground">{fmt(used)}</span>
					{" / "}
					{fmt(total)} {unit}
				</span>
				<span>{total > 0 ? `${Math.round(pct)}%` : "—"}</span>
			</span>
		</div>
	);
};
const fmt = (n: number) => (n >= 100 ? Math.round(n).toString() : n.toFixed(1));

/** The tile footer as a sparkline over the fleet's sample history. */
export const SparkSlot = ({ history, color }: { history: number[]; color: DitherColor }) =>
	history.length < 2 ? (
		<span className="font-mono text-[11px] text-muted-foreground">collecting…</span>
	) : (
		<span className="block h-8 w-full">
			<Spark data={history} color={color} />
		</span>
	);

const DEPLOY_CHART_CONFIG: ChartConfig = {
	deploys: { label: "Deployments", color: "green" },
};
const DEPLOY_CHART_MARGINS = { top: 2, right: 0, bottom: 0, left: 0 };

/** Fourteen dithered bars, one per day; a flat baseline when nothing has shipped. */
export const DeployBars = ({ daily, delay }: { daily: DayBucket[]; delay: number }) => {
	const total = daily.reduce((n, d) => n + d.deploys, 0);
	if (total === 0) {
		return (
			<span
				aria-hidden
				className="mb-1 block h-px w-full"
				style={{ backgroundColor: hostCss("green", 0.5) }}
			/>
		);
	}
	return (
		<div className="relative h-12 w-full">
			<BarChart
				data={daily}
				config={DEPLOY_CHART_CONFIG}
				bloom="low"
				animate={false}
				margins={DEPLOY_CHART_MARGINS}
			>
				<Tooltip
					labelKey="day"
					valueFormatter={(v) => `${v} deploy${v === 1 ? "" : "s"}`}
				/>
				<Bar dataKey="deploys" variant="gradient" />
			</BarChart>
			<Curtain delay={delay + 0.1} />
		</div>
	);
};

export const TileLink = ({ children }: { children: ReactNode }) => (
	<span className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground transition-colors group-hover:text-foreground">
		{children}
		<ArrowRight className="size-3" />
	</span>
);
