/**
 * Global mouse and keyboard through uiohook-napi (Mac, Windows), turned into `Raw` input:
 * logical points, uiohook's key names lowercased, and the character a key types (US layout).
 */
import type { Coords } from "./coords.ts";
import type { Button, Mod, Raw } from "./events.ts";
import { mainRunLoop, type RunLoop } from "./runloop.ts";

// uiohook-napi's UiohookKey, copied so tests and key naming never load the native module.
const KEYS: Record<string, number> = {
  Backspace: 14,
  Tab: 15,
  Enter: 28,
  CapsLock: 58,
  Escape: 1,
  Space: 57,
  PageUp: 3657,
  PageDown: 3665,
  End: 3663,
  Home: 3655,
  ArrowLeft: 57419,
  ArrowUp: 57416,
  ArrowRight: 57421,
  ArrowDown: 57424,
  Insert: 3666,
  Delete: 3667,
  0: 11,
  1: 2,
  2: 3,
  3: 4,
  4: 5,
  5: 6,
  6: 7,
  7: 8,
  8: 9,
  9: 10,
  A: 30,
  B: 48,
  C: 46,
  D: 32,
  E: 18,
  F: 33,
  G: 34,
  H: 35,
  I: 23,
  J: 36,
  K: 37,
  L: 38,
  M: 50,
  N: 49,
  O: 24,
  P: 25,
  Q: 16,
  R: 19,
  S: 31,
  T: 20,
  U: 22,
  V: 47,
  W: 17,
  X: 45,
  Y: 21,
  Z: 44,
  Numpad0: 0x52,
  Numpad1: 0x4f,
  Numpad2: 0x50,
  Numpad3: 0x51,
  Numpad4: 0x4b,
  Numpad5: 0x4c,
  Numpad6: 0x4d,
  Numpad7: 0x47,
  Numpad8: 0x48,
  Numpad9: 0x49,
  NumpadMultiply: 0x37,
  NumpadAdd: 0x4e,
  NumpadSubtract: 0x4a,
  NumpadDecimal: 0x53,
  NumpadDivide: 0xe35,
  NumpadEnter: 0xe00 | 0x1c,
  NumpadEnd: 0xee00 | 0x4f,
  NumpadArrowDown: 0xee00 | 0x50,
  NumpadPageDown: 0xee00 | 0x51,
  NumpadArrowLeft: 0xee00 | 0x4b,
  NumpadArrowRight: 0xee00 | 0x4d,
  NumpadHome: 0xee00 | 0x47,
  NumpadArrowUp: 0xee00 | 0x48,
  NumpadPageUp: 0xee00 | 0x49,
  NumpadInsert: 0xee00 | 0x52,
  NumpadDelete: 0xee00 | 0x53,
  F1: 59,
  F2: 60,
  F3: 61,
  F4: 62,
  F5: 63,
  F6: 64,
  F7: 65,
  F8: 66,
  F9: 67,
  F10: 68,
  F11: 87,
  F12: 88,
  F13: 91,
  F14: 92,
  F15: 93,
  F16: 99,
  F17: 100,
  F18: 101,
  F19: 102,
  F20: 103,
  F21: 104,
  F22: 105,
  F23: 106,
  F24: 107,
  Semicolon: 39,
  Equal: 13,
  Comma: 51,
  Minus: 12,
  Period: 52,
  Slash: 53,
  Backquote: 41,
  BracketLeft: 26,
  Backslash: 43,
  BracketRight: 27,
  Quote: 40,
  Ctrl: 29,
  CtrlRight: 3613,
  Alt: 56,
  AltRight: 3640,
  Shift: 42,
  ShiftRight: 54,
  Meta: 3675,
  MetaRight: 3676,
  NumLock: 69,
  ScrollLock: 70,
  PrintScreen: 3639,
};

const NAMES = new Map<number, string>(Object.entries(KEYS).map(([k, v]) => [v, k.toLowerCase()]));

export const keyName = (code: number): string => NAMES.get(code) ?? `key${code}`;
export const keyCode = (name: string): number | undefined =>
  Object.entries(KEYS).find(([k]) => k.toLowerCase() === name)?.[1];

// US layout: [plain, shifted].
const PUNCT: Record<string, [string, string]> = {
  "0": ["0", ")"],
  "1": ["1", "!"],
  "2": ["2", "@"],
  "3": ["3", "#"],
  "4": ["4", "$"],
  "5": ["5", "%"],
  "6": ["6", "^"],
  "7": ["7", "&"],
  "8": ["8", "*"],
  "9": ["9", "("],
  space: [" ", " "],
  semicolon: [";", ":"],
  equal: ["=", "+"],
  comma: [",", "<"],
  minus: ["-", "_"],
  period: [".", ">"],
  slash: ["/", "?"],
  backquote: ["`", "~"],
  bracketleft: ["[", "{"],
  backslash: ["\\", "|"],
  bracketright: ["]", "}"],
  quote: ["'", '"'],
  numpad0: ["0", "0"],
  numpad1: ["1", "1"],
  numpad2: ["2", "2"],
  numpad3: ["3", "3"],
  numpad4: ["4", "4"],
  numpad5: ["5", "5"],
  numpad6: ["6", "6"],
  numpad7: ["7", "7"],
  numpad8: ["8", "8"],
  numpad9: ["9", "9"],
  numpadmultiply: ["*", "*"],
  numpadadd: ["+", "+"],
  numpadsubtract: ["-", "-"],
  numpaddecimal: [".", "."],
  numpaddivide: ["/", "/"],
};

/** The character a key types on a US layout, or undefined when it types none. */
export function charOf(key: string, shift: boolean, caps = false): string | undefined {
  if (/^[a-z]$/.test(key)) return shift !== caps ? key.toUpperCase() : key;
  const p = PUNCT[key];
  return p ? p[shift ? 1 : 0] : undefined;
}

export interface UiohookEvent {
  type: number;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  keycode?: number;
  x?: number;
  y?: number;
  button?: unknown;
  amount?: number;
  rotation?: number;
  direction?: number;
}

const BUTTONS: Record<number, Button> = { 1: "left", 2: "right", 3: "middle" };
const KEY_DOWN = 4;
const MOUSE_DOWN = 7;
const MOUSE_UP = 8;
const MOUSE_MOVE = 9;
const MOUSE_DRAG = 10;
const WHEEL = 11;
const HORIZONTAL = 4;

function modsOf(e: UiohookEvent, key?: string): Mod[] {
  const mods: Mod[] = [];
  if (e.ctrlKey && !key?.startsWith("ctrl")) mods.push("ctrl");
  if (e.altKey && !key?.startsWith("alt")) mods.push("alt");
  if (e.shiftKey && !key?.startsWith("shift")) mods.push("shift");
  if (e.metaKey && !key?.startsWith("meta")) mods.push("meta");
  return mods;
}

/** One uiohook event → Raw, or null for what we don't record (key up, clicked, other buttons). */
export function toRaw(e: UiohookEvent, t: number, coords: Coords, caps = false): Raw | null {
  if (e.type === KEY_DOWN) {
    const key = keyName(e.keycode ?? 0);
    const mods = modsOf(e, key);
    const char = charOf(key, e.shiftKey, caps);
    return char === undefined
      ? { type: "keydown", t, key, mods }
      : { type: "keydown", t, key, mods, char };
  }
  if (e.x === undefined || e.y === undefined) return null;
  const { x, y } = coords.toLogical(e.x, e.y);
  switch (e.type) {
    case MOUSE_MOVE:
    case MOUSE_DRAG:
      return { type: "move", t, x, y };
    case MOUSE_DOWN:
    case MOUSE_UP: {
      const button = BUTTONS[Number(e.button)];
      if (!button) return null;
      return { type: e.type === MOUSE_DOWN ? "down" : "up", t, x, y, button };
    }
    case WHEEL: {
      const d = e.rotation ?? 0;
      return e.direction === HORIZONTAL
        ? { type: "wheel", t, x, y, dx: d, dy: 0 }
        : { type: "wheel", t, x, y, dx: 0, dy: d };
    }
    default:
      return null;
  }
}

/** The uiohook surface we use; tests pass a fake. */
export interface HookSource {
  on(event: "input", fn: (e: UiohookEvent) => void): unknown;
  removeAllListeners(event: "input"): unknown;
  start(): void;
  stop(): void;
}

export async function uiohook(platform: NodeJS.Platform = process.platform): Promise<HookSource> {
  const hook = (await import("uiohook-napi")).uIOhook as unknown as HookSource;
  return platform === "darwin" ? pumped(hook, await mainRunLoop()) : hook;
}

export const KEY_WAIT_MS = 20;
export const PUMP_MS = 50;

/**
 * Mac: drain the main queue after each key press (uiohook waits there for the character
 * lookup) and every 50 ms for the rest (media keys take the same path, with no event first).
 */
export function pumped(hook: HookSource, loop: RunLoop, everyMs = PUMP_MS): HookSource {
  let timer: NodeJS.Timeout | null = null;
  return {
    on: (event, fn) =>
      hook.on(event, (e) => {
        fn(e);
        if (e.type === KEY_DOWN) loop.drain(KEY_WAIT_MS);
      }),
    removeAllListeners: (event) => hook.removeAllListeners(event),
    start() {
      hook.start();
      timer = setInterval(() => loop.drain(0), everyMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      loop.drain(KEY_WAIT_MS); // a lookup still waiting would block stop's thread join
      hook.stop();
    },
  };
}

/**
 * Start the hook: each event is stamped with `now()` and handed on as Raw. Caps lock is
 * tracked from its key presses (uiohook does not report its state; it starts off).
 */
export function startHook(
  source: HookSource,
  coords: () => Coords,
  now: () => number,
  onRaw: (r: Raw) => void,
): () => void {
  let caps = false;
  source.on("input", (e) => {
    if (e.type === KEY_DOWN && e.keycode === KEYS.CapsLock) caps = !caps;
    const r = toRaw(e, now(), coords(), caps);
    if (r) onRaw(r);
  });
  source.start();
  return () => {
    source.removeAllListeners("input");
    source.stop();
  };
}
