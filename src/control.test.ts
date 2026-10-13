import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  controlPath,
  lock,
  MAX_LINE,
  parseRequest,
  type Request,
  recorderPath,
  send,
  serve,
} from "./control.ts";
import { notifyCommand } from "./notify.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "track-control-"));
  dirs.push(d);
  return d;
};

describe("control", () => {
  it("one recorder per data dir; a stale pid file is taken over", () => {
    const data = tmp();
    const a = lock(data);
    expect(a.ok).toBe(true);
    // Our own pid counts as "not another recorder", so fake a live other one: pid 1 (launchd/init).
    if (a.ok) a.release();
    writeFileSync(join(data, "track.pid"), "1");
    expect(lock(data)).toEqual({ ok: false, pid: 1 });
    writeFileSync(join(data, "track.pid"), "999999999");
    const c = lock(data);
    expect(c.ok).toBe(true);
    if (c.ok) c.release();
  });

  it("answers commands over the socket; nothing listening is null", async () => {
    const data = tmp();
    expect(await send(data, "status", 500)).toBeNull();
    const seen: string[] = [];
    const server = await serve(data, async (req: Request) => {
      seen.push(req.op);
      return { cmd: req.op };
    });
    expect(await send(data, "pause")).toEqual({ cmd: "pause" });
    expect(await send(data, "status")).toEqual({ cmd: "status" });
    expect(seen).toEqual(["pause", "status"]);
    server.close();
  });

  it("many lines on one connection, a reply each in order; a line over 256 KB is refused", async () => {
    const data = tmp();
    const got: Request[] = [];
    const server = await serve(data, async (req) => {
      got.push(req);
      return req.op === "web" ? { written: true } : "s";
    });
    const talk = (payload: string) =>
      new Promise<string[]>((resolve) => {
        const sock = createConnection(controlPath(data));
        let buf = "";
        sock.setEncoding("utf8");
        sock.on("data", (c: string) => {
          buf += c;
        });
        sock.on("close", () => resolve(buf.trim().split("\n")));
        sock.on("connect", () => {
          sock.write(payload);
          setTimeout(() => sock.end(), 200);
        });
      });
    const web = { kind: "web", act: "click", tab: 1, frame: 0, url: "https://x.test/", title: "X" };
    const replies = await talk(
      `${JSON.stringify({ op: "web", event: web })}\n{"op":"status"}\n{"op":"nope"}\n`,
    );
    expect(replies.map((l) => JSON.parse(l))).toEqual([
      { ok: true, result: { written: true } },
      { ok: true, result: "s" },
      { ok: false, error: "unknown op: nope" },
    ]);
    expect(got[0]).toEqual({ op: "web", event: web });
    const snapshot = { ...web, tree: "t".repeat(100_000) }; // a page snapshot fits
    const fits = await talk(`${JSON.stringify({ op: "web", event: snapshot })}\n`);
    expect(JSON.parse(fits[0] as string)).toEqual({ ok: true, result: { written: true } });
    const big = await talk(`{"op":"web","event":{"kind":"web","x":"${"a".repeat(MAX_LINE)}"}}\n`);
    expect(JSON.parse(big[0] as string)).toMatchObject({ ok: false });
    expect(got.length).toBe(3);
    server.close();
  });

  it("parses ops; cmd is an alias", () => {
    expect(parseRequest('{"cmd":"stop"}')).toEqual({ op: "stop" });
    expect(parseRequest('{"op":"task"}')).toEqual({ op: "task" });
    expect(parseRequest('{"op":"web","event":{"kind":"app"}}')).toEqual({
      op: "web",
      event: { kind: "app" },
    });
    expect(() => parseRequest("{}")).toThrow(/unknown op/);
  });

  it("the native host finds the recorder from the environment alone", () => {
    expect(recorderPath({ AUTOTRACK_DIR: "/d" }, "darwin")).toBe("/d/control.sock");
    expect(recorderPath({ LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "win32")).toBe(
      controlPath("C:\\Users\\a\\AppData\\Local\\autotrack", "win32"),
    );
  });

  it("socket paths: a pipe on Windows, short enough on Mac", () => {
    expect(controlPath("C:\\Users\\a\\AppData\\Local\\autotrack", "win32")).toMatch(
      /^\\\\\.\\pipe\\autotrack-[0-9a-f]{12}$/,
    );
    expect(controlPath(`/tmp/${"x".repeat(120)}`, "darwin").length).toBeLessThan(104);
  });

  it("notifications per OS", () => {
    expect(notifyCommand("autotrack", 'Say "hi"', "darwin")).toEqual({
      cmd: "osascript",
      args: ["-e", 'display notification "Say \\"hi\\"" with title "autotrack"'],
    });
    expect(notifyCommand("autotrack", "it's on", "win32")?.args.at(-1)).toContain("it''s on");
    expect(notifyCommand("a", "b", "linux")).toBeNull();
  });
});
