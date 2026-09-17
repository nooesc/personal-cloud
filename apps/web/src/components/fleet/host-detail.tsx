import type { ReactNode } from "react";
import type { Machine, MachineCapability } from "../../lib/data";
import { capabilityLabel, MACHINE_STATE } from "../readiness";
import { Meta, StatusDot } from "../ui/misc";
import { hostCss } from "./palette";
import { Collecting, HostSwatch } from "./primitives";
import { type FleetHostView, formatUptime, GIB } from "./use-fleet";

/** GiB below a tebibyte, TiB with one decimal above — keeps 1.9 TB roots readable. */
const formatBytes = (bytes: number) =>
	bytes >= GIB * 1024
		? `${(bytes / (GIB * 1024)).toFixed(1)} TiB`
		: `${(bytes / GIB).toFixed(0)} GiB`;

interface FactProps {
	label: string;
	children: ReactNode;
}

const Fact = ({ label, children }: FactProps) => (
	<>
		<dt className="text-muted-foreground">{label}</dt>
		<dd className="font-mono text-xs">{children}</dd>
	</>
);

interface HostDetailProps {
	/** Undefined until the sampler has seen the machine */
	host: FleetHostView | undefined;
	machine: Machine;
	/** Server-computed capability; undefined when the control plane does not publish readiness. */
	capability?: MachineCapability;
	live: boolean;
}

/**
 * The machine dialog body: what the control plane says the machine can do,
 * the host's latest vitals in `LocalDetail`'s frame, then the static facts
 * from its last heartbeat. Shows the collecting placeholder until the sampler
 * has a reading for the host.
 */
export const HostDetail = ({
	host,
	machine,
	capability,
	live,
}: HostDetailProps) => {
	const sample = host?.status.state === "online" ? host.status.sample : null;
	const { report } = machine;
	const diskPct =
		sample &&
		sample.diskUsedBytes !== null &&
		sample.diskTotalBytes !== null &&
		sample.diskTotalBytes > 0
			? (sample.diskUsedBytes / sample.diskTotalBytes) * 100
			: null;

	return (
		<section className="gh-surface rounded-lg">
			<div
				role="status"
				className="flex flex-col gap-1 border-b border-border px-4 py-3"
			>
				<span className="flex items-center gap-2 text-sm font-medium">
					<StatusDot
						status={capability ? MACHINE_STATE[capability.state].dot : "idle"}
					/>
					{capabilityLabel(capability)}
				</span>
				{capability?.reasons.map((reason) => (
					<Meta key={reason}>{reason}</Meta>
				))}
			</div>
			{host && sample ? (
				<>
					<div className="flex w-full items-center gap-3 rounded-t-lg px-4 py-3 text-left">
						<HostSwatch host={host} />
						<span className="flex min-w-0 flex-col">
							<span className="gh-eyebrow">Host · live vitals</span>
							<span className="text-sm font-medium">
								{host.name} · {host.ip}
							</span>
						</span>
						<span className="ml-auto hidden font-mono text-[11px] text-muted-foreground sm:block">
							cpu · memory · disk · uptime · load
						</span>
					</div>
					<div className="border-t border-border px-4 py-4">
						<dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
							<Fact label="CPU">
								{sample.cpuPercent === null
									? "—"
									: `${sample.cpuPercent.toFixed(0)}% · ${sample.cpuCount} cpu`}
							</Fact>
							<Fact label="Memory">
								{sample.memTotalBytes > 0
									? `${((sample.memUsedBytes / sample.memTotalBytes) * 100).toFixed(0)}% · ${(sample.memUsedBytes / GIB).toFixed(1)} / ${(sample.memTotalBytes / GIB).toFixed(0)} GiB`
									: "—"}
							</Fact>
							<Fact label="Disk">
								<span className="flex flex-col gap-1">
									<span>
										{diskPct === null
											? "—"
											: `${diskPct.toFixed(0)}% · ${formatBytes(sample.diskUsedBytes ?? 0)} / ${formatBytes(sample.diskTotalBytes ?? 0)}`}
									</span>
									<span className="h-1 w-full overflow-hidden rounded-full bg-muted">
										<span
											className="block h-full rounded-full transition-[width] duration-700"
											style={{
												width: `${diskPct ?? 0}%`,
												backgroundColor: hostCss(host.color),
												boxShadow: `0 0 6px ${hostCss(host.color, 0.5)}`,
											}}
										/>
									</span>
								</span>
							</Fact>
							<Fact label="Uptime">
								{sample.uptimeSec != null ? formatUptime(sample.uptimeSec) : "—"}
							</Fact>
							<Fact label="Load">
								{sample.loadAvg1 != null ? sample.loadAvg1.toFixed(2) : "—"}
							</Fact>
							<Fact label="Containers">{sample.containerCount}</Fact>
						</dl>
					</div>
				</>
			) : (
				<div className="px-4 py-4">
					<Collecting className="h-24" />
				</div>
			)}
			<div className="border-t border-border px-4 py-4">
				<dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
					<Fact label="OS">{report.os}</Fact>
					<Fact label="Architecture">{report.architecture}</Fact>
					<Fact label="Cores">{report.cpu_cores}</Fact>
					<Fact label="Docker">{report.docker ? "yes" : "no"}</Fact>
					<Fact label="Nomad">
						{report.nomad
							? report.nomad_node_id
								? `yes · ${report.nomad_node_id}`
								: "yes"
							: "no"}
					</Fact>
					<Fact label="Private IP">{report.private_ip ?? "—"}</Fact>
					<Fact label="Roles">
						{machine.roles.length > 0 ? machine.roles.join(", ") : "—"}
					</Fact>
					<Fact label="Tags">
						{machine.tags.length > 0 ? machine.tags.join(", ") : "—"}
					</Fact>
					<Fact label="Last heartbeat">
						{live ? new Date(machine.last_seen).toLocaleString() : "Sample data"}
					</Fact>
				</dl>
			</div>
		</section>
	);
};
