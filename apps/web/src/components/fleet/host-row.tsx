import { useMemo } from "react";
import { type DitherColor, Sparkline } from "../dither-kit";
import { type Machine, size } from "../../lib/data";
import { Badge } from "../ui/badge";
import { Meta, StatusDot } from "../ui/misc";
import { ago, type HistoryPoint, pluck } from "./history";

export const COLUMNS =
  "grid grid-cols-[auto_minmax(0,1fr)_auto] sm:grid-cols-[auto_minmax(0,1fr)_repeat(3,minmax(0,6rem))_auto] items-center gap-3";

/** Inline spark for one vital: a fixed-height canvas box with the current reading beneath. */
function Spark({ data, color, value }: { data: number[]; color: DitherColor; value: string }) {
  return (
    <span className="hidden min-w-0 flex-col gap-0.5 sm:flex">
      <span className="h-6 w-full">
        {data.length >= 2 ? (
          <Sparkline data={data} color={color} />
        ) : (
          <Meta className="flex h-full items-center justify-center text-muted-foreground/60">…</Meta>
        )}
      </span>
      <Meta className="truncate">{value}</Meta>
    </span>
  );
}

export function HostRow({
  machine: m,
  services,
  history,
  live,
  now,
  onSelect,
}: {
  machine: Machine;
  services: number;
  history?: HistoryPoint[];
  live: boolean;
  now: number | null;
  onSelect: (m: Machine) => void;
}) {
  const r = m.report;
  const cpu = useMemo(() => pluck(history, "cpu"), [history]);
  const mem = useMemo(() => pluck(history, "mem", r.memory_total ? 100 / r.memory_total : 0), [history, r.memory_total]);
  const disk = useMemo(() => pluck(history, "disk", r.disk_total ? 100 / r.disk_total : 0), [history, r.disk_total]);
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(m)}
        title={`Open ${r.hostname}`}
        className={`gh-interactive w-full rounded-md border border-border bg-card px-3 py-2 text-left ${COLUMNS}`}
      >
        <StatusDot status={m.status} />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-sm font-medium">{r.hostname}</span>
            {m.tags.map((tag) => (
              <Badge key={tag} variant="blank">
                {tag}
              </Badge>
            ))}
          </span>
          <Meta className="truncate">
            {m.location} · {m.roles.join(" · ")} · {r.private_ip ?? "no private ip"}
          </Meta>
        </span>
        <Spark data={cpu} color="green" value={`${r.cpu_percent.toFixed(0)}% cpu`} />
        <Spark data={mem} color="blue" value={`${size(r.memory_used)} mem`} />
        <Spark data={disk} color="purple" value={`${size(r.disk_used)} disk`} />
        <span className="flex flex-col items-end gap-0.5 text-right">
          <Meta className="whitespace-nowrap">
            {services} service{services === 1 ? "" : "s"}
          </Meta>
          <Meta className="whitespace-nowrap">
            {!live ? "sample" : now === null ? "—" : ago(m.last_seen, now)}
          </Meta>
        </span>
      </button>
    </li>
  );
}
