import { useEffect, useRef, useState } from "react";
import { api, type Machine } from "../../lib/data";

export type HistoryPoint = { at: string; cpu: number; mem: number; disk: number };

export type FleetHistory = Record<string, HistoryPoint[]>;

type FleetHistoryResponse = {
  since: string;
  step_seconds: number;
  machines: FleetHistory;
};

const POLL_MS = 15_000;
const STEP_MS = 10_000;
const POINTS = 360;

/** FNV-1a over the machine id so every demo host gets its own stable curve. */
function hash(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Smooth, bounded wobble in [-1, 1]: three seeded sinusoids plus a slow random
 * walk with mean reversion, so the curve drifts without ever looking like noise.
 */
function wobble(rand: () => number) {
  const waves = Array.from({ length: 3 }, (_, i) => ({
    freq: (0.5 + rand() * 1.5) * (i + 1),
    phase: rand() * Math.PI * 2,
    weight: 1 / (i + 1),
  }));
  let walk = 0;
  return (t: number) => {
    walk += (rand() - 0.5) * 0.12 - walk * 0.05;
    let v = walk;
    for (const w of waves) v += Math.sin(t * w.freq * Math.PI * 2 + w.phase) * w.weight * 0.35;
    return Math.max(-1, Math.min(1, v));
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Deterministic in-browser series around the machine's current report. */
export function synthesizeHistory(machine: Machine, end: number): HistoryPoint[] {
  const rand = mulberry32(hash(machine.id));
  const cpuWobble = wobble(rand);
  const memWobble = wobble(rand);
  const { cpu_percent, memory_used, memory_total, disk_used, disk_total } = machine.report;
  const start = end - (POINTS - 1) * STEP_MS;
  const points: HistoryPoint[] = new Array(POINTS);
  for (let i = 0; i < POINTS; i++) {
    const t = i / POINTS;
    points[i] = {
      at: new Date(start + i * STEP_MS).toISOString(),
      cpu: clamp(cpu_percent + cpuWobble(t) * 8, 0, 100),
      mem: clamp(memory_used * (1 + memWobble(t) * 0.03), 0, memory_total),
      disk: clamp(disk_used, 0, disk_total),
    };
  }
  return points;
}

function synthesizeAll(machines: Machine[]): FleetHistory {
  const end = Math.floor(Date.now() / STEP_MS) * STEP_MS;
  const out: FleetHistory = {};
  for (const m of machines) out[m.id] = synthesizeHistory(m, end);
  return out;
}

/**
 * Last hour of per-machine vitals. Live: polls `/api/fleet/history` every 15s
 * and keeps the last good payload across errors. Demo: seeded client-side
 * series. Identity only changes when a poll lands or the machine set changes,
 * so charts don't repaint on every snapshot tick.
 */
export function useFleetHistory(live: boolean, machines: Machine[], enabled = true): FleetHistory {
  const [history, setHistory] = useState<FleetHistory>({});
  const latest = useRef(machines);
  latest.current = machines;
  const ids = machines.map((m) => m.id).join(",");

  useEffect(() => {
    if (!enabled) return;
    if (!live) {
      setHistory(synthesizeAll(latest.current));
      return;
    }
    // Never let a demo series survive into live mode.
    setHistory({});
    let cancelled = false;
    const load = async () => {
      try {
        const res = await api<FleetHistoryResponse>("/fleet/history");
        if (!cancelled) setHistory(res.machines ?? {});
      } catch {
        // Keep whatever we had; an auth or network failure shows no fake data.
      }
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [live, ids, enabled]);

  return history;
}

/** Fleet-wide series aligned on the most recent sample: CPU mean, byte sums. */
export function aggregateHistory(series: HistoryPoint[][]) {
  const length = series.reduce((n, s) => Math.max(n, s.length), 0);
  const cpu = new Array<number>(length);
  const mem = new Array<number>(length);
  const disk = new Array<number>(length);
  for (let i = 0; i < length; i++) {
    let hosts = 0;
    let c = 0;
    let m = 0;
    let d = 0;
    for (const s of series) {
      const p = s[i - (length - s.length)];
      if (!p) continue;
      hosts++;
      c += p.cpu;
      m += p.mem;
      d += p.disk;
    }
    cpu[i] = hosts ? c / hosts : 0;
    mem[i] = m;
    disk[i] = d;
  }
  return { cpu, mem, disk };
}

/** One vital as a plain series; `scale` turns bytes into percent of a total. */
export function pluck(points: HistoryPoint[] | undefined, key: "cpu" | "mem" | "disk", scale = 1): number[] {
  return points ? points.map((p) => p[key] * scale) : [];
}

export function clock(iso: string) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function ago(iso: string, now: number) {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/** Client-only clock so relative times never mismatch between SSR and hydration. */
export function useNow(intervalMs = 10_000) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
