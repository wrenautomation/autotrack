// @ts-check
/**
 * The native messaging link to host `com.wrenautomation.autotrack`. Batches events (≤ 50 per
 * message, every 200 ms), reconnects with backoff (1 s doubling to 60 s), and drops instead of
 * queueing when nothing would record them:
 *
 * - host not installed (or this extension id not allowed): one console warning, events dropped,
 *   a new try after 5 minutes, only when an event arrives (no timers keep the worker up);
 * - the host says `{op:"state", paused:true}` or `recorder:false`: events dropped until a state
 *   says otherwise.
 *
 * Connect, timers and the warning are injected so tests drive it without Chrome.
 */

export const HOST = "com.wrenautomation.autotrack";
const MISSING = /not found|forbidden|not allowed|no such native/i;

/**
 * @typedef {{postMessage(m: any): void, disconnect(): void,
 *   onMessage: {addListener(f: (m: any) => void): void},
 *   onDisconnect: {addListener(f: () => void): void}}} Port
 */

export class Native {
  /**
   * @param {{connect: () => Port, lastError: () => string|undefined, now?: () => number,
   *   setTimeout?: typeof setTimeout, clearTimeout?: typeof clearTimeout, warn?: (m: string) => void,
   *   max?: number, batch?: number, flushMs?: number}} o
   */
  constructor(o) {
    this.o = o;
    this.now = o.now || Date.now;
    // Wrapped: a bare `this.setTimeout(...)` call throws "Illegal invocation" in a browser.
    this.setTimeout = o.setTimeout || ((f, ms) => setTimeout(f, ms));
    this.clearTimeout = o.clearTimeout || ((t) => clearTimeout(t));
    this.warn = o.warn || ((m) => console.warn(m));
    this.max = o.max ?? 500;
    this.batch = o.batch ?? 50;
    this.flushMs = o.flushMs ?? 200;
    /** @type {Port|null} */
    this.port = null;
    /** @type {any[]} */
    this.queue = [];
    this.paused = false;
    this.recorder = true;
    this.missing = false;
    this.warned = false;
    this.backoff = 0;
    this.nextTry = 0;
    /** @type {any} */
    this.timer = null;
    this.sent = 0;
    this.dropped = 0;
  }

  /** Sending would reach a recorder. */
  get active() {
    return !this.paused && this.recorder && !this.missing;
  }

  /** @param {Record<string, any>} ev */
  push(ev) {
    if (!this.port) this.tryConnect();
    if (!this.active) {
      this.dropped++;
      return;
    }
    // The recorder refuses control lines over 256 KB.
    if (JSON.stringify(ev).length > 250_000) {
      this.dropped++;
      return;
    }
    this.queue.push(ev);
    if (this.queue.length > this.max) {
      this.queue.shift();
      this.dropped++;
    }
    this.schedule();
  }

  schedule() {
    if (this.timer || !this.port) return;
    this.timer = this.setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.flushMs);
  }

  flush() {
    while (this.port && this.active && this.queue.length) {
      const events = this.queue.splice(0, this.batch);
      try {
        this.port.postMessage({ events });
        this.sent += events.length;
      } catch {
        this.queue.unshift(...events);
        this.closed();
        return;
      }
    }
  }

  tryConnect() {
    if (this.port || this.now() < this.nextTry) return;
    let port;
    try {
      port = this.o.connect();
    } catch (e) {
      this.failed(String(/** @type {any} */ (e)?.message || e));
      return;
    }
    this.port = port;
    port.onMessage.addListener((m) => this.message(m));
    port.onDisconnect.addListener(() => this.closed(this.o.lastError()));
    this.schedule();
  }

  /** @param {any} m */
  message(m) {
    if (m?.op !== "state") return;
    this.missing = false;
    this.backoff = 0;
    this.paused = m.paused === true;
    this.recorder = m.recorder !== false;
    if (!this.active) this.queue.length = 0;
    else this.schedule();
  }

  /** @param {string} [error] */
  closed(error) {
    if (this.timer) this.clearTimeout(this.timer);
    this.timer = null;
    this.port = null;
    this.failed(error || "native host disconnected");
  }

  /** @param {string} error */
  failed(error) {
    if (MISSING.test(error)) {
      this.missing = true;
      this.queue.length = 0;
      this.nextTry = this.now() + 5 * 60_000;
      if (!this.warned) {
        this.warned = true;
        this.warn(`autotrack: native host ${HOST} unavailable (${error}); events dropped`);
      }
      return;
    }
    this.backoff = Math.min(60_000, this.backoff ? this.backoff * 2 : 1000);
    this.nextTry = this.now() + this.backoff;
    // Queued events shouldn't wait for the next act to retry.
    if (this.queue.length) this.setTimeout(() => this.tryConnect(), this.backoff);
  }
}
