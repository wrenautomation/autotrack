// @ts-check
/**
 * The isolated-world recorder, one per frame. On each trusted pointer down, click, double click,
 * context menu, field change, submit, key (with ctrl/alt/meta, or Enter/Escape/Tab) and scroll
 * end it sends a `web` event to the service worker. One second after an act (or sooner, at the
 * next act or page hide) it sends `act: "effect"`: the URL if it changed and DOM mutation
 * counts; the service worker adds the network requests. `window.postMessage({autotrack:{v:1,
 * action, detail}})` from the page becomes an `app` event after validation.
 *
 * Screen points: Chrome's `screenX/screenY` are DIPs, which are OS points on Mac and logical
 * pixels (physical ÷ display scale) on Windows, unaffected by page zoom. Client (CSS px)
 * coordinates map to screen as `offset + client × zoom`, where offset and zoom come from the
 * latest pointer events in this frame (see `calibrate`).
 *
 * Needs redact.js, hints.js and bridge.js loaded first.
 */
(() => {
  const AT = /** @type {any} */ (globalThis).__autotrack;
  if (!AT || AT.started) return;
  AT.started = true;
  const { hints, redact, bridge } = AT;
  /** Tests swap this; in Chrome only real input counts. @type {(e: Event) => boolean} */
  const trusted = AT.trusted || ((e) => e.isTrusted);
  const EFFECT_MS = 1000;
  const SCROLL_IDLE_MS = 250;
  const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

  let alive = true;
  /** @param {Record<string, any>} ev */
  function send(ev) {
    if (!alive) return;
    try {
      const p = chrome.runtime.sendMessage({ autotrack: ev });
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {
      alive = false; // extension reloaded or removed: this frame's script is orphaned
    }
  }

  /** Epoch ms of an event, from its monotonic timeStamp (no drift after sleep). @param {Event} e */
  const tsOf = (e) =>
    Math.round(Date.now() - Math.max(0, performance.now() - (e.timeStamp || performance.now())));
  const r1 = (/** @type {number} */ n) => Math.round(n * 10) / 10;

  // ---- client → screen ----
  /** @type {{sx:number, sy:number, cx:number, cy:number, t:number}|null} */
  let last = null;
  let zoom = 1;
  /** @type {{x:number, y:number}|null} */
  let offset = null;

  /**
   * Learn this frame's client→screen map from a pointer event. zoom = Δscreen / Δclient between
   * two pointer samples ≥ 40 px and ≤ 1 s apart, snapped to a browser zoom level when close
   * (pinch zoom keeps the raw ratio). offset = screen − client × zoom.
   * @param {MouseEvent} e
   */
  function calibrate(e) {
    const s = { sx: e.screenX, sy: e.screenY, cx: e.clientX, cy: e.clientY, t: e.timeStamp };
    if (last && s.t - last.t <= 1000) {
      const dcx = s.cx - last.cx;
      const dcy = s.cy - last.cy;
      const [dc, ds] =
        Math.abs(dcx) >= Math.abs(dcy) ? [dcx, s.sx - last.sx] : [dcy, s.sy - last.sy];
      if (Math.abs(dc) >= 40) {
        const r = ds / dc;
        if (r > 0.1 && r < 10) {
          const snap = ZOOMS.reduce((a, b) => (Math.abs(b - r) < Math.abs(a - r) ? b : a));
          zoom = Math.abs(snap - r) / snap < 0.04 ? snap : Math.round(r * 1000) / 1000;
        }
      }
    }
    last = s;
    offset = { x: s.sx - s.cx * zoom, y: s.sy - s.cy * zoom };
  }

  /** @param {DOMRect} r */
  function toScreen(r) {
    if (!offset) return null;
    return {
      x: r1(offset.x + r.left * zoom),
      y: r1(offset.y + r.top * zoom),
      width: r1(r.width * zoom),
      height: r1(r.height * zoom),
    };
  }

  /** @param {Element} el */
  const target = (el) => hints.target(el, { toScreen, react: bridge?.react });

  /** The element an event started on, through open shadow roots. @param {Event} e */
  function origin(e) {
    const p = e.composedPath ? e.composedPath() : [];
    const el = p[0] || e.target;
    if (el && /** @type {Node} */ (el).nodeType === 3)
      return /** @type {Node} */ (el).parentElement;
    return el && /** @type {Node} */ (el).nodeType === 1 ? /** @type {Element} */ (el) : null;
  }

  function base(/** @type {string} */ act, /** @type {number} */ ts) {
    return {
      kind: "web",
      act,
      ts,
      url: redact.redactUrl(location.href),
      title: redact.redactText(document.title || "").slice(0, 200),
    };
  }

  // ---- effects: one open window at a time ----
  /** @type {{act:string, ts:number, url:string, added:number, removed:number, textChanged:number, timer:any, mo:MutationObserver|null}|null} */
  let win = null;

  function closeEffect() {
    const w = win;
    if (!w) return;
    win = null;
    clearTimeout(w.timer);
    if (w.mo) {
      count(w, w.mo.takeRecords());
      w.mo.disconnect();
    }
    const ts = Date.now();
    /** @type {Record<string, any>} */
    const effects = {
      requests: [],
      dom: { added: w.added, removed: w.removed, textChanged: w.textChanged },
    };
    const url = redact.redactUrl(location.href);
    if (url !== w.url) effects.url = url;
    send({ ...base("effect", ts), cause: { act: w.act, ts: w.ts }, effects });
  }

  /** @param {any} w @param {MutationRecord[]} records */
  function count(w, records) {
    for (const m of records) {
      if (m.type === "characterData") w.textChanged++;
      else {
        w.added += m.addedNodes.length;
        w.removed += m.removedNodes.length;
      }
    }
  }

  /** @param {string} act @param {number} ts */
  function openEffect(act, ts) {
    closeEffect();
    /** @type {any} */
    const w = {
      act,
      ts,
      url: redact.redactUrl(location.href),
      added: 0,
      removed: 0,
      textChanged: 0,
      mo: null,
    };
    try {
      w.mo = new MutationObserver((records) => count(w, records));
      w.mo.observe(document, { childList: true, subtree: true, characterData: true });
    } catch {}
    w.timer = setTimeout(closeEffect, EFFECT_MS);
    win = w;
  }

  /**
   * Record an act. `effect` opens the 1 s effect window; every act but scroll closes the
   * previous one.
   * @param {Record<string, any>} ev
   * @param {boolean} effect
   */
  function act(ev, effect) {
    if (ev.act !== "scroll") closeEffect();
    send(ev);
    if (effect) openEffect(ev.act, ev.ts);
  }

  const BUTTONS = ["left", "middle", "right", "back", "forward"];

  /** @param {MouseEvent} e @param {string} name @param {boolean} effect */
  function pointer(e, name, effect) {
    if (!trusted(e)) return;
    calibrate(e);
    const hit = origin(e);
    if (!hit) return;
    const el = hints.interactive(hit);
    const ev = base(name, tsOf(e));
    Object.assign(ev, {
      x: r1(e.screenX),
      y: r1(e.screenY),
      button: BUTTONS[e.button] || String(e.button),
      target: target(el),
    });
    if (name === "click" || name === "dblclick") /** @type {any} */ (ev).count = e.detail;
    if (hit !== el) /** @type {any} */ (ev).hit = hit.localName;
    act(ev, effect);
  }

  const opts = { capture: true, passive: true };
  addEventListener(
    "pointermove",
    (e) => {
      if (trusted(e)) calibrate(e);
    },
    opts,
  );
  addEventListener("pointerdown", (e) => pointer(e, "pointerdown", false), opts);
  addEventListener("click", (e) => pointer(e, "click", true), opts);
  addEventListener("dblclick", (e) => pointer(e, "dblclick", true), opts);
  addEventListener("contextmenu", (e) => pointer(e, "contextmenu", true), opts);

  // ---- fields ----
  /** @param {Element} el @param {number} ts */
  function change(el, ts) {
    const ev = { ...base("change", ts), target: target(el), ...hints.fieldValue(el) };
    act(ev, true);
  }

  /** An editable region being typed in: its value is recorded on blur or Enter (no `change`). @type {Element|null} */
  let typing = null;
  function flushTyping(ts = Date.now()) {
    const el = typing;
    typing = null;
    if (el?.isConnected) change(el, ts);
  }

  addEventListener(
    "input",
    (e) => {
      if (!trusted(e)) return;
      const el = origin(e);
      if (!el) return;
      const shadowed = el.getRootNode() !== document;
      if (!hints.isField(el) && hints.isEditable(el)) {
        typing = el.closest("[contenteditable]:not([contenteditable=false])") || el;
        return;
      }
      // `change` doesn't leave a shadow root: keep the field and record it on blur.
      if (shadowed && hints.isField(el)) {
        const t = (el.getAttribute("type") || "").toLowerCase();
        if (t !== "checkbox" && t !== "radio") typing = el;
        else change(el, tsOf(e));
      }
    },
    opts,
  );
  addEventListener(
    "focusout",
    (e) => {
      if (typing && origin(e) === typing) flushTyping(tsOf(e));
    },
    opts,
  );
  addEventListener(
    "change",
    (e) => {
      if (!trusted(e)) return;
      const el = origin(e);
      if (el && hints.isField(el)) change(el, tsOf(e));
    },
    opts,
  );
  addEventListener(
    "submit",
    (e) => {
      if (!trusted(e)) return;
      flushTyping();
      const el = origin(e);
      if (el) act({ ...base("submit", tsOf(e)), target: target(el) }, true);
    },
    opts,
  );

  // ---- keys ----
  const NAMED = new Set(["Enter", "Escape", "Tab"]);
  addEventListener(
    "keydown",
    (e) => {
      if (!trusted(e) || e.repeat) return;
      const combo = e.ctrlKey || e.altKey || e.metaKey;
      if (!combo && !NAMED.has(e.key)) return;
      if (["Control", "Alt", "Meta", "Shift"].includes(e.key)) return;
      const el = origin(e);
      if (typing && el === typing && e.key === "Enter") flushTyping(tsOf(e));
      const mods = [];
      if (e.ctrlKey) mods.push("ctrl");
      if (e.altKey) mods.push("alt");
      if (e.shiftKey) mods.push("shift");
      if (e.metaKey) mods.push("meta");
      // Alt+key types a character on Mac (⌥s = ß): in a secret field that is password text.
      const hidden = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !!el && hints.secret(el);
      const ev = hidden
        ? { ...base("key", tsOf(e)), key: redact.REDACTED, mods }
        : { ...base("key", tsOf(e)), key: e.key.toLowerCase(), code: e.code, mods };
      if (el) /** @type {any} */ (ev).target = target(el);
      act(ev, true);
    },
    opts,
  );

  // ---- scroll end ----
  /** @type {any} */
  let scrollTimer = null;
  /** @type {{el: Element, ts: number}|null} */
  let scrolling = null;
  addEventListener(
    "scroll",
    (e) => {
      if (!trusted(e)) return;
      const t = e.target;
      const el =
        t === document || t === window
          ? document.scrollingElement || document.documentElement
          : /** @type {Element} */ (t);
      if (el?.nodeType !== 1) return;
      if (!scrolling || scrolling.el !== el) {
        if (scrolling) endScroll();
        scrolling = { el, ts: tsOf(e) };
      }
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(endScroll, SCROLL_IDLE_MS);
    },
    opts,
  );
  function endScroll() {
    const s = scrolling;
    scrolling = null;
    clearTimeout(scrollTimer);
    if (!s) return;
    const el = s.el;
    const ev = {
      ...base("scroll", Date.now()),
      start: s.ts,
      scroll: { x: Math.round(el.scrollLeft), y: Math.round(el.scrollTop) },
      target: target(el),
    };
    act(ev, false);
  }

  addEventListener(
    "pagehide",
    () => {
      flushTyping();
      endScroll();
      closeEffect();
    },
    opts,
  );

  // ---- app events ----
  const APP_MAX = 4096;
  let appWindow = 0;
  let appCount = 0;
  addEventListener("message", (e) => {
    if (e.source !== window) return;
    const ev = AT.appEvent(e.data);
    if (!ev) return;
    const now = Date.now();
    if (now - appWindow > 1000) {
      appWindow = now;
      appCount = 0;
    }
    if (++appCount > 20) return; // a page flooding the channel loses the excess
    send({ kind: "app", ts: now, url: redact.redactUrl(location.href), ...ev });
  });

  /**
   * Validate `{autotrack:{v:1, action, detail}}`: action a string of 1–64 chars, detail JSON of
   * at most 4 KB, secret-shaped text in it masked. Anything else is ignored.
   * @param {any} data
   * @returns {{action:string, detail:any}|null}
   */
  AT.appEvent = (data) => {
    const m = data && typeof data === "object" ? data.autotrack : null;
    if (!m || typeof m !== "object" || m.v !== 1) return null;
    const { action, detail } = m;
    if (typeof action !== "string" || !action || action.length > 64) return null;
    let json;
    try {
      json = JSON.stringify(detail === undefined ? null : detail);
    } catch {
      return null;
    }
    if (typeof json !== "string" || new TextEncoder().encode(json).length > APP_MAX) return null;
    try {
      return { action, detail: JSON.parse(redact.redactText(json)) };
    } catch {
      return { action, detail: null }; // redaction broke the JSON shape
    }
  };
})();
