import { describe, expect, it } from "vitest";
import { coordsFor, identity } from "./coords.ts";

describe("coords", () => {
  it("Mac is points throughout", () => {
    expect(coordsFor("darwin", [{ x: 0, y: 0, width: 1512, height: 982, scale: 2 }])).toBe(
      identity,
    );
  });

  it("Windows: physical in, points out, and back for the probe", () => {
    // A 150% laptop panel (2880×1800 physical) and a 100% monitor to its right.
    const c = coordsFor("win32", [
      { x: 0, y: 0, width: 2880, height: 1800, scale: 1.5 },
      { x: 2880, y: 0, width: 1920, height: 1080, scale: 1 },
    ]);
    expect(c.toLogical(1500, 900)).toEqual({ x: 1000, y: 600 });
    expect(c.toPhysical(1000, 600)).toEqual({ x: 1500, y: 900 });
    expect(c.toLogical(3000, 100)).toEqual({ x: 3000, y: 100 });
    expect(c.rect({ x: 300, y: 150, width: 600, height: 60, title: "w" })).toEqual({
      x: 200,
      y: 100,
      width: 400,
      height: 40,
      title: "w",
    });
  });

  it("a point on no display takes the first display's scale", () => {
    const c = coordsFor("win32", [{ x: 0, y: 0, width: 1920, height: 1080, scale: 1.25 }]);
    expect(c.toLogical(-250, 0)).toEqual({ x: -200, y: 0 });
  });
});
