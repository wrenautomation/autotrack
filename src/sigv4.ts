/**
 * AWS Signature Version 4 for one request, with node:crypto only (no AWS SDK in the bundle).
 * S3 rules: the path is encoded once per segment and never normalized. Tested against AWS's
 * published vectors in sigv4.test.ts.
 */
import { createHash, createHmac } from "node:crypto";

export interface SignInput {
  method: string;
  url: URL;
  /** Headers to sign besides host (added from the URL). Names in any case. */
  headers: Record<string, string>;
  /** Hex SHA-256 of the body, or "UNSIGNED-PAYLOAD". */
  payloadHash: string;
  region: string;
  service: string;
  keyId: string;
  secret: string;
  date: Date;
}

export interface Signed {
  /** Headers to send: the input headers plus x-amz-date and authorization. */
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
}

export const sha256Hex = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

const hmac = (key: string | Buffer, data: string) =>
  createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding as SigV4 wants it: everything but A-Z a-z 0-9 - _ . ~ */
export const uriEncode = (s: string) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** `20150830T123600Z` */
export const amzDate = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

function canonicalPath(pathname: string): string {
  // The URL keeps its own %-escapes; decode each segment, then encode it the SigV4 way.
  return pathname
    .split("/")
    .map((seg) => uriEncode(decodeURIComponent(seg)))
    .join("/");
}

function canonicalQuery(url: URL): string {
  const pairs = [...url.searchParams].map(([k, v]) => [uriEncode(k), uriEncode(v)] as const);
  pairs.sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

export function sign(i: SignInput): Signed {
  const when = amzDate(i.date);
  const day = when.slice(0, 8);
  const all: Record<string, string> = { ...i.headers, "x-amz-date": when };
  const lower = new Map<string, string>([["host", i.url.host]]);
  for (const [k, v] of Object.entries(all))
    lower.set(k.toLowerCase(), v.trim().replace(/\s+/g, " "));
  const names = [...lower.keys()].sort();
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    i.method.toUpperCase(),
    canonicalPath(i.url.pathname || "/"),
    canonicalQuery(i.url),
    names.map((n) => `${n}:${lower.get(n)}\n`).join(""),
    signedHeaders,
    i.payloadHash,
  ].join("\n");
  const scope = `${day}/${i.region}/${i.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", when, scope, sha256Hex(canonicalRequest)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${i.secret}`, day), i.region), i.service), "aws4_request");
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex");
  return {
    headers: {
      ...all,
      authorization: `AWS4-HMAC-SHA256 Credential=${i.keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    canonicalRequest,
    stringToSign,
  };
}
