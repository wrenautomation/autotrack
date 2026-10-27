/**
 * Shipping closed segments off the laptop, to the layout autobrowse `src/autotrack/store.ts` reads:
 *
 *   <device>/<session>/session.json            (put again whenever it changes, e.g. endedAt)
 *   <device>/<session>/<segment>/files.bin     (the segment's images, trees and OCR, end to end)
 *   <device>/<session>/<segment>/files.json    (where each one sits in files.bin; see `FilesIndex`)
 *   <device>/<session>/<segment>/stats.json    (the segment's integrity stats)
 *   <device>/<session>/<segment>/events.jsonl.gz (put last: the segment counts once it lands)
 *
 * Inside files.bin, names keep the layout segments had before 0.4.0, when each was its own object
 * (S3 bills per put: ~300 a segment came to ~40k puts a day): `frames/<n>.jpg`, `crops/<n>.jpg`,
 * `trees/<n>.json.gz` (`.txt.gz` for a web snapshot), `ocr/<n>.json.gz` (`c<n>.json.gz` of crop n).
 *
 * A segment is taken only once `.done` is in it, and deleted locally after its events land. A
 * failed put stops the pass (most often: offline) and the whole segment goes again next pass,
 * which waits 5, 10, 20, … 60 minutes. Past `maxLocalGb` the oldest frames and crops are deleted,
 * never events. The secret is only ever used to sign; nothing here logs a header.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { Config, TrackCode } from "./config.ts";
import { finishSegment, readStats } from "./journal.ts";
import { holdUploads } from "./metered.ts";
import { sha256Hex, sign } from "./sigv4.ts";

export interface ShipResult {
  put: number; // segments shipped and deleted locally
  failed: number; // closed segments that stay for the next pass
  objects?: number; // objects put
  bytes?: number; // bytes put
  dropped?: number; // frames deleted locally to stay under maxLocalGb
  skipped?: "no code" | "backoff" | "busy" | "metered";
  /** Why the pass stopped short. */
  error?: string;
}

/** `files.json`: each file of `files.bin` by name, at byte `at`, `size` bytes long. */
export interface FilesIndex {
  v: 1;
  files: { name: string; at: number; size: number }[];
}

export interface Shipper {
  /** One pass over closed (`.done`) segments under `sessionsDir`. Never throws. */
  ship(sessionsDir: string): Promise<ShipResult>;
}

export const noShipper: Shipper = {
  ship: async () => ({ put: 0, failed: 0 }),
};

/** Where objects go. `put` throws a PutError when the object did not land. */
export interface ObjectStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
}

export class PutError extends Error {
  readonly status: number | null; // null: no answer (offline, timeout)
  constructor(message: string, status: number | null) {
    super(message);
    this.status = status;
  }
  /** Worth another try in this pass: no answer, throttled, or the server's fault. */
  get retry(): boolean {
    return this.status === null || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

const encodeKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");

/**
 * S3 PUTs signed with the device's write-only key. AWS by default (virtual-hosted, or path-style
 * for a bucket with dots); `endpoint` gives a path-style S3-compatible server instead (tests).
 */
export function s3Store(o: {
  code: TrackCode;
  endpoint?: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}): ObjectStore {
  const f = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const { bucket, region } = o.code;
  let skewMs = 0; // server time minus ours, learned from a RequestTimeTooSkewed answer
  const urlFor = (key: string) =>
    new URL(
      o.endpoint
        ? `${o.endpoint}/${bucket}/${encodeKey(key)}`
        : bucket.includes(".")
          ? `https://s3.${region}.amazonaws.com/${bucket}/${encodeKey(key)}`
          : `https://${bucket}.s3.${region}.amazonaws.com/${encodeKey(key)}`,
    );
  const once = async (key: string, body: Uint8Array, contentType: string) => {
    const url = urlFor(key);
    const hash = sha256Hex(body);
    const signed = sign({
      method: "PUT",
      url,
      headers: { "content-type": contentType, "x-amz-content-sha256": hash },
      payloadHash: hash,
      region,
      service: "s3",
      keyId: o.code.keyId,
      secret: o.code.secret,
      date: new Date(now() + skewMs),
    });
    let res: Response;
    try {
      res = await f(url, {
        method: "PUT",
        headers: signed.headers,
        body,
        signal: AbortSignal.timeout(o.timeoutMs ?? 120_000),
      });
    } catch (e) {
      throw new PutError(`PUT ${key}: ${(e as Error).message}`, null);
    }
    const text = await res.text().catch(() => "");
    if (res.ok) return null;
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? "";
    return { status: res.status, code, date: res.headers.get("date") };
  };
  return {
    async put(key, body, contentType) {
      let bad = await once(key, body, contentType);
      if (bad?.code === "RequestTimeTooSkewed" && bad.date) {
        skewMs = Date.parse(bad.date) - now();
        bad = await once(key, body, contentType);
      }
      if (bad) throw new PutError(`PUT ${key}: ${bad.status} ${bad.code}`.trim(), bad.status);
    },
  };
}

const isSegment = (name: string) => /^\d{3,}$/.test(name);
const frameNo = (name: string) => {
  const m = /^(\d+)\.jpg$/.exec(name);
  return m ? Number(m[1]) : null;
};
const dirs = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
    : [];
const framesIn = (segDir: string, sub = "frames") => {
  const dir = join(segDir, sub);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => ({ name, n: frameNo(name) }))
    .filter((x): x is { name: string; n: number } => x.n !== null)
    .sort((a, b) => a.n - b.n);
};

const treesIn = (segDir: string) => {
  const dir = join(segDir, "trees");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^\d+\.(json|txt)$/.test(name))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
};

const ocrIn = (segDir: string) => {
  const dir = join(segDir, "ocr");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^c?\d+\.json$/.test(name))
    .sort();
};

/**
 * Segments closed but still waiting for OCR (`stats.json`, no `.done`) get `.done` now, their
 * unread images counted as skipped: for `autotrack ship` and uninstall with no recorder running,
 * so nothing is stranded.
 */
export function finishWaiting(sessions: string): number {
  let n = 0;
  for (const s of dirs(sessions))
    for (const seg of dirs(join(sessions, s)).filter(isSegment)) {
      const sd = join(sessions, s, seg);
      if (existsSync(join(sd, ".done")) || !readStats(sd)) continue;
      finishSegment(sd);
      n++;
    }
  return n;
}

/** Bytes under a dir. */
export function dirBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += dirBytes(p);
    else if (e.isFile()) {
      try {
        total += statSync(p).size;
      } catch {}
    }
  }
  return total;
}

/** Closed segments waiting and open ones being written, over all sessions. */
export function countSegments(sessions: string): { open: number; closed: number } {
  let open = 0;
  let closed = 0;
  for (const s of dirs(sessions))
    for (const seg of dirs(join(sessions, s)).filter(isSegment))
      existsSync(join(sessions, s, seg, ".done")) ? closed++ : open++;
  return { open, closed };
}

/**
 * Delete the oldest frames and crops (session, then segment, then number) until the sessions dir
 * is under `maxBytes`. Events are never touched. Returns how many images went.
 */
export function capFrames(sessions: string, maxBytes: number): number {
  let total = dirBytes(sessions);
  if (total <= maxBytes) return 0;
  let dropped = 0;
  for (const s of dirs(sessions))
    for (const seg of dirs(join(sessions, s)).filter(isSegment))
      for (const [sub, { name }] of [
        ...framesIn(join(sessions, s, seg)).map((f) => ["frames", f] as const),
        ...framesIn(join(sessions, s, seg), "crops").map((f) => ["crops", f] as const),
      ]) {
        if (total <= maxBytes) return dropped;
        const p = join(sessions, s, seg, sub, name);
        try {
          const size = statSync(p).size;
          unlinkSync(p);
          total -= size;
          dropped++;
        } catch {}
      }
  return dropped;
}

/** A cross-process lock file holding a pid: the recorder's pass and `autotrack ship` never overlap. */
function takeLock(path: string): (() => void) | null {
  for (let i = 0; i < 2; i++) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx" });
      return () => {
        try {
          if (readFileSync(path, "utf8").trim() === String(process.pid)) unlinkSync(path);
        } catch {}
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return null;
      let pid = 0;
      try {
        pid = Number(readFileSync(path, "utf8").trim());
      } catch {}
      if (pid > 0 && pid !== process.pid && isAlive(pid)) return null;
      try {
        unlinkSync(path);
      } catch {}
    }
  }
  return null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface DirShipperOptions {
  /** null: no install code; only the local cap runs. */
  store: ObjectStore | null;
  device: string;
  maxLocalGb: number;
  /** Lock file shared with other processes on the same data dir. */
  lockPath?: string;
  log?: (msg: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Tries per object within a pass (default 3). */
  tries?: number;
  /** True while the network is metered: uploads wait, the local cap still runs (`metered.ts`). */
  held?: () => Promise<boolean>;
}

const BACKOFF_MS = 5 * 60_000;
const BACKOFF_MAX_MS = 60 * 60_000;
const SHIPPED = ".session-shipped"; // sha256 of the session.json last put

export class DirShipper implements Shipper {
  private failures = 0;
  private nextTry = 0;
  private readonly o: DirShipperOptions;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(o: DirShipperOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * `force` ignores the backoff (`autotrack ship`). `finish`: no recorder is running, so segments
   * waiting for OCR are finished first (see `finishWaiting`).
   */
  async ship(
    sessions: string,
    opts: { force?: boolean; finish?: boolean } = {},
  ): Promise<ShipResult> {
    const release = this.o.lockPath ? takeLock(this.o.lockPath) : () => {};
    if (!release) return { put: 0, failed: countSegments(sessions).closed, skipped: "busy" };
    try {
      if (opts.finish) finishWaiting(sessions);
      const r = await this.upload(sessions, opts.force ?? false);
      const dropped = capFrames(sessions, this.o.maxLocalGb * 1e9);
      if (dropped)
        this.o.log?.(`ship: over ${this.o.maxLocalGb} GB, deleted the ${dropped} oldest frame(s)`);
      return dropped ? { ...r, dropped } : r;
    } catch (e) {
      this.o.log?.(`ship: ${(e as Error).message}`);
      return { put: 0, failed: countSegments(sessions).closed, error: (e as Error).message };
    } finally {
      release();
    }
  }

  private async upload(sessions: string, force: boolean): Promise<ShipResult> {
    const result: ShipResult = { put: 0, failed: 0, objects: 0, bytes: 0 };
    const store = this.o.store;
    if (!store) return { ...result, failed: countSegments(sessions).closed, skipped: "no code" };
    if (!force && (await this.o.held?.())) {
      // Failures on the hotspot say nothing about wifi: the first pass there ships at once.
      this.failures = 0;
      this.nextTry = 0;
      return { ...result, failed: countSegments(sessions).closed, skipped: "metered" };
    }
    if (!force && this.now() < this.nextTry)
      return { ...result, failed: countSegments(sessions).closed, skipped: "backoff" };
    const put = async (key: string, body: Uint8Array, type: string) => {
      const tries = this.o.tries ?? 3;
      for (let i = 1; ; i++) {
        try {
          await store.put(`${this.o.device}/${key}`, body, type);
          result.objects = (result.objects ?? 0) + 1;
          result.bytes = (result.bytes ?? 0) + body.byteLength;
          return;
        } catch (e) {
          const retry = e instanceof PutError ? e.retry : true;
          if (!retry || i >= tries) throw e;
          await this.sleep(1000 * 4 ** (i - 1));
        }
      }
    };
    try {
      for (const s of dirs(sessions)) {
        const dir = join(sessions, s);
        await this.putMeta(dir, s, put);
        for (const seg of dirs(dir).filter(isSegment)) {
          const segDir = join(dir, seg);
          if (!existsSync(join(segDir, ".done"))) continue;
          await this.putSegment(segDir, `${s}/${seg}`, put);
          rmSync(segDir, { recursive: true, force: true });
          result.put++;
        }
        this.dropIfDone(dir);
      }
    } catch (e) {
      this.failures++;
      const wait = Math.min(BACKOFF_MS * 2 ** (this.failures - 1), BACKOFF_MAX_MS);
      this.nextTry = this.now() + wait;
      result.failed = countSegments(sessions).closed;
      result.error = (e as Error).message;
      this.o.log?.(
        `ship: ${(e as Error).message}; ${result.put} segment(s) shipped, ${result.failed} wait, next try in ${Math.round(wait / 60_000)} min`,
      );
      return result;
    }
    this.failures = 0;
    this.nextTry = 0;
    if (result.put) this.o.log?.(`ship: ${result.put} segment(s), ${result.objects} object(s)`);
    return result;
  }

  private async putMeta(
    dir: string,
    session: string,
    put: (key: string, body: Uint8Array, type: string) => Promise<void>,
  ): Promise<void> {
    const metaPath = join(dir, "session.json");
    if (!existsSync(metaPath)) return;
    const body = readFileSync(metaPath);
    const hash = createHash("sha256").update(body).digest("hex");
    const marker = join(dir, SHIPPED);
    if (existsSync(marker) && readFileSync(marker, "utf8").trim() === hash) return;
    await put(`${session}/session.json`, body, "application/json");
    writeFileSync(marker, hash);
  }

  private async putSegment(
    segDir: string,
    prefix: string,
    put: (key: string, body: Uint8Array, type: string) => Promise<void>,
  ): Promise<void> {
    const files: { path: string; name: string; gzip: boolean }[] = [
      ...framesIn(segDir).map((f) => ({
        path: join(segDir, "frames", f.name),
        name: `frames/${f.n}.jpg`,
        gzip: false,
      })),
      ...framesIn(segDir, "crops").map((f) => ({
        path: join(segDir, "crops", f.name),
        name: `crops/${f.n}.jpg`,
        gzip: false,
      })),
      ...treesIn(segDir).map((name) => ({
        path: join(segDir, "trees", name),
        name: `trees/${name}.gz`,
        gzip: true,
      })),
      ...ocrIn(segDir).map((name) => ({
        path: join(segDir, "ocr", name),
        name: `ocr/${name}.gz`,
        gzip: true,
      })),
    ];
    if (files.length) {
      const index: FilesIndex = { v: 1, files: [] };
      const bodies: Buffer[] = [];
      let at = 0;
      for (const f of files) {
        const raw = readFileSync(f.path);
        const body = f.gzip ? gzipSync(raw) : raw;
        index.files.push({ name: f.name, at, size: body.byteLength });
        bodies.push(body);
        at += body.byteLength;
      }
      await put(`${prefix}/files.bin`, Buffer.concat(bodies), "application/octet-stream");
      await put(`${prefix}/files.json`, Buffer.from(JSON.stringify(index)), "application/json");
    }
    const stats = join(segDir, "stats.json");
    if (existsSync(stats))
      await put(`${prefix}/stats.json`, readFileSync(stats), "application/json");
    const ev = join(segDir, "events.jsonl");
    const events = existsSync(ev) ? readFileSync(ev) : Buffer.alloc(0);
    await put(`${prefix}/events.jsonl.gz`, gzipSync(events), "application/gzip");
  }

  /** An ended session with every segment gone and its final session.json shipped. */
  private dropIfDone(dir: string): void {
    if (dirs(dir).some(isSegment)) return;
    const metaPath = join(dir, "session.json");
    if (!existsSync(metaPath)) return;
    try {
      const body = readFileSync(metaPath);
      const meta = JSON.parse(body.toString("utf8")) as { endedAt?: string | null };
      if (!meta.endedAt) return;
      const hash = createHash("sha256").update(body).digest("hex");
      if (readFileSync(join(dir, SHIPPED), "utf8").trim() !== hash) return;
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

/** The shipper for a data dir's config: S3 when the install code is in, else only the cap. */
export function shipperFor(
  data: string,
  config: Config,
  log?: (msg: string) => void,
  held: () => Promise<boolean> = () => holdUploads(),
): DirShipper {
  return new DirShipper({
    store: config.ship
      ? s3Store({ code: config.ship, ...(config.endpoint ? { endpoint: config.endpoint } : {}) })
      : null,
    device: config.ship?.device ?? config.device,
    maxLocalGb: config.maxLocalGb,
    lockPath: join(data, "ship.lock"),
    held,
    ...(log ? { log } : {}),
  });
}

/**
 * One small PUT to `<device>/doctor.txt` (not a session, so nothing reads it): proves the key,
 * the clock and the network before a segment needs them.
 */
export async function checkShip(
  config: Config,
  version: string,
): Promise<{ ok: boolean; message: string }> {
  if (!config.ship) return { ok: false, message: "no install code: nothing ships" };
  const store = s3Store({
    code: config.ship,
    timeoutMs: 20_000,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
  });
  const body = new TextEncoder().encode(
    `autotrack ${version} doctor ${new Date().toISOString()}\n`,
  );
  try {
    await store.put(`${config.ship.device}/doctor.txt`, body, "text/plain");
    return { ok: true, message: "test upload ok: the key, clock and network work" };
  } catch (e) {
    return { ok: false, message: `test upload failed: ${(e as Error).message}` };
  }
}
