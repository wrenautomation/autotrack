// @ts-check
/**
 * What the browser itself knows, with no page script: navigations (`webNavigation`), searches
 * read from those navigations' URLs, tab opens, closes and switches, and finished downloads
 * (`chrome.downloads`, metadata only: extension, type, size, origin, never the name or the file).
 * Each becomes a `web` event handed to `push`, with tab and frame already set.
 *
 * Also `Gate`: at most one page snapshot per tab per 2 s, the latest one waiting for its turn.
 *
 * The chrome API, the redaction rules and the clock are injected so tests drive it without
 * Chrome.
 */

/** @typedef {{engine: string, query: string}} Search */

const SEARCH_MAX = 300;

/**
 * Known engines: a host pattern, a path pattern and the query parameter. Anything else with a
 * `?q=`, `?query=` or `?search=` is a search on that site.
 * @type {{engine: string, host: RegExp, path: RegExp, param: string}[]}
 */
const ENGINES = [
  { engine: "google", host: /^google\.[a-z.]+$/, path: /^\/search\b/, param: "q" },
  { engine: "bing", host: /^bing\.com$/, path: /^\/search\b/, param: "q" },
  { engine: "duckduckgo", host: /^duckduckgo\.com$/, path: /^\//, param: "q" },
  { engine: "youtube", host: /^youtube\.com$/, path: /^\/results\b/, param: "search_query" },
  { engine: "amazon", host: /^amazon\.[a-z.]+$/, path: /^\/s\b/, param: "k" },
  { engine: "reddit", host: /^reddit\.com$/, path: /\/search\b/, param: "q" },
  { engine: "x", host: /^(x|twitter)\.com$/, path: /^\/search\b/, param: "q" },
  { engine: "linkedin", host: /^linkedin\.com$/, path: /^\/search\//, param: "keywords" },
];
const SITE_PARAMS = ["q", "query", "search"];

/**
 * The search a URL is, with the query as typed: whitespace squeezed, ≤ 300 chars, a
 * secret-shaped token masked.
 * @param {string} href
 * @param {{redactText: (s: string) => string, looksLikeSecretValue: (s: string) => boolean, REDACTED: string}} R
 * @returns {Search|null}
 */
export function searchOf(href, R) {
  let u;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  /** @type {string|null} */
  let engine = null;
  /** @type {string|null} */
  let raw = null;
  for (const e of ENGINES) {
    if (!e.host.test(host) || !e.path.test(u.pathname)) continue;
    const v = u.searchParams.get(e.param);
    if (v !== null) {
      engine = e.engine;
      raw = v;
    }
    break;
  }
  if (raw === null) {
    for (const p of SITE_PARAMS) {
      const v = u.searchParams.get(p);
      if (v !== null) {
        engine = host;
        raw = v;
        break;
      }
    }
  }
  if (engine === null || raw === null) return null;
  const query = raw.replace(/\s+/g, " ").trim().slice(0, SEARCH_MAX);
  if (!query) return null;
  // A lone secret-shaped token is hidden whole; a sentence keeps its words around the mask.
  const lone = !/\s/.test(query) && R.looksLikeSecretValue(query);
  return { engine, query: lone ? R.REDACTED : R.redactText(query) };
}

/**
 * Chrome's transition type, with "back_forward" for the forward_back qualifier (which Chrome
 * reports beside the type, not as one).
 * @param {string} type @param {string[]} [qualifiers]
 */
export function transitionOf(type, qualifiers = []) {
  return qualifiers.includes("forward_back") ? "back_forward" : type || "unknown";
}

/** The origin of a URL, "" when it has none (data:, about:). @param {string} url */
function originOf(url) {
  try {
    const o = new URL(url).origin;
    return o === "null" ? "" : o;
  } catch {
    return "";
  }
}

/** Lower-case extension, up to 10 letters or digits, of a file name or URL path; else "". @param {string} s */
function extOf(s) {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(s);
  return m ? m[1].toLowerCase() : "";
}

/**
 * One snapshot per key per `ms`. A snapshot offered inside the gap replaces any waiting one and
 * goes out when the gap ends.
 */
export class Gate {
  /**
   * @param {{ms?: number, now?: () => number, setTimeout?: typeof setTimeout,
   *   clearTimeout?: typeof clearTimeout}} [o]
   */
  constructor(o = {}) {
    this.ms = o.ms ?? 2000;
    this.now = o.now || Date.now;
    this.setTimeout = o.setTimeout || ((f, ms) => setTimeout(f, ms));
    this.clearTimeout = o.clearTimeout || ((t) => clearTimeout(t));
    /** @type {Map<number, {last: number, waiting: any, timer: any}>} */
    this.keys = new Map();
  }

  /** @param {number} key @param {any} item @param {(item: any) => void} send */
  offer(key, item, send) {
    let k = this.keys.get(key);
    if (!k) {
      k = { last: -Infinity, waiting: null, timer: null };
      this.keys.set(key, k);
    }
    const wait = k.last + this.ms - this.now();
    if (wait <= 0 && !k.timer) {
      k.last = this.now();
      send(item);
      return;
    }
    k.waiting = item;
    if (k.timer) return;
    const state = k;
    k.timer = this.setTimeout(
      () => {
        state.timer = null;
        state.last = this.now();
        const w = state.waiting;
        state.waiting = null;
        if (w) send(w);
      },
      Math.max(0, wait),
    );
  }

  /** @param {number} key */
  forget(key) {
    const k = this.keys.get(key);
    if (k?.timer) this.clearTimeout(k.timer);
    this.keys.delete(key);
  }
}

/**
 * Register the listeners. Call synchronously at the top level of the service worker.
 * @param {any} api `chrome`
 * @param {{push: (ev: Record<string, any>) => void, redact: any, now?: () => number}} o
 */
export function watch(api, o) {
  const { push, redact: R } = o;
  const now = o.now || Date.now;
  const url = (/** @type {string|undefined} */ u) => R.redactUrl(u || "");
  const title = (/** @type {string|undefined} */ t) => R.redactText(t || "").slice(0, 200);

  /** Where each tab last navigated to: the `from` of the next navigation. @type {Map<number, string>} */
  const at = new Map();
  /** What each tab shows now, for events with no page behind them. @type {Map<number, {url: string, title: string}>} */
  const shows = new Map();
  /** Last search per tab, so one navigation reported twice (commit, then history update) says it once. @type {Map<number, string>} */
  const searched = new Map();

  /** @param {any} tab */
  const remember = (tab) => {
    if (tab && typeof tab.id === "number")
      shows.set(tab.id, { url: tab.url || "", title: tab.title || "" });
  };

  // ---- navigation and search ----
  /** @param {any} d @param {boolean} spa */
  function navigated(d, spa) {
    if (d.frameId !== 0 || d.tabId < 0 || d.url === "about:blank") return;
    const from = at.get(d.tabId) ?? "";
    at.set(d.tabId, d.url);
    // A pushState or replaceState that kept the URL moved nothing.
    if (spa && d.url === from) return;
    const ts = Math.round(d.timeStamp || now());
    /** @type {Record<string, any>} */
    const ev = {
      kind: "web",
      act: "nav",
      ts,
      tab: d.tabId,
      frame: 0,
      url: url(d.url),
      title: "", // the page hasn't set one yet; the next event on it carries it
      from: url(from),
      transition: transitionOf(d.transitionType, d.transitionQualifiers),
    };
    if (d.transitionQualifiers?.length) ev.qualifiers = d.transitionQualifiers.slice(0, 8);
    if (spa) ev.spa = true;
    push(ev);
    const s = searchOf(d.url, R);
    if (!s) {
      searched.delete(d.tabId);
      return;
    }
    const key = `${s.engine}\n${s.query}`;
    if (searched.get(d.tabId) === key && spa) return;
    searched.set(d.tabId, key);
    push({
      kind: "web",
      act: "search",
      ts,
      tab: d.tabId,
      frame: 0,
      url: ev.url,
      title: "",
      engine: s.engine,
      query: s.query,
    });
  }
  api.webNavigation.onCommitted.addListener((/** @type {any} */ d) => navigated(d, false));
  api.webNavigation.onHistoryStateUpdated.addListener((/** @type {any} */ d) => navigated(d, true));
  // The tab's address before this navigation commits, when the worker has just woken.
  api.webNavigation.onBeforeNavigate.addListener((/** @type {any} */ d) => {
    if (d.frameId !== 0 || d.tabId < 0 || at.has(d.tabId)) return;
    Promise.resolve(api.tabs.get(d.tabId))
      .then((/** @type {any} */ t) => {
        if (t && !at.has(d.tabId)) at.set(d.tabId, t.url || "");
      })
      .catch(() => {});
  });
  Promise.resolve(api.tabs.query({}))
    .then((/** @type {any[]} */ tabs) => {
      for (const t of tabs || []) {
        remember(t);
        if (typeof t.id === "number" && !at.has(t.id)) at.set(t.id, t.url || "");
      }
    })
    .catch(() => {});

  // ---- tabs ----
  /** @param {number} windowId */
  async function countIn(windowId) {
    try {
      return (await api.tabs.query({ windowId })).length;
    } catch {
      return 0;
    }
  }
  /** @param {"open"|"close"|"switch"} op @param {number} tabId @param {number} windowId @param {{url: string, title: string}} page */
  async function tabEvent(op, tabId, windowId, page) {
    const count = await countIn(windowId);
    push({
      kind: "web",
      act: "tab",
      ts: now(),
      tab: tabId,
      frame: 0,
      url: url(page.url),
      title: title(page.title),
      op,
      count,
    });
  }
  api.tabs.onUpdated.addListener(
    (/** @type {number} */ _id, /** @type {any} */ _c, /** @type {any} */ tab) => remember(tab),
  );
  api.tabs.onCreated.addListener((/** @type {any} */ tab) => {
    remember(tab);
    tabEvent("open", tab.id, tab.windowId, {
      url: tab.url || tab.pendingUrl || "",
      title: tab.title || "",
    });
  });
  api.tabs.onRemoved.addListener((/** @type {number} */ id, /** @type {any} */ info) => {
    const page = shows.get(id) || { url: "", title: "" };
    shows.delete(id);
    at.delete(id);
    searched.delete(id);
    tabEvent("close", id, info.windowId, page);
  });
  api.tabs.onActivated.addListener((/** @type {any} */ info) => {
    Promise.resolve(api.tabs.get(info.tabId))
      .then((/** @type {any} */ tab) => {
        remember(tab);
        return tabEvent("switch", info.tabId, info.windowId, {
          url: tab?.url || "",
          title: tab?.title || "",
        });
      })
      .catch(() => {});
  });

  // ---- downloads ----
  api.downloads.onChanged.addListener((/** @type {any} */ delta) => {
    const state = delta.state?.current;
    if (state !== "complete" && state !== "interrupted") return;
    Promise.resolve(api.downloads.search({ id: delta.id }))
      .then(async (/** @type {any[]} */ [item]) => {
        if (!item) return;
        const [tab] =
          (await Promise.resolve(api.tabs.query({ active: true, lastFocusedWindow: true })).catch(
            () => [],
          )) || [];
        const from = item.finalUrl || item.url || "";
        let bytes = item.fileSize > 0 ? item.fileSize : item.totalBytes > 0 ? item.totalBytes : 0;
        if (!bytes && state === "interrupted") bytes = Math.max(0, item.bytesReceived || 0);
        push({
          kind: "web",
          act: "download",
          ts: now(),
          tab: typeof tab?.id === "number" ? tab.id : -1,
          frame: 0,
          url: url(tab?.url),
          title: title(tab?.title),
          ext: extOf(item.filename || "") || extOf(safePath(from)),
          mime: String(item.mime || "").slice(0, 100),
          bytes,
          origin: originOf(from) || originOf(item.referrer || ""),
          state,
        });
      })
      .catch(() => {});
  });
}

/** The path of a URL, "" when it won't parse. @param {string} s */
function safePath(s) {
  try {
    return new URL(s).pathname;
  } catch {
    return "";
  }
}
