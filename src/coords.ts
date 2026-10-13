/**
 * Logical points vs physical pixels, in one place. Events log logical points. On Mac uiohook,
 * the probe and the shots helper all speak logical points already. On Windows uiohook and the
 * probe speak physical pixels on the virtual desktop: divide by the display's scale for events,
 * multiply back for the probe.
 */
import type { Element, WindowInfo } from "./events.ts";

/** A display as the OS reports it, in its own units (physical on Windows), with its DPI scale. */
export interface Screen {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

export interface Coords {
  toLogical(x: number, y: number): { x: number; y: number };
  toPhysical(x: number, y: number): { x: number; y: number };
  rect<R extends { x: number; y: number; width: number; height: number }>(r: R): R;
}

export const identity: Coords = {
  toLogical: (x, y) => ({ x, y }),
  toPhysical: (x, y) => ({ x, y }),
  rect: (r) => r,
};

const inside = (s: Screen, x: number, y: number) =>
  x >= s.x && y >= s.y && x < s.x + s.width && y < s.y + s.height;

/**
 * Physical pixels ↔ logical points on Windows: a point takes the scale of the display it is on
 * (the primary's when it is on none). Logical = physical / scale, as Windows virtualizes it.
 */
export function physical(screens: Screen[]): Coords {
  const fallback = screens[0]?.scale ?? 1;
  const scaleAtPhysical = (x: number, y: number) =>
    screens.find((s) => inside(s, x, y))?.scale ?? fallback;
  const scaleAtLogical = (x: number, y: number) =>
    screens.find((s) =>
      inside(
        {
          x: s.x / s.scale,
          y: s.y / s.scale,
          width: s.width / s.scale,
          height: s.height / s.scale,
          scale: 1,
        },
        x,
        y,
      ),
    )?.scale ?? fallback;
  const round = (v: number) => Math.round(v * 100) / 100;
  return {
    toLogical(x, y) {
      const k = scaleAtPhysical(x, y);
      return { x: round(x / k), y: round(y / k) };
    },
    toPhysical(x, y) {
      const k = scaleAtLogical(x, y);
      return { x: Math.round(x * k), y: Math.round(y * k) };
    },
    rect(r) {
      const k = scaleAtPhysical(r.x, r.y);
      return {
        ...r,
        x: round(r.x / k),
        y: round(r.y / k),
        width: round(r.width / k),
        height: round(r.height / k),
      };
    },
  };
}

export function coordsFor(platform: NodeJS.Platform, screens: Screen[]): Coords {
  return platform === "win32" ? physical(screens) : identity;
}

/** An element or window from the probe, in logical points. */
export function logicalElement(c: Coords, e: Element | null | undefined): Element | undefined {
  return e ? c.rect(e) : undefined;
}
export function logicalWindow(c: Coords, w: WindowInfo | null | undefined): WindowInfo | undefined {
  return w ? c.rect(w) : undefined;
}
