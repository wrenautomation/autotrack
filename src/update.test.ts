import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Heart, type Heartbeat } from "./heartbeat.ts";
import {
  apply,
  assetFor,
  bootCheck,
  compareVersions,
  currentVersion,
  FORCE_AFTER_MS,
  IDLE_BEFORE_MS,
  MAX_BOOTS,
  markGood,
  pointApp,
  prune,
  readState,
  refreshExtension,
  sourceAt,
  stage,
  Updater,
  verifyRelease,
  versionsDir,
  writeState,
} from "./update.ts";

let data: string;
beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), "autotrack-update-"));
});
afterEach(() => {
  rmSync(data, { recursive: true, force: true });
});

const keys = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    pub: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
};
const signed = (body: object, privateKey: ReturnType<typeof keys>["privateKey"]) => {
  const bytes = Buffer.from(JSON.stringify(body));
  return { bytes, sig: sign(null, bytes, privateKey).toString("base64") };
};

/** An unpacked version folder, as a bundle leaves it. */
function version(v: string, extra: Record<string, string> = {}) {
  const dir = join(versionsDir(data), v);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: v }));
  for (const [name, body] of Object.entries(extra)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

describe("compareVersions", () => {
  it("orders releases, prereleases and ignores build metadata", () => {
    expect(compareVersions("0.3.0", "0.2.9")).toBe(1);
    expect(compareVersions("0.2.0", "0.10.0")).toBe(-1);
    expect(compareVersions("1.0.0+abc", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0-rc.2", "1.0.0-rc.1")).toBe(1);
    expect(() => compareVersions("1.0", "1.0.0")).toThrow(/not a version/);
  });
});

describe("verifyRelease", () => {
  const { privateKey, pub } = keys();
  const files = { "autotrack-linux-x64.tar.gz": "a".repeat(64) };

  it("accepts a signed release and refuses tampering, another key and a bad shape", () => {
    const { bytes, sig } = signed({ version: "0.3.0", files }, privateKey);
    expect(verifyRelease(bytes, sig, pub)).toEqual({ version: "0.3.0", files });
    const tampered = Buffer.from(bytes.toString().replace("0.3.0", "9.9.9"));
    expect(() => verifyRelease(tampered, sig, pub)).toThrow(/bad signature/);
    expect(() => verifyRelease(bytes, sig, keys().pub)).toThrow(/bad signature/);
    const odd = signed({ version: "../x", files }, privateKey);
    expect(() => verifyRelease(odd.bytes, odd.sig, pub)).toThrow(/no version/);
    const path = signed({ version: "1.0.0", files: { "../evil": "a".repeat(64) } }, privateKey);
    expect(() => verifyRelease(path.bytes, path.sig, pub)).toThrow(/bad entry/);
  });
});

describe("assetFor", () => {
  it("names each platform's bundle", () => {
    expect(assetFor("win32", "x64")).toBe("autotrack-win32-x64.zip");
    expect(assetFor("linux", "x64")).toBe("autotrack-linux-x64.tar.gz");
    expect(assetFor("darwin", "arm64")).toBe("autotrack-darwin-arm64.tar.gz");
    expect(assetFor("linux", "arm64")).toBeNull();
  });
});

describe("layout", () => {
  it("points app at a version, swaps it, and prunes all but what is kept", () => {
    version("0.2.0");
    version("0.3.0");
    version("0.1.0");
    expect(currentVersion(data)).toBeNull();
    pointApp(data, "0.2.0");
    expect(currentVersion(data)).toBe("0.2.0");
    expect(JSON.parse(readFileSync(join(data, "app", "package.json"), "utf8")).version).toBe(
      "0.2.0",
    );
    pointApp(data, "0.3.0");
    expect(currentVersion(data)).toBe("0.3.0");
    expect(existsSync(join(data, "app.next"))).toBe(false);
    expect(existsSync(join(data, "app.old"))).toBe(false);
    expect(prune(data, ["0.3.0", "0.2.0"])).toEqual(["0.1.0"]);
    expect(existsSync(join(versionsDir(data), "0.2.0", "package.json"))).toBe(true);
  });

  it("refuses a version that is not unpacked and an app that is a real folder", () => {
    expect(() => pointApp(data, "9.9.9")).toThrow(/not unpacked/);
    version("0.3.0");
    mkdirSync(join(data, "app"));
    expect(() => pointApp(data, "0.3.0", "linux")).toThrow(/real folder/);
  });

  it("on a Mac, trades the real app folder for a version by rename and back", () => {
    renameSync(version("0.2.0"), join(data, "app"));
    writeFileSync(join(data, "app", "node"), "old node");
    version("0.3.0", { node: "new node" });
    expect(currentVersion(data, "darwin")).toBe("0.2.0");
    pointApp(data, "0.3.0", "darwin");
    expect(lstatSync(join(data, "app")).isSymbolicLink()).toBe(false);
    expect(currentVersion(data, "darwin")).toBe("0.3.0");
    expect(readFileSync(join(data, "app", "node"), "utf8")).toBe("new node");
    expect(readFileSync(join(versionsDir(data), "0.2.0", "node"), "utf8")).toBe("old node");
    expect(existsSync(join(versionsDir(data), "0.3.0"))).toBe(false);
    expect(() => pointApp(data, "0.3.0", "darwin")).toThrow(/not unpacked/);
    pointApp(data, "0.2.0", "darwin"); // the rollback
    expect(currentVersion(data, "darwin")).toBe("0.2.0");
    expect(existsSync(join(versionsDir(data), "0.3.0", "package.json"))).toBe(true);
  });
});

describe("bootCheck and markGood", () => {
  it("rolls back a pending version after MAX_BOOTS starts and marks it bad", () => {
    version("0.2.0");
    version("0.3.0");
    pointApp(data, "0.3.0");
    writeState(data, { pending: "0.3.0", previous: "0.2.0", boots: 0 });
    for (let i = 0; i < MAX_BOOTS; i++) expect(bootCheck(data, "0.3.0")).toBe("ok");
    expect(readState(data).boots).toBe(MAX_BOOTS);
    expect(bootCheck(data, "0.3.0")).toBe("rolled back");
    expect(currentVersion(data)).toBe("0.2.0");
    const s = readState(data);
    expect(s.pending).toBeUndefined();
    expect(s.bad).toEqual(["0.3.0"]);
    expect(s.error).toMatch(/0\.3\.0 failed 3 starts; back on 0\.2\.0/);
    expect(bootCheck(data, "0.2.0")).toBe("ok"); // not pending: nothing counted
  });

  it("clears pending once good and keeps current and previous", () => {
    version("0.1.0");
    version("0.2.0");
    version("0.3.0");
    pointApp(data, "0.3.0");
    writeState(data, { pending: "0.3.0", previous: "0.2.0", boots: 2 });
    markGood(data, "0.3.0");
    expect(readState(data)).toEqual({ previous: "0.2.0" });
    expect(existsSync(join(versionsDir(data), "0.1.0"))).toBe(false);
    expect(existsSync(join(versionsDir(data), "0.2.0"))).toBe(true);
  });
});

describe("stage", () => {
  const { privateKey, pub } = keys();
  const asset = "autotrack-linux-x64.tar.gz";

  /** A release folder holding a tarball of a fake bundle at `v`. */
  function release(v: string, o: { bundleVersion?: string; badHash?: boolean } = {}) {
    const rel = mkdtempSync(join(tmpdir(), "autotrack-release-"));
    const src = join(rel, "src");
    mkdirSync(src);
    writeFileSync(join(src, "package.json"), JSON.stringify({ version: o.bundleVersion ?? v }));
    execFileSync("tar", ["-czf", join(rel, asset), "-C", src, "package.json"]);
    const sum = createHash("sha256")
      .update(readFileSync(join(rel, asset)))
      .digest("hex");
    const { bytes, sig } = signed(
      { version: v, files: { [asset]: o.badHash ? "0".repeat(64) : sum } },
      privateKey,
    );
    writeFileSync(join(rel, "release.json"), bytes);
    writeFileSync(join(rel, "release.json.sig"), sig);
    return rel;
  }
  const opts = (rel: string, selftest = vi.fn(async () => "selftest ok")) => ({
    data,
    version: "0.2.0",
    platform: "linux" as const,
    arch: "x64",
    source: sourceAt(rel),
    key: pub,
    selftest,
  });

  it("stages a newer verified release and selftests it", async () => {
    const rel = release("0.3.0");
    const selftest = vi.fn(async () => "selftest ok");
    expect(await stage(opts(rel, selftest))).toEqual({ state: "staged", latest: "0.3.0" });
    expect(existsSync(join(versionsDir(data), "0.3.0", "package.json"))).toBe(true);
    expect(selftest).toHaveBeenCalledOnce();
    expect(readState(data)).toMatchObject({ staged: "0.3.0", latest: "0.3.0" });
    expect(existsSync(join(versionsDir(data), `${asset}.download`))).toBe(false);
    rmSync(rel, { recursive: true, force: true });
  });

  it("says current for the same or an older version, and skips a bad one", async () => {
    const same = release("0.2.0");
    expect(await stage(opts(same))).toEqual({ state: "current", latest: "0.2.0" });
    const newer = release("0.3.0");
    writeState(data, { bad: ["0.3.0"] });
    expect(await stage(opts(newer))).toEqual({ state: "bad", latest: "0.3.0" });
    for (const r of [same, newer]) rmSync(r, { recursive: true, force: true });
  });

  it("refuses a wrong checksum, a mislabelled bundle, and marks a failed selftest bad", async () => {
    const hash = release("0.3.0", { badHash: true });
    await expect(stage(opts(hash))).rejects.toThrow(/sha256/);
    const label = release("0.3.0", { bundleVersion: "0.2.5" });
    await expect(stage(opts(label))).rejects.toThrow(/holds 0\.2\.5/);
    expect(existsSync(join(versionsDir(data), "0.3.0"))).toBe(false);
    const ok = release("0.3.0");
    const failing = vi.fn(async () => {
      throw new Error("no helper");
    });
    await expect(stage(opts(ok, failing))).rejects.toThrow(/selftest, marked bad: no helper/);
    expect(readState(data).bad).toEqual(["0.3.0"]);
    expect(existsSync(join(versionsDir(data), "0.3.0"))).toBe(false);
    for (const r of [hash, label, ok]) rmSync(r, { recursive: true, force: true });
  });

  it("says unsupported where there is no bundle", async () => {
    expect(await stage({ ...opts(data), platform: "aix", arch: "ppc64" })).toEqual({
      state: "unsupported",
    });
  });
});

describe("apply and the extension", () => {
  it("switches, records pending and previous, and refreshes the unpacked extension", () => {
    version("0.2.0");
    version("0.3.0", { "extension/manifest.json": '{"v":3}' });
    pointApp(data, "0.2.0");
    mkdirSync(join(data, "extension"));
    writeFileSync(join(data, "extension", "manifest.json"), '{"v":2}');
    writeState(data, { staged: "0.3.0", error: "old" });
    expect(apply(data, "0.3.0")).toEqual({ previous: "0.2.0" });
    expect(currentVersion(data)).toBe("0.3.0");
    expect(readState(data)).toEqual({ pending: "0.3.0", previous: "0.2.0", boots: 0 });
    expect(readFileSync(join(data, "extension", "manifest.json"), "utf8")).toBe('{"v":3}');
  });

  it("leaves no extension alone when the install made none", () => {
    version("0.3.0", { "extension/manifest.json": "{}" });
    pointApp(data, "0.3.0");
    expect(refreshExtension(data)).toBe(false);
    expect(existsSync(join(data, "extension"))).toBe(false);
  });
});

describe("Updater", () => {
  const setup = (idle: number) => {
    version("0.2.0");
    version("0.3.0");
    pointApp(data, "0.2.0");
    let now = 1_000_000;
    const restart = vi.fn(async () => {});
    const u = new Updater({
      data,
      version: "0.2.0",
      mode: "auto",
      idleMs: () => idle,
      stageChild: async () => ({ state: "staged", latest: "0.3.0" }),
      restart,
      now: () => now,
    });
    return { u, restart, advance: (ms: number) => (now += ms) };
  };

  it("waits for input to rest, then applies and restarts", async () => {
    const busy = setup(1000);
    await busy.u.check();
    expect(busy.u.status().state).toBe("staged");
    expect(await busy.u.tick()).toBe(false);
    busy.advance(FORCE_AFTER_MS);
    expect(await busy.u.tick()).toBe(true);
    expect(busy.restart).toHaveBeenCalledWith("update to 0.3.0");
    expect(currentVersion(data)).toBe("0.3.0");
    busy.u.stop();
  });

  it("applies at once when idle", async () => {
    const idle = setup(IDLE_BEFORE_MS);
    await idle.u.check();
    expect(await idle.u.tick()).toBe(true);
    expect(readState(data).pending).toBe("0.3.0");
    idle.u.stop();
  });

  it("records a failed check without throwing", async () => {
    const u = new Updater({
      data,
      version: "0.2.0",
      mode: "auto",
      idleMs: () => 0,
      stageChild: async () => {
        throw new Error("GET release.json: 404");
      },
      restart: async () => {},
    });
    expect(await u.check()).toBeNull();
    expect(u.status()).toMatchObject({ state: "idle", error: "GET release.json: 404" });
  });
});

describe("Heart", () => {
  const body = (): Heartbeat => ({
    v: 1,
    version: "0.3.0",
    platform: "linux",
    arch: "x64",
    os: "6.8",
    at: "2026-10-14T00:00:00.000Z",
    startedAt: "2026-10-14T00:00:00.000Z",
    paused: null,
    level: "full",
    memoryRestarts: { count: 0, last: null },
    waiting: { segments: 0, bytes: 0 },
    ship: null,
    metered: false,
    update: null,
  });

  it("puts heartbeat.json under the device, and reports a failed put", async () => {
    const puts: { key: string; body: string }[] = [];
    const ok = new Heart({
      store: {
        put: async (key, b) => {
          puts.push({ key, body: Buffer.from(b).toString() });
        },
      },
      device: "laptop",
      body,
    });
    expect(await ok.beat()).toBe(true);
    expect(puts[0]?.key).toBe("laptop/heartbeat.json");
    expect(JSON.parse(puts[0]?.body ?? "")).toMatchObject({ v: 1, version: "0.3.0" });
    const log = vi.fn();
    const bad = new Heart({
      store: {
        put: async () => {
          throw new Error("403 AccessDenied");
        },
      },
      device: "laptop",
      body,
      log,
    });
    expect(await bad.beat()).toBe(false);
    expect(log).toHaveBeenCalledWith("heartbeat: 403 AccessDenied");
    expect(await new Heart({ store: null, device: "x", body }).beat()).toBe(false);
  });
});
