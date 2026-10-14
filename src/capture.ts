/**
 * The real screen, through the native helper's `--shots` mode (helpers/mac/probe, helpers/win/probe.ps1):
 * it grabs a display into a ring of the last few grabs in its own memory, answers a slot and a
 * hash, and writes the JPEG when asked. Node keeps slot numbers and hashes, never pixels.
 *
 * It is a second process next to the probe, so a capture never delays a probe answer. A missing or
 * failing helper means no frames; the recorder carries on without them.
 */
import type { Screen as CoordScreen } from "./coords.ts";
import type { Display } from "./events.ts";
import { HelperClient, helperCommand, spawnHelper } from "./helper.ts";
import type { Capturer, CropAnswer, Shot } from "./screen.ts";

/** JPEG quality of every frame. */
export const QUALITY = 70;

const GRAB_MS = 2500;
const SAVE_MS = 4000;
const DISPLAYS_MS = 3000;

/** A display as the helper reports it: logical points, plus the OS's own rect and DPI scale. */
export interface ShotsDisplay extends Display {
  os?: CoordScreen;
}

export interface GrabAnswer {
  slot: number;
  seq?: number;
  w: number;
  h: number;
  hash: string;
  error?: string;
}

export interface SaveAnswer {
  ok: boolean;
  bytes?: number;
  error?: string;
}

export interface CropReply extends SaveAnswer {
  /** Pixels written. */
  w?: number;
  h?: number;
}

/** JPEG quality of a crop (small text has to stay readable). */
export const CROP_QUALITY = 85;

export class Shots extends HelperClient {
  private readonly grabMs: number;
  private readonly saveMs: number;

  /** `timeoutMs` replaces the grab, save and displays deadlines (tests). */
  constructor(opts: ConstructorParameters<typeof HelperClient>[0]) {
    super({ ...opts, name: "shots" });
    this.grabMs = opts.timeoutMs ?? GRAB_MS;
    this.saveMs = opts.timeoutMs ?? SAVE_MS;
  }

  displays(timeoutMs?: number): Promise<{ displays?: ShotsDisplay[] } | null> {
    return this.call(
      "displays",
      {},
      timeoutMs ?? (this.grabMs === GRAB_MS ? DISPLAYS_MS : this.grabMs),
    );
  }
  grab(display: string): Promise<GrabAnswer | null> {
    return this.call("grab", { display }, this.grabMs);
  }
  save(slot: number, seq: number | undefined, path: string): Promise<SaveAnswer | null> {
    const args = { slot, ...(seq !== undefined ? { seq } : {}), path, quality: QUALITY };
    return this.call("save", args, this.saveMs);
  }
  /** A rect of a display, in global logical points, at its native pixels. */
  crop(
    display: string,
    rect: { x: number; y: number; w: number; h: number },
    path: string,
  ): Promise<CropReply | null> {
    return this.call("crop", { display, ...rect, path, quality: CROP_QUALITY }, this.saveMs);
  }
}

/** The shots helper for this OS, or one that answers null when it is missing. */
export function openShots(log?: (msg: string) => void): Shots {
  const cmd = helperCommand(process.platform, undefined, "shots");
  return new Shots({ spawn: cmd ? spawnHelper(cmd) : null, ...(log ? { log } : {}) });
}

/** What the helper's grab token holds: which slot, which grab, which helper start. */
interface Token {
  slot: number;
  seq: number | undefined;
  start: number;
}

/**
 * The recorder's capturer over a shots client. `refresh()` reads the display list (call it before
 * the recorder starts, then now and then); `displays()`, `displayAt` and `screens()` answer from
 * that list.
 */
export class ShotsCapturer implements Capturer {
  private list: ShotsDisplay[] = [];
  private readonly shots: Shots;
  private readonly log: ((msg: string) => void) | undefined;
  private lastError = "";

  constructor(shots: Shots, log?: (msg: string) => void) {
    this.shots = shots;
    this.log = log;
  }

  /**
   * Re-read the display list; keeps the old one when the helper doesn't answer. The first call
   * after start can be slow (PowerShell compiles its code before it reads a request).
   */
  async refresh(timeoutMs?: number): Promise<boolean> {
    const a = await this.shots.displays(timeoutMs);
    if (!a?.displays?.length) return false;
    this.list = a.displays;
    return true;
  }

  displays(): Display[] {
    return this.list.map(({ os: _os, ...d }) => d);
  }

  /** Displays in the OS's own units, for `coordsFor`. */
  screens(): CoordScreen[] {
    return this.list.flatMap((d) => (d.os ? [d.os] : []));
  }

  /** The display id under a logical point, without capturing. */
  close(): void {
    this.shots.close();
  }

  displayAt = (x: number, y: number): string | undefined => this.at(x, y)?.id;

  private at(x: number, y: number): ShotsDisplay | undefined {
    return this.list.find((d) => x >= d.x && y >= d.y && x < d.x + d.width && y < d.y + d.height);
  }

  async grab(x: number, y: number): Promise<Shot | null> {
    if (!this.list.length) await this.refresh(); // the helper wasn't up at start
    const d = this.at(x, y) ?? this.list.find((e) => e.primary) ?? this.list[0];
    if (!d) return null;
    const start = this.shots.starts;
    const a = await this.shots.grab(d.id);
    if (!a || a.error || typeof a.slot !== "number") {
      this.note(a?.error ?? "no answer");
      return null;
    }
    return {
      display: d.id,
      width: a.w,
      height: a.h,
      hash: a.hash,
      token: { slot: a.slot, seq: a.seq, start } satisfies Token,
    };
  }

  async save(shot: Shot, path: string): Promise<boolean | "reused"> {
    const t = shot.token as Token;
    if (t.start !== this.shots.starts) return false; // the helper restarted: its slots are gone
    const a = await this.shots.save(t.slot, t.seq, path);
    if (a?.error === "slot reused") return "reused";
    if (!a?.ok) {
      this.note(a?.error ?? "no answer");
      return false;
    }
    return true;
  }

  /**
   * `size` × `size` points centred on a logical point, moved inside its display, at the display's
   * native pixels.
   */
  async crop(x: number, y: number, size: number, path: string): Promise<CropAnswer | null> {
    const d = this.at(x, y);
    if (!d) return null;
    const rect = cropRect(d, x, y, size);
    const a = await this.shots.crop(d.id, rect, path);
    if (!a?.ok) {
      this.note(a?.error ?? "no answer");
      return null;
    }
    return { ok: true, ...(a.w ? { w: a.w } : {}), ...(a.h ? { h: a.h } : {}) };
  }

  /** Log a failure once per distinct message, not every 500 ms. */
  private note(error: string): void {
    if (error === this.lastError) return;
    this.lastError = error;
    this.log?.(`screen: ${error}`);
  }
}

/** The crop rect for a point: `size` points square (smaller on a tinier display), inside it. */
export function cropRect(
  d: Pick<Display, "x" | "y" | "width" | "height">,
  x: number,
  y: number,
  size: number,
): { x: number; y: number; w: number; h: number } {
  const w = Math.min(size, Math.floor(d.width));
  const h = Math.min(size, Math.floor(d.height));
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  return {
    x: Math.round(clamp(x - w / 2, d.x, d.x + d.width - w)),
    y: Math.round(clamp(y - h / 2, d.y, d.y + d.height - h)),
    w,
    h,
  };
}

export interface FramesCheck {
  ok: boolean;
  /** One line for `doctor`. */
  message: string;
}

/** For `doctor`: grab the primary display and save it, so a missing permission or helper shows. */
export async function checkFrames(shots: Shots, path: string): Promise<FramesCheck> {
  if (!shots.available)
    return { ok: false, message: "shots helper missing: no frames are recorded" };
  const capturer = new ShotsCapturer(shots);
  if (!(await capturer.refresh(15_000)))
    return { ok: false, message: "shots helper does not answer: no frames are recorded" };
  const t0 = performance.now();
  const shot = await capturer.grab(0, 0);
  const t1 = performance.now();
  if (!shot)
    return {
      ok: false,
      message:
        process.platform === "darwin"
          ? "cannot grab the screen (Screen Recording not granted?): no frames are recorded"
          : "cannot grab the screen: no frames are recorded",
    };
  const saved = await capturer.save(shot, path);
  const t2 = performance.now();
  if (!saved)
    return { ok: false, message: "grabbed a frame but cannot save it: no frames are recorded" };
  return {
    ok: true,
    message: `frames ${shot.width}x${shot.height}, grab ${Math.round(t1 - t0)} ms, save ${Math.round(t2 - t1)} ms`,
  };
}
