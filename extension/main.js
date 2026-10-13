// @ts-check
/**
 * Page-world helper (content script with "world": "MAIN"). The isolated world can't see expando
 * properties page JS sets on nodes, so React's fiber keys (`__reactFiber$…`) are only readable
 * here, and neither can it hear the page's own console. This script does two things: answer
 * "which React components rendered this element?", and report the page's errors.
 *
 * Channel: at document_start, before any page script runs, the isolated script hands over a
 * random nonce through a one-shot handshake (see content/bridge.js). Queries then arrive as a
 * CustomEvent named `autotrack-q-<nonce>` dispatched on the element itself; the answer goes back
 * as `autotrack-r-<nonce>` on the document, synchronously. A page that never saw the nonce can't
 * hear queries or answer them, and it can never put an event into the stream: the isolated world
 * only records trusted input events. Built-ins are captured before page code can patch them.
 *
 * Errors: `console.error` calls, uncaught errors and unhandled rejections go out as
 * `autotrack-e-<nonce>` events on the document, `{source, message}` as a JSON string (message ≤
 * 200 chars, at most 10 a second). The isolated script keeps them only while an effect window is
 * open. Only `console.error` is wrapped; it still calls the original.
 *
 * Nothing global is left behind except the wrapped `console.error`.
 */
(() => {
  const doc = document;
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const stop = Event.prototype.stopImmediatePropagation;
  const path = Event.prototype.composedPath;
  const Custom = CustomEvent;
  const keys = Object.keys;
  const stringify = JSON.stringify;
  const isArray = Array.isArray;
  const apply = Reflect.apply;
  const defineProperty = Object.defineProperty;
  const now = Date.now;

  const MAX_NAMES = 12;
  const MAX_FIBERS = 400;
  const MAX_UP = 50;
  const MSG_MAX = 200;
  const ERRORS_PER_SECOND = 10;

  /** @param {any} type @returns {string} */
  function nameOf(type) {
    if (!type || typeof type === "string") return "";
    if (typeof type === "function") return String(type.displayName || type.name || "");
    if (typeof type === "object") {
      if (typeof type.displayName === "string" && type.displayName) return type.displayName;
      if (type.render) return nameOf(type.render); // forwardRef
      if (type.type) return nameOf(type.type); // memo
    }
    return "";
  }

  /** The fiber on this node or its nearest ancestor that has one. @param {any} node */
  function fiberOf(node) {
    for (let n = node, up = 0; n && up < MAX_UP; n = n.parentNode || n.host, up++) {
      let ks;
      try {
        ks = keys(n);
      } catch {
        return null;
      }
      for (const k of ks)
        if (k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")) return n[k];
    }
    return null;
  }

  /** Component names from the element's fiber up through `return`, nearest first. @param {any} el */
  function reactChain(el) {
    /** @type {string[]} */
    const out = [];
    let f = fiberOf(el);
    for (let i = 0; f && i < MAX_FIBERS && out.length < MAX_NAMES; i++, f = f.return) {
      const n = nameOf(f.type || f.elementType).slice(0, 80);
      if (n && out[out.length - 1] !== n) out.push(n);
    }
    return out;
  }

  /** One short line for a thrown or logged value, without running page code beyond property reads. @param {any} v */
  function describe(v) {
    try {
      if (typeof v === "string") return v.slice(0, MSG_MAX);
      if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint")
        return String(v);
      if (v && typeof v === "object" && typeof v.message === "string")
        return `${typeof v.name === "string" ? v.name : "Error"}: ${v.message}`.slice(0, MSG_MAX);
      if (typeof v === "function") return "[function]";
      if (v && typeof v === "object") return "[object]";
    } catch {}
    return "";
  }

  /** @param {string} nonce */
  function reportErrors(nonce) {
    const E = `autotrack-e-${nonce}`;
    let windowStart = 0;
    let count = 0;
    /** @param {string} source @param {string} message */
    const report = (source, message) => {
      const t = now();
      if (t - windowStart >= 1000) {
        windowStart = t;
        count = 0;
      }
      if (!message || ++count > ERRORS_PER_SECOND) return;
      dispatch.call(
        doc,
        new Custom(E, { detail: stringify({ source, message: message.slice(0, MSG_MAX) }) }),
      );
    };
    const con = console;
    const original = con.error;
    if (typeof original === "function") {
      /** @this {any} @param {any[]} args */
      const wrapped = function error(...args) {
        try {
          report("console", args.slice(0, 4).map(describe).filter(Boolean).join(" "));
        } catch {}
        return apply(original, this, args);
      };
      try {
        defineProperty(wrapped, "name", { value: "error" });
        con.error = wrapped;
      } catch {}
    }
    add.call(
      window,
      "error",
      (/** @type {any} */ e) => {
        // Resource load errors reach a capturing window listener too; their target is the element.
        if (e.target !== window) return;
        try {
          const text = describe(e.error) || (typeof e.message === "string" ? e.message : "");
          report("uncaught", text);
        } catch {}
      },
      true,
    );
    add.call(
      window,
      "unhandledrejection",
      (/** @type {any} */ e) => {
        try {
          report("rejection", describe(e.reason) || "unhandled rejection");
        } catch {}
      },
      true,
    );
  }

  /** @param {string} nonce */
  function serve(nonce) {
    reportErrors(nonce);
    const Q = `autotrack-q-${nonce}`;
    const R = `autotrack-r-${nonce}`;
    add.call(
      window,
      Q,
      (/** @type {Event} */ e) => {
        stop.call(e);
        let names = [];
        try {
          names = reactChain(path.call(e)[0] || e.target);
        } catch {}
        dispatch.call(doc, new Custom(R, { detail: stringify(isArray(names) ? names : []) }));
      },
      true,
    );
  }

  // Handshake. Whichever world runs second completes it synchronously; then no listener is left.
  let done = false;
  /** @param {Event} e */
  const onHello = (e) => {
    const nonce = /** @type {CustomEvent} */ (e).detail;
    if (done || typeof nonce !== "string" || !/^[0-9a-f]{32}$/.test(nonce)) return;
    done = true;
    remove.call(doc, "autotrack:hello-iso", onHello, true);
    serve(nonce);
    dispatch.call(doc, new Custom("autotrack:ack"));
  };
  add.call(doc, "autotrack:hello-iso", onHello, true);
  if (!done) dispatch.call(doc, new Custom("autotrack:hello-main"));
})();
