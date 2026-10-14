import { describe, expect, it } from "vitest";
import { APPROACH_MAX, DRAG_MAX, downsample, PathRing } from "./path.ts";
import { addStats, emptyStats, SegmentCounters } from "./stats.ts";

describe("downsample", () => {
  it("keeps all when under the cap", () => {
    expect(downsample([1, 2, 3], 5)).toEqual([1, 2, 3]);
  });

  it("keeps evenly spaced points, first and last included", () => {
    const pts = Array.from({ length: 101 }, (_, i) => i);
    expect(downsample(pts, 5)).toEqual([0, 25, 50, 75, 100]);
    expect(downsample(pts, 60)).toHaveLength(60);
    expect(downsample(pts, 60)[0]).toBe(0);
    expect(downsample(pts, 60).at(-1)).toBe(100);
  });
});

describe("path ring", () => {
  it("the approach is the last 1 s of raw moves, dt negative, rounded to 0.1", () => {
    const r = new PathRing();
    r.move(0, 1, 1); // older than 1 s at t = 1200
    r.move(300, 10.04, 20.06);
    r.move(1100, 30, 40);
    r.move(1300, 99, 99); // after the act
    expect(r.before(1200)).toEqual([
      [-900, 10, 20.1],
      [-100, 30, 40],
    ]);
  });

  it("120 Hz for a second is cut to 60 points", () => {
    const r = new PathRing();
    for (let i = 0; i < 120; i++) r.move(i * 8.3, i, i);
    const p = r.before(1000);
    expect(p).toHaveLength(APPROACH_MAX);
    expect(p[0]?.[0]).toBeLessThan(-900);
    expect(p.at(-1)?.[0]).toBeLessThanOrEqual(0);
  });

  it("the ring holds 1.5 s", () => {
    const r = new PathRing();
    r.move(0, 0, 0);
    r.move(1600, 5, 5);
    expect(r.before(1600, 100).length).toBe(1);
    expect(r.before(900).length).toBe(0); // the 0 ms point dropped once 1.6 s came
  });

  it("a held button collects the drag, dt from its start, at most 120 points", () => {
    const r = new PathRing();
    r.move(0, 0, 0);
    r.press();
    for (let i = 1; i <= 500; i++) r.move(i * 4, i, 0);
    const held = r.release(0);
    expect(held).toHaveLength(DRAG_MAX);
    expect(held[0]).toEqual([4, 1, 0]);
    expect(held.at(-1)).toEqual([2000, 500, 0]);
    expect(r.release(0)).toEqual([]); // released once
  });

  it("clear drops the ring and a held path", () => {
    const r = new PathRing();
    r.press();
    r.move(10, 1, 1);
    r.clear();
    expect(r.before(20)).toEqual([]);
    expect(r.release(0)).toEqual([]);
  });
});

describe("stats", () => {
  it("counts events, probe answers and seconds per level; take starts afresh", () => {
    let now = 0;
    const c = new SegmentCounters(() => now);
    c.event("click");
    c.event("click");
    c.probe(true);
    c.probe(false);
    c.setLevel("full");
    now = 10_400;
    c.setLevel("lean");
    now = 12_000;
    const s = c.take();
    expect(s.events).toEqual({ click: 2 });
    expect(s.probe).toEqual({ answers: 1, timeouts: 1 });
    expect(s.levels).toEqual({ full: 10, normal: 0, lean: 2 });
    now = 15_000;
    expect(c.take().levels).toEqual({ full: 0, normal: 0, lean: 3 }); // still lean
  });

  it("restarts are starts past each helper's first", () => {
    const c = new SegmentCounters(() => 0);
    c.helperStarts({ probe: 1, shots: 1 });
    c.helperStarts({ probe: 3, shots: 1 });
    expect(c.take().restarts).toEqual({ probe: 2 });
    c.helperStarts({ probe: 3, shots: 2 });
    expect(c.take().restarts).toEqual({ shots: 1 });
  });

  it("adds field by field", () => {
    const a = emptyStats();
    a.events.click = 1;
    a.frames.saved = 2;
    const b = emptyStats();
    b.events.click = 2;
    b.events.key = 1;
    b.frames.saved = 3;
    b.levels.full = 7;
    b.restarts.probe = 1;
    const sum = addStats(a, b);
    expect(sum.events).toEqual({ click: 3, key: 1 });
    expect(sum.frames.saved).toBe(5);
    expect(sum.levels.full).toBe(7);
    expect(sum.restarts).toEqual({ probe: 1 });
  });
});
