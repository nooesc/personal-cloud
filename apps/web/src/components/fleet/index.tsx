import { Server } from "lucide-react";
import { useMemo } from "react";
import {
  Area,
  AreaChart,
  type ChartConfig,
  type DitherColor,
  Grid,
  Sparkline,
  Tooltip,
  XAxis,
  YAxis,
} from "../dither-kit";
import { type Machine, type Service, size } from "../../lib/data";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "../ui/card";
import { EmptyState, Meta, StatusDot } from "../ui/misc";
import { aggregateHistory, clock, type FleetHistory, type HistoryPoint, useFleetHistory, useNow } from "./history";
import { HostRow } from "./host-row";

export type { HistoryPoint } from "./history";
export { useFleetHistory } from "./history";

/* -- aggregate strip ------------------------------------------------------ */

function Tile({
  label,
  value,
  sub,
  color,
  data,
}: {
  label: string;
  value: string;
  sub: string;
  color: DitherColor;
  data: number[];
}) {
  return (
    <div className="gh-surface flex flex-col gap-1 rounded-lg p-4">
      <span className="gh-eyebrow">{label}</span>
      <span className="text-2xl font-semibold tabular-nums tracking-tight">{value}</span>
      <Meta>{sub}</Meta>
      <div className="mt-2 h-10 w-full">
        {data.length >= 2 ? (
          <Sparkline data={data} color={color} />
        ) : (
          <Meta className="flex h-full items-center text-muted-foreground/60">collecting…</Meta>
        )}
      </div>
    </div>
  );
}

/* -- fleet panel ---------------------------------------------------------- */

export function FleetPanel({
  machines,
  services,
  live,
  stream,
  onSelect,
  onAdd,
  search,
  history: historyProp,
}: {
  machines: Machine[];
  services: Service[];
  live: boolean;
  stream: string;
  onSelect: (m: Machine) => void;
  onAdd: () => void;
  search: string;
  /** Pass the shell's `useFleetHistory` result to share one poller with the machine dialog. */
  history?: FleetHistory;
}) {
  const fetched = useFleetHistory(live, machines, historyProp === undefined);
  const history = historyProp ?? fetched;
  const now = useNow();

  const online = machines.filter((m) => m.status === "online").length;
  const totals = machines.reduce(
    (acc, m) => {
      acc.cpu += m.report.cpu_percent;
      acc.memUsed += m.report.memory_used;
      acc.memTotal += m.report.memory_total;
      acc.diskUsed += m.report.disk_used;
      acc.diskTotal += m.report.disk_total;
      return acc;
    },
    { cpu: 0, memUsed: 0, memTotal: 0, diskUsed: 0, diskTotal: 0 },
  );
  const cpuAvg = machines.length ? totals.cpu / machines.length : 0;

  const ids = machines.map((m) => m.id).join(",");
  const { memTotal, diskTotal } = totals;
  const aggregate = useMemo(() => {
    const agg = aggregateHistory(ids ? ids.split(",").map((id) => history[id] ?? []) : []);
    // Percent of fleet capacity so the slab height means something.
    const memScale = memTotal ? 100 / memTotal : 0;
    const diskScale = diskTotal ? 100 / diskTotal : 0;
    return { cpu: agg.cpu, mem: agg.mem.map((v) => v * memScale), disk: agg.disk.map((v) => v * diskScale) };
  }, [history, ids, memTotal, diskTotal]);

  const serviceCount = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of services) {
      const id = s.machine_id ?? s.demo_machine;
      if (id) counts[id] = (counts[id] ?? 0) + 1;
    }
    return counts;
  }, [services]);

  const streamStatus = stream === "Live updates" ? "online" : live ? "degraded" : "idle";

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <CardTitle>Fleet</CardTitle>
          <Meta>
            {machines.length} host{machines.length === 1 ? "" : "s"} · {online} online
          </Meta>
        </div>
        <span className="flex items-center gap-2">
          <StatusDot status={streamStatus} />
          <Meta>{live ? stream : "Sample data"}</Meta>
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {machines.length ? (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <Tile
                label="CPU · fleet average"
                value={`${cpuAvg.toFixed(0)}%`}
                sub="mean of enrolled hosts"
                color="green"
                data={aggregate.cpu}
              />
              <Tile
                label="Memory"
                value={size(totals.memUsed)}
                sub={`of ${size(memTotal)} · ${memTotal ? ((totals.memUsed / memTotal) * 100).toFixed(0) : 0}% in use`}
                color="blue"
                data={aggregate.mem}
              />
              <Tile
                label="Disk"
                value={size(totals.diskUsed)}
                sub={`of ${size(diskTotal)} · ${diskTotal ? ((totals.diskUsed / diskTotal) * 100).toFixed(0) : 0}% in use`}
                color="purple"
                data={aggregate.disk}
              />
            </div>
            <ul className="flex flex-col gap-2" aria-label="Host roster">
              {machines.map((m) => (
                <HostRow
                  key={m.id}
                  machine={m}
                  services={serviceCount[m.id] ?? 0}
                  history={history[m.id]}
                  live={live}
                  now={now}
                  onSelect={onSelect}
                />
              ))}
            </ul>
          </>
        ) : (
          <EmptyState
            icon={<Server />}
            title={search ? "No matching machines" : "Your cloud starts with a machine"}
            description={
              search
                ? "Try a different hostname or tag."
                : "Bring a home computer, a VPS, or both. Add your first machine to see its resources here."
            }
            action={
              !search && (
                <Button variant="outline" size="sm" onClick={onAdd}>
                  Add your first machine
                </Button>
              )
            }
          />
        )}
      </CardContent>
      <CardFooter className="justify-between gap-3">
        <Meta>{live ? "Updated every 10 seconds" : "Sample fleet · no infrastructure connected"}</Meta>
        <Button variant="link" size="xs" onClick={onAdd}>
          Add machine
        </Button>
      </CardFooter>
    </Card>
  );
}

/* -- machine detail ------------------------------------------------------- */

const CPU_CONFIG: ChartConfig = { cpu: { label: "CPU", color: "green" } };
const CHART_MARGINS = { top: 8, right: 8, bottom: 22, left: 36 };

function Usage({ label, used, total }: { label: string; used: number; total: number }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  return (
    <div className="gh-surface flex flex-col gap-2 rounded-lg p-4">
      <span className="flex items-baseline justify-between gap-2">
        <span className="gh-eyebrow">{label}</span>
        <Meta>{pct.toFixed(0)}%</Meta>
      </span>
      <span className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <span className="block h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </span>
      <Meta>
        {size(used)} / {size(total)}
      </Meta>
    </div>
  );
}

export function MachineDetailBody({
  machine,
  live,
  history,
}: {
  machine: Machine;
  live: boolean;
  history?: HistoryPoint[];
}) {
  const r = machine.report;
  const rows = useMemo(() => (history ?? []).map((p) => ({ t: clock(p.at), cpu: p.cpu })), [history]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <StatusDot status={machine.status} />
        <span className="text-sm capitalize">{machine.status}</span>
        <Badge variant="outline">{machine.location}</Badge>
        {machine.roles.map((role) => (
          <Badge key={role} variant="blank">
            {role}
          </Badge>
        ))}
      </div>

      <div className="flex flex-col gap-2">
        <span className="flex items-baseline justify-between gap-2">
          <span className="gh-eyebrow">CPU · last hour</span>
          <Meta>{r.cpu_percent.toFixed(0)}% now</Meta>
        </span>
        {rows.length >= 2 ? (
          <div className="h-44 w-full">
            <AreaChart data={rows} config={CPU_CONFIG} animate={false} bloom="low" margins={CHART_MARGINS}>
              <Grid />
              <XAxis dataKey="t" maxTicks={6} />
              <YAxis tickFormatter={(v) => `${v}%`} />
              <Tooltip labelKey="t" valueFormatter={(v) => `${v.toFixed(0)}%`} />
              <Area dataKey="cpu" />
            </AreaChart>
          </div>
        ) : (
          <div className="gh-surface flex h-44 items-center justify-center rounded-lg" role="status">
            <Meta>{live ? "Collecting samples…" : "No samples"}</Meta>
          </div>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Usage label="Memory" used={r.memory_used} total={r.memory_total} />
        <Usage label="Disk" used={r.disk_used} total={r.disk_total} />
      </div>

      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Operating system</dt>
        <dd>{r.os}</dd>
        <dt className="text-muted-foreground">Architecture</dt>
        <dd className="font-mono text-xs">{r.architecture}</dd>
        <dt className="text-muted-foreground">CPU cores</dt>
        <dd className="font-mono text-xs">{r.cpu_cores}</dd>
        <dt className="text-muted-foreground">Docker</dt>
        <dd>{r.docker ? "Responding" : "Unavailable"}</dd>
        <dt className="text-muted-foreground">Nomad</dt>
        <dd>{r.nomad ? "Responding" : "Unavailable"}</dd>
        <dt className="text-muted-foreground">Private IP</dt>
        <dd className="font-mono text-xs">{r.private_ip ?? "—"}</dd>
        <dt className="text-muted-foreground">Tags</dt>
        <dd>{machine.tags.join(", ") || "None"}</dd>
        <dt className="text-muted-foreground">Last heartbeat</dt>
        <dd className="font-mono text-xs">{live ? new Date(machine.last_seen).toLocaleString() : "Sample data"}</dd>
      </dl>
    </div>
  );
}
