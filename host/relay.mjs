/**
 * The host's work: framed messages from the extension in, one control line per event out to the
 * recorder (`{"op":"web","event":…}`), recorder state back to the extension as
 * `{"op":"state","paused":bool,"recorder":bool}` whenever it changes.
 *
 * The recorder answers each line in order: `{"ok":true,"result":{"written":true}}`, or
 * `{"written":false,"reason":<pause reason>}` while paused. A `status` line every 5 s (and on
 * connect) says whether it is paused, so the extension learns of a resume while it sends nothing.
 * No recorder listening: events are dropped (the recorder is the only writer) and a reconnect is
 * tried at the next event or tick, at most once a second.
 */
import { Decoder, encode } from "./framing.mjs";

export const MAX_LINE = 256 * 1024; // src/control.ts MAX_LINE: the recorder closes a connection on a longer line
const PENDING_MAX = 200;

/**
 * @param {{input: NodeJS.ReadableStream, output: NodeJS.WritableStream, path: string|null,
 *   connect: (path: string) => import("node:net").Socket, statusMs?: number,
 *   log?: (m: string) => void, onEnd?: () => void}} o
 */
export function relay(o) {
  const log = o.log ?? ((m) => process.stderr.write(`autotrack-host: ${m}\n`));
  const statusMs = o.statusMs ?? 5000;
  /** @type {import("node:net").Socket|null} */
  let sock = null;
  let up = false;
  let lastTry = 0;
  /** @type {string[]} */
  let pending = [];
  /** @type {("web"|"status")[]} */
  let expect = [];
  let replyBuf = "";
  /** @type {{paused:boolean, recorder:boolean}|null} */
  let sent = null;
  const state = { paused: false, recorder: false };
  const stats = { relayed: 0, dropped: 0 };

  function tell() {
    if (sent && sent.paused === state.paused && sent.recorder === state.recorder) return;
    sent = { ...state };
    o.output.write(encode({ op: "state", ...state }));
  }

  function connect() {
    if (sock || !o.path || Date.now() - lastTry < 1000) return;
    lastTry = Date.now();
    const s = o.connect(o.path);
    sock = s;
    s.setEncoding("utf8");
    s.on("connect", () => {
      up = true;
      write(JSON.stringify({ op: "status" }), "status");
      for (const line of pending) write(line, "web");
      pending = [];
    });
    s.on("data", (chunk) => {
      replyBuf += chunk;
      let nl = replyBuf.indexOf("\n");
      while (nl >= 0) {
        reply(replyBuf.slice(0, nl));
        replyBuf = replyBuf.slice(nl + 1);
        nl = replyBuf.indexOf("\n");
      }
    });
    s.on("error", () => {});
    s.on("close", () => {
      if (sock !== s) return;
      sock = null;
      up = false;
      stats.dropped += pending.length;
      pending = [];
      expect = [];
      replyBuf = "";
      state.recorder = false;
      tell();
    });
  }

  /** @param {string} line @param {"web"|"status"} kind */
  function write(line, kind) {
    expect.push(kind);
    sock?.write(`${line}\n`);
  }

  /** @param {string} line */
  function reply(line) {
    const kind = expect.shift();
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      return;
    }
    if (!r?.ok) {
      if (r?.error) log(`recorder refused: ${r.error}`);
      return;
    }
    const res = r.result ?? {};
    state.recorder = true;
    if (kind === "status") state.paused = !!res.paused;
    else if (res.written === true) state.paused = false;
    else if (res.written === false) {
      if (res.reason === "stopped") state.recorder = false;
      else state.paused = true;
    }
    tell();
  }

  /** @param {unknown} ev */
  function relayEvent(ev) {
    if (!ev || typeof ev !== "object" || Array.isArray(ev)) return;
    const kind = /** @type {any} */ (ev).kind;
    if (kind !== "web" && kind !== "app") return;
    const line = JSON.stringify({ op: "web", event: ev });
    if (Buffer.byteLength(line) >= MAX_LINE) {
      stats.dropped++;
      return;
    }
    if (up) {
      write(line, "web");
      stats.relayed++;
    } else {
      connect();
      if (sock && pending.length < PENDING_MAX) pending.push(line);
      else stats.dropped++;
    }
  }

  const decoder = new Decoder(
    (msg) => {
      const events = Array.isArray(msg?.events) ? msg.events : [msg];
      for (const ev of events) relayEvent(ev);
    },
    (e) => log(e.message),
  );
  o.input.on("data", (c) => decoder.push(c));
  o.input.on("end", () => {
    clearInterval(tick);
    sock?.end();
    o.onEnd?.();
  });

  const tick = setInterval(() => {
    if (up) write(JSON.stringify({ op: "status" }), "status");
    else connect();
  }, statusMs);
  tick.unref?.();

  if (o.path) connect();
  else tell(); // recorder:false, so the extension stops sending

  return { state, stats };
}
