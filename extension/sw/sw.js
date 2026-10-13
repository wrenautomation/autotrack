// @ts-check
/**
 * Service worker. Stamps each event from a content script with its tab and frame, fills an
 * effect event's `requests` from webRequest once its window has closed (plus 250 ms for late
 * finishes), and hands events to the native host.
 */
import "../content/redact.js";
import { HOST, Native } from "./native.js";
import { Requests } from "./requests.js";

const R = /** @type {any} */ (globalThis).__autotrack.redact;
const requests = new Requests(R.originPath);
const native = new Native({
  connect: () => chrome.runtime.connectNative(HOST),
  lastError: () => chrome.runtime.lastError?.message,
});

const ALL = { urls: ["<all_urls>"] };
chrome.webRequest.onBeforeRequest.addListener((d) => {
  requests.start(d);
  return undefined; // observe only, never block
}, ALL);
chrome.webRequest.onCompleted.addListener((d) => requests.end(d, d.statusCode), ALL);
chrome.webRequest.onErrorOccurred.addListener((d) => requests.end(d, 0), ALL);
chrome.tabs?.onRemoved?.addListener((tab) => requests.forget(tab));

chrome.runtime.onMessage.addListener((msg, sender) => {
  const ev = msg?.autotrack;
  if (!ev || typeof ev !== "object" || sender.id !== chrome.runtime.id || !sender.tab) return;
  if (ev.kind !== "web" && ev.kind !== "app") return;
  ev.tab = sender.tab.id;
  ev.frame = sender.frameId ?? 0;
  if (ev.act !== "effect") return native.push(ev);
  const from = Number(ev.cause?.ts) || ev.ts;
  const wait = Math.max(0, from + 1250 - Date.now());
  setTimeout(() => {
    // The window ran from the act until the effect closed it (1 s, or the next act).
    const done = requests.between(ev.tab, from, Math.max(ev.ts, from));
    ev.effects.requests = done.map(({ method, url, type, status, ms }) => ({
      method,
      url,
      type,
      status,
      ms,
    }));
    // A full navigation unloads the page before it can see its new URL.
    const nav = ev.frame === 0 && done.findLast((r) => r.type === "main_frame");
    if (!ev.effects.url && nav) ev.effects.url = nav.url;
    native.push(ev);
  }, wait);
});
