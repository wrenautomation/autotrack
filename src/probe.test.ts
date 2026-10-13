import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Probe, type ProbeChild } from "./probe.ts";

/** A fake helper: records requests; the test answers when and how it likes. */
class FakeChild extends EventEmitter implements ProbeChild {
  stdin = new PassThrough();
  stdout = new PassThrough();
  requests: { id: number; op: string; [k: string]: unknown }[] = [];
  killed = false;
  constructor() {
    super();
    let buf = "";
    this.stdin.on("data", (c: Buffer) => {
      buf += c.toString();
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        this.requests.push(JSON.parse(buf.slice(0, nl)));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
    });
  }
  answer(msg: object) {
    this.stdout.write(`${JSON.stringify(msg)}\n`);
  }
  kill() {
    this.killed = true;
    this.emit("exit");
    return true;
  }
}

const tick = () => new Promise((r) => setImmediate(r));

function setup(opts: { timeoutMs?: number } = {}) {
  const children: FakeChild[] = [];
  const probe = new Probe({
    spawn: () => {
      const c = new FakeChild();
      children.push(c);
      return c;
    },
    timeoutMs: opts.timeoutMs ?? 50,
    restartMs: 10,
  });
  return { probe, children, child: () => children[children.length - 1] as FakeChild };
}

afterEach(() => vi.useRealTimers());

describe("probe client", () => {
  it("sends ids and resolves answers by id, out of order", async () => {
    const { probe, child } = setup({ timeoutMs: 1000 });
    const a = probe.at(10.4, 20.6);
    const f = probe.front();
    await tick();
    expect(child().requests).toEqual([
      { id: 1, op: "at", x: 10, y: 21 },
      { id: 2, op: "front" },
    ]);
    child().answer({
      id: 2,
      app: { name: "Finder", id: "com.apple.finder", pid: 9 },
      window: null,
    });
    child().answer({ id: 1, element: null });
    expect(await f).toMatchObject({ app: { name: "Finder" } });
    expect(await a).toMatchObject({ element: null });
    probe.close();
  });

  it("an at asked with longer tells the helper to wait as long", async () => {
    const { probe, child } = setup();
    void probe.at(1, 2, 1000);
    await tick();
    expect(child().requests[0]).toEqual({ id: 1, op: "at", x: 1, y: 2, wait: 1000 });
    probe.close();
  });

  it("times out to null in 50 ms and drops the late answer", async () => {
    const { probe, child } = setup();
    const t = Date.now();
    const first = await probe.focused();
    expect(first).toBeNull();
    expect(Date.now() - t).toBeLessThan(500);
    const second = probe.focused();
    await tick();
    child().answer({ id: 1, element: { secure: true } }); // late answer for the first request
    await tick();
    child().answer({ id: 2, element: null });
    expect(await second).toEqual({ id: 2, element: null });
    probe.close();
  });

  it("skips garbage lines", async () => {
    const { probe, child } = setup({ timeoutMs: 1000 });
    const p = probe.perm();
    await tick();
    child().stdout.write("not json\n\n");
    child().answer({ id: 1, accessibility: true, screen: false, input: true });
    expect(await p).toMatchObject({ screen: false });
    probe.close();
  });

  it("resolves pending calls null when the helper dies, then restarts it", async () => {
    const { probe, children, child } = setup({ timeoutMs: 5000 });
    const p = probe.front();
    await tick();
    children[0]?.emit("exit");
    expect(await p).toBeNull();
    expect(probe.running).toBe(false);
    expect(await probe.front()).toBeNull(); // down: null at once
    await new Promise((r) => setTimeout(r, 30));
    expect(children.length).toBe(2);
    const q = probe.front();
    await tick();
    const id = child().requests[0]?.id;
    child().answer({ id, app: null, window: null });
    expect(await q).toEqual({ id, app: null, window: null });
    probe.close();
    expect(child().killed).toBe(true);
  });

  it("with no helper, every call is null at once", async () => {
    const probe = new Probe({ spawn: null });
    expect(probe.available).toBe(false);
    expect(await probe.at(1, 1)).toBeNull();
    expect(await probe.perm()).toBeNull();
  });
});
