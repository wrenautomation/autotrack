/**
 * Frames. A ring keeps the latest grab of the display under the cursor while input happened in
 * the last 5 s (idle = no capture), every 250 / 500 / 1000 ms by level. A key or text act takes
 * the ring's frame as "before"; a click or drag grabs a fresh one at button-down. "After" grabs
 * every tick until two grabs in a row do not differ (up to 3 s), or, at `lean`, once 300 ms later.
 * While idle, a grab every 1 / 2 / 5 s is written only when its hash differs from the last written
 * frame's; a screen that keeps changing with nobody there (a video) drops to one grab per 10 s.
 * Each frame is written once and referenced by number.
 *
 * Pixels never reach Node: the native helper holds the last few grabs and writes the JPEG; this
 * keeps a slot reference and a 64-bit hash per grab.
 */
import type { Display } from "./events.ts";
import type { Reservation } from "./journal.ts";
import { LEVELS, type LevelParams } from "./level.ts";

export const ACTIVE_MS = 5000;
export const AFTER_MS = 300;
/** Settle gives up after this. */
export const SETTLE_MAX_MS = 3000;
/** Video guard: this long with no input, over this share of idle grabs changed. */
export const GUARD_MS = 30_000;
export const GUARD_SHARE = 0.8;
export const GUARD_IDLE_MS = 10_000;

/** One grab, held by the helper. `token` is the capturer's own reference to it. */
export interface Shot {
  display: string;
  width: number;
  height: number;
  /** 16 hex digits, see `differs`. */
  hash: string;
  token: unknown;
}

export interface CropAnswer {
  ok: boolean;
  /** Pixels written (the display's native pixels for 256 points). */
  w?: number;
  h?: number;
}

export interface Capturer {
  displays(): Display[];
  /** Grab the display under this logical point; null when it can't. */
  grab(x: number, y: number): Promise<Shot | null>;
  /**
   * Write a grab as a JPEG at `path`: true, false when it failed, "reused" when the helper's slot
   * went to a newer grab first.
   */
  save(shot: Shot, path: string): Promise<boolean | "reused">;
  /** A native-pixel crop of `size` points around a logical point, written as a JPEG at `path`. */
  crop?(x: number, y: number, size: number, path: string): Promise<CropAnswer | null>;
  /** Stop the helper. */
  close?(): void;
}

/** Where the next frame goes: the journal. `done(false)` gives the reservation up. */
export interface FrameSink {
  reserveFrame(): Reservation;
}

export interface Frame {
  shot: Shot;
  /** When the grab was asked for. */
  at: number;
  /** The cursor then. */
  x: number;
  y: number;
  n?: Promise<number | null>;
  /** Where it was written, once it was. */
  path?: string;
}

export interface After {
  n: number | null;
  hash: string | null;
  /** Where it was written. */
  path?: string;
  /** ms from the act's end to the screen holding still (or to giving up). */
  settle?: number;
  /** false: 3 s ran out before two grabs agreed. */
  settled?: boolean;
}

export interface ScreenOptions {
  capturer: Capturer;
  frames: FrameSink;
  now: () => number;
  /** True while nothing may be captured (paused, excluded app, locked). */
  blocked: () => boolean;
  /** A last check right before a frame is written (is an excluded app in front now?). */
  mayWrite?: () => Promise<boolean>;
  /** The level's timings; `normal` when not given. */
  params?: () => LevelParams;
  /** A frame was written (at `path`). */
  onShot?: (n: number, f: Frame, path: string) => void;
  log?: (msg: string) => void;
}

/** The hash is: byte 0 = mean luma of the top half, byte 1 = the bottom half, low 48 bits = a 9×6 difference hash. */
const bits = (h: string) => BigInt(`0x${h}`);

/**
 * Changed when 3 or more of the 48 gradient bits flipped, or either half's mean luma moved by 2
 * or more (a blinking caret or a ticking clock is neither).
 */
export function differs(a: string | null, b: string): boolean {
  if (!a || !/^[0-9a-f]{16}$/.test(a) || !/^[0-9a-f]{16}$/.test(b)) return true;
  const x = bits(a) ^ bits(b);
  let flipped = 0;
  for (let v = x & 0xffffffffffffn; v; v >>= 1n) flipped += Number(v & 1n);
  const lumaTop = Math.abs(Number(bits(a) >> 56n) - Number(bits(b) >> 56n));
  const lumaBottom = Math.abs(Number((bits(a) >> 48n) & 0xffn) - Number((bits(b) >> 48n) & 0xffn));
  return flipped >= 3 || lumaTop >= 2 || lumaBottom >= 2;
}

/** A tick fires up to this early and still counts (timers drift). */
const SLACK_MS = 50;

export class Screen {
  private ring: Frame | null = null;
  private lastInput = Number.NEGATIVE_INFINITY;
  private cursor = { x: 0, y: 0 };
  private lastHash: string | null = null;
  private lastWrite = Number.NEGATIVE_INFINITY;
  private capturing: Promise<Frame | null> | null = null;
  /** Idle grabs: when, the last hash, and which of the recent ones changed (video guard). */
  private idleAt = Number.NEGATIVE_INFINITY;
  private idleHash: string | null = null;
  private idleSeen: { t: number; changed: boolean }[] = [];
  private guard = false;

  private readonly o: ScreenOptions;

  constructor(o: ScreenOptions) {
    this.o = o;
  }

  private get p(): LevelParams {
    return this.o.params?.() ?? LEVELS.normal;
  }

  /** Input happened (at a point, for pointer input). */
  input(x?: number, y?: number): void {
    this.lastInput = this.o.now();
    if (x !== undefined && y !== undefined) this.cursor = { x, y };
    this.guard = false;
    this.idleSeen = [];
  }

  get active(): boolean {
    return this.o.now() - this.lastInput < ACTIVE_MS;
  }

  /** The video guard is holding idle frames to one per 10 s. */
  get guarded(): boolean {
    return this.guard;
  }

  /** Ring step (called every 250 ms): capture only while active, at the level's period. */
  async ringTick(): Promise<void> {
    if (!this.active || this.o.blocked()) return;
    if (this.ring && this.o.now() - this.ring.at < this.p.ringMs - SLACK_MS) return;
    await this.capture();
  }

  /** A key's "before" frame: the ring's latest when no older than the ring period, else a capture now. */
  async before(): Promise<Frame | null> {
    if (this.o.blocked()) return null;
    const r = this.ring;
    if (r && this.o.now() - r.at <= this.p.ringMs) return r;
    return this.capture();
  }

  /** A click's "before" frame: grabbed now (a grab already under way is just as early). */
  async fresh(): Promise<Frame | null> {
    if (this.o.blocked()) return null;
    return this.capture();
  }

  /** Write a frame once; later calls get the same number. */
  number(f: Frame | null): Promise<number | null> {
    if (!f) return Promise.resolve(null);
    f.n ??= this.persist(f);
    return f.n;
  }

  /** The "after" frame's number. */
  async after(sleep = defaultSleep): Promise<number | null> {
    return (await this.afterFrame(sleep)).n;
  }

  /**
   * The "after" frame, written, with its hash (null with no capture) for telling whether the
   * screen moved. With a settle tick: grab every tick until two grabs in a row do not differ, up
   * to 3 s; `settle` is ms from `endedAt` (the act's end, on this clock) to the first of the two.
   * Without one: a single grab 300 ms from now.
   */
  async afterFrame(sleep = defaultSleep, endedAt = this.o.now()): Promise<After> {
    const tick = this.p.settleTickMs;
    if (tick === null) {
      await sleep(AFTER_MS);
      if (this.o.blocked()) return { n: null, hash: null };
      const f = await this.capture();
      const n = await this.number(f);
      return { n, hash: f?.shot.hash ?? null, ...(n !== null && f?.path ? { path: f.path } : {}) };
    }
    const start = this.o.now();
    const most = Math.ceil(SETTLE_MAX_MS / tick);
    let prev: Frame | null = null;
    for (let i = 1; ; i++) {
      await sleep(tick);
      if (this.o.blocked()) return { n: null, hash: null };
      const f = await this.capture();
      if (!f) {
        if (!prev || i >= most) return { n: null, hash: null };
        continue; // one failed grab; the clock still runs out
      }
      const stable = prev !== null && !differs(prev.shot.hash, f.shot.hash);
      const out = stable || i >= most || this.o.now() - start >= SETTLE_MAX_MS;
      if (out) {
        const at = stable ? (prev as Frame).at : f.at;
        const n = await this.number(f);
        return {
          n,
          hash: f.shot.hash,
          ...(n !== null && f.path ? { path: f.path } : {}),
          settle: Math.max(0, Math.round(at - endedAt)),
          ...(stable ? {} : { settled: false }),
        };
      }
      prev = f;
    }
  }

  /**
   * Idle reading (no input for 5 s), called every second: a grab at the level's idle period, a
   * frame number when the screen changed since the last write. Over 80% of grabs changing for 30 s
   * with nobody there turns on the video guard: one grab per 10 s, until input or a still grab.
   */
  async idle(): Promise<number | null> {
    if (this.active || this.o.blocked()) return null;
    const now = this.o.now();
    const every = this.guard ? GUARD_IDLE_MS : this.p.idleMs;
    if (now - this.idleAt < every - SLACK_MS) return null;
    this.idleAt = now;
    const f = await this.capture();
    if (!f) return null;
    const changed = differs(this.idleHash, f.shot.hash);
    this.idleHash = f.shot.hash;
    this.watchVideo(now, changed);
    if (!differs(this.lastHash, f.shot.hash)) return null;
    if (now - this.lastWrite < every - SLACK_MS) return null;
    return this.number(f);
  }

  private watchVideo(now: number, changed: boolean): void {
    if (this.guard) {
      if (!changed) this.guard = false;
      return;
    }
    this.idleSeen.push({ t: now, changed });
    while (this.idleSeen.length && now - (this.idleSeen[0] as { t: number }).t > GUARD_MS)
      this.idleSeen.shift();
    const first = this.idleSeen[0];
    if (!first || now - this.lastInput < GUARD_MS || now - first.t < GUARD_MS - this.p.idleMs)
      return;
    const share = this.idleSeen.filter((s) => s.changed).length / this.idleSeen.length;
    if (share > GUARD_SHARE) {
      this.guard = true;
      this.idleSeen = [];
      this.o.log?.("screen: the screen keeps changing with nobody there, idle frames every 10 s");
    }
  }

  private capture(): Promise<Frame | null> {
    this.capturing ??= (async () => {
      const at = this.o.now();
      const { x, y } = this.cursor;
      try {
        const shot = await this.o.capturer.grab(x, y);
        if (!shot) return null;
        const f: Frame = { shot, at, x, y };
        this.ring = f;
        return f;
      } catch (e) {
        this.o.log?.(`screen: capture failed: ${(e as Error).message}`);
        return null;
      } finally {
        this.capturing = null;
      }
    })();
    return this.capturing;
  }

  private async persist(f: Frame): Promise<number | null> {
    try {
      this.lastHash = f.shot.hash;
      this.lastWrite = this.o.now();
      if (this.o.blocked() || (this.o.mayWrite && !(await this.o.mayWrite()))) return null;
      const slot = this.o.frames.reserveFrame();
      let ok: boolean | "reused" = false;
      try {
        ok = await this.o.capturer.save(f.shot, slot.path);
        if (ok === true && this.o.blocked()) ok = false; // paused while saving: the file is deleted
      } finally {
        slot.done(ok);
      }
      if (ok !== true) {
        this.o.log?.("screen: frame not saved");
        return null;
      }
      f.path = slot.path;
      try {
        this.o.onShot?.(slot.n, f, slot.path);
      } catch {}
      return slot.n;
    } catch (e) {
      this.o.log?.(`screen: frame failed: ${(e as Error).message}`);
      return null;
    }
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
