import { afterEach, describe, expect, it, vi } from "vitest";
import type { Raw } from "./events.ts";
import { syntheticHook, syntheticRate } from "./synthetic.ts";

afterEach(() => vi.useRealTimers());

describe("synthetic input", () => {
  it("reads the rate from the env value", () => {
    expect(syntheticRate("2")).toBe(2);
    expect(syntheticRate("0.5")).toBe(0.5);
    for (const v of [undefined, "", "0", "-1", "x"]) expect(syntheticRate(v)).toBeNull();
  });

  it("emits the asked rate inside the area, and stops", () => {
    vi.useFakeTimers();
    let t = 0;
    const out: Raw[] = [];
    const stop = syntheticHook(
      2,
      () => ({ x: 100, y: 50, width: 400, height: 300 }),
      () => t,
    )((r) => out.push(r));
    for (let i = 0; i < 12; i++) {
      t += 500;
      vi.advanceTimersByTime(500);
    }
    const downs = out.filter((r) => r.type === "down");
    expect(downs.length).toBe(8); // 12 ticks: 2 enters, 2 wheels
    expect(out.filter((r) => r.type === "up").length).toBe(8);
    expect(out.filter((r) => r.type === "keydown").length).toBe(2);
    expect(out.filter((r) => r.type === "wheel").length).toBe(2);
    for (const r of out) {
      if ("x" in r) {
        expect(r.x).toBeGreaterThanOrEqual(100);
        expect(r.x).toBeLessThanOrEqual(500);
        expect(r.y).toBeGreaterThanOrEqual(50);
        expect(r.y).toBeLessThanOrEqual(350);
      }
    }
    stop();
    const n = out.length;
    vi.advanceTimersByTime(5000);
    expect(out.length).toBe(n);
  });
});
