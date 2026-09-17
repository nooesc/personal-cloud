/** Never let absent or invalid server metadata turn a timer into a tight loop. */
export function fleetPollDelay(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(10_000, Math.min(60_000, value))
    : 10_000;
}
