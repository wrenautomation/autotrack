#!/usr/bin/env node
/**
 * The part of install.sh and install.ps1 that is easier in Node, run with the bundle's own node:
 *
 *   node install/setup.mjs --check   checks $AUTOTRACK (the install code), prints the device
 *   node install/setup.mjs           writes config.json from it, registers the browser host
 *
 * Env: AUTOTRACK (required), AUTOTRACK_DIR (data dir), AUTOTRACK_ENDPOINT (S3-compatible
 * endpoint for tests; a reinstall without it drops any old one). The code never reaches argv,
 * logs or stdout.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkEndpoint, dataDir, decodeCode } from "../dist/config.js";
import { recorderPath } from "../host/control.mjs";
import { install as installHost } from "../host/manifests.mjs";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const fail = (msg) => {
  console.error(`autotrack install: ${msg}`);
  process.exit(2);
};

let code;
try {
  code = decodeCode(process.env.AUTOTRACK ?? "");
} catch (e) {
  fail(`AUTOTRACK: ${e.message}`);
}
const endpoint = process.env.AUTOTRACK_ENDPOINT;
if (endpoint && !checkEndpoint(endpoint)) fail(`AUTOTRACK_ENDPOINT not usable: ${endpoint}`);
if (process.argv.includes("--check")) {
  console.log(`install code ok: device ${code.device}, bucket ${code.bucket} (${code.region})`);
  process.exit(0);
}

const data = dataDir();
mkdirSync(data, { recursive: true });
const path = join(data, "config.json");
let cfg = {};
try {
  cfg = JSON.parse(readFileSync(path, "utf8"));
} catch {}
if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) cfg = {};
cfg.code = process.env.AUTOTRACK.trim();
if (endpoint) cfg.endpoint = endpoint;
else delete cfg.endpoint;
writeFileSync(`${path}.tmp`, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
renameSync(`${path}.tmp`, path);
console.log(`config ${path}`);

const host = await installHost({
  nodePath: process.execPath,
  hostScript: join(app, "host", "autotrack-host.mjs"),
  // A custom data dir: the browser starts the host without our env, so pin the socket.
  ...(process.env.AUTOTRACK_DIR ? { control: recorderPath() } : {}),
});
for (const m of host.manifests) console.log(`browser host ${m}`);
for (const k of host.registry) console.log(`browser host ${k}`);
