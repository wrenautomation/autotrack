import { describe, expect, it } from "vitest";
import { type Capturer, differs, Screen, type Shot, thumbHash } from "./screen.ts";

function solid(w: number, h: number, v: number): Uint8Array {
  return new Uint8Array(w * h * 4).fill(v);
}

function setup() {
  let now = 0;
  let shade = 10;
  let captures = 0;
  let blocked = false;
  const written: number[] = [];
  const capturer: Capturer = {
    displays: () => [],
    capture: async () => {
      captures++;
      const v = shade;
      const shot: Shot = { display: "1", width: 64, height: 36, raw: async () => solid(64, 36, v) };
      return shot;
    },
  };
  const screen = new Screen({
    capturer,
    encode: async (rgba) => rgba.subarray(0, 4),
    write: () => {
      written.push(written.length);
      return written.length - 1;
    },
    now: () => now,
    blocked: () => blocked,
  });
  return {
    screen,
    written,
    at: (t: number) => {
      now = t;
    },
    shade: (v: number) => {
      shade = v;
    },
    block: (b: boolean) => {
      blocked = b;
    },
    captures: () => captures,
  };
}

const instant = async () => {};

describe("screen", () => {
  it("captures for the ring only while input happened in the last 5 s", async () => {
    const s = setup();
    await s.screen.ringTick();
    expect(s.captures()).toBe(0);
    s.screen.input(1, 1);
    await s.screen.ringTick();
    expect(s.captures()).toBe(1);
    s.at(5001);
    await s.screen.ringTick();
    expect(s.captures()).toBe(1);
  });

  it("before = the ring frame when ≤ 500 ms old, else a fresh capture; written once", async () => {
    const s = setup();
    s.screen.input(1, 1);
    await s.screen.ringTick();
    s.at(400);
    const a = await s.screen.before();
    const b = await s.screen.before();
    expect(a).toBe(b);
    expect(s.captures()).toBe(1);
    expect(await s.screen.number(a)).toBe(0);
    expect(await s.screen.number(b)).toBe(0);
    expect(s.written.length).toBe(1);
    s.at(1000);
    await s.screen.before();
    expect(s.captures()).toBe(2);
  });

  it("after = a new capture, written", async () => {
    const s = setup();
    expect(await s.screen.after(instant)).toBe(0);
    expect(await s.screen.after(instant)).toBe(1);
  });

  it("nothing is captured or written while blocked", async () => {
    const s = setup();
    s.block(true);
    s.screen.input(1, 1);
    await s.screen.ringTick();
    expect(await s.screen.before()).toBeNull();
    expect(await s.screen.after(instant)).toBeNull();
    expect(await s.screen.idle()).toBeNull();
    expect(s.captures()).toBe(0);
  });

  it("idle writes a frame only when idle and the screen changed, 2 s apart at most", async () => {
    const s = setup();
    s.screen.input(1, 1);
    expect(await s.screen.idle()).toBeNull(); // input just now: not idle
    s.at(6000);
    expect(await s.screen.idle()).toBe(0); // first one: nothing to compare with
    s.at(9000);
    expect(await s.screen.idle()).toBeNull(); // same picture
    s.shade(200);
    s.at(11000);
    expect(await s.screen.idle()).toBe(1);
    s.shade(90);
    s.at(12000);
    expect(await s.screen.idle()).toBeNull(); // changed, but < 2 s after the last write
    s.at(13000);
    expect(await s.screen.idle()).toBe(2);
  });

  it("a blinking caret is not a change; a scrolled page is", () => {
    const a = thumbHash(solid(320, 180, 50), 320, 180);
    const caret = new Uint8Array(a);
    caret[5] = 250;
    expect(differs(a, caret)).toBe(false);
    expect(differs(a, thumbHash(solid(320, 180, 120), 320, 180))).toBe(true);
    expect(differs(null, a)).toBe(true);
  });
});
