import { describe, expect, it } from "vitest";
import { type Begin, type Button, type Folded, Folder, type Mod, type Raw } from "./events.ts";

function fold() {
  const out: Folded<number>[] = [];
  const begins: Begin[] = [];
  const f = new Folder<number>(
    (b) => begins.push(b),
    (a) => out.push(a),
  );
  const push = (...rs: Raw[]) => {
    for (const r of rs) f.push(r);
  };
  const strip = () => out.map(({ end: _e, ctx: _c, ...a }) => a);
  return { f, out, begins, push, strip };
}

const down = (t: number, x: number, y: number, button: Button = "left"): Raw => ({
  type: "down",
  t,
  x,
  y,
  button,
});
const up = (t: number, x: number, y: number, button: Button = "left"): Raw => ({
  type: "up",
  t,
  x,
  y,
  button,
});
const key = (t: number, k: string, char?: string, mods: Mod[] = []): Raw =>
  char === undefined
    ? { type: "keydown", t, key: k, mods }
    : { type: "keydown", t, key: k, mods, char };
const type = (t0: number, text: string, gap = 50): Raw[] =>
  [...text].map((c, i) => key(t0 + i * gap, c === " " ? "space" : c.toLowerCase(), c));

describe("moves", () => {
  it("throttles to 20 Hz and 4 px", () => {
    const { push, strip } = fold();
    push(
      { type: "move", t: 0, x: 0, y: 0 },
      { type: "move", t: 10, x: 50, y: 0 }, // too soon
      { type: "move", t: 60, x: 2, y: 0 }, // too close
      { type: "move", t: 120, x: 10, y: 0 },
    );
    expect(strip()).toEqual([
      { kind: "move", t: 0, x: 0, y: 0 },
      { kind: "move", t: 120, x: 10, y: 0 },
    ]);
  });
});

describe("clicks and drags", () => {
  it("pairs down and up into a click, with the point context taken at down", () => {
    const { push, strip, begins, out } = fold();
    push(down(100, 10, 20), up(180, 11, 21));
    expect(strip()).toEqual([{ kind: "click", t: 100, x: 10, y: 20, button: "left", count: 1 }]);
    expect(begins).toEqual([{ on: "point", x: 10, y: 20 }]);
    expect(out[0]?.end).toBe(180);
  });

  it("counts double and triple clicks, resets after 500 ms or a move away", () => {
    const { push, strip } = fold();
    push(
      down(0, 5, 5),
      up(50, 5, 5),
      down(200, 6, 5),
      up(250, 6, 5),
      down(400, 6, 6),
      up(450, 6, 6),
    );
    push(down(1200, 6, 6), up(1250, 6, 6)); // too late
    push(down(1400, 100, 100), up(1450, 100, 100)); // too far
    expect(strip().map((a) => (a.kind === "click" ? a.count : 0))).toEqual([1, 2, 3, 1, 1]);
  });

  it("a different button starts a new count", () => {
    const { push, strip } = fold();
    push(down(0, 5, 5), up(50, 5, 5), down(100, 5, 5, "right"), up(150, 5, 5, "right"));
    expect(strip().map((a) => (a.kind === "click" ? [a.button, a.count] : null))).toEqual([
      ["left", 1],
      ["right", 1],
    ]);
  });

  it("turns a down/up 5 px or more apart into a drag", () => {
    const { push, strip } = fold();
    push(down(0, 10, 10), { type: "move", t: 100, x: 40, y: 10 }, up(200, 80, 90));
    expect(strip()).toEqual([
      { kind: "drag", t: 0, x0: 10, y0: 10, x: 80, y: 90, button: "left" },
      { kind: "move", t: 100, x: 40, y: 10 },
    ]);
  });

  it("ignores an up with no down", () => {
    const { push, out } = fold();
    push(up(10, 1, 1));
    expect(out).toEqual([]);
  });
});

describe("scroll", () => {
  it("folds wheel ticks per 250 ms", () => {
    const { push, f, strip } = fold();
    push(
      { type: "wheel", t: 0, x: 5, y: 5, dx: 0, dy: 1 },
      { type: "wheel", t: 100, x: 5, y: 5, dx: 0, dy: 2 },
      { type: "wheel", t: 200, x: 5, y: 5, dx: 1, dy: 0 },
      { type: "wheel", t: 300, x: 5, y: 5, dx: 0, dy: -1 },
    );
    f.tick(600);
    expect(strip()).toEqual([
      { kind: "scroll", t: 0, x: 5, y: 5, dx: 1, dy: 3 },
      { kind: "scroll", t: 300, x: 5, y: 5, dx: 0, dy: -1 },
    ]);
  });
});

describe("text runs", () => {
  it("folds printable keys and ends at 1 s idle", () => {
    const { push, f, strip, begins } = fold();
    push(...type(0, "Hi there"));
    f.tick(500);
    expect(strip()).toEqual([]);
    f.tick(350 + 1000);
    expect(strip()).toEqual([{ kind: "text", t: 0, text: "Hi there" }]);
    expect(begins).toEqual([{ on: "focus" }]);
  });

  it("ends at a click and at a non-text key", () => {
    const { push, strip } = fold();
    push(...type(0, "ab"), down(200, 1, 1), up(220, 1, 1));
    push(...type(300, "cd"), key(450, "enter"));
    expect(strip()).toEqual([
      { kind: "text", t: 0, text: "ab" },
      { kind: "click", t: 200, x: 1, y: 1, button: "left", count: 1 },
      { kind: "text", t: 300, text: "cd" },
      { kind: "key", t: 450, key: "enter", mods: [] },
    ]);
  });

  it("backspace trims the run; past its start it is a key", () => {
    const { push, f, strip } = fold();
    push(...type(0, "helx"), key(300, "backspace"), ...type(400, "lo"));
    f.tick(3000);
    push(key(4000, "backspace"), key(4050, "backspace"));
    expect(strip()).toEqual([
      { kind: "text", t: 0, text: "hello" },
      { kind: "key", t: 4000, key: "backspace", mods: [] },
      { kind: "key", t: 4050, key: "backspace", mods: [] },
    ]);
  });

  it("holds moves made while typing until the run closes, so acts stay in time order", () => {
    const { push, f, strip } = fold();
    push(...type(0, "ab"), { type: "move", t: 60, x: 9, y: 9 });
    expect(strip()).toEqual([]);
    f.tick(2000);
    expect(strip().map((a) => [a.kind, a.t])).toEqual([
      ["text", 0],
      ["move", 60],
    ]);
  });
});

describe("hotkeys", () => {
  it("a combo with ctrl, alt or meta is a key, not text; modifiers alone are nothing", () => {
    const { push, strip } = fold();
    push(
      key(0, "meta"),
      key(10, "c", "c", ["meta"]),
      key(20, "shift"),
      key(30, "arrowleft", undefined, ["shift"]),
    );
    expect(strip()).toEqual([
      { kind: "key", t: 10, key: "c", mods: ["meta"] },
      { kind: "key", t: 30, key: "arrowleft", mods: ["shift"] },
    ]);
  });

  it("shift + letter is text", () => {
    const { push, f, strip } = fold();
    push(key(0, "a", "A", ["shift"]));
    f.flush();
    expect(strip()).toEqual([{ kind: "text", t: 0, text: "A" }]);
  });
});

describe("flush", () => {
  it("closes runs and drops a held button", () => {
    const { push, f, strip } = fold();
    push(...type(0, "x"), down(100, 1, 1));
    f.flush();
    expect(strip()).toEqual([{ kind: "text", t: 0, text: "x" }]);
  });
});
