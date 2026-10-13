// @ts-check
/**
 * Isolated side of the page-world channel (see main.js). Picks a random nonce and hands it to
 * main.js in a one-shot handshake at document_start, before page scripts exist:
 *
 *   isolated → "autotrack:hello-iso" {detail: nonce}; main.js answers "autotrack:ack" inside
 *   that same synchronous dispatch. No ack (main.js not loaded yet) → wait for main.js's
 *   "autotrack:hello-main" once, then send the nonce again. Either way no listener stays open.
 *
 * Then `react(el)` asks for the component chain of an element: a query event on the element, the
 * reply read synchronously. The reply is untrusted page-world data: a list of short strings or
 * nothing.
 *
 * Errors come the other way: main.js dispatches `autotrack-e-<nonce>` on the document with
 * `{source, message}` as a JSON string; `onError(fn)` hands each valid one to `fn`. Also untrusted
 * data: the source must be one of three words and the message is cut to 200 chars.
 *
 * Classic script; sets `globalThis.__autotrack.bridge`.
 */
(() => {
  const AT = /** @type {any} */ (globalThis).__autotrack;

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const nonce = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const Q = `autotrack-q-${nonce}`;
  const R = `autotrack-r-${nonce}`;
  const E = `autotrack-e-${nonce}`;

  /** @type {string|null} */
  let reply = null;
  document.addEventListener(
    R,
    (e) => {
      const d = /** @type {CustomEvent} */ (e).detail;
      reply = typeof d === "string" ? d : null;
    },
    true,
  );

  const hello = () =>
    document.dispatchEvent(new CustomEvent("autotrack:hello-iso", { detail: nonce }));
  let acked = false;
  const onAck = () => {
    acked = true;
  };
  document.addEventListener("autotrack:ack", onAck, true);
  hello();
  document.removeEventListener("autotrack:ack", onAck, true);
  if (!acked) {
    const onMain = () => {
      document.removeEventListener("autotrack:hello-main", onMain, true);
      hello();
    };
    document.addEventListener("autotrack:hello-main", onMain, true);
  }

  /**
   * React component names for an element, nearest first, ≤ 12; null when the page world gave
   * no answer.
   * @param {Element} el
   * @returns {string[]|null}
   */
  function react(el) {
    reply = null;
    try {
      el.dispatchEvent(new CustomEvent(Q, { bubbles: true, composed: true }));
    } catch {
      return null;
    }
    const raw = reply;
    reply = null;
    if (!raw || raw.length > 4096) return null;
    try {
      const v = JSON.parse(raw);
      if (!Array.isArray(v)) return null;
      return v
        .filter((s) => typeof s === "string" && s)
        .slice(0, 12)
        .map((s) => s.slice(0, 80));
    } catch {
      return null;
    }
  }

  const SOURCES = new Set(["console", "uncaught", "rejection"]);
  /** @type {((e: {source: string, message: string}) => void)[]} */
  const errorHandlers = [];
  document.addEventListener(
    E,
    (e) => {
      const d = /** @type {CustomEvent} */ (e).detail;
      if (typeof d !== "string" || d.length > 1024 || !errorHandlers.length) return;
      try {
        const v = JSON.parse(d);
        if (!v || typeof v.message !== "string" || !SOURCES.has(v.source)) return;
        const err = { source: v.source, message: v.message.slice(0, 200) };
        for (const f of errorHandlers) f(err);
      } catch {}
    },
    true,
  );

  /** @param {(e: {source: string, message: string}) => void} fn */
  function onError(fn) {
    errorHandlers.push(fn);
  }

  AT.bridge = { react, onError };
})();
