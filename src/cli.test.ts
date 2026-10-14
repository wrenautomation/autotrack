import { describe, expect, it } from "vitest";
import { costOf } from "./cli.ts";
import type { Status } from "./recorder.ts";

const status = (o: Partial<Status>): Status =>
  ({ level: "full", why: "on AC", cpuUs: 0, rssMb: 80, inputs: 0, helpers: {}, ...o }) as Status;

describe("doctor's cost", () => {
  it("CPU per part over the window, peak RSS of all the statuses read, inputs in the window", () => {
    const a = status({ cpuUs: 0, inputs: 10, helpers: { probe: { cpuMs: 100, rssMb: 20 } } });
    const mid = status({ rssMb: 120, helpers: { probe: { cpuMs: 150, rssMb: 40 } } });
    const b = status({
      cpuUs: 200_000,
      inputs: 110,
      helpers: { probe: { cpuMs: 300, rssMb: 25 } },
    });
    const c = costOf(a, b, 10_000, "test", [mid, b]);
    expect(c.parts.recorder?.cpuPct).toBeCloseTo(2);
    expect(c.parts.probe?.cpuPct).toBeCloseTo(2);
    expect(c.cpuPct).toBeCloseTo(4);
    expect(c.rssMb).toBe(105);
    expect(c.peakRssMb).toBe(160);
    expect(c.inputs).toBe(100);
  });
});
