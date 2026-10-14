import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Level } from "./events.ts";
import type { Power } from "./level.ts";
import { OCR_IDLE_MS, OCR_WAIT_MS, type OcrAnswer, OcrScheduler, ocrPath } from "./ocr.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function seg(session = "s1", name = "000") {
  const root = mkdtempSync(join(tmpdir(), "autotrack-ocr-"));
  dirs.push(root);
  const sd = join(root, session, name);
  mkdirSync(join(sd, "frames"), { recursive: true });
  mkdirSync(join(sd, "crops"), { recursive: true });
  return { root, sd };
}

const jpg = (sd: string, sub: "frames" | "crops", n: number) => {
  const p = join(sd, sub, `${n}.jpg`);
  writeFileSync(p, "x");
  return p;
};

function setup(o: { power?: Power | null; level?: Level } = {}) {
  let now = 1_000_000;
  let idle = OCR_IDLE_MS;
  let power = o.power ?? null;
  let level: Level = o.level ?? "normal";
  const reads: string[] = [];
  const finished: string[] = [];
  let starts = 0;
  let closes = 0;
  let hold: ((a: OcrAnswer | null) => void) | null = null;
  let manual = false;
  let answer: (path: string) => OcrAnswer | null = () => ({
    lines: [{ text: "Submit", x: 1.4, y: 2, w: 30, h: 10, conf: 0.987 }],
    w: 64,
    h: 36,
  });
  const ocr = new OcrScheduler({
    now: () => now,
    idleFor: () => idle,
    power: () => power,
    level: () => level,
    start: () => {
      starts++;
      return {
        read: (path) => {
          reads.push(path);
          if (manual)
            return new Promise((r) => {
              hold = r;
            });
          return Promise.resolve(answer(path));
        },
        close: () => {
          closes++;
          hold?.(null);
          hold = null;
        },
      };
    },
    finish: (sd) => finished.push(sd),
  });
  return {
    ocr,
    reads,
    finished,
    starts: () => starts,
    closes: () => closes,
    at: (t: number) => {
      now = t;
    },
    now: () => now,
    idle: (ms: number) => {
      idle = ms;
    },
    power: (p: Power | null) => {
      power = p;
    },
    level: (l: Level) => {
      level = l;
    },
    manual: () => {
      manual = true;
    },
    answer: (fn: (path: string) => OcrAnswer | null) => {
      answer = fn;
    },
    release: (a: OcrAnswer | null) => {
      const h = hold;
      hold = null;
      h?.(a);
    },
    pending: () => hold !== null,
  };
}

const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("ocr scheduling", () => {
  it("reads only after 20 s idle, on AC or battery ≥ 50%, not at lean", async () => {
    const { sd } = seg();
    const s = setup();
    s.ocr.image(jpg(sd, "frames", 0));
    s.idle(OCR_IDLE_MS - 1);
    expect(s.ocr.allowed).toBe(false);
    s.idle(OCR_IDLE_MS);
    s.power({ ac: false, battery: 49 });
    expect(s.ocr.allowed).toBe(false);
    s.power({ ac: false, battery: 50 });
    expect(s.ocr.allowed).toBe(true);
    s.level("lean");
    expect(s.ocr.allowed).toBe(false);
    s.level("full");
    s.power(null); // unknown counts as AC
    s.ocr.tick();
    await flush();
    expect(s.reads).toEqual([join(sd, "frames", "0.jpg")]);
  });

  it("writes lines in image pixels, redacted, and quits the helper when the queue is empty", async () => {
    const { sd } = seg();
    const s = setup();
    s.answer(() => ({
      lines: [{ text: "key sk-abcdefghijklmnopqrstuvwxyz0123", x: 1.4, y: 2, w: 30, h: 10 }],
      w: 64,
      h: 36,
      cpuMs: 40,
    }));
    s.ocr.image(jpg(sd, "frames", 3));
    s.ocr.image(jpg(sd, "crops", 1));
    await s.ocr.run();
    expect(read(ocrPath(sd, false, 3))).toEqual({
      lines: [{ text: "key <redacted>", x: 1, y: 2, w: 30, h: 10 }],
      w: 64,
      h: 36,
    });
    expect(existsSync(join(sd, "ocr", "c1.json"))).toBe(true);
    expect(s.starts()).toBe(1);
    expect(s.closes()).toBe(1);
    expect(s.ocr.busy).toBe(false);
    expect(s.ocr.cpuMs).toBe(40);
  });

  it("input stops a read at once; the image is read again at the next idle", async () => {
    const { sd } = seg();
    const s = setup();
    s.manual();
    s.ocr.image(jpg(sd, "frames", 0));
    const run = s.ocr.run();
    await flush();
    expect(s.pending()).toBe(true);
    const t0 = performance.now();
    s.idle(0);
    s.ocr.input();
    expect(s.closes()).toBe(1); // killed synchronously, inside the input call
    expect(performance.now() - t0).toBeLessThan(100);
    await run;
    expect(existsSync(ocrPath(sd, false, 0))).toBe(false);
    expect(s.ocr.waiting).toBe(1);
    s.ocr.tick(); // not idle: nothing
    expect(s.starts()).toBe(1);
    s.idle(OCR_IDLE_MS);
    s.ocr.tick();
    await flush();
    expect(s.starts()).toBe(2);
    s.release({ lines: [], w: 1, h: 1 });
    await flush();
    expect(read(ocrPath(sd, false, 0))).toEqual({ lines: [], w: 1, h: 1 });
  });

  it("a frame with a hash already read is {same: m}", async () => {
    const { sd } = seg();
    const s = setup();
    s.ocr.image(jpg(sd, "frames", 0), "aaaa");
    s.ocr.image(jpg(sd, "frames", 1), "aaaa");
    s.ocr.image(jpg(sd, "frames", 2), "bbbb");
    await s.ocr.run();
    expect(s.reads.length).toBe(2);
    expect(read(ocrPath(sd, false, 1))).toEqual({ same: 0 });
  });

  it("a failed read is written as failed and the next image gets a new helper", async () => {
    const { sd } = seg();
    const s = setup();
    s.answer((p) => (p.endsWith("0.jpg") ? null : { lines: [], w: 1, h: 1 }));
    s.ocr.image(jpg(sd, "frames", 0));
    s.ocr.image(jpg(sd, "frames", 1));
    await s.ocr.run();
    expect(read(ocrPath(sd, false, 0))).toEqual({ failed: true });
    expect(s.starts()).toBe(2);
  });

  it("secure frames are never read", async () => {
    const { sd } = seg();
    const s = setup();
    const p = jpg(sd, "frames", 0);
    s.ocr.image(p);
    s.ocr.skip(p);
    await s.ocr.run();
    expect(s.reads).toEqual([]);
    expect(read(ocrPath(sd, false, 0))).toEqual({ skipped: "secure" });
  });
});

describe(".done timing", () => {
  it("a closed segment finishes when its last image is read, not before", async () => {
    const { sd } = seg();
    const s = setup();
    s.idle(0);
    s.ocr.image(jpg(sd, "frames", 0));
    jpg(sd, "frames", 1); // on disk, not announced: picked up at close
    s.ocr.closed(sd);
    expect(s.finished).toEqual([]);
    expect(s.ocr.waiting).toBe(2);
    s.idle(OCR_IDLE_MS);
    await s.ocr.run();
    expect(s.finished).toEqual([sd]);
  });

  it("a segment with nothing to read finishes at close", () => {
    const { sd } = seg();
    const s = setup();
    s.ocr.closed(sd);
    expect(s.finished).toEqual([sd]);
  });

  it("an open segment never finishes; a closed one gives up 2 h after it closed", () => {
    const { sd } = seg();
    const s = setup();
    s.idle(0);
    s.ocr.image(jpg(sd, "frames", 0));
    s.at(s.now() + OCR_WAIT_MS * 2);
    s.ocr.tick();
    expect(s.finished).toEqual([]);
    s.ocr.closed(sd);
    s.at(s.now() + OCR_WAIT_MS - 1);
    s.ocr.tick();
    expect(s.finished).toEqual([]);
    s.at(s.now() + 1);
    s.ocr.tick();
    expect(s.finished).toEqual([sd]);
  });

  it("resume picks up closed segments without .done, with their own close time", () => {
    const { root, sd } = seg("s1", "000");
    jpg(sd, "frames", 0);
    const closedAt = 500_000;
    writeFileSync(
      join(sd, "stats.json"),
      JSON.stringify({ segment: "000", closedAt: new Date(closedAt).toISOString() }),
    );
    const doneSeg = join(root, "s1", "001");
    mkdirSync(doneSeg);
    writeFileSync(join(doneSeg, "stats.json"), "{}");
    writeFileSync(join(doneSeg, ".done"), "");
    const s = setup();
    s.idle(0);
    expect(s.ocr.resume(root)).toBe(1);
    expect(s.ocr.waiting).toBe(1);
    s.at(closedAt + OCR_WAIT_MS);
    s.ocr.tick();
    expect(s.finished).toEqual([sd]);
  });
});
