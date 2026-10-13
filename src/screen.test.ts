import { describe, expect, it } from "vitest";
import { type Capturer, differs, Screen, type Shot } from "./screen.ts";

/** A hash: two luma bytes, then 48 gradient bits. */
const hash = (top: number, bottom: number, grad = 0n) =>
  ((BigInt(top) << 56n) | (BigInt(bottom) << 48n) | grad).toString(16).padStart(16, "0");

function setup() {
  let now = 0;
  let h = hash(10, 10);
  let grabs = 0;
  let blocked = false;
  let saves = 0;
  let saveOk = true;
  let allowed = true;
  let pauseOnSave = false;
  const written: string[] = [];
  const given: boolean[] = [];
  let next = 0;
  const capturer: Capturer = {
    displays: () => [],
    grab: async () => {
      grabs++;
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
  });
  return {
    screen,
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
    expect(await s.screen.afterFrame(instant)).toEqual({ n: 0, hash: hash(90, 20) });
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
