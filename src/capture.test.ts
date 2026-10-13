import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { checkFrames, QUALITY, Shots, ShotsCapturer } from "./capture.ts";
import type { HelperChild } from "./helper.ts";

type Req = { id: number; op: string; [k: string]: unknown };

/** A fake `--shots` helper with a ring of 4 slots, answering like the real one. */
class FakeShots extends EventEmitter implements HelperChild {
  stdin = new PassThrough();
  stdout = new PassThrough();
  requests: Req[] = [];
  seqs: (number | null)[] = [null, null, null, null];
  seq = 0;
  mute = false;
  grabError: string | null = null;
  displays: Record<string, unknown>[] = [
    { id: "7", x: 0, y: 0, width: 1000, height: 500, scale: 1.92, primary: true },
    { id: "9", x: 1000, y: 0, width: 800, height: 500, scale: 2.4, primary: false },
  ];
  constructor() {
    super();
    let buf = "";
    this.stdin.on("data", (c: Buffer) => {
      buf += c.toString();
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const req = JSON.parse(buf.slice(0, nl)) as Req;
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        this.requests.push(req);
        if (!this.mute) this.answer(req);
      }
    });
  }
  private reply(msg: object) {
    this.stdout.write(`${JSON.stringify(msg)}\n`);
  }
  private answer(req: Req) {
    if (req.op === "displays") return this.reply({ id: req.id, displays: this.displays });
    if (req.op === "grab") {
      if (this.grabError) return this.reply({ id: req.id, error: this.grabError });
      const seq = ++this.seq;
      const slot = seq % 4;
      this.seqs[slot] = seq;
      return this.reply({
        id: req.id,
        slot,
        seq,
        w: 1920,
        h: 960,
        hash: `${"0".repeat(15)}${seq % 10}`,
      });
    }
    if (req.op === "save") {
      const slot = req.slot as number;
      if (this.seqs[slot] === null || this.seqs[slot] !== req.seq)
        return this.reply({ id: req.id, ok: false, error: "slot reused" });
      return this.reply({ id: req.id, ok: true, bytes: 1234 });
    }
    return this.reply({ id: req.id, error: "unknown op" });
  }
  kill() {
    this.emit("exit");
    return true;
  }
}

function setup(timeoutMs = 1000) {
  const children: FakeShots[] = [];
  const shots = new Shots({
    spawn: () => {
      const c = new FakeShots();
      children.push(c);
      return c;
    },
    timeoutMs,
    restartMs: 5,
  });
  const capturer = new ShotsCapturer(shots);
  return { shots, capturer, children, child: () => children[children.length - 1] as FakeShots };
}

describe("shots client", () => {
  it("lists displays in logical points and keeps the OS rects for coordinates", async () => {
    const { capturer, child } = setup();
    (child().displays[0] as Record<string, unknown>).os = {
      x: 0,
      y: 0,
      width: 1920,
      height: 960,
      scale: 1.92,
    };
    expect(await capturer.refresh()).toBe(true);
    expect(capturer.displays().map((d) => d.id)).toEqual(["7", "9"]);
    expect(capturer.displays()[0]).not.toHaveProperty("os");
    expect(capturer.screens()).toEqual([{ x: 0, y: 0, width: 1920, height: 960, scale: 1.92 }]);
    expect(capturer.displayAt(10, 10)).toBe("7");
    expect(capturer.displayAt(1500, 10)).toBe("9");
    expect(capturer.displayAt(5000, 10)).toBeUndefined();
  });

  it("grabs the display under the point, then saves that grab with its seq and quality", async () => {
    const { capturer, child } = setup();
    await capturer.refresh();
    const shot = await capturer.grab(1500, 10);
    expect(shot).toMatchObject({ display: "9", width: 1920, height: 960 });
    expect(shot?.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(child().requests.at(-1)).toMatchObject({ op: "grab", display: "9" });
    expect(await capturer.save(shot as never, "/data/0.jpg")).toBe(true);
    expect(child().requests.at(-1)).toMatchObject({
      op: "save",
      slot: 1,
      seq: 1,
      path: "/data/0.jpg",
      quality: QUALITY,
    });
  });

  it("a point on no display grabs the primary", async () => {
    const { capturer, child } = setup();
    await capturer.refresh();
    await capturer.grab(-50, -50);
    expect(child().requests.at(-1)).toMatchObject({ op: "grab", display: "7" });
  });

  it("a grab the ring has since reused does not save", async () => {
    const { capturer } = setup();
    await capturer.refresh();
    const first = await capturer.grab(1, 1);
    for (let i = 0; i < 4; i++) await capturer.grab(1, 1);
    expect(await capturer.save(first as never, "/data/old.jpg")).toBe(false);
  });

  it("a grab from before a helper restart does not save", async () => {
    const { capturer, child, children } = setup();
    await capturer.refresh();
    const shot = await capturer.grab(1, 1);
    child().kill(); // crashes; restarts after 5 ms
    await new Promise((r) => setTimeout(r, 40));
    expect(children.length).toBe(2);
    expect(await capturer.save(shot as never, "/data/stale.jpg")).toBe(false);
    expect(children[1]?.requests.some((r) => r.op === "save")).toBe(false);
  });

  it("an error or silence from the helper is a null grab and a false save, never a throw", async () => {
    const logs: string[] = [];
    const children: FakeShots[] = [];
    const shots = new Shots({
      spawn: () => {
        const c = new FakeShots();
        children.push(c);
        return c;
      },
      timeoutMs: 20,
    });
    const capturer = new ShotsCapturer(shots, (m) => logs.push(m));
    await capturer.refresh();
    const c = children[0] as FakeShots;
    c.grabError = "capture failed";
    expect(await capturer.grab(1, 1)).toBeNull();
    expect(await capturer.grab(1, 1)).toBeNull();
    expect(logs).toEqual(["screen: capture failed"]); // once, not every 500 ms
    c.grabError = null;
    const shot = await capturer.grab(1, 1);
    c.mute = true;
    expect(await capturer.save(shot as never, "/data/x.jpg")).toBe(false);
    expect(await capturer.grab(1, 1)).toBeNull();
  });

  it("a missing helper gives no displays and no frames, and does not throw", async () => {
    const shots = new Shots({ spawn: null });
    const capturer = new ShotsCapturer(shots);
    expect(shots.available).toBe(false);
    expect(await capturer.refresh()).toBe(false);
    expect(capturer.displays()).toEqual([]);
    expect(await capturer.grab(1, 1)).toBeNull();
    expect((await checkFrames(shots, "/data/x.jpg")).message).toMatch(/helper missing/);
  });

  it("doctor's check reports the grab and save, or what failed", async () => {
    const ok = setup();
    const good = await checkFrames(ok.shots, "/data/doctor.jpg");
    expect(good.ok).toBe(true);
    expect(good.message).toMatch(/^frames 1920x960, grab \d+ ms, save \d+ ms$/);
    const bad = setup();
    await new Promise((r) => setTimeout(r, 0));
    bad.child().grabError = "capture failed";
    const r = await checkFrames(bad.shots, "/data/doctor.jpg");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/cannot grab the screen/);
  });
});
