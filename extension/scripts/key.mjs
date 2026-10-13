#!/usr/bin/env node
/**
 * The extension's signing key, which fixes its id. Makes an RSA-2048 key at
 * ~/.config/autotrack/extension-key.pem (0600, never in git) when none exists, writes the public
 * half into manifest.json `key`, and prints the id. `--check` only prints.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionId } from "../../host/manifests.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(here, "..", "manifest.json");
const keyPath =
  process.env.AUTOTRACK_KEY || join(homedir(), ".config", "autotrack", "extension-key.pem");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (process.argv.includes("--check")) {
  console.log(manifest.key ? extensionId(manifest.key) : "no key in manifest.json");
  process.exit(0);
}

let pem;
if (existsSync(keyPath)) pem = readFileSync(keyPath, "utf8");
else {
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
  pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    type: "pkcs8",
    format: "pem",
  });
  writeFileSync(keyPath, pem, { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  console.log(`new key: ${keyPath}`);
}
const der = createPublicKey(createPrivateKey(pem)).export({ type: "spki", format: "der" });
const key = der.toString("base64");
if (manifest.key !== key) {
  manifest.key = key;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log("manifest.json key updated");
}
console.log(extensionId(key));
