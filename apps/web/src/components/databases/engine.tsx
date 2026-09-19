import type { ProviderResource } from "../../lib/data";
import { cn } from "../../lib/utils";

/*
 * Engine identity shared by the Databases ledger, the provider strip and the
 * detail dialogs. One monogram per engine so a row reads at a glance whether
 * it is PostgreSQL on the fleet or a hosted backend, and which one.
 */

export type Engine = "postgresql" | ProviderResource["provider"];

/** Monogram, full label and the short name used in counts like "2 Convex". */
export const ENGINES: Record<
  Engine,
  { mark: string; label: string; short: string; tint: string }
> = {
  postgresql: {
    mark: "PG",
    label: "PostgreSQL",
    short: "PostgreSQL",
    tint: "bg-primary/12 text-primary ring-primary/25",
  },
  neon: {
    mark: "NE",
    label: "Neon",
    short: "Neon",
    tint: "bg-sky-400/12 text-sky-700 ring-sky-400/30 dark:text-sky-300",
  },
  convex: {
    mark: "CX",
    label: "Convex Cloud",
    short: "Convex",
    tint: "bg-orange-400/12 text-orange-700 ring-orange-400/30 dark:text-orange-300",
  },
  convex_self_hosted: {
    mark: "CX",
    label: "Convex · self-hosted",
    short: "Convex",
    tint: "bg-orange-400/12 text-orange-700 ring-orange-400/30 dark:text-orange-300",
  },
};

/**
 * Counts by short name in a fixed order (PostgreSQL, Neon, Convex) so a mix
 * reads the same in the page summary and every project band.
 */
export function engineMix(engines: Engine[]): [string, number][] {
  const counts: Record<string, number> = {};
  for (const e of engines)
    counts[ENGINES[e].short] = (counts[ENGINES[e].short] ?? 0) + 1;
  return [ENGINES.postgresql.short, ENGINES.neon.short, ENGINES.convex.short]
    .filter((short) => counts[short])
    .map((short) => [short, counts[short]]);
}

/** A small monogram tile; the tint is the only place engine colour appears. */
export function EngineMark({
  engine,
  size = 26,
  className,
}: {
  engine: Engine;
  size?: number;
  className?: string;
}) {
  const e = ENGINES[engine];
  return (
    <span
      aria-hidden
      title={e.label}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-[4px] font-mono font-semibold leading-none tracking-wide ring-1",
        e.tint,
        className,
      )}
    >
      {e.mark}
    </span>
  );
}

/** Host part of a URL, for "runs on" cells; the raw string when unparsable. */
export function hostOf(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
