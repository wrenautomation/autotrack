#!/usr/bin/env node
/**
 * Builds the release bundle for one platform: `bundles/autotrack-<platform>-<arch>.{zip|tar.gz}`,
 * plus its line in `bundles/SHA256SUMS`. Run it on that platform (CI does, one runner each), so
 * the production node_modules carry that platform's prebuilds and the helper gets compiled.
 *
 *   node scripts/bundle.mjs [--arch x64|arm64] [--out bundles] [--skip-build]
 *
 * Layout inside the archive (no top folder):
 *   VERSION                  "<package version>+<git sha>"
 *   package.json             name, version, type: module, dependencies
 *   node/node[.exe]          official Node, pinned below, SHA-256 checked twice
 *   dist/                    tsc output, tests left out
 *   node_modules/            production deps, hoisted (no symlinks), this platform only
 *   helpers/mac/probe        universal binary (Mac) | helpers/win/autotrack-helper.exe (Windows,
 *                            C# for .NET Framework 4.8, built by helpers/win/build.ps1) |
 *                            helpers/linux/autotrack-helper (Linux, static musl Rust, built by
 *                            helpers/linux/build.sh)
 *   host/*.mjs               native messaging host for the browser extension
 *   install/setup.mjs        config.json + browser host, run by install.sh / install.ps1
 *   install/perm.mjs         Mac: asks the probe which permissions node holds
 *   extension.zip            the browser extension with its manifest `key`; the installers unpack
 *                            it to <data>/extension (the Web Store zip is `pnpm zip` in extension/)
 *   autotrack.cmd (Windows) | bin/autotrack (Mac, Linux)    the CLI
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const NODE_VERSION = "24.21.0";
/** From https://nodejs.org/dist/v24.21.0/SHASUMS256.txt, pinned so a swapped download fails. */
export const NODE_SHA256 = {
  "darwin-arm64": "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057",
  "darwin-x64": "1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097",
  "win32-x64": "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541",
  "linux-x64": "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff",
};
export const TARGETS = Object.keys(NODE_SHA256);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIN = process.platform === "win32";
const TAR = WIN ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const log = (m) => console.log(`bundle: ${m}`);
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function run(cmd, args, opts = {}) {
  // Node refuses to spawn .cmd files without a shell; pnpm on Windows is one.
  if (WIN && cmd === "pnpm")
    return execFileSync(["pnpm", ...args].join(" "), { stdio: "inherit", shell: true, ...opts });
  return execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

async function download(url, file) {
  if (existsSync(file)) return readFileSync(file);
  log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, buf);
  return buf;
}

/** The official Node binary for the target, checked against the pin and SHASUMS256.txt. */
async function fetchNode(target, cache, into) {
  const [os, arch] = target.split("-");
  const name = `node-v${NODE_VERSION}-${os === "win32" ? "win" : os}-${arch}`;
  const file = `${name}.${os === "win32" ? "zip" : "tar.gz"}`;
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  const buf = await download(`${base}/${file}`, join(cache, file));
  const sums = (
    await download(`${base}/SHASUMS256.txt`, join(cache, `SHASUMS256-${NODE_VERSION}.txt`))
  ).toString();
  const listed = sums
    .split("\n")
    .find((l) => l.endsWith(`  ${file}`))
    ?.split(/\s+/)[0];
  const got = sha256(buf);
  if (got !== NODE_SHA256[target] || got !== listed) {
    rmSync(join(cache, file), { force: true });
    throw new Error(`${file}: sha256 ${got}, pinned ${NODE_SHA256[target]}, SHASUMS256 ${listed}`);
  }
  const tmp = mkdtempSync(join(tmpdir(), "autotrack-node-"));
  try {
    const exe = os === "win32" ? `${name}/node.exe` : `${name}/bin/node`;
    run(TAR, ["-xf", join(cache, file), "-C", tmp, exe, `${name}/LICENSE`]);
    mkdirSync(into, { recursive: true });
    cpSync(join(tmp, exe), join(into, basename(exe)));
    cpSync(join(tmp, name, "LICENSE"), join(into, "LICENSE"));
    if (os !== "win32") chmodSync(join(into, "node"), 0o755);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  log(`node v${NODE_VERSION} ${target} checked (${got.slice(0, 12)}…)`);
}

/** Production deps, hoisted into real dirs (zip has no symlinks), installed on this machine. */
function installDeps(target, stage) {
  const [os, arch] = target.split("-");
  const tmp = mkdtempSync(join(tmpdir(), "autotrack-deps-"));
  try {
    cpSync(join(ROOT, "package.json"), join(tmp, "package.json"));
    cpSync(join(ROOT, "pnpm-lock.yaml"), join(tmp, "pnpm-lock.yaml"));
    run(
      "pnpm",
      [
        "install",
        "--prod",
        "--frozen-lockfile",
        "--config.node-linker=hoisted",
        "--config.package-import-method=copy",
        "--config.confirmModulesPurge=false",
      ],
      { cwd: tmp },
    );
    const nm = join(tmp, "node_modules");
    for (const junk of [".bin", ".modules.yaml", ".pnpm", ".package-lock.json"])
      rmSync(join(nm, junk), { recursive: true, force: true });
    // Other platforms' prebuilds and native sources: dead weight in this bundle.
    const keepOnly = (dir, keep) => {
      if (!existsSync(dir)) return;
      for (const d of readdirSync(dir))
        if (d !== keep) rmSync(join(dir, d), { recursive: true, force: true });
    };
    keepOnly(join(nm, "koffi", "build", "koffi"), `${os}_${arch}`);
    keepOnly(join(nm, "uiohook-napi", "prebuilds"), `${os}-${arch}`);
    for (const d of ["libuiohook", "src"])
      rmSync(join(nm, "uiohook-napi", d), { recursive: true, force: true });
    for (const d of ["doc", "vendor"])
      rmSync(join(nm, "koffi", d), { recursive: true, force: true });
    cpSync(nm, join(stage, "node_modules"), { recursive: true });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Every file under dir, relative, sorted. */
function files(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name), base) : [relative(base, join(dir, e.name))],
    )
    .sort();
}

/** What the store zip leaves out: dev files, docs, dotfiles. */
const EXTENSION_SKIP =
  /(^|[\\/])(node_modules|test|scripts|\.[^\\/]+)([\\/]|$)|^(package\.json|pnpm-lock\.yaml|tsconfig.*|vitest.*)$|\.md$|\.test\./;

/** bin/autotrack: the CLI on the bundled node (Mac, Linux). */
function writeBin(stage) {
  mkdirSync(join(stage, "bin"), { recursive: true });
  writeFileSync(
    join(stage, "bin", "autotrack"),
    '#!/bin/sh\n# The autotrack CLI on the bundled node.\napp=$(cd "$(dirname "$0")/.." && pwd -P)\nexec "$app/node/node" "$app/dist/cli.js" "$@"\n',
  );
  chmodSync(join(stage, "bin", "autotrack"), 0o755);
}

/** A zip of `entries` under `cwd`: bsdtar on Mac and Windows; on Linux (GNU tar has no zip) `zip`. */
function zip(out, cwd, entries) {
  rmSync(out, { force: true });
  if (process.platform === "linux") {
    run("zip", ["-q", "-X", "-r", out, ...entries], { cwd });
    return;
  }
  run(TAR, ["--format", "zip", "-cf", out, "-C", cwd, ...entries], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
}

async function main() {
  const os = process.platform;
  const arch = arg("arch", process.arch);
  const target = `${os}-${arch}`;
  if (!TARGETS.includes(target))
    throw new Error(`no bundle for ${target}; targets: ${TARGETS.join(", ")}`);
  const out = join(ROOT, arg("out", "bundles"));
  const cache = join(out, "cache");
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  let sha = "dev";
  try {
    sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
  } catch {}
  const version = `${pkg.version}+${sha}`;

  if (!process.argv.includes("--skip-build")) {
    rmSync(join(ROOT, "dist"), { recursive: true, force: true });
    run("pnpm", ["run", "build"], { cwd: ROOT });
  }
  const stage = mkdtempSync(join(tmpdir(), `autotrack-${target}-`));
  try {
    await fetchNode(target, cache, join(stage, "node"));

    for (const f of files(join(ROOT, "dist")).filter(
      (f) => f.endsWith(".js") && !/\.test\.js$/.test(f),
    )) {
      mkdirSync(dirname(join(stage, "dist", f)), { recursive: true });
      cpSync(join(ROOT, "dist", f), join(stage, "dist", f));
    }
    if (!existsSync(join(stage, "dist", "cli.js")))
      throw new Error("dist/cli.js missing: build failed?");

    installDeps(target, stage);
    const { name, type, license, dependencies } = pkg;
    writeFileSync(
      join(stage, "package.json"),
      `${JSON.stringify({ name, version: pkg.version, private: true, type, license, dependencies }, null, 2)}\n`,
    );

    mkdirSync(join(stage, "install"), { recursive: true });
    if (os === "darwin") {
      run("sh", [join(ROOT, "helpers", "mac", "build.sh")]);
      const macDir = join(ROOT, "helpers", "mac");
      mkdirSync(join(stage, "helpers", "mac"), { recursive: true });
      // Built helpers: executable files that aren't scripts.
      for (const f of readdirSync(macDir)) {
        const p = join(macDir, f);
        const st = statSync(p);
        if (st.isFile() && st.mode & 0o111 && !/\.(sh|mjs|js|swift)$/.test(f)) {
          cpSync(p, join(stage, "helpers", "mac", f));
          chmodSync(join(stage, "helpers", "mac", f), 0o755);
        }
      }
      if (!existsSync(join(stage, "helpers", "mac", "probe")))
        throw new Error("helpers/mac/probe not built");
      writeBin(stage);
      cpSync(join(ROOT, "install", "perm.mjs"), join(stage, "install", "perm.mjs"));
    } else if (os === "linux") {
      // Needs cargo with the x86_64-unknown-linux-musl target.
      const bin = join(ROOT, "helpers", "linux", "autotrack-helper");
      run("sh", [join(ROOT, "helpers", "linux", "build.sh")]);
      if (!existsSync(bin)) throw new Error("helpers/linux/autotrack-helper not built");
      mkdirSync(join(stage, "helpers", "linux"), { recursive: true });
      cpSync(bin, join(stage, "helpers", "linux", "autotrack-helper"));
      chmodSync(join(stage, "helpers", "linux", "autotrack-helper"), 0o755);
      writeBin(stage);
    } else {
      const exe = join(ROOT, "helpers", "win", "autotrack-helper.exe");
      run("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(ROOT, "helpers", "win", "build.ps1"),
      ]);
      if (!existsSync(exe)) throw new Error("helpers/win/autotrack-helper.exe not built");
      mkdirSync(join(stage, "helpers", "win"), { recursive: true });
      cpSync(exe, join(stage, "helpers", "win", "autotrack-helper.exe"));
      writeFileSync(
        join(stage, "autotrack.cmd"),
        '@"%~dp0node\\node.exe" "%~dp0dist\\cli.js" %*\r\n',
      );
    }

    cpSync(join(ROOT, "install", "setup.mjs"), join(stage, "install", "setup.mjs"));
    mkdirSync(join(stage, "host"), { recursive: true });
    for (const f of readdirSync(join(ROOT, "host")).filter((f) => f.endsWith(".mjs")))
      cpSync(join(ROOT, "host", f), join(stage, "host", f));

    const ext = join(ROOT, "extension");
    const extFiles = files(ext).filter((f) => !EXTENSION_SKIP.test(f));
    if (!extFiles.includes("manifest.json")) throw new Error("extension/manifest.json missing");
    zip(join(stage, "extension.zip"), ext, extFiles);
    cpSync(join(stage, "extension.zip"), join(out, "autotrack-extension.zip"));
    // Linux: unpacked too, since unzip is not on every distro.
    if (os === "linux")
      for (const f of extFiles) {
        mkdirSync(dirname(join(stage, "extension", f)), { recursive: true });
        cpSync(join(ext, f), join(stage, "extension", f));
      }

    writeFileSync(join(stage, "VERSION"), `${version}\n`);

    mkdirSync(out, { recursive: true });
    const entries = readdirSync(stage).sort();
    const archive = join(out, `autotrack-${target}.${os === "win32" ? "zip" : "tar.gz"}`);
    rmSync(archive, { force: true });
    if (os === "win32") zip(archive, stage, entries);
    else
      run("tar", ["-czf", archive, "-C", stage, ...entries], {
        env: { ...process.env, COPYFILE_DISABLE: "1" },
      });

    const sumsPath = join(out, "SHA256SUMS");
    const sums = new Map(
      (existsSync(sumsPath) ? readFileSync(sumsPath, "utf8") : "")
        .split("\n")
        .filter(Boolean)
        .map((l) => [l.split(/\s+/)[1], l]),
    );
    for (const f of [archive, join(out, "autotrack-extension.zip")])
      sums.set(basename(f), `${sha256(readFileSync(f))}  ${basename(f)}`);
    writeFileSync(
      sumsPath,
      `${[...sums.keys()]
        .sort()
        .map((k) => sums.get(k))
        .join("\n")}\n`,
    );
    log(`${relative(ROOT, archive)} ${(statSync(archive).size / 1e6).toFixed(1)} MB, ${version}`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(`bundle: ${e.message}`);
  process.exit(1);
});
