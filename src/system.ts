/**
 * The governor's readings of the machine: power (Mac `pmset -g batt`, Windows the probe's `power`
 * op over `GetSystemPowerStatus`) and how busy the system is over 60 s (Mac load average per
 * core, Windows the share of CPU time idle, from `os.cpus()` which reads `GetSystemTimes`' per-core
 * counters).
 */
import { execFile } from "node:child_process";
import { cpus, loadavg } from "node:os";
import type { Busy, Power } from "./level.ts";

/** Mac: load average per core over this is busy. */
export const BUSY_LOAD = 0.85;
/** Windows: CPU idle under this % is busy. */
export const BUSY_IDLE_PCT = 15;

/** `pmset -g batt` → power; null when it says nothing usable. */
export function parsePmset(out: string): Power | null {
  const from = /Now drawing from '([^']+)'/.exec(out)?.[1];
  if (!from) return null;
  const m = /InternalBattery[^\n]*?\t(\d+)%/.exec(out) ?? /\b(\d{1,3})%;/.exec(out);
  return { ac: !/battery/i.test(from), battery: m ? Number(m[1]) : null };
}

export function macPower(): Promise<Power | null> {
  return new Promise((resolve) => {
    execFile("pmset", ["-g", "batt"], { timeout: 5000 }, (err, stdout) =>
      resolve(err ? null : parsePmset(String(stdout))),
    );
  });
}

/** The probe's `power` answer → power. ac null (unknown) with a battery reads as on battery. */
export function powerOf(
  a: { ac?: boolean | null; battery?: number | null } | null | undefined,
): Power | null {
  if (!a || (a.ac === undefined && a.battery === undefined)) return null;
  const battery = typeof a.battery === "number" && a.battery >= 0 ? a.battery : null;
  if (a.ac === null || a.ac === undefined) return battery === null ? null : { ac: false, battery };
  return { ac: a.ac, battery };
}

export interface CpuTimes {
  idle: number;
  total: number;
}

const sumTimes = (): CpuTimes => {
  let idle = 0;
  let total = 0;
  for (const c of cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
};

/**
 * How busy the system is. Mac: the 1-minute load average per core. Windows (and anything else):
 * idle CPU time over a sliding 60 s window of 10 s samples (null until the window is full).
 */
export function busyMeter(
  platform: NodeJS.Platform = process.platform,
  read: { load?: () => number; cores?: () => number; times?: () => CpuTimes } = {},
  now: () => number = () => performance.now(),
  windowMs = 60_000,
): () => Busy | null {
  if (platform === "darwin") {
    const load = read.load ?? (() => loadavg()[0] ?? 0);
    const cores = read.cores ?? (() => cpus().length || 1);
    return () => {
      const perCore = load() / cores();
      return { busy: perCore > BUSY_LOAD, why: `load ${perCore.toFixed(2)} per core` };
    };
  }
  const times = read.times ?? sumTimes;
  const samples: { t: number; idle: number; total: number }[] = [];
  return () => {
    const t = now();
    samples.push({ t, ...times() });
    while (samples.length > 2 && t - (samples[1] as { t: number }).t >= windowMs) samples.shift();
    const a = samples[0] as { t: number; idle: number; total: number };
    const b = samples.at(-1) as { t: number; idle: number; total: number };
    if (b.t - a.t < (windowMs * 5) / 6 || b.total <= a.total) return null;
    const idlePct = ((b.idle - a.idle) / (b.total - a.total)) * 100;
    return { busy: idlePct < BUSY_IDLE_PCT, why: `cpu idle ${Math.round(idlePct)}%` };
  };
}
