/**
 * Frames. A 2 fps ring keeps the latest capture of the display under the cursor while input
 * happened in the last 5 s (idle = no capture). An act takes the ring's frame as "before" and a
 * fresh one 300 ms later as "after". While idle, a capture every 2 s is written only when it
 * differs from the last written frame. Each frame is written once and referenced by number.
 */
import type { Display } from "./events.ts";

export const RING_MS = 500;
export const ACTIVE_MS = 5000;
export const AFTER_MS = 300;
export const IDLE_MS = 2000;

/** One capture. `raw` is RGBA, read lazily (the capture itself stays native until then). */
export interface Shot {
  display: string;
  width: number;
  height: number;
  raw(): Promise<Uint8Array>;
  /** Drop the pixels once the frame is written (24 MB at Retina); raw() is not called after. */
  release?(): void;
}

export interface Capturer {
  displays(): Display[];
  /** The display under this logical point. */
  capture(x: number, y: number): Promise<Shot | null>;
}

export type Encode = (rgba: Uint8Array, width: number, height: number) => Promise<Uint8Array>;

export interface Frame {
  shot: Shot;
  at: number;
  n?: Promise<number | null>;
}

export interface ScreenOptions {
  capturer: Capturer;
  encode: Encode;
  write: (jpeg: Uint8Array) => number;
  now: () => number;
  /** True while nothing may be captured (paused, excluded app, locked). */
  blocked: () => boolean;
  /** A last check right before a frame is written (is an excluded app in front now?). */
  mayWrite?: () => Promise<boolean>;
  log?: (msg: string) => void;
}

const GRID_W = 32;
const GRID_H = 18;

/** Luminance at a 32×18 grid of points: cheap, and enough to tell a page moved. */
export function thumbHash(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(GRID_W * GRID_H);
  for (let gy = 0; gy < GRID_H; gy++) {
    const y = Math.floor(((gy + 0.5) * height) / GRID_H);
    for (let gx = 0; gx < GRID_W; gx++) {
      const x = Math.floor(((gx + 0.5) * width) / GRID_W);
      const p = (y * width + x) * 4;
      out[gy * GRID_W + gx] =
        ((rgba[p] ?? 0) * 77 + (rgba[p + 1] ?? 0) * 150 + (rgba[p + 2] ?? 0) * 29) >> 8;
    }
  }
  return out;
}

/** Changed when over 2% of grid points moved by more than 10 levels (a blinking caret is not). */
export function differs(a: Uint8Array | null, b: Uint8Array): boolean {
  if (!a || a.length !== b.length) return true;
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs((a[i] ?? 0) - (b[i] ?? 0)) > 10) n++;
  return n > a.length * 0.02;
}

export class Screen {
  private ring: Frame | null = null;
  private lastInput = Number.NEGATIVE_INFINITY;
  private cursor = { x: 0, y: 0 };
  private lastHash: Uint8Array | null = null;
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
    const raw = await f.shot.raw();
    if (!differs(this.lastHash, thumbHash(raw, f.shot.width, f.shot.height))) return null;
    return this.number(f);
  }

  private capture(): Promise<Frame | null> {
    this.capturing ??= (async () => {
      try {
        const shot = await this.o.capturer.capture(this.cursor.x, this.cursor.y);
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
      const raw = await f.shot.raw();
      this.lastHash = thumbHash(raw, f.shot.width, f.shot.height);
      this.lastWrite = this.o.now();
      const jpeg = await this.o.encode(raw, f.shot.width, f.shot.height);
      f.shot.release?.();
      if (this.o.blocked() || (this.o.mayWrite && !(await this.o.mayWrite()))) return null;
      return this.o.write(jpeg);
    } catch (e) {
      this.o.log?.(`screen: frame failed: ${(e as Error).message}`);
      return null;
    }
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
