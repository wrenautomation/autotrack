/**
 * The cursor approach. Every raw move (60–120 Hz, before the 20 Hz fold) goes into a 1.5 s ring;
 * a click, drag or scroll takes the last 1 s before it as `path: [[dt, x, y], …]`, at most 60
 * points, dt in ms (negative: before the act). A drag adds its own path while the button is held
 * (dt >= 0, at most 120 points). Downsampling keeps evenly spaced points, first and last included.
 */

export const RING_MS = 1500;
export const APPROACH_MS = 1000;
export const APPROACH_MAX = 60;
export const DRAG_MAX = 120;
/** A held button collects at most this many raw points before thinning (a long drag). */
const HELD_CAP = 4000;

export type PathPoint = [number, number, number];

/** At most `max` of `points`, evenly spaced, first and last kept. */
export function downsample<T>(points: T[], max: number): T[] {
  if (points.length <= max) return points;
  if (max <= 1) return points.slice(-max);
  const out: T[] = [];
  for (let i = 0; i < max; i++)
    out.push(points[Math.round((i * (points.length - 1)) / (max - 1))] as T);
  return out;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

export class PathRing {
  private pts: { t: number; x: number; y: number }[] = [];
  private held: { t: number; x: number; y: number }[] | null = null;

  /** A raw move at session time t. */
  move(t: number, x: number, y: number): void {
    this.pts.push({ t, x, y });
    let drop = 0;
    while (drop < this.pts.length && t - (this.pts[drop] as { t: number }).t > RING_MS) drop++;
    if (drop) this.pts.splice(0, drop);
    if (this.held) {
      this.held.push({ t, x, y });
      if (this.held.length > HELD_CAP) this.held = this.held.filter((_, i) => i % 2 === 0);
    }
  }

  /** The approach to an act at t: moves in (t − 1 s, t], as [dt, x, y]. */
  before(t: number, max = APPROACH_MAX): PathPoint[] {
    const pts = this.pts
      .filter((p) => p.t <= t && t - p.t < APPROACH_MS)
      .map((p): PathPoint => [Math.round(p.t - t), r1(p.x), r1(p.y)]);
    return downsample(pts, max);
  }

  /** A button went down at t: collect moves until `release`. */
  press(): void {
    this.held = [];
  }

  /** The button came up: the moves while it was held, dt from `t0`, at most `max`. */
  release(t0: number, max = DRAG_MAX): PathPoint[] {
    const held = this.held ?? [];
    this.held = null;
    return downsample(
      held.map((p): PathPoint => [Math.round(p.t - t0), r1(p.x), r1(p.y)]),
      max,
    );
  }

  /** A pause or stop: the ring and any held path go. */
  clear(): void {
    this.pts = [];
    this.held = null;
  }
}
