/**
 * Integrity stats: what a segment holds and what went missing while it was written (probe
 * timeouts, frames that failed, helper restarts, time at each level). The journal writes them as
 * `<segment>/stats.json` when the segment closes and sums them into `session.json` `totals`.
 */
import type { Level, Stats } from "./events.ts";

export function emptyStats(): Stats {
  return {
    events: {},
    movesDropped: 0,
    probe: { answers: 0, timeouts: 0 },
    nullElement: 0,
    frames: { saved: 0, failed: 0, slotReused: 0 },
    trees: 0,
    crops: 0,
    ocr: { done: 0, same: 0, failed: 0, skipped: 0 },
    levels: { full: 0, normal: 0, lean: 0 },
    restarts: {},
  };
}

const addRecord = (a: Record<string, number>, b: Record<string, number>) => {
  for (const [k, v] of Object.entries(b)) a[k] = (a[k] ?? 0) + v;
};

/** a += b, field by field. */
export function addStats(a: Stats, b: Stats): Stats {
  addRecord(a.events, b.events);
  a.movesDropped += b.movesDropped;
  addRecord(a.probe, b.probe);
  a.nullElement += b.nullElement;
  addRecord(a.frames, b.frames);
  a.trees += b.trees;
  a.crops += b.crops;
  addRecord(a.ocr, b.ocr);
  addRecord(a.levels, b.levels);
  addRecord(a.restarts, b.restarts);
  return a;
}

/**
 * The open segment's counters. Time at a level accrues from `level()` to the next change or
 * `take()`; restarts are counted from cumulative start counts per helper.
 */
export class SegmentCounters {
  s: Stats = emptyStats();
  private level: Level | null = null;
  private levelSince = 0;
  private starts = new Map<string, number>();
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  event(kind: string): void {
    this.s.events[kind] = (this.s.events[kind] ?? 0) + 1;
  }

  probe(answered: boolean): void {
    if (answered) this.s.probe.answers++;
    else this.s.probe.timeouts++;
  }

  /** The level from now on. */
  setLevel(level: Level): void {
    this.accrue();
    this.level = level;
  }

  /** Cumulative starts per helper; anything past a helper's first start is a restart. */
  helperStarts(starts: Record<string, number>): void {
    for (const [name, n] of Object.entries(starts)) {
      const prev = this.starts.get(name) ?? Math.min(n, 1);
      if (n > prev) this.s.restarts[name] = (this.s.restarts[name] ?? 0) + (n - prev);
      this.starts.set(name, Math.max(n, prev));
    }
  }

  /** The counters so far (levels accrued up to now), and a fresh set for the next segment. */
  take(): Stats {
    this.accrue();
    const out = this.s;
    out.levels = {
      full: Math.round(out.levels.full),
      normal: Math.round(out.levels.normal),
      lean: Math.round(out.levels.lean),
    };
    this.s = emptyStats();
    return out;
  }

  private accrue(): void {
    const now = this.now();
    if (this.level) this.s.levels[this.level] += (now - this.levelSince) / 1000;
    this.levelSince = now;
  }
}
