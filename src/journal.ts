/**
 * A session on disk: `session.json`, then segments `000/`, `001/`, … each with `events.jsonl`
 * and `frames/<n>.jpg`. A segment closes after 5 minutes or 2,000 events; `.done` is written
 * last, so the shipper never takes a half-written one. Writes are synchronous appends: a crash
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
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { Event, SessionMeta } from "./events.ts";

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

/**
 * Close what a crash left open: every segment without `.done` gets one, and a session with no
 * `endedAt` gets the time its files last changed. Returns how many segments it closed.
 */
export function closeStale(sessions: string, keep?: string): number {
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
      if (!existsSync(join(sd, ".done"))) {
        writeFileSync(join(sd, ".done"), "");
        closed++;
      }
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

export interface JournalOptions {
  sessions: string;
  meta: Omit<SessionMeta, "v" | "session" | "startedAt" | "endedAt">;
  now?: () => number; // epoch ms
  segmentMs?: number;
  segmentEvents?: number;
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
  private readonly now: () => number;
  private closed = false;
  events = 0;
  frames = 0;

  private readonly opts: JournalOptions;

  constructor(opts: JournalOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    mkdirSync(opts.sessions, { recursive: true });
    const started = this.now();
    let name = sessionName(started);
    while (existsSync(join(opts.sessions, name))) name = sessionName(started);
    closeStale(opts.sessions, name);
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
  }

  /** Write one frame into the current segment; returns its session-wide number. */
  writeFrame(jpeg: Uint8Array): number {
    if (this.closed) throw new Error("journal closed");
    this.rotateIfDue(false);
    const n = this.frameNo++;
    writeFileSync(join(this.segDir, "frames", `${n}.jpg`), jpeg);
    this.frames++;
    this.segFrames++;
    return n;
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

  /** Events rotate by count and time; frames and ticks by time only. */
  private rotateIfDue(byCount = true): void {
    const full = byCount && this.segEvents >= (this.opts.segmentEvents ?? SEGMENT_EVENTS);
    const old = this.now() - this.segOpenedAt >= (this.opts.segmentMs ?? SEGMENT_MS);
    if (!full && !old) return;
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
    writeFileSync(join(this.segDir, ".done"), "");
  }
}
