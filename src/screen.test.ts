import { describe, expect, it } from "vitest";
import { LEVELS, type Level } from "./level.ts";
import { type Capturer, differs, type Frame, Screen, type Shot } from "./screen.ts";

/** A hash: two luma bytes, then 48 gradient bits. */
const hash = (top: number, bottom: number, grad = 0n) =>
  ((BigInt(top) << 56n) | (BigInt(bottom) << 48n) | grad).toString(16).padStart(16, "0");

function setup(o: { level?: Level; hashes?: string[] } = {}) {
  let now = 0;
  let h = hash(10, 10);
  let level: Level = o.level ?? "normal";
  const shots: { n: number; f: Frame }[] = [];
  let grabs = 0;
  let blocked = false;
  let saves = 0;
  let saveOk = true;
  let allowed = true;
  let pauseOnSave = false;
  const written: string[] = [];
  const given: (boolean | "reused")[] = [];
  let next = 0;
  const capturer: Capturer = {
    displays: () => [],
    grab: async () => {
      grabs++;
      if (o.hashes?.length) h = o.hashes.shift() as string;
      return { display: "1", width: 64, height: 36, hash: h, token: grabs } satisfies Shot;
    },
    save: async (_shot, path) => {
      saves++;
      if (pauseOnSave) blocked = true;
      if (saveOk) written.push(path);
      return saveOk;
    },
  };
  const screen = new Screen({
    capturer,
    frames: {
      reserveFrame: () => {
        const n = next++;
        return { n, path: `/f/${n}.jpg`, done: (ok) => given.push(ok) };
      },
    },
    now: () => now,
    blocked: () => blocked,
    mayWrite: async () => allowed,
    params: () => LEVELS[level],
    onShot: (n, f) => shots.push({ n, f }),
  });
  return {
    screen,
    shots,
    level: (l: Level) => {
      level = l;
    },
    written,
    given,
    at: (t: number) => {
      now = t;
    },
    hash: (v: string) => {
      h = v;
    },
    block: (b: boolean) => {
      blocked = b;
    },
    saveOk: (v: boolean) => {
      saveOk = v;
    },
    pauseOnSave: () => {
      pauseOnSave = true;
    },
    allow: (v: boolean) => {
      allowed = v;
    },
    grabs: () => grabs,
    saves: () => saves,
  };
}

const instant = async () => {};

describe("screen", () => {
  it("captures for the ring only while input happened in the last 5 s", async () => {
    const s = setup();
    await s.screen.ringTick();
    expect(s.grabs()).toBe(0);
    s.screen.input(1, 1);
    await s.screen.ringTick();
    expect(s.grabs()).toBe(1);
    s.at(5001);
    await s.screen.ringTick();
    expect(s.grabs()).toBe(1);
  });

  it("before = the ring frame when ≤ 500 ms old, else a fresh capture; written once", async () => {
    const s = setup();
    s.screen.input(1, 1);
    await s.screen.ringTick();
    s.at(400);
    const a = await s.screen.before();
    const b = await s.screen.before();
    expect(a).toBe(b);
    expect(s.grabs()).toBe(1);
    expect(await s.screen.number(a)).toBe(0);
    expect(await s.screen.number(b)).toBe(0);
    expect(s.written).toEqual(["/f/0.jpg"]);
    s.at(1000);
    await s.screen.before();
    expect(s.grabs()).toBe(2);
  });

  it("after = a new capture, written", async () => {
    const s = setup();
    expect(await s.screen.after(instant)).toBe(0);
    expect(await s.screen.after(instant)).toBe(1);
  });

  it("afterFrame gives the capture's hash with its number; blocked gives neither", async () => {
    const s = setup();
    s.hash(hash(90, 20));
    expect(await s.screen.afterFrame(instant)).toEqual({
      n: 0,
      hash: hash(90, 20),
      path: "/f/0.jpg",
      settle: 0,
    });
    s.block(true);
    expect(await s.screen.afterFrame(instant)).toEqual({ n: null, hash: null });
  });

  it("nothing is captured or written while blocked", async () => {
    const s = setup();
    s.block(true);
    s.screen.input(1, 1);
    await s.screen.ringTick();
    expect(await s.screen.before()).toBeNull();
    expect(await s.screen.after(instant)).toBeNull();
    expect(await s.screen.idle()).toBeNull();
    expect(s.grabs()).toBe(0);
  });

  it("idle writes a frame only when idle and the screen changed, 2 s apart at most", async () => {
    const s = setup();
    s.screen.input(1, 1);
    expect(await s.screen.idle()).toBeNull(); // input just now: not idle
    s.at(6000);
    expect(await s.screen.idle()).toBe(0); // first one: nothing to compare with
    s.at(9000);
    expect(await s.screen.idle()).toBeNull(); // same picture
    s.hash(hash(200, 200));
    s.at(11000);
    expect(await s.screen.idle()).toBe(1);
    s.hash(hash(90, 90));
    s.at(12000);
    expect(await s.screen.idle()).toBeNull(); // changed, but < 2 s after the last write
    s.at(13000);
    expect(await s.screen.idle()).toBe(2);
  });

  it("a frame that could not be saved is not numbered and the reservation is given up", async () => {
    const s = setup();
    s.saveOk(false);
    expect(await s.screen.after(instant)).toBeNull();
    expect(s.given).toEqual([false]);
    s.saveOk(true);
    expect(await s.screen.after(instant)).toBe(1); // 0 was given up
    expect(s.given).toEqual([false, true]);
  });

  it("an excluded app in front at the last check: nothing is saved", async () => {
    const s = setup();
    s.allow(false);
    expect(await s.screen.after(instant)).toBeNull();
    expect(s.saves()).toBe(0);
    expect(s.given).toEqual([]);
  });

  it("paused while the helper saves: the frame is dropped", async () => {
    const s = setup();
    const f = await s.screen.before();
    s.pauseOnSave();
    expect(await s.screen.number(f)).toBeNull();
    expect(s.given).toEqual([false]);
  });
});

describe("quality", () => {
  /** A sleep that moves the fake clock. */
  const clocked = (s: ReturnType<typeof setup>, start: number) => {
    let now = start;
    return async (ms: number) => {
      now += ms;
      s.at(now);
    };
  };

  it("settles: grabs every tick until two agree, settle from the act's end", async () => {
    const s = setup({ hashes: [hash(10, 10), hash(90, 10), hash(150, 10), hash(150, 10)] });
    s.at(1000);
    const a = await s.screen.afterFrame(clocked(s, 1000), 900);
    // normal: 150 ms ticks; grabs at 1150, 1300, 1450, 1600; 1450 and 1600 agree
    expect(a).toEqual({ n: 0, hash: hash(150, 10), path: "/f/0.jpg", settle: 550 });
    expect(s.grabs()).toBe(4);
    expect(s.written).toEqual(["/f/0.jpg"]);
  });

  it("full settles on 100 ms ticks; lean takes one grab 300 ms after", async () => {
    const f = setup({ level: "full" });
    f.at(0);
    expect(await f.screen.afterFrame(clocked(f, 0), 0)).toEqual({
      n: 0,
      hash: hash(10, 10),
      path: "/f/0.jpg",
      settle: 100,
    });
    const l = setup({ level: "lean" });
    let slept = 0;
    const r = await l.screen.afterFrame(async (ms) => {
      slept += ms;
    });
    expect(r).toEqual({ n: 0, hash: hash(10, 10), path: "/f/0.jpg" });
    expect(slept).toBe(300);
    expect(l.grabs()).toBe(1);
  });

  it("gives up after 3 s of change: settled false, the last grab written", async () => {
    const hashes = Array.from({ length: 40 }, (_, i) => hash(i * 5, 0));
    const s = setup({ hashes });
    s.at(0);
    const a = await s.screen.afterFrame(clocked(s, 0), 0);
    expect(a.settled).toBe(false);
    expect(a.settle).toBe(3000);
    expect(s.grabs()).toBe(20); // 3000 / 150
    expect(s.written.length).toBe(1);
  });

  it("gives up after its tick count even when the clock stands still", async () => {
    const hashes = Array.from({ length: 40 }, (_, i) => hash(i * 5, 0));
    const s = setup({ hashes, level: "full" });
    const a = await s.screen.afterFrame(instant);
    expect(a.settled).toBe(false);
    expect(s.grabs()).toBe(30);
  });

  it("a click's before is fresh even when the ring has one", async () => {
    const s = setup();
    s.screen.input(1, 1);
    await s.screen.ringTick();
    s.at(100);
    const ring = await s.screen.before();
    const fresh = await s.screen.fresh();
    expect(fresh).not.toBe(ring);
    expect(s.grabs()).toBe(2);
    expect(fresh?.at).toBe(100);
  });

  it("the ring runs at the level's period and before takes frames that young", async () => {
    const s = setup({ level: "full" });
    s.screen.input(1, 1);
    for (const t of [0, 250, 500, 750]) {
      s.at(t);
      await s.screen.ringTick();
    }
    expect(s.grabs()).toBe(4);
    s.level("lean");
    for (const t of [1000, 1250, 1500, 1750]) {
      s.at(t);
      await s.screen.ringTick();
    }
    expect(s.grabs()).toBe(5); // at 1750 (1 s after 750)
    s.at(2700);
    await s.screen.before(); // 950 ms old: still the ring's at lean
    expect(s.grabs()).toBe(5);
    s.level("full");
    await s.screen.before(); // too old at full
    expect(s.grabs()).toBe(6);
  });

  it("idle frames at 1 s (full), 5 s (lean)", async () => {
    const s = setup({ level: "full" });
    let shade = 0;
    const tick = async (t: number) => {
      s.at(t);
      shade += 3;
      s.hash(hash(shade, 0));
      return s.screen.idle();
    };
    expect(await tick(6000)).toBe(0);
    expect(await tick(7000)).toBe(1);
    s.level("lean");
    expect(await tick(8000)).toBeNull();
    expect(await tick(12000)).toBe(2);
  });

  it("video guard: a screen that keeps changing for 30 s with nobody there drops to one grab per 10 s", async () => {
    const s = setup({ level: "full" });
    let shade = 0;
    const tick = async (t: number) => {
      s.at(t);
      shade = (shade + 7) % 250;
      s.hash(hash(shade, 0));
      return s.screen.idle();
    };
    let t = 1000;
    for (; !s.screen.guarded && t <= 40_000; t += 1000) await tick(t);
    expect(s.screen.guarded).toBe(true);
    expect(t).toBe(31_000); // on at the grab that made 30 s
    const grabs = s.grabs();
    const on = t - 1000;
    for (; t < on + 10_000; t += 1000) await tick(t);
    expect(s.grabs()).toBe(grabs); // nothing for 10 s
    expect(await tick(on + 10_000)).not.toBeNull();
    expect(s.grabs()).toBe(grabs + 1);
    // a still grab ends it
    s.at(on + 20_000);
    expect(await s.screen.idle()).toBeNull();
    expect(s.screen.guarded).toBe(false);
    // and so does input
    s.screen.input(1, 1);
    expect(s.screen.guarded).toBe(false);
  });

  it("no guard while the screen mostly holds still", async () => {
    const s = setup({ level: "full" });
    for (let t = 1000; t <= 40_000; t += 1000) {
      s.at(t);
      if (t % 3000 === 0) s.hash(hash(t % 200, 0));
      await s.screen.idle();
    }
    expect(s.screen.guarded).toBe(false);
  });

  it("each written frame is reported once, with when it was grabbed and the cursor then", async () => {
    const s = setup();
    s.screen.input(30, 40);
    s.at(70);
    const f = await s.screen.fresh();
    s.at(500);
    await s.screen.number(f);
    await s.screen.number(f);
    expect(s.shots.map((x) => [x.n, x.f.at, x.f.x, x.f.y])).toEqual([[0, 70, 30, 40]]);
  });

  it("a save refused because the slot was reused is given up as reused", async () => {
    const s = setup();
    const f = await s.screen.fresh();
    s.saveOk(false);
    expect(await s.screen.number(f)).toBeNull();
    expect(s.given).toEqual([false]);
    expect(s.shots).toEqual([]);
  });
});

describe("differs", () => {
  it("a blinking caret or a ticking clock is not a change", () => {
    const a = hash(100, 100, 0b1010101n);
    expect(differs(a, a)).toBe(false);
    expect(differs(a, hash(100, 100, 0b1010100n))).toBe(false); // 1 gradient bit
    expect(differs(a, hash(100, 101, 0b1010101n))).toBe(false); // 1 level of luma
  });

  it("a scrolled page, a new window or a dark flash is", () => {
    const a = hash(100, 100, 0b1010101n);
    expect(differs(a, hash(100, 100, 0b1010000n))).toBe(false); // 2 gradient bits: still noise
    expect(differs(a, hash(100, 100, 0b1000000n))).toBe(true); // 3 gradient bits
    expect(differs(a, hash(100, 103, 0b1010101n))).toBe(true); // luma moved
    expect(differs(a, hash(30, 100, 0b1010101n))).toBe(true);
  });

  it("no earlier hash, or a malformed one, counts as changed", () => {
    expect(differs(null, hash(1, 1))).toBe(true);
    expect(differs("zz", hash(1, 1))).toBe(true);
  });
});
