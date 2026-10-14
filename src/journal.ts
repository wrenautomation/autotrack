/**
 * A session on disk: `session.json`, then segments `000/`, `001/`, … each with `events.jsonl`,
 * `frames/<n>.jpg`, `crops/<n>.jpg`, `trees/<n>.json|txt` and, once closed, `stats.json`. A
 * segment closes after 5 minutes or 2,000 events; `.done` is written last, so the shipper never
 * takes a half-written one. With OCR on (`waitOcr`), `.done` waits until the OCR scheduler
 * finishes the segment (or gives up 2 h after it closed). Writes are synchronous appends: a crash
 * loses nothing written, and the next start closes what it left open.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Event, SessionMeta, Stats } from "./events.ts";
import { addStats, emptyStats, SegmentCounters } from "./stats.ts";

export const SEGMENT_MS = 5 * 60_000;
export const SEGMENT_EVENTS = 2000;

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** `<yyyymmddThhmmss>-<4 hex>`, UTC. */
export function sessionName(epochMs: number, hex = randomBytes(2).toString("hex")): string {
  const d = new Date(epochMs);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}-${hex}`;
}

export const segmentName = (i: number) => pad(i, 3);
const isSegment = (name: string) => /^\d{3,}$/.test(name);

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** `<segment>/stats.json`: the segment's stats, its name and when it closed. */
export type SegmentStats = Stats & { segment: string; closedAt: string };

export const statsPath = (segDir: string) => join(segDir, "stats.json");

export function readStats(segDir: string): SegmentStats | null {
  try {
    return JSON.parse(readFileSync(statsPath(segDir), "utf8")) as SegmentStats;
  } catch {
    return null;
  }
}

const numbered = (dir: string, re: RegExp) => {
  try {
    return readdirSync(dir).filter((n) => re.test(n));
  } catch {
    return [];
  }
};

/** Images in a segment with no OCR output yet: frames as numbers, crops as numbers. */
export function unread(segDir: string): { frames: number[]; crops: number[] } {
  const ocr = new Set(numbered(join(segDir, "ocr"), /^c?\d+\.json$/));
  const nums = (sub: string, prefix: string) =>
    numbered(join(segDir, sub), /^\d+\.jpg$/)
      .map((n) => Number.parseInt(n, 10))
      .filter((n) => !ocr.has(`${prefix}${n}.json`))
      .sort((a, b) => a - b);
  return { frames: nums("frames", ""), crops: nums("crops", "c") };
}

/** Stats from what a crashed segment's files show (counters that live in memory are lost). */
function recoveredStats(segDir: string): Stats {
  const s = emptyStats();
  s.recovered = true;
  try {
    for (const line of readFileSync(join(segDir, "events.jsonl"), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const kind = String((JSON.parse(line) as { kind?: unknown }).kind);
        s.events[kind] = (s.events[kind] ?? 0) + 1;
      } catch {}
    }
  } catch {}
  s.frames.saved = numbered(join(segDir, "frames"), /^\d+\.jpg$/).length;
  s.crops = numbered(join(segDir, "crops"), /^\d+\.jpg$/).length;
  s.trees = numbered(join(segDir, "trees"), /^\d+\.(json|txt)$/).length;
  return s;
}

/** Remove what an unfinished save left: `.tmp` files and crops still held for a privacy check. */
function sweepPartial(segDir: string): void {
  for (const sub of ["frames", "crops"])
    for (const n of numbered(join(segDir, sub), /\.(tmp|hold)$/)) {
      try {
        unlinkSync(join(segDir, sub, n));
      } catch {}
    }
}

/**
 * What a segment's OCR came to, from its `ocr/` files: `{lines}` read, `{same}` a repeat,
 * `{failed}`, `{skipped}` (a secure element's frame); images with no file count as skipped.
 */
export function ocrCounts(segDir: string): Stats["ocr"] {
  const c = emptyStats().ocr;
  const dir = join(segDir, "ocr");
  for (const name of numbered(dir, /^c?\d+\.json$/)) {
    try {
      const o = JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>;
      if ("same" in o) c.same++;
      else if ("failed" in o) c.failed++;
      else if ("skipped" in o) c.skipped++;
      else c.done++;
    } catch {
      c.failed++;
    }
  }
  const left = unread(segDir);
  c.skipped += left.frames.length + left.crops.length;
  return c;
}

/**
 * The segment's OCR is over (or given up): its counts go into `stats.json` and the session's
 * totals (`meta` when the open journal holds them, else `session.json`), then `.done`.
 */
export function finishSegment(segDir: string, meta?: SessionMeta): void {
  const done = ocrCounts(segDir);
  const stats = readStats(segDir);
  if (stats) {
    const add = { ...emptyStats().ocr };
    for (const k of Object.keys(done) as (keyof Stats["ocr"])[])
      add[k] = done[k] - (stats.ocr?.[k] ?? 0);
    stats.ocr = done;
    writeJson(statsPath(segDir), stats);
    const metaPath = join(dirname(segDir), "session.json");
    try {
      const m = meta ?? (JSON.parse(readFileSync(metaPath, "utf8")) as SessionMeta);
      m.totals = addStats(m.totals ?? emptyStats(), { ...emptyStats(), ocr: add });
      writeJson(metaPath, m);
    } catch {}
  }
  writeFileSync(join(segDir, ".done"), "");
}

/**
 * Close what a crash left open: every segment without `.done` and without `stats.json` gets the
 * stats its files show, then `.done` (or, with `waitOcr`, is left for the OCR scheduler); a
 * session with no `endedAt` gets the time its files last changed. Returns how many segments it
 * closed.
 */
export function closeStale(
  sessions: string,
  keep?: string,
  waitOcr = false,
  now = Date.now,
): number {
  if (!existsSync(sessions)) return 0;
  let closed = 0;
  for (const s of readdirSync(sessions)) {
    if (s === keep) continue;
    const dir = join(sessions, s);
    if (!statSync(dir).isDirectory()) continue;
    let last = 0;
    for (const seg of readdirSync(dir).filter(isSegment)) {
      const sd = join(dir, seg);
      const ev = join(sd, "events.jsonl");
      if (existsSync(ev)) last = Math.max(last, statSync(ev).mtimeMs);
      if (existsSync(join(sd, ".done"))) continue;
      sweepPartial(sd);
      if (!existsSync(statsPath(sd))) {
        const stats: SegmentStats = {
          segment: seg,
          closedAt: new Date(now()).toISOString(),
          ...recoveredStats(sd),
        };
        writeJson(statsPath(sd), stats);
        addTotals(join(dir, "session.json"), stats);
        closed++;
      }
      if (!waitOcr) finishSegment(sd);
    }
    const metaPath = join(dir, "session.json");
    if (!existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as SessionMeta;
      if (meta.endedAt === null) {
        meta.endedAt = new Date(last || statSync(metaPath).mtimeMs).toISOString();
        writeJson(metaPath, meta);
      }
    } catch {
      // A torn session.json stays as it is; its segments still ship.
    }
  }
  return closed;
}

function addTotals(metaPath: string, stats: Stats): void {
  try {
    const m = JSON.parse(readFileSync(metaPath, "utf8")) as SessionMeta;
    const { segment: _s, closedAt: _c, recovered: _r, ...plain } = stats as SegmentStats;
    m.totals = addStats(m.totals ?? emptyStats(), plain);
    writeJson(metaPath, m);
  } catch {}
}

export interface JournalOptions {
  sessions: string;
  meta: Omit<SessionMeta, "v" | "session" | "startedAt" | "endedAt">;
  now?: () => number; // epoch ms
  segmentMs?: number;
  segmentEvents?: number;
  /** `.done` waits for `finish` (the OCR scheduler); stale segments are left to it too. */
  waitOcr?: boolean;
  /** A segment closed (its `stats.json` is written); with `waitOcr`, `.done` is not yet. */
  onClosed?: (segDir: string) => void;
}

/** A reserved image: its number, where the helper writes it, and `done` to keep or drop it. */
export interface Reservation {
  n: number;
  path: string;
  /** true: kept; "reused": the helper's slot was taken by a newer grab; false: failed. */
  done(ok: boolean | "reused"): void;
}

export class Journal {
  readonly session: string;
  readonly dir: string;
  private meta: SessionMeta;
  private seg = -1;
  private segDir = "";
  private fd: number | null = null;
  private segOpenedAt = 0;
  private segEvents = 0;
  private segFrames = 0;
  private frameNo = 0;
  private cropNo = 0;
  private treeNo = 0;
  private pending = 0; // reserved frames and crops not yet saved
  private readonly now: () => number;
  private closed = false;
  events = 0;
  frames = 0;
  crops = 0;
  trees = 0;
  /** The open segment's counters; `stats.json` when it closes. */
  readonly stats: SegmentCounters;

  private readonly opts: JournalOptions;

  constructor(opts: JournalOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.stats = new SegmentCounters(this.now);
    mkdirSync(opts.sessions, { recursive: true });
    const started = this.now();
    let name = sessionName(started);
    while (existsSync(join(opts.sessions, name))) name = sessionName(started);
    closeStale(opts.sessions, name, opts.waitOcr ?? false, this.now);
    this.session = name;
    this.dir = join(opts.sessions, name);
    mkdirSync(this.dir);
    this.meta = {
      v: 1,
      session: name,
      ...opts.meta,
      startedAt: new Date(started).toISOString(),
      endedAt: null,
    };
    writeJson(join(this.dir, "session.json"), this.meta);
    this.openSegment();
  }

  get segment(): string {
    return segmentName(this.seg);
  }

  write(e: Event): void {
    if (this.closed) return;
    this.rotateIfDue();
    writeSync(this.fd as number, `${JSON.stringify(e)}\n`);
    this.segEvents++;
    this.events++;
    this.stats.event(e.kind);
  }

  /** The current segment's folder. */
  get segmentDir(): string {
    return this.segDir;
  }

  /**
   * Store a tree as `trees/<n>.<ext>` (n counts over the session) and write the event naming it,
   * in the same segment. Returns n, or null once closed.
   */
  writeTree(body: string, ext: "json" | "txt", event: (n: number) => Event): number | null {
    if (this.closed) return null;
    this.rotateIfDue();
    const n = this.treeNo++;
    const dir = join(this.segDir, "trees");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${n}.${ext}`), body);
    const e = event(n);
    writeSync(this.fd as number, `${JSON.stringify(e)}\n`);
    this.segEvents++;
    this.events++;
    this.trees++;
    this.stats.event(e.kind);
    this.stats.s.trees++;
    return n;
  }

  /**
   * Reserve the next frame in the current segment: its session-wide number and the path the
   * helper writes it to. The segment stays open until `done` (an in-flight save must not lose its
   * folder to a rotation); `done(false)` gives the number up and removes any file.
   */
  reserveFrame(): Reservation {
    if (this.closed) throw new Error("journal closed");
    this.rotateIfDue(false);
    const n = this.frameNo++;
    const path = join(this.segDir, "frames", `${n}.jpg`);
    return this.reserve(n, path, path, (ok) => {
      if (ok === true) {
        this.frames++;
        this.segFrames++;
        this.stats.s.frames.saved++;
      } else if (ok === "reused") this.stats.s.frames.slotReused++;
      else this.stats.s.frames.failed++;
    });
  }

  /**
   * Reserve the next crop: the helper writes `crops/<n>.jpg.hold`, and `done(true)` renames it to
   * `crops/<n>.jpg` once the act's element is known not to be secure (`done(false)` deletes it).
   */
  reserveCrop(): Reservation {
    if (this.closed) throw new Error("journal closed");
    this.rotateIfDue(false);
    const n = this.cropNo++;
    const dir = join(this.segDir, "crops");
    mkdirSync(dir, { recursive: true });
    const final = join(dir, `${n}.jpg`);
    return this.reserve(n, `${final}.hold`, final, (ok) => {
      if (ok !== true) return;
      this.crops++;
      this.stats.s.crops++;
      this.segFrames++;
    });
  }

  private reserve(
    n: number,
    path: string,
    final: string,
    count: (ok: boolean | "reused") => void,
  ): Reservation {
    this.pending++;
    let settled = false;
    return {
      n,
      path,
      done: (ok) => {
        if (settled) return;
        settled = true;
        this.pending--;
        let kept = ok === true;
        if (kept && path !== final) {
          try {
            renameSync(path, final);
          } catch {
            kept = false;
          }
        }
        count(kept ? true : ok === true ? false : ok);
        if (kept) return;
        for (const p of [path, `${path}.tmp`]) {
          try {
            unlinkSync(p);
          } catch {}
        }
      },
    };
  }

  /** Close the segment when it is due by time, even with nothing new to write. */
  tick(): void {
    if (!this.closed) this.rotateIfDue(false);
  }

  close(): void {
    if (this.closed) return;
    this.closeSegment();
    this.closed = true;
    this.meta.endedAt = new Date(this.now()).toISOString();
    writeJson(join(this.dir, "session.json"), this.meta);
  }

  /** Session totals so far (closed segments). */
  get totals(): Stats {
    return this.meta.totals ?? emptyStats();
  }

  /** A closed segment's OCR is over (see `finishSegment`); this session's totals stay in step. */
  finish(segDir: string): void {
    if (dirname(segDir) === this.dir) finishSegment(segDir, this.meta);
    else finishSegment(segDir);
  }

  /** Events rotate by count and time; frames and ticks by time only. */
  private rotateIfDue(byCount = true): void {
    const full = byCount && this.segEvents >= (this.opts.segmentEvents ?? SEGMENT_EVENTS);
    const old = this.now() - this.segOpenedAt >= (this.opts.segmentMs ?? SEGMENT_MS);
    if ((!full && !old) || this.pending > 0) return; // a save in flight keeps its segment open
    if (this.segEvents === 0 && this.segFrames === 0) {
      this.segOpenedAt = this.now(); // an idle segment stays open rather than ship empty
      return;
    }
    this.closeSegment();
    this.openSegment();
  }

  private openSegment(): void {
    this.seg++;
    this.segDir = join(this.dir, segmentName(this.seg));
    mkdirSync(join(this.segDir, "frames"), { recursive: true });
    this.fd = openSync(join(this.segDir, "events.jsonl"), "a");
    this.segOpenedAt = this.now();
    this.segEvents = 0;
    this.segFrames = 0;
  }

  private closeSegment(): void {
    if (this.fd === null) return;
    closeSync(this.fd);
    this.fd = null;
    const stats: SegmentStats = {
      segment: basename(this.segDir),
      closedAt: new Date(this.now()).toISOString(),
      ...this.stats.take(),
    };
    writeJson(statsPath(this.segDir), stats);
    const { segment: _s, closedAt: _c, ...plain } = stats;
    this.meta.totals = addStats(this.meta.totals ?? emptyStats(), structuredClone(plain));
    writeJson(join(this.dir, "session.json"), this.meta);
    if (!this.opts.waitOcr) finishSegment(this.segDir, this.meta);
    this.opts.onClosed?.(this.segDir);
  }
}
