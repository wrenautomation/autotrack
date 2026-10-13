import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "./config.ts";
import type { App, Element, Event, Raw } from "./events.ts";
import type { FrontAnswer } from "./probe.ts";
import { type ProbeLike, Recorder } from "./recorder.ts";
import type { Capturer } from "./screen.ts";

const T0 = Date.UTC(2030, 5, 1, 12, 0, 0);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const app = (name: string, id: string, pid: number): App => ({ name, id, pid });
const win = (title: string) => ({ title, x: 0, y: 0, width: 800, height: 600 });
const field = (secure: boolean): Element => ({
  role: "textfield",
  name: secure ? "Password" : "Search",
  x: 10,
  y: 10,
  width: 200,
  height: 24,
  secure,
});

function setup(opts: { focused?: () => { element: Element | null } | null } = {}) {
  const sessions = mkdtempSync(join(tmpdir(), "track-recorder-"));
  dirs.push(sessions);
  let now = 1000;
  let front: FrontAnswer = { app: app("TextEdit", "com.apple.TextEdit", 10), window: win("Notes") };
  let shade = 0;
  let onRaw: (r: Raw) => void = () => {};
  const notes: string[] = [];
  const probe: ProbeLike = {
    available: true,
    running: true,
    at: async () => ({ element: { ...field(false), role: "button", name: "OK" } }),
    front: async () => front,
    focused: async () => (opts.focused ? opts.focused() : { element: field(false) }),
    perm: async () => ({ accessibility: true, screen: true, input: true }),
    close: () => {},
  };
  const capturer: Capturer = {
    displays: () => [{ id: "1", x: 0, y: 0, width: 64, height: 36, scale: 1, primary: true }],
    grab: async () => {
      shade += 40;
      return {
        display: "1",
        width: 64,
        height: 36,
        hash: ((BigInt(shade % 256) << 56n) | 0n).toString(16).padStart(16, "0"),
        token: shade,
      };
    },
    save: async (_shot, path) => {
      writeFileSync(path, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
      return true;
    },
  };
  const rec = new Recorder({
    sessions,
    config: parseConfig({ device: "test-mac" }),
    meta: { os: "darwin", osVersion: "1", arch: "arm64", trackVersion: "0.0.0" },
    probe,
    capturer,
    hook: (fn) => {
      onRaw = fn;
      return () => {};
    },
    displayAt: () => "1",
    notify: (m) => notes.push(m),
    clock: { now: () => now, epoch: () => T0 + now - 1000 },
    timers: false,
    sleep: async () => {},
  });
  rec.start();
  const at = (t: number) => {
    now = 1000 + t;
  };
  const raw = (r: Raw) => {
    at(r.t);
    onRaw({ ...r, t: 1000 + r.t } as Raw);
  };
  const events = (): Event[] => {
    const out: Event[] = [];
    for (const seg of readdirSync(rec.journal.dir)
      .filter((n) => /^\d+$/.test(n))
      .sort())
      for (const l of readFileSync(join(rec.journal.dir, seg, "events.jsonl"), "utf8").split("\n"))
        if (l) out.push(JSON.parse(l));
    return out;
  };
  const typeText = (t0: number, s: string) => {
    [...s].forEach((c, i) => {
      raw({ type: "keydown", t: t0 + i * 30, key: c, mods: [], char: c });
    });
  };
  return {
    rec,
    raw,
    at,
    events,
    notes,
    typeText,
    setFront: (f: FrontAnswer) => {
      front = f;
    },
  };
}

describe("recorder", () => {
  it("a click carries element, app, window, display and before/after frames on disk", async () => {
    const r = setup();
    r.raw({ type: "down", t: 100, x: 50, y: 60, button: "left" });
    r.raw({ type: "up", t: 150, x: 50, y: 60, button: "left" });
    await r.rec.settled();
    await r.rec.stop();
    const [click] = r.events();
    expect(click).toMatchObject({
      kind: "click",
      t: 100,
      ts: T0 + 100,
      x: 50,
      y: 60,
      count: 1,
      element: { role: "button", name: "OK" },
      app: { name: "TextEdit" },
      window: { title: "Notes" },
      display: "1",
      before: 0,
      after: 1,
    });
    expect(existsSync(join(r.rec.journal.dir, "000", "frames", "0.jpg"))).toBe(true);
    expect(existsSync(join(r.rec.journal.dir, "000", "frames", "1.jpg"))).toBe(true);
    expect(existsSync(join(r.rec.journal.dir, "000", ".done"))).toBe(true);
    expect(r.notes).toEqual(["Tracking on"]);
  });

  it("text into a password field is written empty and redacted", async () => {
    const r = setup({ focused: () => ({ element: field(true) }) });
    r.typeText(0, "hunter2");
    r.at(2000);
    r.rec.foldTick();
    await r.rec.stop();
    const text = r.events().find((e) => e.kind === "text");
    expect(text).toMatchObject({ kind: "text", text: "", redacted: true });
    expect(JSON.stringify(r.events())).not.toContain("hunter2");
  });

  it("keys are held while the probe can't answer, then written by its answer", async () => {
    let calls = 0;
    const r = setup({ focused: () => (++calls < 3 ? null : { element: field(false) }) });
    r.typeText(0, "hello");
    r.at(2000);
    r.rec.foldTick();
    await r.rec.stop();
    expect(calls).toBe(3);
    expect(r.events().find((e) => e.kind === "text")).toMatchObject({
      text: "hello",
      redacted: false,
    });
  });

  it("an excluded app records nothing and pauses; leaving it resumes with a focus event", async () => {
    const r = setup();
    r.raw({ type: "down", t: 0, x: 1, y: 1, button: "left" });
    r.raw({ type: "up", t: 10, x: 1, y: 1, button: "left" });
    await r.rec.settled();
    r.setFront({ app: app("1Password", "com.1password.1password", 20), window: win("Vault") });
    r.raw({ type: "down", t: 100, x: 5, y: 5, button: "left" });
    r.raw({ type: "up", t: 110, x: 5, y: 5, button: "left" });
    await r.rec.settled();
    r.typeText(200, "secret"); // dropped at the hook: we are paused now
    r.raw({ type: "move", t: 300, x: 90, y: 90 });
    r.setFront({ app: app("Safari", "com.apple.Safari", 30), window: win("Inbox") });
    r.at(500);
    await r.rec.frontTick();
    await r.rec.stop();
    const ev = r.events();
    expect(ev.map((e) => e.kind)).toEqual(["click", "pause", "resume", "focus"]);
    expect(ev[1]).toMatchObject({ kind: "pause", reason: "excluded" });
    expect(ev[3]).toMatchObject({ app: { name: "Safari" }, window: { title: "Inbox" } });
    expect(JSON.stringify(ev)).not.toContain("Vault");
  });

  it("the lock screen pauses with reason locked", async () => {
    const r = setup();
    r.raw({ type: "move", t: 0, x: 1, y: 1 });
    r.setFront({ app: app("loginwindow", "com.apple.loginwindow", 1), window: null });
    r.at(100);
    await r.rec.frontTick();
    await r.rec.stop();
    expect(r.events().at(-1)).toMatchObject({ kind: "pause", reason: "locked" });
  });

  it("Ctrl+Alt+Shift+P toggles a pause with notifications; the hotkey itself is not recorded", async () => {
    const r = setup();
    const hot = (t: number) =>
      r.raw({ type: "keydown", t, key: "p", mods: ["ctrl", "alt", "shift"], char: "P" });
    hot(0);
    expect(r.rec.paused).toBe("hotkey");
    r.typeText(100, "private");
    hot(1000);
    r.typeText(1100, "ok");
    r.at(3000);
    r.rec.foldTick();
    await r.rec.stop();
    const ev = r.events();
    expect(ev.map((e) => e.kind)).toEqual(["pause", "resume", "text"]);
    expect(ev[0]).toMatchObject({ reason: "hotkey" });
    expect(ev[2]).toMatchObject({ text: "ok" });
    expect(r.notes).toEqual(["Tracking on", "Tracking paused", "Tracking on"]);
  });

  it("cli pause and resume", async () => {
    const r = setup();
    r.rec.pause("cli");
    expect(r.rec.status().paused).toBe("cli");
    r.rec.resume();
    await r.rec.stop();
    expect(r.events().map((e) => e.kind)).toEqual(["pause", "resume"]);
  });

  it("idle reading writes frame events when the screen changes", async () => {
    const r = setup();
    r.at(0);
    await r.rec.idleTick();
    r.at(2500);
    await r.rec.idleTick();
    await r.rec.stop();
    expect(r.events()).toEqual([
      { kind: "frame", frame: 0, t: 0, ts: T0 },
      { kind: "frame", frame: 1, t: 2500, ts: T0 + 2500 },
    ]);
  });

  it("events land in time order", async () => {
    const r = setup();
    r.typeText(0, "ab");
    r.raw({ type: "move", t: 40, x: 10, y: 10 });
    r.raw({ type: "down", t: 200, x: 10, y: 10, button: "left" });
    r.raw({ type: "up", t: 220, x: 10, y: 10, button: "left" });
    r.raw({ type: "keydown", t: 300, key: "enter", mods: [] });
    await r.rec.stop();
    const ev = r.events();
    expect(ev.map((e) => e.kind)).toEqual(["text", "move", "click", "key"]);
    expect(ev.map((e) => e.t)).toEqual([0, 40, 200, 300]);
  });

  it("a click the probe could not place in time keeps the last known app", async () => {
    let up = true;
    const r = setup();
    const probe = (r.rec as unknown as { d: { probe: ProbeLike } }).d.probe;
    const front = probe.front;
    probe.front = async () => (up ? front() : null);
    r.raw({ type: "move", t: 0, x: 1, y: 1 });
    await r.rec.frontTick();
    up = false;
    r.raw({ type: "down", t: 100, x: 5, y: 5, button: "left" });
    r.raw({ type: "up", t: 120, x: 5, y: 5, button: "left" });
    await r.rec.stop();
    expect(r.events().find((e) => e.kind === "click")).toMatchObject({ app: { name: "TextEdit" } });
  });

  it("web and app events from the extension are written as is, t/ts filled in", async () => {
    const r = setup();
    r.at(500);
    const web = {
      kind: "web",
      act: "click",
      tab: 3,
      frame: 0,
      url: "https://app.test/",
      title: "App",
      ts: T0 + 400,
      target: { tag: "button", testId: "approve", react: ["ApproveButton"] },
    };
    expect(r.rec.external(web)).toEqual({ written: true });
    expect(
      r.rec.external({ kind: "app", url: "u", action: "approve-message", detail: { id: 1 } }),
    ).toEqual({ written: true });
    expect(() => r.rec.external({ kind: "click" })).toThrow(/web or app/);
    expect(() => r.rec.external("x")).toThrow();
    r.rec.pause("cli");
    expect(r.rec.external({ ...web, ts: T0 + 600 })).toEqual({ written: false, reason: "cli" });
    await r.rec.stop();
    const ev = r.events().filter((e) => e.kind === "web" || e.kind === "app");
    expect(ev).toEqual([
      { ...web, t: 400 },
      { kind: "app", url: "u", action: "approve-message", detail: { id: 1 }, t: 500, ts: T0 + 500 },
    ]);
  });

  it("the probe's richer element fields pass through", async () => {
    const r = setup();
    const probe = (r.rec as unknown as { d: { probe: ProbeLike } }).d.probe;
    const rich = {
      ...field(false),
      role: "AXButton",
      name: "Approve",
      path: [{ role: "AXGroup", name: "Message" }],
      id: "approve",
      cls: "btn primary",
      url: "https://app.test/m/1",
      help: "Send it",
    };
    probe.at = async () => ({ element: rich });
    r.raw({ type: "down", t: 100, x: 5, y: 5, button: "left" });
    r.raw({ type: "up", t: 120, x: 5, y: 5, button: "left" });
    await r.rec.stop();
    expect(r.events().find((e) => e.kind === "click")).toMatchObject({ element: rich });
  });

  it("status reports the session", async () => {
    const r = setup();
    const s = r.rec.status();
    expect(s).toMatchObject({ session: r.rec.journal.session, paused: null, probe: "running" });
    await r.rec.stop();
  });
});
