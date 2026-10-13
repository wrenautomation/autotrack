/**
 * Load-test input, never on by default: `AUTOTRACK_SYNTHETIC=<acts per second>` makes the
 * recorder take clicks, wheel ticks and Enter presses from this generator instead of the OS
 * hook. They go through folding, probe, frames and journal like real input, but nothing is
 * sent to the desktop, so a measurement can run while someone is using the machine.
 */
import type { Raw } from "./events.ts";

export interface Area {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Acts per second from the env value; null when unset, empty or not a positive number. */
export function syntheticRate(value: string | undefined): number | null {
  const n = Number(value);
  return value && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * A hook (same shape as the real one) that emits `perSecond` acts per second inside `area`:
 * mostly clicks (down, up 40 ms later), every 4th a wheel tick, every 6th an Enter press.
 */
export function syntheticHook(
  perSecond: number,
  area: () => Area,
  now: () => number = () => performance.now(),
): (onRaw: (r: Raw) => void) => () => void {
  return (onRaw) => {
    let n = 0;
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pending = new Set<NodeJS.Timeout>();
    const timer = setInterval(
      () => {
        n++;
        const a = area();
        const x = Math.round(a.x + 20 + rand() * Math.max(1, a.width - 40));
        const y = Math.round(a.y + 20 + rand() * Math.max(1, a.height - 40));
        const t = now();
        if (n % 6 === 0) {
          onRaw({ type: "keydown", t, key: "enter", mods: [] });
        } else if (n % 4 === 0) {
          onRaw({ type: "move", t, x, y });
          onRaw({ type: "wheel", t, x, y, dx: 0, dy: -3 });
        } else {
          onRaw({ type: "down", t, x, y, button: "left" });
          const up = setTimeout(() => {
            pending.delete(up);
            onRaw({ type: "up", t: now(), x, y, button: "left" });
          }, 40);
          pending.add(up);
        }
      },
      Math.max(1, Math.round(1000 / perSecond)),
    );
    return () => {
      clearInterval(timer);
      for (const p of pending) clearTimeout(p);
    };
  };
}
