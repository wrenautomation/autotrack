#!/usr/bin/env node
/**
 * Self-update end to end on Windows and Linux (CI): installs the built bundle, then
 *   1. a fake 9.9.9 (this bundle, version bumped, signed with a throwaway key, served from a
 *      folder) must be staged, switched to and running, with its heartbeat in the S3 stub;
 *   2. a fake 9.9.10 that passes its selftest but fails every start must roll back to 9.9.9 and
 *      be marked bad;
 *   3. uninstall must leave nothing.
 * The recorder runs under the real launcher on Windows (the .vbs loop) and under a loop that
 * restarts it like the systemd unit on Linux (no user session on the runner).
 *
 *   node test/e2e/update.mjs            (from the repo root, after `node scripts/bundle.mjs`)
 */
import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const win = process.platform === "win32";
const repo = resolve(import.meta.dirname, "..", "..");
const asset = win ? "autotrack-win32-x64.zip" : "autotrack-linux-x64.tar.gz";
const bundle = join(repo, "bundles", asset);
const work = join(process.env.RUNNER_TEMP ?? tmpdir(), "autotrack-e2e", "update");
const data = join(work, "data");
const app = join(data, "app");
const tar = win ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";

const step = (s) => console.log(`\n== ${s}`);
const die = (msg) => {
  console.error(`::error::update e2e: ${msg}`);
  for (const f of ["track.log", "update.json"])
    if (existsSync(join(data, f)))
      console.error(`--- ${f}\n${readFileSync(join(data, f), "utf8").slice(-4000)}`);
  process.exit(1);
};

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
if (!existsSync(bundle)) die(`no ${bundle}: run node scripts/bundle.mjs first`);

step("S3 stub");
const device = "update-e2e";
const keyId = "AKIAUPDATETEST000001";
const secret = "update-test-secret";
const stub = spawn(
  process.execPath,
  [
    join(repo, "test/e2e/s3-stub.mjs"),
    "--root",
    join(work, "s3"),
    "--key-id",
    keyId,
    "--secret",
    secret,
    "--prefix",
    `${device}/`,
    "--port-file",
    join(work, "port"),
  ],
  { stdio: ["ignore", "inherit", "inherit"] },
);
for (let i = 0; !existsSync(join(work, "port")); i++) {
  if (i > 50) die("stub did not start");
  await sleep(100);
}
const port = readFileSync(join(work, "port"), "utf8").trim();
const code = Buffer.from(
  JSON.stringify({ v: 1, bucket: "autotrack-e2e", region: "us-east-1", device, keyId, secret }),
).toString("base64url");

step("install");
const env = {
  ...process.env,
  AUTOTRACK: code,
  AUTOTRACK_DIR: data,
  AUTOTRACK_BUNDLE: bundle,
  AUTOTRACK_ENDPOINT: `http://127.0.0.1:${port}`,
  AUTOTRACK_NO_AUTOSTART: "1",
  AUTOTRACK_NO_BROWSER: "1",
};
if (win)
  execFileSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(repo, "install", "install.ps1")],
    { env, stdio: "inherit" },
  );
else execFileSync("sh", [join(repo, "install", "install.sh")], { env, stdio: "inherit" });
const first = JSON.parse(readFileSync(join(app, "package.json"), "utf8")).version;
if (!lstatSync(app).isSymbolicLink()) die(`${app} is not a link`);
console.log(`installed ${first}: app → ${readlinkSync(app)}`);

step("releases 9.9.9 and 9.9.10, signed with a throwaway key");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const signingKey = privateKey.export({ type: "pkcs8", format: "pem" });
const pub = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const release = join(work, "release");

/** This bundle at `version`; `crash` makes every start fail after the boot check. */
function fake(version, crash) {
  const src = join(work, `src-${version}`);
  mkdirSync(src, { recursive: true });
  execFileSync(tar, win ? ["-xf", bundle, "-C", src] : ["-xzf", bundle, "-C", src]);
  const pkg = JSON.parse(readFileSync(join(src, "package.json"), "utf8"));
  writeFileSync(join(src, "package.json"), `${JSON.stringify({ ...pkg, version }, null, 2)}\n`);
  writeFileSync(join(src, "VERSION"), `${version}+e2e\n`);
  if (crash) {
    const cli = join(src, "dist", "cli.js");
    const js = readFileSync(cli, "utf8");
    if (!js.includes("recorder.start();")) die("dist/cli.js has no recorder.start()");
    writeFileSync(
      cli,
      js.replace("recorder.start();", `throw new Error("fake ${version} fails to start");`),
    );
  }
  rmSync(release, { recursive: true, force: true });
  mkdirSync(release);
  const out = join(release, asset);
  const entries = readdirSync(src);
  execFileSync(
    tar,
    win ? ["-a", "-cf", out, "-C", src, ...entries] : ["-czf", out, "-C", src, ...entries],
  );
  execFileSync(process.execPath, [join(repo, "scripts", "sign-release.mjs"), release, version], {
    env: { ...process.env, AUTOTRACK_SIGNING_KEY: signingKey },
    stdio: "inherit",
  });
  rmSync(src, { recursive: true, force: true });
}

const node = join(app, "node", win ? "node.exe" : "node");
const cliJs = join(app, "dist", "cli.js");
const recorderEnv = { ...env, AUTOTRACK_UPDATE_URL: release, AUTOTRACK_UPDATE_KEY: pub };
const cli = (...args) => {
  try {
    return execFileSync(node, [cliJs, ...args], {
      env: recorderEnv,
      encoding: "utf8",
      timeout: 600_000,
    });
  } catch (e) {
    return `${e.stdout ?? ""}${e.stderr ?? ""}(exit ${e.status})`;
  }
};
const runningVersion = () => /"version":\s*"([^"]+)"/.exec(cli("status"))?.[1] ?? null;
async function waitFor(what, test, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await test();
    if (v) return v;
    await sleep(2000);
  }
  die(`timed out waiting for ${what}`);
}
const state = () => {
  try {
    return JSON.parse(readFileSync(join(data, "update.json"), "utf8"));
  } catch {
    return {};
  }
};

step("start under the launcher");
let supervisor;
let stopping = false;
if (win) {
  supervisor = spawn(
    join(process.env.SystemRoot, "System32", "wscript.exe"),
    ["//B", "//Nologo", join(data, "autotrack.vbs")],
    {
      env: recorderEnv,
      detached: true,
      stdio: "ignore",
    },
  );
} else {
  // Like the systemd unit: AUTOTRACK_SUPERVISED, anything but 0 restarts (10 s; 75 at once here).
  const loop = async () => {
    while (!stopping) {
      const child = spawn(node, [cliJs, "start"], {
        env: { ...recorderEnv, AUTOTRACK_SUPERVISED: "1" },
        stdio: ["ignore", "ignore", "inherit"],
      });
      const rc = await new Promise((r) => child.on("exit", (c) => r(c)));
      console.log(`(recorder exited ${rc})`);
      if (rc === 0) return;
      await sleep(rc === 75 ? 500 : 10_000);
    }
  };
  supervisor = loop();
}
await waitFor(`${first} running`, () => runningVersion() === first, 60_000);
console.log(`running ${first}`);

step("update to 9.9.9");
fake("9.9.9", false);
console.log(cli("update", "--check"));
console.log(cli("update"));
await waitFor("9.9.9 running", () => runningVersion() === "9.9.9", 180_000);
if (basename(readlinkSync(app).replace(/[\\/]+$/, "")) !== "9.9.9")
  die(`app → ${readlinkSync(app)}`);
const s1 = state();
if (s1.pending !== "9.9.9" || s1.previous !== first)
  die(`update.json after 9.9.9: ${JSON.stringify(s1)}`);
const beat = join(work, "s3", "autotrack-e2e", device, "heartbeat.json");
await waitFor(
  "a 9.9.9 heartbeat",
  () => existsSync(beat) && JSON.parse(readFileSync(beat, "utf8")).version === "9.9.9",
  30_000,
);
console.log(`heartbeat: ${readFileSync(beat, "utf8").trim()}`);

step("9.9.10 fails every start: rolled back to 9.9.9");
fake("9.9.10", true);
console.log(cli("update"));
await waitFor("9.9.10 marked bad", () => state().bad?.includes("9.9.10"), 300_000);
await waitFor("9.9.9 running again", () => runningVersion() === "9.9.9", 120_000);
const s2 = state();
console.log(`update.json: ${JSON.stringify(s2)}`);
if (!/9\.9\.10 failed 3 starts; back on 9\.9\.9/.test(s2.error ?? ""))
  die(`no rollback error: ${s2.error}`);
if (basename(readlinkSync(app).replace(/[\\/]+$/, "")) !== "9.9.9")
  die(`app → ${readlinkSync(app)} after rollback`);
if (!/marked bad/.test(cli("update", "--check"))) die("--check does not show 9.9.10 as bad");

step("uninstall");
stopping = true;
console.log(cli("uninstall", "--yes"));
if (!win) await supervisor;
for (let i = 0; i < 40 && existsSync(data); i++) await sleep(500);
if (existsSync(data)) die(`uninstall left ${readdirSync(data).join(", ")}`);
stub.kill();
console.log("\nupdate e2e ok");
process.exit(0);
