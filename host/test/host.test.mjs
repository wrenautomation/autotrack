// Host tests. Run by extension/vitest.config.mjs with vitest globals (describe/it/expect).
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { recorderPath as tsRecorderPath } from "../../src/control.ts";
import { controlPath, recorderPath } from "../control.mjs";
import { Decoder, encode, MAX_MESSAGE } from "../framing.mjs";
import { relay } from "../relay.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("framing", () => {
  it("round-trips messages split at every byte", () => {
    const msgs = [
      { events: [{ kind: "web", act: "click", t: "é✓" }] },
      { op: "state", paused: true },
      [],
    ];
    const wire = Buffer.concat(msgs.map(encode));
    const got = [];
    const d = new Decoder((m) => got.push(m));
    for (let i = 0; i < wire.length; i++) d.push(wire.subarray(i, i + 1));
    expect(got).toEqual(msgs);
    const got2 = [];
    new Decoder((m) => got2.push(m)).push(wire);
    expect(got2).toEqual(msgs);
  });

  it("skips a message over 1 MB without buffering it, then carries on", () => {
    const got = [];
    const errors = [];
    const d = new Decoder(
      (m) => got.push(m),
      (e) => errors.push(e.message),
    );
    const big = Buffer.alloc(4 + MAX_MESSAGE + 10, 0x61);
    big.writeUInt32LE(MAX_MESSAGE + 10, 0);
    const wire = Buffer.concat([encode({ a: 1 }), big, encode({ b: 2 })]);
    for (let i = 0; i < wire.length; i += 65536) d.push(wire.subarray(i, i + 65536));
    expect(got).toEqual([{ a: 1 }, { b: 2 }]);
    expect(errors).toHaveLength(1);
    expect(d.buf.length).toBe(0);
  });

  it("refuses to encode over 1 MB and reports bad JSON", () => {
    expect(() => encode({ x: "y".repeat(MAX_MESSAGE) })).toThrow(/over/);
    const errors = [];
    const d = new Decoder(
      () => {},
      (e) => errors.push(e),
    );
    const body = Buffer.from("{nope");
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length);
    d.push(Buffer.concat([head, body]));
    expect(errors).toHaveLength(1);
  });
});

describe("control path", () => {
  it("matches the recorder's resolver", () => {
    for (const platform of ["darwin", "win32", "linux"])
      for (const env of [
        {},
        { AUTOTRACK_DIR: "/tmp/at" },
        { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" },
        { AUTOTRACK_DIR: `/${"x".repeat(120)}` },
      ])
        expect(recorderPath(env, platform)).toBe(tsRecorderPath(env, platform));
  });

  it("takes --control or AUTOTRACK_CONTROL first, ignoring Chrome's origin argument", () => {
    expect(controlPath(["chrome-extension://abc/", "--control=/s.sock"], {})).toBe("/s.sock");
    expect(controlPath(["--control", "/t.sock"], {})).toBe("/t.sock");
    expect(controlPath(["chrome-extension://abc/"], { AUTOTRACK_CONTROL: "/u.sock" })).toBe(
      "/u.sock",
    );
    expect(controlPath(["chrome-extension://abc/"], { AUTOTRACK_DIR: "/d" }, "darwin")).toBe(
      "/d/control.sock",
    );
  });
});

/** A fake recorder on a unix socket: records lines, answers like src/control.ts. */
async function fakeRecorder(path, state = { paused: null }) {
  const lines = [];
  const server = createServer((s) => {
    let buf = "";
    s.setEncoding("utf8");
    s.on("data", (c) => {
      buf += c;
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const req = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        lines.push(req);
        const result =
          req.op === "status"
            ? { paused: state.paused }
            : state.paused
              ? { written: false, reason: state.paused }
              : { written: true };
        s.write(`${JSON.stringify({ ok: true, result })}\n`);
      }
    });
  });
  await new Promise((r) => server.listen(path, r));
  return { lines, server, state };
}

function host(path, statusMs = 100) {
  const input = new PassThrough();
  const output = new PassThrough();
  const states = [];
  const d = new Decoder((m) => states.push(m));
  output.on("data", (c) => d.push(c));
  const r = relay({
    input,
    output,
    path,
    connect: (p) => createConnection(p),
    statusMs,
    log: () => {},
  });
  return { input, states, r, send: (m) => input.write(encode(m)) };
}

describe("relay", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "at-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("relays each event as a web line and passes pause state back", async () => {
    const path = join(dir, "c.sock");
    const rec = await fakeRecorder(path);
    const h = host(path);
    await sleep(50);
    h.send({
      events: [
        { kind: "web", act: "click", ts: 1 },
        { kind: "app", action: "x", ts: 2 },
        { kind: "evil" },
        "str",
      ],
    });
    h.send({ kind: "web", act: "key", ts: 3 });
    await sleep(80);
    expect(rec.lines.filter((l) => l.op === "web").map((l) => l.event.ts)).toEqual([1, 2, 3]);
    expect(h.states.at(-1)).toEqual({ op: "state", paused: false, recorder: true });

    rec.state.paused = "hotkey";
    h.send({ events: [{ kind: "web", act: "click", ts: 4 }] });
    await sleep(80);
    expect(h.states.at(-1)).toEqual({ op: "state", paused: true, recorder: true });

    rec.state.paused = null; // resumed while the extension sends nothing: the status tick says so
    await sleep(250);
    expect(h.states.at(-1)).toEqual({ op: "state", paused: false, recorder: true });
    h.input.end();
    rec.server.close();
  });

  it("says recorder:false when nothing listens, and recovers when it starts", async () => {
    const path = join(dir, "c.sock");
    const h = host(path);
    h.send({ events: [{ kind: "web", act: "click", ts: 1 }] });
    await sleep(80);
    expect(h.states.at(-1)).toEqual({ op: "state", paused: false, recorder: false });
    const rec = await fakeRecorder(path);
    await sleep(1300);
    expect(h.states.at(-1)).toEqual({ op: "state", paused: false, recorder: true });
    h.send({ events: [{ kind: "web", act: "click", ts: 2 }] });
    await sleep(80);
    expect(rec.lines.filter((l) => l.op === "web").map((l) => l.event.ts)).toEqual([2]);
    h.input.end();
    rec.server.close();
  });

  it("drops an event that would exceed the 256 KB control line", async () => {
    const path = join(dir, "c.sock");
    const rec = await fakeRecorder(path);
    const h = host(path);
    await sleep(50);
    h.send({
      events: [
        { kind: "app", detail: "x".repeat(270_000) },
        { kind: "web", ts: 5 },
      ],
    });
    await sleep(80);
    expect(rec.lines.filter((l) => l.op === "web").map((l) => l.event.ts)).toEqual([5]);
    expect(h.r.stats.dropped).toBe(1);
    h.input.end();
    rec.server.close();
  });
});
