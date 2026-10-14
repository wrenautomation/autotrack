import { describe, expect, it } from "vitest";
import { CpuMeter, decide, Governor, type LevelInputs, pinnedLevel } from "./level.ts";
import { busyMeter, parsePmset, powerOf } from "./system.ts";

const calm = { busy: false, why: "load 0.20 per core" };
const inputs = (o: Partial<LevelInputs>): LevelInputs => ({
  power: { ac: true, battery: 80 },
  busy: calm,
  cpuPct: 1,
  ...o,
});

describe("decide", () => {
  it("full on AC with a calm system", () => {
    expect(decide(inputs({}))).toEqual({ level: "full", why: "on AC, load 0.20 per core" });
  });

  it("normal on battery ≥ 20% or when a reading is missing", () => {
    expect(decide(inputs({ power: { ac: false, battery: 20 } }))).toEqual({
      level: "normal",
      why: "on battery 20%",
    });
    expect(decide(inputs({ power: null })).level).toBe("normal");
    expect(decide(inputs({ busy: null })).level).toBe("normal");
  });

  it("lean on a low battery, a busy system or own CPU over 3%; low battery wins", () => {
    expect(decide(inputs({ power: { ac: false, battery: 19 } }))).toEqual({
      level: "lean",
      why: "battery 19%",
    });
    expect(decide(inputs({ busy: { busy: true, why: "cpu idle 9%" } }))).toEqual({
      level: "lean",
      why: "system busy: cpu idle 9%",
    });
    expect(decide(inputs({ cpuPct: 3.4 }))).toEqual({
      level: "lean",
      why: "own cpu 3.4% over 60 s",
    });
    expect(
      decide(inputs({ power: { ac: false, battery: 5 }, busy: { busy: true, why: "x" } })).why,
    ).toBe("battery 5%");
  });

  it("a CPU-forced lean holds until own CPU is under 2%", () => {
    const lean = decide(inputs({ cpuPct: 4 }));
    expect(decide(inputs({ cpuPct: 2.5 }), lean).level).toBe("lean");
    expect(decide(inputs({ cpuPct: 1.9 }), lean).level).toBe("full");
    // a lean for another reason does not hold
    const busy = decide(inputs({ busy: { busy: true, why: "x" } }));
    expect(decide(inputs({ cpuPct: 2.5 }), busy).level).toBe("full");
  });
});

describe("decide: bursts", () => {
  it("a 10 s burst over 3% steps down one level, over 6% to lean", () => {
    expect(decide(inputs({ burstPct: 2.9 })).level).toBe("full");
    expect(decide(inputs({ burstPct: 4.2 }))).toEqual({
      level: "normal",
      why: "burst: own cpu 4.2% over 10 s",
    });
    expect(decide(inputs({ burstPct: 4.2, power: { ac: false, battery: 50 } })).level).toBe("lean");
    expect(decide(inputs({ burstPct: 6.5 }))).toEqual({
      level: "lean",
      why: "burst: own cpu 6.5% over 10 s",
    });
    expect(decide(inputs({ burstPct: null })).level).toBe("full");
  });

  it("the step down holds until the burst is under 2%; a lean for another reason wins", () => {
    const stepped = decide(inputs({ burstPct: 7 }));
    expect(decide(inputs({ burstPct: 2.5 }), stepped).level).toBe("normal");
    expect(decide(inputs({ burstPct: 1.9 }), stepped).level).toBe("full");
    expect(decide(inputs({ burstPct: 2.5 })).level).toBe("full"); // no burst before: no hold
    expect(decide(inputs({ burstPct: 9, cpuPct: 4 })).why).toBe("own cpu 4.0% over 60 s");
  });
});

describe("CpuMeter", () => {
  it("is null until 50 s of a 60 s window are covered, then % of one core", () => {
    const m = new CpuMeter();
    m.add(0, { recorder: 0, shots: 100 });
    m.add(40_000, { recorder: 600, shots: 700 });
    expect(m.pct()).toBeNull();
    m.add(60_000, { recorder: 900, shots: 1000 });
    expect(m.pct()).toBeCloseTo(3);
  });

  it("a restarted helper counts from zero; a missing reading is skipped", () => {
    const m = new CpuMeter();
    m.add(0, { shots: 5000 });
    m.add(30_000, { shots: 5300 });
    m.add(60_000, { shots: 200, probe: null }); // restarted: 200 new ms
    expect(m.pct()).toBeCloseTo(((300 + 200) / 60_000) * 100);
  });

  it("slides: old samples drop out", () => {
    const m = new CpuMeter();
    for (let t = 0; t <= 120_000; t += 10_000) m.add(t, { r: t < 60_000 ? t / 10 : 6000 });
    expect(m.pct()).toBeCloseTo(0);
  });
});

describe("Governor", () => {
  const make = (o: { pinned?: "lean" } = {}) => {
    let now = 0;
    let busy = false;
    let cpu = 0;
    let powerCalls = 0;
    const g = new Governor({
      now: () => now,
      cpu: async () => ({ recorder: cpu }),
      power: async () => {
        powerCalls++;
        return { ac: true, battery: 100 };
      },
      busy: () => ({ busy, why: busy ? "busy" : "calm" }),
      ...o,
    });
    return {
      g,
      at: (t: number) => {
        now = t;
      },
      busy: (b: boolean) => {
        busy = b;
      },
      cpu: (v: number) => {
        cpu = v;
      },
      powerCalls: () => powerCalls,
    };
  };

  it("answers the first decision and each change, nothing in between", async () => {
    const s = make();
    expect(await s.g.tick()).toEqual({ level: "full", why: "on AC, calm" });
    s.at(10_000);
    expect(await s.g.tick()).toBeNull();
    s.busy(true);
    s.at(20_000);
    expect(await s.g.tick()).toEqual({ level: "lean", why: "system busy: busy" });
    expect(s.g.level).toBe("lean");
  });

  it("own CPU over budget for 60 s turns lean", async () => {
    const s = make();
    for (let t = 0; t <= 60_000; t += 10_000) {
      s.at(t);
      s.cpu(t * 0.05); // 5% of a core
      await s.g.tick();
    }
    expect(s.g.level).toBe("lean");
    expect(s.g.cpuPct).toBeCloseTo(5);
  });

  it("a burst turns the level down within 10 s and back once it is over", async () => {
    const s = make();
    let cpu = 0;
    const levels: string[] = [];
    for (let t = 0; t <= 40_000; t += 2_000) {
      s.at(t);
      if (t > 0) cpu += t <= 20_000 ? 2_000 * 0.08 : 2_000 * 0.005; // 8% of a core, then 0.5%
      s.cpu(cpu);
      await s.g.tick();
      levels.push(s.g.level);
    }
    expect(levels[0]).toBe("full");
    expect(levels.indexOf("lean")).toBeGreaterThan(0);
    expect(levels.indexOf("lean")).toBeLessThanOrEqual(5); // by 10 s
    expect(levels.at(-1)).toBe("full");
    expect(s.g.burstPct).toBeCloseTo(0.5);
  });

  it("polls power once a minute", async () => {
    const s = make();
    for (let t = 0; t < 60_000; t += 10_000) {
      s.at(t);
      await s.g.tick();
    }
    expect(s.powerCalls()).toBe(1);
    s.at(60_000);
    await s.g.tick();
    expect(s.powerCalls()).toBe(2);
  });

  it("pinned holds the level but still measures", async () => {
    const s = make({ pinned: "lean" });
    expect(s.g.level).toBe("lean");
    expect(await s.g.tick()).toEqual({ level: "lean", why: "pinned (AUTOTRACK_LEVEL)" });
    expect(s.g.powerNow).toEqual({ ac: true, battery: 100 });
    expect(pinnedLevel("full")).toBe("full");
    expect(pinnedLevel("max")).toBeNull();
    expect(pinnedLevel(undefined)).toBeNull();
  });
});

describe("system readings", () => {
  it("parses pmset", () => {
    expect(
      parsePmset(
        "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=123)\t45%; discharging; 3:10 remaining present: true\n",
      ),
    ).toEqual({ ac: false, battery: 45 });
    expect(
      parsePmset(
        "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true\n",
      ),
    ).toEqual({ ac: true, battery: 100 });
    expect(parsePmset("Now drawing from 'AC Power'\n")).toEqual({ ac: true, battery: null });
    expect(parsePmset("")).toBeNull();
  });

  it("reads the probe's power answer", () => {
    expect(powerOf({ ac: true, battery: null })).toEqual({ ac: true, battery: null });
    expect(powerOf({ ac: false, battery: 30 })).toEqual({ ac: false, battery: 30 });
    expect(powerOf({ ac: null, battery: 30 })).toEqual({ ac: false, battery: 30 });
    expect(powerOf({ ac: null, battery: null })).toBeNull();
    expect(powerOf(null)).toBeNull();
  });

  it("Mac and Linux: busy over 0.85 load per core", () => {
    for (const os of ["darwin", "linux"] as const) {
      const b = busyMeter(os, { load: () => 7, cores: () => 8 });
      expect(b()).toEqual({ busy: true, why: "load 0.88 per core" });
      const c = busyMeter(os, { load: () => 2, cores: () => 8 });
      expect(c()?.busy).toBe(false);
    }
  });

  it("Windows: busy under 15% idle over 60 s, null until the window is covered", () => {
    let t = 0;
    let idle = 0;
    let total = 0;
    const b = busyMeter("win32", { times: () => ({ idle, total }) }, () => t);
    expect(b()).toBeNull();
    while (t < 60_000) {
      t += 10_000;
      idle += 1000;
      total += 10_000;
      b();
    }
    expect(b()).toEqual({ busy: true, why: "cpu idle 10%" });
  });
});
