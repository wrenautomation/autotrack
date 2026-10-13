import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startStub } from "../test/e2e/s3-stub.mjs";
import { parseConfig, type TrackCode } from "./config.ts";
import {
  capFrames,
  countSegments,
  DirShipper,
  type ObjectStore,
  PutError,
  s3Store,
  shipperFor,
} from "./ship.ts";

let root: string;
let sessions: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "autotrack-ship-"));
  sessions = join(root, "sessions");
  mkdirSync(sessions);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function session(
  name: string,
  segs: { events: number; frames: number[]; done: boolean; frameBytes?: number }[],
  endedAt: string | null = null,
) {
  const dir = join(sessions, name);
  mkdirSync(dir);
  writeFileSync(join(dir, "session.json"), JSON.stringify({ v: 1, session: name, endedAt }));
  segs.forEach((s, i) => {
    const seg = join(dir, String(i).padStart(3, "0"));
    mkdirSync(join(seg, "frames"), { recursive: true });
    const lines = Array.from({ length: s.events }, (_, t) => JSON.stringify({ kind: "move", t }));
    writeFileSync(join(seg, "events.jsonl"), lines.map((l) => `${l}\n`).join(""));
    for (const n of s.frames)
      writeFileSync(join(seg, "frames", `${n}.jpg`), Buffer.alloc(s.frameBytes ?? 10, n));
    if (s.done) writeFileSync(join(seg, ".done"), "");
  });
  return dir;
}

function memStore(failAfter = Infinity, status: number | null = null) {
  const puts: { key: string; body: Buffer; type: string }[] = [];
  let calls = 0;
  const store: ObjectStore = {
    async put(key, body, type) {
      if (++calls > failAfter) throw new PutError(`PUT ${key}: down`, status);
      puts.push({ key, body: Buffer.from(body), type });
    },
  };
  return { store, puts, calls: () => calls };
}

const shipper = (
  store: ObjectStore | null,
  extra: Partial<ConstructorParameters<typeof DirShipper>[0]> = {},
) =>
  new DirShipper({
    store,
    device: "laptop",
    maxLocalGb: 5,
    sleep: async () => {},
    concurrency: 1,
    ...extra,
  });

describe("DirShipper", () => {
  it("puts trees gzipped after frames and before events, deleting each once put", async () => {
    const dir = session("20261013T100000-abcd", [{ events: 2, frames: [0], done: true }]);
    const trees = join(dir, "000", "trees");
    mkdirSync(trees);
    writeFileSync(join(trees, "10.json"), '{"nodes":[]}');
    writeFileSync(join(trees, "2.txt"), "button Save");
    writeFileSync(join(trees, "notes.tmp"), "x");
    const m = memStore();
    await shipper(m.store).ship(sessions);
    expect(m.puts.map((p) => p.key.split("/").slice(2).join("/"))).toEqual([
      "session.json",
      "000/frames/0.jpg",
      "000/trees/2.txt.gz",
      "000/trees/10.json.gz",
      "000/events.jsonl.gz",
    ]);
    expect(gunzipSync(m.puts[2]?.body ?? Buffer.alloc(0)).toString()).toBe("button Save");
    expect(m.puts[2]?.type).toBe("application/gzip");
    expect(existsSync(join(dir, "000"))).toBe(false);
  });

  it("a failed tree put keeps the trees not yet put and the events", async () => {
    const dir = session("20261013T100000-abcd", [{ events: 2, frames: [], done: true }]);
    const trees = join(dir, "000", "trees");
    mkdirSync(trees);
    writeFileSync(join(trees, "0.json"), "{}");
    writeFileSync(join(trees, "1.json"), "{}");
    const m = memStore(2); // session.json and tree 0 land, tree 1 fails
    await shipper(m.store).ship(sessions);
    expect(existsSync(join(trees, "0.json"))).toBe(false);
    expect(existsSync(join(trees, "1.json"))).toBe(true);
    expect(existsSync(join(dir, "000", "events.jsonl"))).toBe(true);
  });

  it("puts session.json, frames, then events; deletes each closed segment; leaves open ones", async () => {
    const dir = session("20261013T100000-abcd", [
      { events: 3, frames: [0, 1], done: true },
      { events: 1, frames: [2], done: false },
    ]);
    const m = memStore();
    const r = await shipper(m.store).ship(sessions);
    expect(r).toMatchObject({ put: 1, failed: 0, objects: 4 });
    expect(m.puts.map((p) => p.key)).toEqual([
      "laptop/20261013T100000-abcd/session.json",
      "laptop/20261013T100000-abcd/000/frames/0.jpg",
      "laptop/20261013T100000-abcd/000/frames/1.jpg",
      "laptop/20261013T100000-abcd/000/events.jsonl.gz",
    ]);
    const events = gunzipSync(m.puts[3]?.body ?? Buffer.alloc(0))
      .toString("utf8")
      .trim()
      .split("\n");
    expect(events).toHaveLength(3);
    expect(m.puts.map((p) => p.type)).toEqual([
      "application/json",
      "image/jpeg",
      "image/jpeg",
      "application/gzip",
    ]);
    expect(existsSync(join(dir, "000"))).toBe(false);
    expect(existsSync(join(dir, "001", "frames", "2.jpg"))).toBe(true);
    expect(countSegments(sessions)).toEqual({ open: 1, closed: 0 });
  });

  it("re-puts session.json only when it changes, and drops an ended session once all is up", async () => {
    const dir = session("20261013T100000-abcd", [{ events: 1, frames: [], done: true }]);
    const m = memStore();
    const s = shipper(m.store);
    await s.ship(sessions);
    await s.ship(sessions);
    expect(m.puts.filter((p) => p.key.endsWith("session.json"))).toHaveLength(1);
    expect(existsSync(dir)).toBe(true); // not ended yet
    writeFileSync(
      join(dir, "session.json"),
      JSON.stringify({ v: 1, endedAt: "2026-10-13T10:05:00Z" }),
    );
    await s.ship(sessions);
    const metas = m.puts.filter((p) => p.key.endsWith("session.json"));
    expect(metas).toHaveLength(2);
    expect(JSON.parse(metas[1]?.body.toString() ?? "{}").endedAt).toBe("2026-10-13T10:05:00Z");
    expect(existsSync(dir)).toBe(false);
  });

  it("ships oldest sessions first", async () => {
    session("20261013T110000-bbbb", [{ events: 1, frames: [], done: true }]);
    session("20261013T100000-aaaa", [{ events: 1, frames: [], done: true }]);
    const m = memStore();
    await shipper(m.store).ship(sessions);
    expect(m.puts.map((p) => p.key.split("/")[1])).toEqual([
      "20261013T100000-aaaa",
      "20261013T100000-aaaa",
      "20261013T110000-bbbb",
      "20261013T110000-bbbb",
    ]);
  });

  it("a failed put keeps the segment, resumes where it stopped, and backs off", async () => {
    const dir = session("20261013T100000-abcd", [{ events: 2, frames: [0, 1, 2], done: true }]);
    let now = 1_000_000;
    const m = memStore(2); // session.json and frame 0 land, then offline
    const s = shipper(m.store, { now: () => now });
    const r = await s.ship(sessions);
    expect(r).toMatchObject({ put: 0, failed: 1 });
    expect(existsSync(join(dir, "000", "frames", "0.jpg"))).toBe(false);
    expect(existsSync(join(dir, "000", "frames", "1.jpg"))).toBe(true);
    expect(m.calls()).toBe(5); // 2 landed, then frame 1 tried 3 times (no answer = retry)
    expect((await s.ship(sessions)).skipped).toBe("backoff");
    now += 5 * 60_000;
    const ok = memStore();
    const s2 = shipper(ok.store);
    expect(await s2.ship(sessions)).toMatchObject({ put: 1, failed: 0 });
    expect(ok.puts.map((p) => p.key.split("/").slice(2).join("/"))).toEqual([
      "000/frames/1.jpg",
      "000/frames/2.jpg",
      "000/events.jsonl.gz",
    ]);
  });

  it("does not retry a refused put within the pass", async () => {
    session("20261013T100000-abcd", [{ events: 1, frames: [], done: true }]);
    const m = memStore(0, 403);
    const r = await shipper(m.store).ship(sessions);
    expect(r).toMatchObject({ put: 0, failed: 1 });
    expect(m.calls()).toBe(1);
  });

  it("force ignores the backoff", async () => {
    session("20261013T100000-abcd", [{ events: 1, frames: [], done: true }]);
    const down = memStore(0);
    const s = shipper(down.store);
    await s.ship(sessions);
    expect((await s.ship(sessions)).skipped).toBe("backoff");
    expect((await s.ship(sessions, { force: true })).skipped).toBeUndefined();
  });

  it("with no code it ships nothing but still caps", async () => {
    session("20261013T100000-abcd", [
      { events: 1, frames: [0, 1, 2, 3], done: true, frameBytes: 400 },
    ]);
    const r = await shipper(null, { maxLocalGb: 1000 / 1e9 }).ship(sessions);
    expect(r.skipped).toBe("no code");
    expect(r.dropped).toBeGreaterThan(0);
  });

  it("a second shipper on the same lock is busy", async () => {
    session("20261013T100000-abcd", [{ events: 1, frames: [], done: true }]);
    const lockPath = join(root, "ship.lock");
    writeFileSync(lockPath, String(process.ppid)); // a live process that isn't us
    const r = await shipper(memStore().store, { lockPath }).ship(sessions);
    expect(r.skipped).toBe("busy");
    writeFileSync(lockPath, "999999999"); // dead: taken over
    expect((await shipper(memStore().store, { lockPath }).ship(sessions)).put).toBe(1);
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("capFrames", () => {
  it("deletes the oldest frames first and never events", () => {
    const a = session("20261013T100000-aaaa", [
      { events: 50, frames: [0, 1], done: true, frameBytes: 1000 },
    ]);
    const b = session("20261013T110000-bbbb", [
      { events: 50, frames: [0, 1], done: false, frameBytes: 1000 },
    ]);
    const evBytes = readFileSync(join(a, "000", "events.jsonl")).length;
    const dropped = capFrames(sessions, 2 * 1000 + 2 * evBytes + 200);
    expect(dropped).toBe(2);
    expect(existsSync(join(a, "000", "frames", "0.jpg"))).toBe(false);
    expect(existsSync(join(a, "000", "frames", "1.jpg"))).toBe(false);
    expect(existsSync(join(b, "000", "frames", "0.jpg"))).toBe(true);
    expect(existsSync(join(a, "000", "events.jsonl"))).toBe(true);
    expect(capFrames(sessions, 1)).toBe(2); // every frame, still no events
    expect(existsSync(join(b, "000", "events.jsonl"))).toBe(true);
  });
});

describe("s3Store against the stub", () => {
  const code: TrackCode = {
    v: 1,
    bucket: "autobrowse-prod-track-1234",
    region: "us-east-1",
    device: "laptop",
    keyId: "AKIASTUBTESTKEY00001",
    secret: "stub-secret-0123456789abcdef",
  };

  it("signs puts the stub accepts, and a wrong secret is refused", async () => {
    const stub = await startStub({
      root: join(root, "s3"),
      keyId: code.keyId,
      secret: code.secret,
      prefix: "laptop/",
    });
    try {
      session(
        "20261013T100000-abcd",
        [{ events: 2, frames: [0], done: true }],
        "2026-10-13T10:01:00Z",
      );
      const cfg = parseConfig({
        code: Buffer.from(JSON.stringify(code)).toString("base64url"),
        endpoint: stub.url,
      });
      expect(cfg.endpoint).toBe(stub.url);
      const r = await shipperFor(root, cfg).ship(sessions);
      expect(r).toMatchObject({ put: 1, failed: 0, objects: 3 });
      const base = join(root, "s3", code.bucket, "laptop", "20261013T100000-abcd");
      expect(JSON.parse(readFileSync(join(base, "session.json"), "utf8")).endedAt).toBe(
        "2026-10-13T10:01:00Z",
      );
      expect(gunzipSync(readFileSync(join(base, "000", "events.jsonl.gz"))).toString()).toContain(
        '"move"',
      );
      expect(existsSync(join(base, "000", "frames", "0.jpg"))).toBe(true);
      expect(existsSync(join(sessions, "20261013T100000-abcd"))).toBe(false);

      const bad = s3Store({
        code: { ...code, secret: "wrong-secret-0123456789" },
        endpoint: stub.url,
      });
      const err = await bad.put("laptop/x", Buffer.from("x"), "text/plain").catch((e) => e);
      expect(err).toBeInstanceOf(PutError);
      expect(err.status).toBe(403);
      expect(err.message).toContain("SignatureDoesNotMatch");
      expect(err.message).not.toContain(code.secret);

      const other = s3Store({ code, endpoint: stub.url });
      const denied = await other
        .put("someone-else/x", Buffer.from("x"), "text/plain")
        .catch((e) => e);
      expect(denied.status).toBe(403);
    } finally {
      await stub.close();
    }
  });

  it("corrects for a wrong local clock", async () => {
    const stub = await startStub({
      root: join(root, "s3"),
      keyId: code.keyId,
      secret: code.secret,
    });
    try {
      const store = s3Store({ code, endpoint: stub.url, now: () => Date.now() - 3 * 3600_000 });
      await store.put("laptop/a", Buffer.from("a"), "text/plain");
      expect(stub.puts.map((p) => p.key)).toEqual(["laptop/a"]);
    } finally {
      await stub.close();
    }
  });
});

describe("config endpoint", () => {
  it("takes https or local http only", () => {
    const warn: string[] = [];
    expect(parseConfig({ endpoint: "https://s3.example.com/" }).endpoint).toBe(
      "https://s3.example.com",
    );
    expect(parseConfig({ endpoint: "http://127.0.0.1:9000" }).endpoint).toBe(
      "http://127.0.0.1:9000",
    );
    expect(
      parseConfig({ endpoint: "http://evil.example.com" }, (m) => warn.push(m)).endpoint,
    ).toBeUndefined();
    expect(parseConfig({ endpoint: "https://x.com/path" }).endpoint).toBeUndefined();
    expect(warn).toHaveLength(1);
  });
});
