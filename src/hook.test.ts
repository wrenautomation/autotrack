import { describe, expect, it, vi } from "vitest";
import { identity, physical } from "./coords.ts";
import {
  charOf,
  type HookSource,
  KEY_WAIT_MS,
  keyCode,
  keyName,
  pumped,
  startHook,
  toRaw,
  type UiohookEvent,
} from "./hook.ts";

const base = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };

describe("hook", () => {
  it("names keys as uiohook does, lowercased", () => {
    expect(keyName(30)).toBe("a");
    expect(keyName(28)).toBe("enter");
    expect(keyName(63)).toBe("f5");
    expect(keyName(0x4f)).toBe("numpad1");
    expect(keyCode("arrowleft")).toBe(57419);
  });

  it("maps characters on a US layout", () => {
    expect(charOf("a", false)).toBe("a");
    expect(charOf("a", true)).toBe("A");
    expect(charOf("a", false, true)).toBe("A");
    expect(charOf("1", true)).toBe("!");
    expect(charOf("space", false)).toBe(" ");
    expect(charOf("enter", false)).toBeUndefined();
  });

  it("key down carries mods without the key itself, and its char", () => {
    expect(toRaw({ ...base, type: 4, keycode: 30, shiftKey: true }, 5, identity)).toEqual({
      type: "keydown",
      t: 5,
      key: "a",
      mods: ["shift"],
      char: "A",
    });
    expect(toRaw({ ...base, type: 4, keycode: 29, ctrlKey: true }, 5, identity)).toEqual({
      type: "keydown",
      t: 5,
      key: "ctrl",
      mods: [],
    });
    expect(toRaw({ ...base, type: 5, keycode: 30 }, 5, identity)).toBeNull();
  });

  it("mouse and wheel, Windows scaled to points", () => {
    const win = physical([{ x: 0, y: 0, width: 3000, height: 2000, scale: 2 }]);
    expect(toRaw({ ...base, type: 7, x: 200, y: 100, button: 1 }, 1, win)).toEqual({
      type: "down",
      t: 1,
      x: 100,
      y: 50,
      button: "left",
    });
    expect(toRaw({ ...base, type: 8, x: 2, y: 2, button: 2 }, 1, identity)).toMatchObject({
      type: "up",
      button: "right",
    });
    expect(toRaw({ ...base, type: 7, x: 2, y: 2, button: 5 }, 1, identity)).toBeNull();
    expect(toRaw({ ...base, type: 10, x: 3, y: 4 }, 1, identity)).toEqual({
      type: "move",
      t: 1,
      x: 3,
      y: 4,
    });
    expect(
      toRaw({ ...base, type: 11, x: 3, y: 4, rotation: -2, direction: 3, amount: 3 }, 1, identity),
    ).toEqual({ type: "wheel", t: 1, x: 3, y: 4, dx: 0, dy: -2 });
    expect(
      toRaw({ ...base, type: 11, x: 3, y: 4, rotation: 1, direction: 4, amount: 3 }, 1, identity),
    ).toMatchObject({ dx: 1, dy: 0 });
  });
});

describe("Mac main-queue pump", () => {
  it("drains after each key press, on a timer, and before stop", () => {
    vi.useFakeTimers();
    let emit: (e: UiohookEvent) => void = () => {};
    const calls: string[] = [];
    const fake: HookSource = {
      on: (_ev, fn) => {
        emit = fn;
      },
      removeAllListeners: () => {},
      start: () => calls.push("start"),
      stop: () => calls.push("stop"),
    };
    const waits: number[] = [];
    const seen: string[] = [];
    const stop = startHook(
      pumped(fake, { drain: (ms) => waits.push(ms) }, 50),
      () => identity,
      () => 0,
      (r) => seen.push(r.type),
    );
    emit({ ...base, type: 4, keycode: 30 });
    emit({ ...base, type: 5, keycode: 30 });
    expect(seen).toEqual(["keydown"]);
    expect(waits).toEqual([KEY_WAIT_MS]);
    vi.advanceTimersByTime(120);
    expect(waits).toEqual([KEY_WAIT_MS, 0, 0]);
    stop();
    vi.advanceTimersByTime(500);
    expect(waits).toEqual([KEY_WAIT_MS, 0, 0, KEY_WAIT_MS]);
    expect(calls).toEqual(["start", "stop"]);
    vi.useRealTimers();
  });
});
