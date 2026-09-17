import { useEffect, useRef, useState } from "react";
import { FleetCharts } from "./fleet-charts";
import { HostRoster } from "./host-roster";
import type { Fleet } from "./use-fleet";
import { attentionOf, type Workloads } from "./workloads";

interface FleetSectionProps {
	fleet: Fleet;
	workloads: Record<string, Workloads>;
	delay: number;
}

/**
 * The `#fleet` landing: host chips, the shared CPU and memory charts, then the
 * roster. Selecting a host — from a chip, a chart series, or a roster row —
 * isolates it everywhere at once; the state lives here so a hover only
 * re-renders this section.
 */
export const FleetSection = ({ fleet, workloads, delay }: FleetSectionProps) => {
	const ref = useRef<HTMLElement>(null);
	const [selected, setSelected] = useState<string | null>(null);
	const [focus, setFocus] = useState<string | null>(null);

	// The section mounts after the permission query settles, which is after
	// the browser has already tried (and failed) to jump to a `#fleet` deep link.
	useEffect(() => {
		if (window.location.hash === "#fleet") ref.current?.scrollIntoView();
	}, []);

	// A host can drop out of the charts (no readings left in the window); an
	// isolation on it would dim everything, so treat it as "show all".
	const chartKeys = fleet.chartHosts.map((host) => host.key);
	const isolated =
		selected !== null && chartKeys.includes(selected) ? selected : null;

	// Hosts under pressure or out of reach, named before the charts so the
	// page answers "what do I fix" before "how does it look".
	const attention = fleet.hosts
		.map((h) =>
			attentionOf(
				h.name,
				h.status.state === "online" ? h.status.sample : null,
				h.status.state === "unreachable" ? h.status.error : null,
			),
		)
		.filter((n): n is string => n !== null);

	return (
		<section
			ref={ref}
			id="fleet"
			className="flex scroll-mt-4 flex-col gap-4"
			aria-label="Fleet"
		>
			{attention.length > 0 && (
				<p
					role="status"
					className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md border border-yellow-500/30 bg-yellow-500/5 px-3 py-2 font-mono text-[12px]"
				>
					<span className="text-yellow-500">
						{attention.length} host{attention.length === 1 ? "" : "s"} need{attention.length === 1 ? "s" : ""} attention
					</span>
					{attention.map((n) => (
						<span key={n} className="text-muted-foreground">
							{n}
						</span>
					))}
				</p>
			)}
			<FleetCharts
				fleet={fleet}
				selected={isolated}
				focus={focus}
				delay={delay}
				onSelect={setSelected}
				onSpotlight={setFocus}
			/>
			<HostRoster
				hosts={fleet.hosts}
				workloads={workloads}
				chartKeys={chartKeys}
				selected={isolated}
				delay={delay + 0.15}
				onSelect={setSelected}
				onSpotlight={setFocus}
			/>
		</section>
	);
};
