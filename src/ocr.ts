/**
 * Idle-time OCR. The OS's own engine (Mac Vision, Windows.Media.Ocr) reads each written frame and
 * crop in a third helper (`--ocr`), started on demand at background priority and stopped when the
 * queue is empty. It runs only while the person has been idle 20 s, on AC or a battery at 50% or
 * more, and the level is not `lean`; one image at a time; any input kills the helper at once and
 * the image goes back on the queue. Output: `ocr/<n>.json` (frames), `ocr/c<n>.json` (crops),
 * `{lines: [{text, x, y, w, h, conf?}], w, h}` in the image's pixels, text through the secret
 * redaction. A frame whose hash equals one already read is `{same: m}`.
 *
 * A closed segment gets `.done` (via `finish`) when its images are all read, or 2 h after it closed.
 */
import { mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Level } from "./events.ts";
import { HelperClient, helperCommand, spawnHelper } from "./helper.ts";
import { readStats, unread } from "./journal.ts";
import type { Power } from "./level.ts";
import { redactSecrets } from "./privacy.ts";

export const OCR_IDLE_MS = 20_000;
export const OCR_BATTERY_PCT = 50;
/** A closed segment waits this long for its OCR at most. */
export const OCR_WAIT_MS = 2 * 60 * 60_000;
export const OCR_TICK_MS = 1000;
/** One image's read; past this it counts as failed and the helper is restarted. */
export const OCR_READ_MS = 60_000;
/** Hashes remembered for `same`, per session. */
const HASHES_MAX = 20_000;

export interface OcrLine {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0–1; Windows gives none. */
  conf?: number;
}

export interface OcrAnswer {
  lines: OcrLine[];
  w: number;
  h: number;
  /** The helper run's own CPU so far (not written). */
  cpuMs?: number;
}

/** One `--ocr` helper run. `close` kills it at once. */
export interface OcrReader {
  read(path: string): Promise<OcrAnswer | null>;
  close(): void;
}

export interface OcrOptions {
  /** Epoch ms. */
  now: () => number;
  /** ms since the last raw input. */
  idleFor: () => number;
  power: () => Power | null;
  level: () => Level;
  /** Start a helper run. */
  start: () => OcrReader;
  /** A segment's OCR is over: write its counts and `.done`. */
  finish: (segDir: string) => void;
  waitMs?: number;
  log?: (msg: string) => void;
}

type Image = { crop: boolean; n: number; hash?: string };

interface Job {
  seg: string;
  /** Epoch ms; null while the segment is open. */
  closedAt: number | null;
  todo: Image[];
}

/** `ocr/<n>.json` or `ocr/c<n>.json` for an image. */
export const ocrPath = (seg: string, crop: boolean, n: number) =>
  join(seg, "ocr", `${crop ? "c" : ""}${n}.json`);

const imagePath = (seg: string, img: Image) =>
  join(seg, img.crop ? "crops" : "frames", `${img.n}.jpg`);

function writeOcr(seg: string, img: Image, body: unknown): void {
  const p = ocrPath(seg, img.crop, img.n);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(`${p}.tmp`, JSON.stringify(body));
  renameSync(`${p}.tmp`, p);
}

/** An answer as written: text redacted, numbers rounded, nothing else kept. */
export function ocrBody(a: OcrAnswer): Omit<OcrAnswer, "cpuMs"> {
  const r = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0);
  return {
    lines: (Array.isArray(a.lines) ? a.lines : []).map((l) => ({
      text: redactSecrets(String(l.text ?? "")).text,
      x: r(l.x),
      y: r(l.y),
      w: r(l.w),
      h: r(l.h),
      ...(typeof l.conf === "number" ? { conf: Math.round(l.conf * 100) / 100 } : {}),
    })),
    w: r(a.w),
    h: r(a.h),
  };
}

export class OcrScheduler {
  private jobs = new Map<string, Job>();
  /** Per session: frame hash → the frame read with it. */
  private hashes = new Map<string, Map<string, number>>();
  private reader: OcrReader | null = null;
  private running = false;
  /** Bumped when input kills a run: a read from before it is thrown away. */
  private epoch = 0;
  private cpu = 0;
  private runCpu = 0;
  private readonly o: OcrOptions;

  constructor(o: OcrOptions) {
    this.o = o;
  }

  /** Whether OCR may run now. */
  get allowed(): boolean {
    if (this.o.idleFor() < OCR_IDLE_MS || this.o.level() === "lean") return false;
    const p = this.o.power();
    return !p || p.ac || (p.battery ?? 100) >= OCR_BATTERY_PCT;
  }

  /** Images waiting, over all segments. */
  get waiting(): number {
    let n = 0;
    for (const j of this.jobs.values()) n += j.todo.length;
    return n;
  }

  /** CPU ms the OCR helper runs have reported, in total. */
  get cpuMs(): number {
    return this.cpu;
  }

  /** True while a helper run is up. */
  get busy(): boolean {
    return this.reader !== null;
  }

  /** A frame or crop was written (its final path). */
  image(path: string, hash?: string): void {
    const kind = basename(dirname(path));
    const n = Number.parseInt(basename(path), 10);
    if ((kind !== "frames" && kind !== "crops") || !Number.isFinite(n)) return;
    const job = this.job(dirname(dirname(path)), null);
    job.todo.push({ crop: kind === "crops", n, ...(hash ? { hash } : {}) });
  }

  /** A frame (its path) of an act on a secure element: never read. */
  skip(path: string): void {
    const seg = dirname(dirname(path));
    const n = Number.parseInt(basename(path), 10);
    if (!Number.isFinite(n)) return;
    const job = this.jobs.get(seg);
    if (job) job.todo = job.todo.filter((i) => i.crop || i.n !== n);
    try {
      writeOcr(seg, { crop: false, n }, { skipped: "secure" });
    } catch (e) {
      this.o.log?.(`ocr: ${(e as Error).message}`);
    }
  }

  /** A segment closed: anything on disk not yet queued joins; done now when nothing is left. */
  closed(seg: string, closedAt = this.o.now()): void {
    const job = this.job(seg, closedAt);
    job.closedAt = closedAt;
    const queued = new Set(job.todo.map((i) => `${i.crop}:${i.n}`));
    const left = unread(seg);
    for (const n of left.frames) if (!queued.has(`false:${n}`)) job.todo.push({ crop: false, n });
    for (const n of left.crops) if (!queued.has(`true:${n}`)) job.todo.push({ crop: true, n });
    if (!job.todo.length) this.done(job);
  }

  /**
   * At start: closed segments of every session that wait for OCR (`stats.json`, no `.done`),
   * oldest first, keep their close time.
   */
  resume(sessions: string): number {
    let found = 0;
    let names: string[] = [];
    try {
      names = readdirSync(sessions).sort();
    } catch {
      return 0;
    }
    for (const s of names) {
      const dir = join(sessions, s);
      let segs: string[] = [];
      try {
        if (!statSync(dir).isDirectory()) continue;
        segs = readdirSync(dir)
          .filter((n) => /^\d{3,}$/.test(n))
          .sort();
      } catch {
        continue;
      }
      for (const seg of segs) {
        const sd = join(dir, seg);
        if (this.jobs.has(sd) || exists(join(sd, ".done"))) continue;
        const stats = readStats(sd);
        if (!stats) continue;
        const at = Date.parse(stats.closedAt);
        this.closed(sd, Number.isFinite(at) ? at : this.o.now());
        found++;
      }
    }
    return found;
  }

  /** Raw input: a run in progress is killed now; its image goes back on the queue. */
  input(): void {
    if (!this.reader) return;
    this.epoch++;
    this.reader.close();
    this.reader = null;
  }

  /** Every second: give up on segments past their wait, then read while allowed. */
  tick(): void {
    const now = this.o.now();
    const wait = this.o.waitMs ?? OCR_WAIT_MS;
    for (const job of [...this.jobs.values()])
      if (job.closedAt !== null && now - job.closedAt >= wait) {
        if (job.todo.length) this.o.log?.(`ocr: ${job.todo.length} images not read in time`);
        this.done(job);
      }
    if (!this.running && this.allowed && this.waiting) void this.run();
  }

  /** Stop: kill any run (nothing is finished; the next start resumes). */
  close(): void {
    this.input();
    this.jobs.clear();
  }

  /** Read until the queue is empty, input comes or reading is no longer allowed. */
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const epoch = this.epoch;
        if (!this.allowed) break;
        const next = this.next();
        if (!next) break;
        const { job, img } = next;
        const same = img.hash ? this.hashes.get(dirname(job.seg))?.get(img.hash) : undefined;
        if (same !== undefined && same !== img.n) {
          this.write(job, img, { same });
          continue;
        }
        if (!this.reader) {
          this.reader = this.o.start();
          this.runCpu = 0;
        }
        const reader = this.reader;
        let a: OcrAnswer | null = null;
        let failed = false;
        try {
          a = await withTimeout(reader.read(imagePath(job.seg, img)), OCR_READ_MS);
        } catch {
          failed = true;
        }
        if (epoch !== this.epoch) {
          job.todo.unshift(img); // input stopped it: read again at the next idle
          break;
        }
        if (!a || !Array.isArray(a.lines)) failed = true;
        if (failed) {
          this.write(job, img, { failed: true });
          reader.close(); // a hung or broken run: the next image starts a new one
          if (this.reader === reader) this.reader = null;
          continue;
        }
        const answer = a as OcrAnswer;
        if (typeof answer.cpuMs === "number" && answer.cpuMs >= this.runCpu) {
          this.cpu += answer.cpuMs - this.runCpu;
          this.runCpu = answer.cpuMs;
        }
        this.write(job, img, ocrBody(answer));
        if (img.hash) this.remember(dirname(job.seg), img.hash, img.n);
      }
    } finally {
      this.running = false;
      if (!this.waiting) {
        this.reader?.close();
        this.reader = null;
      }
    }
  }

  private next(): { job: Job; img: Image } | null {
    for (const job of this.jobs.values()) {
      const img = job.todo.shift();
      if (img) return { job, img };
      if (job.closedAt !== null) this.done(job);
    }
    return null;
  }

  private write(job: Job, img: Image, body: unknown): void {
    try {
      writeOcr(job.seg, img, body);
    } catch (e) {
      this.o.log?.(`ocr: ${(e as Error).message}`);
    }
    if (!job.todo.length && job.closedAt !== null) this.done(job);
  }

  private remember(session: string, hash: string, n: number): void {
    let m = this.hashes.get(session);
    if (!m) {
      m = new Map();
      this.hashes.set(session, m);
    }
    if (m.has(hash)) return;
    m.set(hash, n);
    if (m.size > HASHES_MAX) m.delete(m.keys().next().value as string);
  }

  private job(seg: string, closedAt: number | null): Job {
    let j = this.jobs.get(seg);
    if (!j) {
      j = { seg, closedAt, todo: [] };
      this.jobs.set(seg, j);
    }
    return j;
  }

  private done(job: Job): void {
    if (!this.jobs.delete(job.seg)) return;
    try {
      this.o.finish(job.seg);
    } catch (e) {
      this.o.log?.(`ocr: finish ${job.seg}: ${(e as Error).message}`);
    }
  }
}

function exists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(null), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** One run of the `--ocr` helper for this OS; null when the helper is missing. */
export function ocrHelper(log?: (msg: string) => void): (() => OcrReader) | null {
  const cmd = helperCommand(process.platform, undefined, "ocr");
  if (!cmd) return null;
  return () => {
    const c = new HelperClient({
      spawn: spawnHelper(cmd),
      name: "ocr",
      restartMs: 3_600_000, // a run that dies is not restarted; the next image starts a new one
      ...(log ? { log } : {}),
    });
    return {
      read: (path) => c.call<OcrAnswer>("read", { path }, OCR_READ_MS),
      close: () => c.close(),
    };
  };
}
