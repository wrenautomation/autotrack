import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Event, SessionMeta } from "./events.ts";
import { closeStale, Journal, sessionName } from "./journal.ts";

const T0 = Date.UTC(2030, 0, 2, 3, 4, 5);
const meta = {
  device: "test",
  os: "darwin",
  osVersion: "1",
  arch: "arm64",
  trackVersion: "0.0.0",
  displays: [],
};
const dirs: string[] = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "track-journal-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ev = (t: number): Event => ({ kind: "move", t, ts: T0 + t, x: t, y: 0 });
const lines = (path: string) => readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
const readMeta = (dir: string) =>
  JSON.parse(readFileSync(join(dir, "session.json"), "utf8")) as SessionMeta;

describe("journal", () => {
  it("names sessions <yyyymmddThhmmss>-<4 hex> in UTC", () => {
    expect(sessionName(T0, "ab12")).toBe("20300102T030405-ab12");
  });

  it("writes session.json open, then closed with ISO times", () => {
    let now = T0;
    const j = new Journal({ sessions: tmp(), meta, now: () => now });
    const m = readMeta(j.dir);
    expect(m).toMatchObject({
      v: 1,
      device: "test",
      startedAt: new Date(T0).toISOString(),
      endedAt: null,
    });
    now += 5000;
    j.close();
    expect(readMeta(j.dir).endedAt).toBe(new Date(T0 + 5000).toISOString());
  });

  it("rotates every 2,000 events (here 3) and writes .done only on a closed segment", () => {
    const j = new Journal({ sessions: tmp(), meta, now: () => T0, segmentEvents: 3 });
    for (let i = 0; i < 7; i++) j.write(ev(i));
    expect(readdirSync(j.dir).sort()).toEqual(["000", "001", "002", "session.json"]);
    expect(lines(join(j.dir, "000", "events.jsonl")).length).toBe(3);
    expect(existsSync(join(j.dir, "000", ".done"))).toBe(true);
    expect(existsSync(join(j.dir, "001", ".done"))).toBe(true);
    expect(existsSync(join(j.dir, "002", ".done"))).toBe(false);
    j.close();
    expect(existsSync(join(j.dir, "002", ".done"))).toBe(true);
    expect(lines(join(j.dir, "002", "events.jsonl")).map((l) => JSON.parse(l).t)).toEqual([6]);
  });

  it("rotates after 5 minutes, but an idle empty segment stays open", () => {
    let now = T0;
    const j = new Journal({ sessions: tmp(), meta, now: () => now });
    now += 6 * 60_000;
    j.tick();
    expect(j.segment).toBe("000");
    j.write(ev(1));
    now += 5 * 60_000;
    j.tick();
    expect(j.segment).toBe("001");
    expect(existsSync(join(j.dir, "000", ".done"))).toBe(true);
    j.close();
  });

  it("numbers frames across the session, in the segment they were reserved in", () => {
    const j = new Journal({ sessions: tmp(), meta, now: () => T0, segmentEvents: 1 });
    const a = j.reserveFrame();
    expect(a.n).toBe(0);
    writeFileSync(a.path, "a");
    a.done(true);
    j.write(ev(0));
    j.write(ev(1)); // rotates
    const b = j.reserveFrame();
    expect(b.n).toBe(1);
    writeFileSync(b.path, "b");
    b.done(true);
    expect(readdirSync(join(j.dir, "000", "frames"))).toEqual(["0.jpg"]);
    expect(readdirSync(join(j.dir, "001", "frames"))).toEqual(["1.jpg"]);
    expect(j.frames).toBe(2);
    j.close();
  });

  it("stores trees as trees/<n>.<ext>, numbered over the session, with their event", () => {
    const j = new Journal({ sessions: tmp(), meta, now: () => T0, segmentEvents: 2 });
    const tree = (n: number): Event => ({ kind: "tree", tree: n, t: n, ts: T0 + n });
    expect(j.writeTree('{"nodes":[]}', "json", tree)).toBe(0);
    j.write(ev(1));
    expect(
      j.writeTree("page text", "txt", (n) => ({ ...ev(2), kind: "web", treeFile: n }) as Event),
    ).toBe(1);
    expect(readFileSync(join(j.dir, "000", "trees", "0.json"), "utf8")).toBe('{"nodes":[]}');
    expect(readFileSync(join(j.dir, "001", "trees", "1.txt"), "utf8")).toBe("page text");
    expect(JSON.parse(lines(join(j.dir, "000", "events.jsonl"))[0] as string)).toMatchObject({
      kind: "tree",
      tree: 0,
    });
    expect(JSON.parse(lines(join(j.dir, "001", "events.jsonl"))[0] as string)).toMatchObject({
      treeFile: 1,
    });
    expect([j.trees, j.events]).toEqual([2, 3]);
    j.close();
    expect(j.writeTree("x", "txt", tree)).toBeNull();
  });

  it("a segment with a save in flight is not closed; it rotates once the save is done", () => {
    const j = new Journal({ sessions: tmp(), meta, now: () => T0, segmentEvents: 1 });
    j.write(ev(0));
    const f = j.reserveFrame();
    j.write(ev(1)); // due to rotate, but a save is in flight
    expect(j.segment).toBe("000");
    expect(existsSync(join(j.dir, "000", ".done"))).toBe(false);
    writeFileSync(f.path, "x");
    f.done(true);
    j.write(ev(2));
    expect(j.segment).toBe("001");
    expect(existsSync(join(j.dir, "000", ".done"))).toBe(true);
    expect(existsSync(f.path)).toBe(true);
    j.close();
  });

  it("a given-up frame leaves no file and is not counted", () => {
    const j = new Journal({ sessions: tmp(), meta, now: () => T0 });
    const f = j.reserveFrame();
    writeFileSync(f.path, "x");
    writeFileSync(`${f.path}.tmp`, "y");
    f.done(false);
    f.done(true); // settled once
    expect(readdirSync(join(j.dir, "000", "frames"))).toEqual([]);
    expect(j.frames).toBe(0);
    expect(j.reserveFrame().n).toBe(1);
    j.close();
  });

  it("a crash leaves a segment open; the next start closes it and ends the session", () => {
    const sessions = tmp();
    const crashed = new Journal({ sessions, meta, now: () => T0 });
    crashed.write(ev(1)); // never closed: the process "died"
    expect(existsSync(join(crashed.dir, "000", ".done"))).toBe(false);
    expect(readMeta(crashed.dir).endedAt).toBeNull();

    const next = new Journal({ sessions, meta, now: () => T0 + 60_000 });
    expect(next.session).not.toBe(crashed.session);
    expect(existsSync(join(crashed.dir, "000", ".done"))).toBe(true);
    expect(readMeta(crashed.dir).endedAt).not.toBeNull();
    expect(existsSync(join(next.dir, "000", ".done"))).toBe(false); // its own stays open
    expect(lines(join(crashed.dir, "000", "events.jsonl")).length).toBe(1);
    next.close();
    expect(closeStale(sessions)).toBe(0);
  });
});
