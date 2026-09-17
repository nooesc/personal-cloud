import { fleetPollDelay } from "./polling";
import { format } from "date-fns";
import { useEffect, useMemo, useState } from "react";
import type { ChartConfig } from "../dither-kit";
import { api } from "../../lib/data";
import { type HostColor, hostColorAt } from "./palette";

export const GIB = 1024 ** 3;
/** Sampler cadence and ring capacity assumed until the first payload lands; the server is authoritative. */
export const POLL_MS = 10_000;
export const MAX_SAMPLES = 360;

export const LOCAL_HOST_KEY = "local";

/** One server-side sample of a host, as the sampler stores it. */
export type Sample = {
	t: number;
	cpuPercent: number | null;
	loadAvg1: number | null;
	memUsedBytes: number;
	memTotalBytes: number;
	diskUsedBytes: number | null;
	diskTotalBytes: number | null;
	uptimeSec: number | null;
	cpuCount: number;
	containerCount: number;
};
type HistoryHost = {
	hostKey: string;
	serverId: string | null;
	name: string;
	aliases: string[];
	ipAddress: string | null;
	status: "ok" | "unreachable" | "pending";
	error: string | null;
	latest: Sample | null;
	samples: Sample[];
};
/** `GET /api/fleet/history` — the sampler's ring for every host in the account. */
type FleetHistory = {
	pollMs: number;
	maxSamples: number;
	hosts: HistoryHost[];
};

export interface FleetHost {
	/** The serverId of the first registration for an endpoint, or `local` for the Dinghy host */
	key: string;
	/** Absent for the local host */
	serverId?: string;
	name: string;
	ip: string;
	/** Other registrations pointing at the same endpoint (deduped away) */
	aliases: string[];
	color: HostColor;
}

export type HostStatus =
	| { state: "checking" }
	| { state: "online"; sample: Sample }
	| { state: "unreachable"; error: string };

export type FleetHostView = FleetHost & { status: HostStatus };

/** One host's reading at a snapshot. Only present when the host answered. */
export interface HostReading {
	cpu: number | null;
	/** memUsed / memTotal, 0–100; null when the total is unknown */
	memPct: number | null;
	memUsedGiB: number;
	memTotalGiB: number;
	containers: number;
	/** Root filesystem; null when the agent did not report disk. */
	diskUsedGiB: number | null;
	diskTotalGiB: number | null;
}

export interface FleetSample {
	t: number;
	readings: Record<string, HostReading>;
}

/** A chart row: the formatted time plus one numeric column per host key. */
export type SeriesRow = Record<string, number | string>;

const NO_HOSTS: HistoryHost[] = [];

// Local always takes palette slot 0; remotes follow in payload (registration)
// order so a colour sticks to a host as the fleet grows.
const buildViews = (hosts: HistoryHost[]): FleetHostView[] => {
	const local = hosts.find((h) => h.hostKey === LOCAL_HOST_KEY);
	const remotes = hosts.filter((h) => h.hostKey !== LOCAL_HOST_KEY);
	const views: FleetHostView[] = [];
	if (local) {
		views.push(viewOf(local, hostColorAt(0), "Dinghy host"));
	}
	remotes.forEach((host, i) => {
		views.push(viewOf(host, hostColorAt(i + 1), host.ipAddress ?? "—"));
	});
	return views;
};

const viewOf = (
	host: HistoryHost,
	color: HostColor,
	ip: string,
): FleetHostView => ({
	key: host.hostKey,
	serverId: host.serverId ?? undefined,
	name: host.name,
	ip,
	aliases: host.aliases,
	color,
	status:
		host.status === "ok" && host.latest
			? { state: "online", sample: host.latest }
			: host.status === "unreachable"
				? { state: "unreachable", error: host.error ?? "unreachable" }
				: { state: "checking" },
});

const readingOf = (sample: Sample): HostReading => ({
	cpu: sample.cpuPercent,
	memPct:
		sample.memTotalBytes > 0
			? (sample.memUsedBytes / sample.memTotalBytes) * 100
			: null,
	memUsedGiB: sample.memUsedBytes / GIB,
	memTotalGiB: sample.memTotalBytes / GIB,
	containers: sample.containerCount,
	diskUsedGiB: sample.diskUsedBytes === null ? null : sample.diskUsedBytes / GIB,
	diskTotalGiB: sample.diskTotalBytes === null ? null : sample.diskTotalBytes / GIB,
});

// Hosts sample at slightly different moments within a cycle, so their
// timestamps are snapped to the sampler grid and merged into one row per tick.
// A host that failed a tick simply has no reading in that row.
const buildSamples = (
	hosts: HistoryHost[],
	pollMs: number,
	maxSamples: number,
): FleetSample[] => {
	const byTick = new Map<number, FleetSample>();
	for (const host of hosts) {
		for (const sample of host.samples) {
			const t = Math.round(sample.t / pollMs) * pollMs;
			let row = byTick.get(t);
			if (!row) {
				row = { t, readings: {} };
				byTick.set(t, row);
			}
			row.readings[host.hostKey] = readingOf(sample);
		}
	}
	const rows = [...byTick.values()].sort((a, b) => a.t - b.t);
	return rows.length > maxSamples ? rows.slice(rows.length - maxSamples) : rows;
};

interface Aggregate {
	containers: number;
	/** Mean of the hosts that report CPU; null until one does */
	cpuAvg: number | null;
	memUsedGiB: number;
	memTotalGiB: number;
	/** Summed over the hosts that report disk only. */
	diskUsedGiB: number;
	diskTotalGiB: number;
}

const aggregate = (readings: HostReading[]): Aggregate => {
	const cpus = readings
		.map((r) => r.cpu)
		.filter((c): c is number => c !== null);
	return {
		containers: readings.reduce((sum, r) => sum + r.containers, 0),
		cpuAvg:
			cpus.length === 0
				? null
				: cpus.reduce((sum, c) => sum + c, 0) / cpus.length,
		memUsedGiB: readings.reduce((sum, r) => sum + r.memUsedGiB, 0),
		memTotalGiB: readings.reduce((sum, r) => sum + r.memTotalGiB, 0),
		diskUsedGiB: readings.reduce((sum, r) => sum + (r.diskUsedGiB ?? 0), 0),
		diskTotalGiB: readings.reduce((sum, r) => sum + (r.diskTotalGiB ?? 0), 0),
	};
};

export interface FleetSummary extends Aggregate {
	online: number;
	total: number;
	/** One value per sample, for the tile sparklines */
	history: {
		online: number[];
		containers: number[];
		cpuAvg: number[];
		memUsedGiB: number[];
		diskUsedGiB: number[];
	};
}

export interface Fleet {
	hosts: FleetHostView[];
	samples: FleetSample[];
	/** `live · last 42 min · every 5s`, or a collecting hint before two samples exist */
	windowLabel: string;
	summary: FleetSummary;
	/** Hosts with at least one sample in the window — the chart series */
	chartHosts: FleetHostView[];
	chartConfig: ChartConfig;
	cpuRows: SeriesRow[];
	memRows: SeriesRow[];
}

/**
 * Reads the server-side sampler's history for every host in the organisation
 * and folds it into one shared, time-aligned sample list so all hosts can
 * share a chart. The full window arrives on the first fetch, so the page is
 * populated immediately; refetches on the sampler's own cadence keep it live.
 *
 * `enabled: false` skips the query entirely (the summary reads as an empty
 * fleet) for viewers who may not see the fleet at all.
 */
export const useFleet = ({
	enabled = true,
}: { enabled?: boolean } = {}): Fleet => {
	const [data, setData] = useState<FleetHistory>();
	useEffect(() => {
		if (!enabled) {
			setData(undefined);
			return;
		}
		setData(undefined);
		let cancelled = false;
		let pollMs = POLL_MS;
		let timer: number | undefined;
		const poll = async () => {
			try {
				const next = await api<FleetHistory>("/fleet/history");
				if (cancelled) return;
				if (!Array.isArray(next.hosts)) throw new Error("Incompatible fleet history response");
				pollMs = fleetPollDelay(next.pollMs);
				setData({ ...next, pollMs });
			} catch {
				// Keep the previous payload; an auth or network failure never shows fake data.
				if (cancelled) return;
				pollMs = 60_000;
			}
			timer = window.setTimeout(poll, fleetPollDelay(pollMs));
		};
		void poll();
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [enabled]);
	const pollMs = data?.pollMs ?? POLL_MS;
	const maxSamples = data?.maxSamples ?? MAX_SAMPLES;
	const hosts = data?.hosts ?? NO_HOSTS;

	const views = useMemo(() => buildViews(hosts), [hosts]);
	const samples = useMemo(
		() => buildSamples(hosts, pollMs, maxSamples),
		[hosts, pollMs, maxSamples],
	);

	// Series identity: hosts with at least one sample in the window. Keyed on a
	// signature so the chart config keeps its identity between polls — the kit
	// re-derives bands/series on change.
	const sampled = new Set(
		hosts.filter((h) => h.samples.length > 0).map((h) => h.hostKey),
	);
	const chartHosts = views.filter((view) => sampled.has(view.key));
	const chartSig = chartHosts
		.map((host) => `${host.key}\u0000${host.name}\u0000${host.color}`)
		.join("\n");
	const chartConfig = useMemo<ChartConfig>(() => {
		const config: ChartConfig = {};
		for (const host of chartHosts) {
			config[host.key] = { label: host.name, color: host.color };
		}
		return config;
	}, [chartSig]);
	const chartKeys = useMemo(() => Object.keys(chartConfig), [chartConfig]);

	const { cpuRows, memRows } = useMemo(() => {
		const cpu: SeriesRow[] = [];
		const mem: SeriesRow[] = [];
		for (const sample of samples) {
			const time = format(sample.t, "HH:mm:ss");
			const cpuRow: SeriesRow = { time };
			const memRow: SeriesRow = { time };
			for (const key of chartKeys) {
				const reading = sample.readings[key];
				cpuRow[key] = reading?.cpu ?? 0;
				memRow[key] = reading?.memPct ?? 0;
			}
			cpu.push(cpuRow);
			mem.push(memRow);
		}
		return { cpuRows: cpu, memRows: mem };
	}, [samples, chartKeys]);

	const history = useMemo<FleetSummary["history"]>(() => {
		const perSample = samples.map((s) => aggregate(Object.values(s.readings)));
		return {
			online: samples.map((s) => Object.keys(s.readings).length),
			containers: perSample.map((a) => a.containers),
			cpuAvg: perSample.map((a) => a.cpuAvg ?? 0),
			memUsedGiB: perSample.map((a) => a.memUsedGiB),
			diskUsedGiB: perSample.map((a) => a.diskUsedGiB),
		};
	}, [samples]);

	const latest: HostReading[] = [];
	for (const view of views) {
		if (view.status.state === "online") {
			latest.push(readingOf(view.status.sample));
		}
	}
	const summary: FleetSummary = {
		online: latest.length,
		total: views.length,
		...aggregate(latest),
		history,
	};

	const first = samples[0];
	const last = samples[samples.length - 1];
	const windowLabel =
		first && last && samples.length > 1
			? `live · last ${formatWindow(last.t - first.t)} · every ${pollMs / 1000}s`
			: "collecting samples…";

	return {
		hosts: views,
		samples,
		windowLabel,
		summary,
		chartHosts,
		chartConfig,
		cpuRows,
		memRows,
	};
};

export const formatWindow = (ms: number) => {
	const minutes = Math.round(ms / 60000);
	if (minutes < 1) return `${Math.round(ms / 1000)}s`;
	if (minutes < 60) return `${minutes} min`;
	return `${(minutes / 60).toFixed(1)} h`;
};

/** "3d 4h" / "4h 12m" / "12m" */
export const formatUptime = (seconds: number) => {
	const d = Math.floor(seconds / 86400);
	const h = Math.floor((seconds % 86400) / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	if (d > 0) return `${d}d ${h}h`;
	if (h > 0) return `${h}h ${m}m`;
	return `${m}m`;
};
