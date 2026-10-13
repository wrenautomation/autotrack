import { describe, expect, it } from "vitest";
import "../content/redact.js";
import { Native } from "../sw/native.js";
import { Requests } from "../sw/requests.js";

const R = globalThis.__autotrack.redact;

function fakePort() {
  const port = {
    posted: [],
    msg: null,
    disc: null,
    postMessage: (m) => port.posted.push(m),
    disconnect() {},
    onMessage: { addListener: (f) => (port.msg = f) },
    onDisconnect: { addListener: (f) => (port.disc = f) },
  };
  return port;
}

function rig(o = {}) {
  let now = 1_000_000;
  const timers = [];
  const ports = [];
  let error;
  const warnings = [];
  const n = new Native({
    connect: () => {
      const p = fakePort();
      ports.push(p);
      return p;
    },
    lastError: () => error,
    now: () => now,
    setTimeout: (f, ms) => {
      const t = { f, at: now + ms };
      timers.push(t);
      return t;
    },
    clearTimeout: (t) => {
      const i = timers.indexOf(t);
      if (i >= 0) timers.splice(i, 1);
    },
    warn: (m) => warnings.push(m),
    ...o,
  });
  const advance = (ms) => {
    now += ms;
    for (const t of timers.filter((t) => t.at <= now)) {
      timers.splice(timers.indexOf(t), 1);
      t.f();
    }
  };
  return { n, ports, advance, warnings, setError: (e) => (error = e) };
}

const ev = (i) => ({ kind: "web", act: "click", ts: i });

describe("native link", () => {
  it("batches events into one message per flush", () => {
    const { n, ports, advance } = rig();
    for (let i = 0; i < 120; i++) n.push(ev(i));
    advance(200);
    expect(ports).toHaveLength(1);
    expect(ports[0].posted.map((m) => m.events.length)).toEqual([50, 50, 20]);
    expect(ports[0].posted[2].events.at(-1).ts).toBe(119);
  });

  it("stops sending while paused or with no recorder, and starts again", () => {
    const { n, ports, advance } = rig();
    n.push(ev(1));
    ports[0].msg({ op: "state", paused: true, recorder: true });
    advance(200);
    n.push(ev(2));
    advance(200);
    expect(ports[0].posted).toEqual([]);
    ports[0].msg({ op: "state", paused: false, recorder: false });
    n.push(ev(3));
    advance(200);
    expect(ports[0].posted).toEqual([]);
    ports[0].msg({ op: "state", paused: false, recorder: true });
    n.push(ev(4));
    advance(200);
    expect(ports[0].posted.flatMap((m) => m.events.map((e) => e.ts))).toEqual([4]);
  });

  it("warns once and drops when the host isn't installed, retries after 5 minutes", () => {
    const { n, ports, advance, warnings, setError } = rig();
    n.push(ev(1));
    setError("Specified native messaging host not found.");
    ports[0].disc();
    for (let i = 0; i < 10; i++) n.push(ev(i));
    advance(60_000);
    n.push(ev(11));
    expect(ports).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(n.queue).toEqual([]);
    advance(5 * 60_000);
    n.push(ev(12));
    expect(ports).toHaveLength(2);
    ports[1].disc();
    expect(warnings).toHaveLength(1);
  });

  it("reconnects with backoff after a crash", () => {
    const { n, ports, advance, setError } = rig();
    n.push(ev(1));
    setError("Native host has exited.");
    ports[0].disc();
    n.push(ev(2));
    expect(ports).toHaveLength(1);
    advance(1000); // backoff timer fires with events queued
    expect(ports).toHaveLength(2);
    ports[1].disc();
    advance(1000);
    expect(ports).toHaveLength(2);
    advance(1000);
    expect(ports).toHaveLength(3);
    ports[2].msg({ op: "state", paused: false, recorder: true });
    advance(200);
    expect(ports[2].posted.flatMap((m) => m.events.map((e) => e.ts))).toEqual([1, 2]);
  });

  it("drops an event too big for one control line", () => {
    const { n, ports, advance } = rig();
    n.push({ kind: "app", detail: "x".repeat(270_000) });
    advance(200);
    expect(ports[0].posted).toEqual([]);
    expect(n.dropped).toBe(1);
  });
});

describe("requests", () => {
  it("keeps method, origin + path, status and ms for a tab's window", () => {
    const r = new Requests(R.originPath);
    const start = (id, url, t, tab = 1, type = "xmlhttprequest") =>
      r.start({ requestId: id, tabId: tab, frameId: 0, method: "POST", url, type, timeStamp: t });
    start("1", "https://api.x.com/v1/send?token=abc", 1000);
    start("2", "https://api.x.com/v1/fail", 1100);
    start("3", "https://x.com/late", 2500);
    start("4", "https://x.com/other-tab", 1000, 2);
    start("5", "https://x.com/bg", 1000, -1);
    r.end({ requestId: "1", timeStamp: 1042 }, 200);
    r.end({ requestId: "2", timeStamp: 1300 }, 0);
    r.end({ requestId: "3", timeStamp: 2600 }, 200);
    r.end({ requestId: "4", timeStamp: 1010 }, 200);
    r.end({ requestId: "5", timeStamp: 1010 }, 200);
    expect(r.between(1, 990, 2000)).toEqual([
      {
        method: "POST",
        url: "https://api.x.com/v1/send",
        type: "xmlhttprequest",
        status: 200,
        ms: 42,
        start: 1000,
        frame: 0,
      },
      {
        method: "POST",
        url: "https://api.x.com/v1/fail",
        type: "xmlhttprequest",
        status: 0,
        ms: 200,
        start: 1100,
        frame: 0,
      },
    ]);
  });

  it("forgets requests older than 15 s", () => {
    const r = new Requests(R.originPath);
    r.start({
      requestId: "1",
      tabId: 1,
      frameId: 0,
      method: "GET",
      url: "https://x.com/a",
      type: "image",
      timeStamp: 0,
    });
    r.end({ requestId: "1", timeStamp: 5 }, 200);
    r.start({
      requestId: "2",
      tabId: 1,
      frameId: 0,
      method: "GET",
      url: "https://x.com/b",
      type: "image",
      timeStamp: 20_000,
    });
    r.end({ requestId: "2", timeStamp: 20_005 }, 200);
    expect(r.between(1, 0, 30_000).map((x) => x.url)).toEqual(["https://x.com/b"]);
  });
});

describe("manifest", () => {
  it("asks for no more than it needs", async () => {
    const { readFileSync } = await import("node:fs");
    const m = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
    expect(m.manifest_version).toBe(3);
    expect(m.permissions.sort()).toEqual([
      "downloads",
      "nativeMessaging",
      "webNavigation",
      "webRequest",
    ]);
    expect(m.host_permissions).toEqual(["<all_urls>"]);
    expect(m.incognito).toBe("not_allowed");
    const [main, iso] = m.content_scripts;
    expect(main).toMatchObject({
      world: "MAIN",
      all_frames: true,
      match_about_blank: true,
      run_at: "document_start",
    });
    expect(iso.world).toBeUndefined();
    expect(iso).toMatchObject({
      all_frames: true,
      match_about_blank: true,
      run_at: "document_start",
    });
  });
});
