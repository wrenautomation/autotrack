#!/usr/bin/env node
/**
 * Writes `release.json` ({version, files: {asset: sha256}}) and `release.json.sig` (Ed25519,
 * base64) into a release folder. The recorder's updater trusts nothing else (src/update.ts).
 *
 *   AUTOTRACK_SIGNING_KEY=<PKCS8 PEM, or its DER in base64> node scripts/sign-release.mjs <dir> <version>
 *
 * Signs every `autotrack-*.zip|.tar.gz` bundle in <dir>; the installers aren't update assets.
 */
import { createHash, createPrivateKey, sign } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, version] = process.argv.slice(2);
const raw = process.env.AUTOTRACK_SIGNING_KEY?.trim();
if (!dir || !version || !raw) {
  console.error("usage: AUTOTRACK_SIGNING_KEY=... sign-release.mjs <dir> <version>");
  process.exit(2);
}
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`not a version: ${version}`);
  process.exit(2);
}
const key = raw.startsWith("-----")
  ? createPrivateKey(raw)
  : createPrivateKey({ key: Buffer.from(raw, "base64"), format: "der", type: "pkcs8" });
const files = {};
for (const name of readdirSync(dir).sort())
  if (/^autotrack-.+\.(zip|tar\.gz)$/.test(name))
    files[name] = createHash("sha256")
      .update(readFileSync(join(dir, name)))
      .digest("hex");
if (!Object.keys(files).length) {
  console.error(`no bundles in ${dir}`);
  process.exit(1);
}
const body = Buffer.from(`${JSON.stringify({ version, files }, null, 2)}\n`);
writeFileSync(join(dir, "release.json"), body);
writeFileSync(join(dir, "release.json.sig"), `${sign(null, body, key).toString("base64")}\n`);
console.log(`release.json: ${version}, ${Object.keys(files).join(", ")}`);
