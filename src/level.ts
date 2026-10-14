/**
 * The level governor. Every 2 s the recorder asks it which capture level fits the machine right
 * now: `full` on AC with a calm system, `lean` on a low battery, a busy system or when autotrack's
 * own CPU (recorder + helpers) ran over budget for 60 s, `normal` otherwise. A burst of input that
 * runs over budget for 10 s steps the level down one (to `lean` past twice the budget) until the
 * burst is over. What each level costs is `LEVELS`. Pure: readings come in, so tests feed it fakes.
 */
import type { Level } from "./events.ts";

export type { Level };

export interface LevelParams {
  /** The ring's period while active; a ring frame this old or newer is a key's "before". */
  ringMs: number;
  /** After-frame: grab every this many ms until two grabs agree; null = one grab 300 ms after. */
  settleTickMs: number | null;
  /** Native crops at clicks, drag starts and scrolls. */
  crops: boolean;
  /** Idle frames at most this often. */
  idleMs: number;
  /** Trees after an act that moved the screen (focus changes always ask for one). */
  treesOnScreen: boolean;
  /** At most one tree this often. */
  treeMs: number;
}

export const LEVELS: Record<Level, LevelParams> = {
  full: {
    ringMs: 250,
    settleTickMs: 100,
    crops: true,
    idleMs: 1000,
    treesOnScreen: true,
    treeMs: 1000,
  },
  normal: {
    ringMs: 500,
    settleTickMs: 150,
    crops: true,
    idleMs: 2000,
    treesOnScreen: true,
    treeMs: 2000,
  },
  lean: {
    ringMs: 1000,
    settleTickMs: null,
    crops: false,
    idleMs: 5000,
    treesOnScreen: false,
    treeMs: 5000,
  },
};

export const LEVEL_TICK_MS = 2_000;
export const POWER_POLL_MS = 60_000;
/** Own CPU and system load are judged over this window. */
export const WINDOW_MS = 60_000;
/** A burst: own CPU over this short window. */
export const BURST_MS = 10_000;
/** % of one core, recorder + helpers, on average. */
export const CPU_BUDGET_PCT = 3;
/** Back from a CPU-forced `lean` only under this (so it does not flap at the line). */
export const CPU_RESUME_PCT = 2;
export const LOW_BATTERY_PCT = 20;

export interface Power {
  /** On mains (or no battery at all). */
  ac: boolean;
  /** Charge %, null when there is no battery. */
  battery: number | null;
}

export interface Busy {
  busy: boolean;
  /** What was measured, for `why`. */
  why: string;
}

export interface LevelInputs {
  /** null: not known (no answer yet). */
  power: Power | null;
  busy: Busy | null;
  /** Own CPU, % of one core over the last 60 s; null until 60 s of samples. */
  cpuPct: number | null;
  /** Own CPU over the last 10 s; null until 10 s of samples. */
  burstPct?: number | null;
}

export interface Decision {
  level: Level;
  why: string;
}

const pct = (n: number) => `${Math.round(n)}%`;

const STEP_DOWN: Record<Level, Level> = { full: "normal", normal: "lean", lean: "lean" };

/**
 * The level for these readings. `prev` keeps a CPU-forced `lean` until CPU drops under 2%, and a
 * burst's step down until the burst drops under 2%.
 */
export function decide(i: LevelInputs, prev: Decision | null = null): Decision {
  const d = calm(i, prev);
  if (d.level === "lean" || i.burstPct === null || i.burstPct === undefined) return d;
  const b = i.burstPct;
  const why = `burst: own cpu ${b.toFixed(1)}% over 10 s`;
  if (b > 2 * CPU_BUDGET_PCT) return { level: "lean", why };
  const held = prev?.why.startsWith("burst") ?? false;
  if (b > CPU_BUDGET_PCT || (held && b >= CPU_RESUME_PCT))
    return { level: STEP_DOWN[d.level], why };
  return d;
}

/** The level without the burst rule. */
function calm(i: LevelInputs, prev: Decision | null): Decision {
  const p = i.power;
  if (p && !p.ac && p.battery !== null && p.battery < LOW_BATTERY_PCT)
    return { level: "lean", why: `battery ${pct(p.battery)}` };
  if (i.busy?.busy) return { level: "lean", why: `system busy: ${i.busy.why}` };
  if (i.cpuPct !== null) {
    const held = prev?.level === "lean" && prev.why.startsWith("own cpu");
    if (i.cpuPct > CPU_BUDGET_PCT || (held && i.cpuPct >= CPU_RESUME_PCT))
      return { level: "lean", why: `own cpu ${i.cpuPct.toFixed(1)}% over 60 s` };
  }
  if (p?.ac && i.busy && !i.busy.busy) return { level: "full", why: `on AC, ${i.busy.why}` };
  if (p && !p.ac) return { level: "normal", why: `on battery ${pct(p.battery ?? 0)}` };
  if (!p) return { level: "normal", why: "power unknown" };
  return { level: "normal", why: "system load unknown" };
}

/**
 * Own CPU over a sliding window, from cumulative CPU ms per process. A process that restarted
 * (its counter went back) counts from zero again, so the total only grows.
 */
export class CpuMeter {
  private last = new Map<string, number>();
  private total = 0;
  private samples: { t: number; total: number }[] = [];
  private readonly windowMs: number;

  constructor(windowMs = WINDOW_MS) {
    this.windowMs = windowMs;
  }

  /** Cumulative CPU ms per process (missing ones are skipped this time). */
  add(t: number, readings: Record<string, number | null>): void {
    for (const [name, ms] of Object.entries(readings)) {
      if (ms === null || !Number.isFinite(ms)) continue;
      const prev = this.last.get(name);
      this.total += prev === undefined ? 0 : ms >= prev ? ms - prev : ms;
      this.last.set(name, ms);
    }
    this.samples.push({ t, total: this.total });
    while (this.samples.length > 2 && t - (this.samples[1] as { t: number }).t >= this.windowMs)
      this.samples.shift();
  }

  /** % of one core over the window; null until the samples span 5/6 of it. */
  pct(): number | null {
    const a = this.samples[0];
    const b = this.samples.at(-1);
    if (!a || !b || b.t - a.t < (this.windowMs * 5) / 6) return null;
    return ((b.total - a.total) / (b.t - a.t)) * 100;
  }
}

/** "full" / "normal" / "lean" from `AUTOTRACK_LEVEL` (tests and measurement); else null. */
export function pinnedLevel(v: string | undefined): Level | null {
  return v === "full" || v === "normal" || v === "lean" ? v : null;
}

export interface GovernorOptions {
  now: () => number;
  /** Cumulative CPU ms per process: the recorder and each helper. */
  cpu: () => Promise<Record<string, number | null>>;
  power: () => Promise<Power | null>;
  busy: () => Busy | null;
  pinned?: Level | null;
  powerPollMs?: number;
}

/** Ticks every 2 s; answers the decision when the level changed (the first tick always does). */
export class Governor {
  private current: Decision | null = null;
  private power: Power | null = null;
  private powerAt = Number.NEGATIVE_INFINITY;
  private readonly meter = new CpuMeter();
  private readonly burst = new CpuMeter(BURST_MS);
  private readonly o: GovernorOptions;

  constructor(o: GovernorOptions) {
    this.o = o;
  }

  get level(): Level {
    return this.current?.level ?? this.o.pinned ?? "normal";
  }

  get decision(): Decision | null {
    return this.current;
  }

  get cpuPct(): number | null {
    return this.meter.pct();
  }

  /** Own CPU over the last 10 s. */
  get burstPct(): number | null {
    return this.burst.pct();
  }

  /** The last power reading (null: not known). */
  get powerNow(): Power | null {
    return this.power;
  }

  /** Readings are taken even when pinned, so `status` and `doctor` show the cost. */
  async tick(): Promise<Decision | null> {
    const now = this.o.now();
    if (now - this.powerAt >= (this.o.powerPollMs ?? POWER_POLL_MS)) {
      this.powerAt = now;
      this.power = await this.o.power().catch(() => null);
    }
    const cpu = await this.o.cpu().catch(() => ({}));
    const t = this.o.now();
    this.meter.add(t, cpu);
    this.burst.add(t, cpu);
    const next: Decision = this.o.pinned
      ? { level: this.o.pinned, why: "pinned (AUTOTRACK_LEVEL)" }
      : decide(
          {
            power: this.power,
            busy: this.o.busy(),
            cpuPct: this.meter.pct(),
            burstPct: this.burst.pct(),
          },
          this.current,
        );
    const changed = next.level !== this.current?.level;
    this.current = changed ? next : (this.current as Decision);
    if (!changed && next.why !== this.current.why) this.current = next;
    return changed ? next : null;
  }
}
