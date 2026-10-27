/**
 * Registers the native messaging host with Chrome and Edge (and on Linux Chromium and Brave) for
 * this user (no admin). Opera and Opera GX read Chrome's dir and registry key, so they need none.
 *
 * Mac and Linux: a manifest JSON in each browser's per-user `NativeMessagingHosts/` dir, pointing at a
 * `/bin/sh` wrapper that runs the bundled node on autotrack-host.mjs (a browser started from the
 * Dock has no node on PATH). Windows: one manifest file plus `HKCU\Software\<browser>\
 * NativeMessagingHosts\com.wrenautomation.autotrack` whose default value is its path, set with
 * `reg add`; the manifest points at a `.cmd` wrapper, since Windows runs only executables.
 *
 * The wrapper and the Windows manifest live in `<data dir>/native-host/`. fs, the registry runner
 * and the targets are injectable for tests.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { dataDir } from "./control.mjs";

export const HOST = "com.wrenautomation.autotrack";

/**
 * Ids allowed to start the host. The first is the id our manifest.json `key` gives (unpacked
 * and Web Store, when uploaded with the same key; see extension/README.md). A store-assigned id
 * that differs goes here too.
 */
export const EXTENSION_IDS = ["colpoheiepckdglfmebejhelggjikjim"];

/** Chrome's id for a public key (base64 DER SPKI): sha256, first 16 bytes, hex digits 0-f → a-p. */
export function extensionId(publicKeyBase64) {
  const hex = createHash("sha256")
    .update(Buffer.from(publicKeyBase64, "base64"))
    .digest("hex")
    .slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join("");
}

const REG = {
  chrome: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST}`,
  edge: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST}`,
};

/**
 * Where each browser looks. Mac, Linux: `{browser, dir}` (manifest file goes in dir). Windows:
 * `{browser, regKey}`.
 */
export function targets(platform = process.platform, home = homedir()) {
  if (platform === "darwin") {
    const as = posix.join(home, "Library", "Application Support");
    return [
      { browser: "chrome", dir: posix.join(as, "Google", "Chrome", "NativeMessagingHosts") },
      { browser: "edge", dir: posix.join(as, "Microsoft Edge", "NativeMessagingHosts") },
    ];
  }
  if (platform === "win32")
    return [
      { browser: "chrome", regKey: REG.chrome },
      { browser: "edge", regKey: REG.edge },
    ];
  if (platform === "linux") {
    const config = posix.join(home, ".config");
    return [
      { browser: "chrome", dir: posix.join(config, "google-chrome", "NativeMessagingHosts") },
      { browser: "chromium", dir: posix.join(config, "chromium", "NativeMessagingHosts") },
      { browser: "edge", dir: posix.join(config, "microsoft-edge", "NativeMessagingHosts") },
      {
        browser: "brave",
        dir: posix.join(config, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"),
      },
    ];
  }
  throw new Error(`autotrack's browser host supports Mac, Windows and Linux, not ${platform}`);
}

/** The host manifest Chrome and Edge read. */
export function hostManifest(wrapper, ids = EXTENSION_IDS) {
  return {
    name: HOST,
    description: "autotrack: relays browser events to the local recorder",
    path: wrapper,
    type: "stdio",
    allowed_origins: ids.map((id) => `chrome-extension://${id}/`),
  };
}

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** The script the browser runs. */
export function wrapperScript(platform, nodePath, hostScript, control) {
  if (platform === "win32") {
    for (const s of [nodePath, hostScript, control ?? ""])
      if (/["%\r\n]/.test(s)) throw new Error(`path not usable in a .cmd file: ${s}`);
    const env = control ? `set "AUTOTRACK_CONTROL=${control}"\r\n` : "";
    return `@echo off\r\n${env}"${nodePath}" "${hostScript}" %*\r\n`;
  }
  const env = control ? `AUTOTRACK_CONTROL=${shQuote(control)} ` : "";
  return `#!/bin/sh\n${env}exec ${shQuote(nodePath)} ${shQuote(hostScript)} "$@"\n`;
}

function defaultRun(cmd, args) {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { windowsHide: true }, (err, stdout, stderr) =>
      err
        ? reject(new Error(`${cmd} ${args.join(" ")}: ${stderr || err.message}`))
        : resolve(stdout),
    ),
  );
}

function setup(o = {}) {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const join = platform === "win32" ? win32.join : posix.join;
  const home = o.home ?? homedir();
  const dir = o.dir ?? join(dataDir(env, platform, home), "native-host");
  return {
    platform,
    join,
    dir,
    fs: o.fs ?? fsp,
    run: o.run ?? defaultRun,
    targets: o.targets ?? targets(platform, home),
    ids: o.ids ?? EXTENSION_IDS,
    wrapper: join(dir, platform === "win32" ? "autotrack-host.cmd" : "autotrack-host.sh"),
  };
}

/**
 * Write the wrapper and manifests and register them. `control` pins the recorder socket in the
 * wrapper (tests); without it the host finds the recorder itself.
 * @param {{nodePath: string, hostScript: string, control?: string, platform?: string,
 *   env?: object, home?: string, dir?: string, fs?: object, run?: Function, targets?: object[],
 *   ids?: string[]}} o
 * @returns {Promise<{wrapper: string, manifests: string[], registry: string[]}>}
 */
export async function install(o) {
  if (!o?.nodePath || !o?.hostScript) throw new Error("install needs nodePath and hostScript");
  const s = setup(o);
  await s.fs.mkdir(s.dir, { recursive: true });
  await s.fs.writeFile(s.wrapper, wrapperScript(s.platform, o.nodePath, o.hostScript, o.control));
  if (s.platform !== "win32") await s.fs.chmod(s.wrapper, 0o755);
  const json = `${JSON.stringify(hostManifest(s.wrapper, s.ids), null, 2)}\n`;
  const manifests = [];
  const registry = [];
  if (s.platform === "win32") {
    const file = s.join(s.dir, `${HOST}.json`);
    await s.fs.writeFile(file, json);
    manifests.push(file);
    for (const t of s.targets) {
      if (t.dir) {
        const f = s.join(t.dir, `${HOST}.json`);
        await s.fs.mkdir(t.dir, { recursive: true });
        await s.fs.writeFile(f, json);
        manifests.push(f);
        continue;
      }
      await s.run("reg", ["add", t.regKey, "/ve", "/t", "REG_SZ", "/d", file, "/f"]);
      registry.push(t.regKey);
    }
  } else
    for (const t of s.targets) {
      const f = s.join(t.dir, `${HOST}.json`);
      await s.fs.mkdir(t.dir, { recursive: true });
      await s.fs.writeFile(f, json);
      manifests.push(f);
    }
  return { wrapper: s.wrapper, manifests, registry };
}

/** Remove what install wrote. Missing pieces are fine. */
export async function uninstall(o = {}) {
  const s = setup(o);
  const rm = (p) => s.fs.rm(p, { force: true });
  for (const t of s.targets) {
    if (t.dir) await rm(s.join(t.dir, `${HOST}.json`));
    else
      try {
        await s.run("reg", ["delete", t.regKey, "/f"]);
      } catch {} // not there
  }
  if (s.platform === "win32") await rm(s.join(s.dir, `${HOST}.json`));
  await rm(s.wrapper);
}
