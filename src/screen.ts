/**
 * Frames. A 2 fps ring keeps the latest grab of the display under the cursor while input
 * happened in the last 5 s (idle = no capture). An act takes the ring's frame as "before" and a
 * fresh one 300 ms later as "after". While idle, a grab every 2 s is written only when its hash
 * differs from the last written frame's. Each frame is written once and referenced by number.
 *
 * Pixels never reach Node: the native helper holds the last few grabs and writes the JPEG; this
 * keeps a slot reference and a 64-bit hash per grab.
 */
import type { Display } from "./events.ts";

export const RING_MS = 500;
export const ACTIVE_MS = 5000;
export const AFTER_MS = 300;
export const IDLE_MS = 2000;

/** One grab, held by the helper. `token` is the capturer's own reference to it. */
export interface Shot {
  display: string;
  width: number;
  height: number;
  /** 16 hex digits, see `differs`. */
  hash: string;
  token: unknown;
}

export interface Capturer {
  displays(): Display[];
  /** Grab the display under this logical point; null when it can't. */
  grab(x: number, y: number): Promise<Shot | null>;
  /** Write a grab as a JPEG at `path`; false when it can't (the grab was reused, or the write failed). */
  save(shot: Shot, path: string): Promise<boolean>;
  /** Stop the helper. */
  close?(): void;
}

/** Where the next frame goes: the journal. `done(false)` gives the reservation up. */
export interface FrameSink {
  reserveFrame(): { n: number; path: string; done(ok: boolean): void };
}

export interface Frame {
  shot: Shot;
  at: number;
  n?: Promise<number | null>;
}

export interface ScreenOptions {
  capturer: Capturer;
  frames: FrameSink;
  now: () => number;
  /** True while nothing may be captured (paused, excluded app, locked). */
  blocked: () => boolean;
  /** A last check right before a frame is written (is an excluded app in front now?). */
  mayWrite?: () => Promise<boolean>;
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

export class Screen {
  private ring: Frame | null = null;
  private lastInput = Number.NEGATIVE_INFINITY;
  private cursor = { x: 0, y: 0 };
  private lastHash: string | null = null;
  private lastWrite = Number.NEGATIVE_INFINITY;
  private capturing: Promise<Frame | null> | null = null;

  private readonly o: ScreenOptions;

  constructor(o: ScreenOptions) {
    this.o = o;
  }

  /** Input happened (at a point, for pointer input). */
  input(x?: number, y?: number): void {
    this.lastInput = this.o.now();
    if (x !== undefined && y !== undefined) this.cursor = { x, y };
  }

  get active(): boolean {
    return this.o.now() - this.lastInput < ACTIVE_MS;
  }

  /** Ring step, every 500 ms: capture only while active. */
  async ringTick(): Promise<void> {
    if (!this.active || this.o.blocked()) return;
    await this.capture();
  }

  /** The "before" frame: the ring's latest when ≤ 500 ms old, else a capture now. */
  async before(): Promise<Frame | null> {
    if (this.o.blocked()) return null;
    const r = this.ring;
    if (r && this.o.now() - r.at <= RING_MS) return r;
    return this.capture();
  }

  /** Write a frame once; later calls get the same number. */
  number(f: Frame | null): Promise<number | null> {
    if (!f) return Promise.resolve(null);
    f.n ??= this.persist(f);
    return f.n;
  }

  /** The "after" frame: a capture 300 ms from now, written. */
  async after(sleep = defaultSleep): Promise<number | null> {
    await sleep(AFTER_MS);
    if (this.o.blocked()) return null;
    return this.number(await this.capture());
  }

  /**
   * Idle reading (no input for 5 s): a frame number when the screen changed since the last
   * write, 2 s apart at most.
   */
  async idle(): Promise<number | null> {
    if (this.active || this.o.blocked() || this.o.now() - this.lastWrite < IDLE_MS) return null;
    const f = await this.capture();
    if (!f) return null;
    if (!differs(this.lastHash, f.shot.hash)) return null;
    return this.number(f);
  }

  private capture(): Promise<Frame | null> {
    this.capturing ??= (async () => {
      try {
        const shot = await this.o.capturer.grab(this.cursor.x, this.cursor.y);
        if (!shot) return null;
        const f: Frame = { shot, at: this.o.now() };
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
      let ok = false;
      try {
        ok = await this.o.capturer.save(f.shot, slot.path);
        if (ok && this.o.blocked()) ok = false; // paused while saving: the file is deleted
      } finally {
        slot.done(ok);
      }
      if (!ok) this.o.log?.("screen: frame not saved");
      return ok ? slot.n : null;
    } catch (e) {
      this.o.log?.(`screen: frame failed: ${(e as Error).message}`);
      return null;
    }
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
