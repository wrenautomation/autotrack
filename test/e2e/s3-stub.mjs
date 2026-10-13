#!/usr/bin/env node
/**
 * A tiny S3 stand-in for tests: path-style PUT /<bucket>/<key>, SigV4 checked the way S3 does
 * (own code, not src/sigv4.ts, so a signing bug can't hide behind its twin), the body's sha256
 * checked, and an IAM-like rule that a key may only write under its device prefix. Objects land
 * in <root>/<bucket>/<key>.
 *
 *   node test/e2e/s3-stub.mjs --root <dir> --key-id <id> --secret <secret> --prefix <device>/
 *        [--port 0] [--port-file <file>]
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const hex = (data) => createHash("sha256").update(data).digest("hex");
const mac = (key, data) => createHmac("sha256", key).update(data).digest();
const enc = (s) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

function xml(res, status, code, message) {
  res.writeHead(status, { "content-type": "application/xml", date: new Date().toUTCString() });
  res.end(
    `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`,
  );
}

/** Check one request; returns null when it is good, else [status, code, message]. */
export function verify(req, body, o) {
  const auth = req.headers.authorization ?? "";
  const m =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, ?SignedHeaders=([a-z0-9;-]+), ?Signature=([0-9a-f]{64})$/.exec(
      auth,
    );
  if (!m) return [403, "AccessDenied", "no SigV4 authorization"];
  const [, keyId, day, region, signedHeaders, signature] = m;
  if (keyId !== o.keyId) return [403, "InvalidAccessKeyId", "unknown key"];
  const date = req.headers["x-amz-date"] ?? "";
  const when = Date.parse(
    date.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"),
  );
  if (!date.startsWith(day) || Number.isNaN(when)) return [403, "AccessDenied", "bad x-amz-date"];
  if (Math.abs(when - (o.now?.() ?? Date.now())) > 15 * 60_000)
    return [403, "RequestTimeTooSkewed", "clock skew"];
  const names = signedHeaders.split(";");
  for (const need of ["host", "x-amz-date", "x-amz-content-sha256"])
    if (!names.includes(need)) return [403, "AccessDenied", `${need} not signed`];
  const claimed = req.headers["x-amz-content-sha256"];
  if (claimed !== hex(body)) return [400, "XAmzContentSHA256Mismatch", "body hash"];
  const url = new URL(req.url, "http://stub");
  const query = [...url.searchParams]
    .map(([k, v]) => [enc(k), enc(v)])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const headers = names
    .map(
      (n) =>
        `${n}:${String(req.headers[n] ?? "")
          .trim()
          .replace(/\s+/g, " ")}\n`,
    )
    .join("");
  const canonical = ["PUT", url.pathname, query, headers, signedHeaders, claimed].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${hex(canonical)}`;
  const key = mac(mac(mac(mac(`AWS4${o.secret}`, day), region), "s3"), "aws4_request");
  const want = createHmac("sha256", key).update(toSign).digest();
  if (!timingSafeEqual(want, Buffer.from(signature, "hex")))
    return [403, "SignatureDoesNotMatch", "signature"];
  return null;
}

/**
 * @param {{root: string, keyId: string, secret: string, prefix?: string, port?: number,
 *   now?: () => number, log?: (msg: string) => void}} o
 */
export async function startStub(o) {
  const root = resolve(o.root);
  const puts = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (req.method !== "PUT") return xml(res, 405, "MethodNotAllowed", req.method ?? "");
      const bad = verify(req, body, o);
      const path = decodeURIComponent(new URL(req.url, "http://stub").pathname).slice(1);
      const [bucket, ...rest] = path.split("/");
      const key = rest.join("/");
      if (!bad && (!bucket || !key)) return xml(res, 400, "InvalidRequest", "path-style only");
      if (!bad && o.prefix && !key.startsWith(o.prefix))
        return xml(res, 403, "AccessDenied", "outside the device prefix");
      const file = join(root, bucket ?? "", key);
      if (!bad && !file.startsWith(root + sep)) return xml(res, 400, "InvalidRequest", "path");
      o.log?.(`${bad ? bad[0] : 200} PUT ${path} ${body.length} B`);
      if (bad) return xml(res, ...bad);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, body);
      puts.push({ bucket, key, size: body.length, type: req.headers["content-type"] ?? "" });
      res.writeHead(200, { etag: `"${createHash("md5").update(body).digest("hex")}"` });
      res.end();
    });
  });
  await new Promise((r) => server.listen(o.port ?? 0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    puts,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : dflt;
  };
  const stub = await startStub({
    root: arg("root", "s3-stub-data"),
    keyId: arg("key-id"),
    secret: arg("secret"),
    prefix: arg("prefix"),
    port: Number(arg("port", "0")),
    log: (m) => console.log(m),
  });
  const portFile = arg("port-file");
  if (portFile) writeFileSync(portFile, String(stub.port));
  console.log(`s3 stub on ${stub.url}`);
}
