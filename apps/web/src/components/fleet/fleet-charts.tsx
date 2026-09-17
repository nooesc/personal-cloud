import { type ReactNode, useEffect, useMemo } from "react";
import {
	Area,
	AreaChart,
	Grid,
	Tooltip,
	XAxis,
	YAxis,
} from "../dither-kit";
import { useCommonChart } from "../dither-kit/common-context";
import { Collecting, Curtain, HostChip, Reveal } from "./primitives";
import type { Fleet } from "./use-fleet";

/**
 * Mirrors the page-level selection/spotlight into a chart root, so the shared
 * host chips and the roster drive both charts at once. Sits in the DOM layer
 * and renders nothing.
 */
const SelectionBridge = ({
	selected,
	focus,
}: {
	selected: string | null;
	focus: string | null;
}) => {
	const { selectedDataKey, selectDataKey, focusDataKey, setFocusDataKey } =
		useCommonChart();
	useEffect(() => {
		if (selectedDataKey !== selected) selectDataKey(selected);
	}, [selected, selectedDataKey, selectDataKey]);
	useEffect(() => {
		if (focusDataKey !== focus) setFocusDataKey(focus);
	}, [focus, focusDataKey, setFocusDataKey]);
	return null;
};
SelectionBridge.chartLayer = "dom" as const;

const MARGINS = { top: 8, right: 8, bottom: 22, left: 40 };

interface PanelProps {
	eyebrow: string;
	title: string;
	note: string;
	delay: number;
	ready: boolean;
	children: ReactNode;
}

const Panel = ({ eyebrow, title, note, delay, ready, children }: PanelProps) => (
	<Reveal delay={delay} className="gh-surface relative rounded-lg">
		<div className="flex items-baseline justify-between gap-3 px-4 pt-4">
			<div className="flex flex-col gap-0.5">
				<span className="gh-eyebrow">{eyebrow}</span>
				<span className="text-sm font-medium">{title}</span>
			</div>
			<span className="font-mono text-[11px] text-muted-foreground">
				{note}
			</span>
		</div>
		<div className="relative h-56 px-2 pt-3 pb-2">
			{ready ? (
				<>
					{children}
					<Curtain delay={delay + 0.1} className="rounded-b-lg" />
				</>
			) : (
				<Collecting
					className="h-full"
					hint="collecting samples · first point after two polls"
				/>
			)}
		</div>
	</Reveal>
);

interface FleetChartsProps {
	fleet: Fleet;
	selected: string | null;
	focus: string | null;
	/** Reveal offset of the chip row; the two panels follow it */
	delay: number;
	onSelect: (key: string | null) => void;
	onSpotlight: (key: string | null) => void;
}

export const FleetCharts = ({
	fleet,
	selected,
	focus,
	delay,
	onSelect,
	onSpotlight,
}: FleetChartsProps) => {
	const { hosts, chartHosts, chartConfig, cpuRows, memRows, samples } = fleet;
	const ready = samples.length >= 2;
	const chartKeys = chartHosts.map((host) => host.key);

	// Last known total per host, so the % axis stays shared while the tooltip
	// still speaks GiB.
	const memTotals = useMemo(() => {
		const totals: Record<string, number> = {};
		for (let i = samples.length - 1; i >= 0; i--) {
			const sample = samples[i];
			if (!sample) continue;
			for (const key of Object.keys(sample.readings)) {
				if (totals[key] === undefined) {
					totals[key] = sample.readings[key]?.memTotalGiB ?? 0;
				}
			}
		}
		return totals;
	}, [samples]);

	return (
		<div className="flex flex-col gap-3">
			<Reveal
				delay={delay}
				className="flex flex-wrap items-center gap-2 px-1"
			>
				<span className="gh-eyebrow mr-1">Fleet</span>
				{hosts.map((host) => (
					<HostChip
						key={host.key}
						host={host}
						selected={selected === host.key}
						dimmed={selected !== null && selected !== host.key}
						isolatable={chartKeys.includes(host.key)}
						onSelect={onSelect}
						onSpotlight={onSpotlight}
					/>
				))}
				<span className="ml-auto font-mono text-[11px] text-muted-foreground">
					{selected === null
						? "click a host to isolate it"
						: "click again to show every host"}
				</span>
			</Reveal>

			<div className="grid gap-3 lg:grid-cols-2">
				<Panel
					eyebrow="CPU"
					title="Utilisation, every host"
					note="% of each host"
					delay={delay + 0.05}
					ready={ready}
				>
					<AreaChart
						data={cpuRows}
						config={chartConfig}
						bloom="aura"
						animate={false}
						margins={MARGINS}
						onSelectionChange={onSelect}
					>
						<Grid />
						<XAxis dataKey="time" maxTicks={6} />
						<YAxis tickFormatter={(v) => `${v}%`} />
						<Tooltip
							labelKey="time"
							valueFormatter={(v) => `${v.toFixed(0)}%`}
						/>
						<SelectionBridge selected={selected} focus={focus} />
						{chartKeys.map((key) => (
							<Area key={key} dataKey={key} variant="dotted" isClickable />
						))}
					</AreaChart>
				</Panel>

				<Panel
					eyebrow="Memory"
					title="In use, every host"
					note="% of each host's total · GiB on hover"
					delay={delay + 0.1}
					ready={ready}
				>
					<AreaChart
						data={memRows}
						config={chartConfig}
						bloom="aura"
						animate={false}
						margins={MARGINS}
						onSelectionChange={onSelect}
					>
						<Grid />
						<XAxis dataKey="time" maxTicks={6} />
						<YAxis tickFormatter={(v) => `${v}%`} />
						<Tooltip
							labelKey="time"
							valueFormatter={(v, name) => {
								const total = memTotals[name];
								return total
									? `${v.toFixed(0)}% · ${((v / 100) * total).toFixed(1)} GiB`
									: `${v.toFixed(0)}%`;
							}}
						/>
						<SelectionBridge selected={selected} focus={focus} />
						{chartKeys.map((key) => (
							<Area
								key={key}
								dataKey={key}
								variant="gradient"
								isClickable
							/>
						))}
					</AreaChart>
				</Panel>
			</div>
		</div>
	);
};
