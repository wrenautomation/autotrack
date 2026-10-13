// @ts-check
/**
 * Recent network requests per tab, from `webRequest` (method, origin + path, status, ms; no
 * bodies, no headers), so an effect event can say what an act fetched. Bounded: done requests
 * older than 15 s go, at most 300 per tab, at most 2,000 in flight.
 */

/** @typedef {{method:string, url:string, type:string, status:number, ms:number, start:number, frame:number}} Done */

export class Requests {
  /** @param {(url: string) => string} originPath */
  constructor(originPath) {
    this.originPath = originPath;
    /** @type {Map<string, {tab:number, frame:number, method:string, url:string, type:string, start:number}>} */
    this.pending = new Map();
    /** @type {Map<number, Done[]>} */
    this.done = new Map();
  }

  /** @param {{requestId:string, tabId:number, frameId:number, method:string, url:string, type:string, timeStamp:number}} d */
  start(d) {
    if (d.tabId < 0) return;
    if (this.pending.size >= 2000) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
    this.pending.set(d.requestId, {
      tab: d.tabId,
      frame: d.frameId,
      method: d.method,
      url: this.originPath(d.url),
      type: d.type,
      start: d.timeStamp,
    });
  }

  /** @param {{requestId:string, timeStamp:number}} d @param {number} status 0 on a network error */
  end(d, status) {
    const p = this.pending.get(d.requestId);
    if (!p) return;
    this.pending.delete(d.requestId);
    let list = this.done.get(p.tab);
    if (!list) {
      list = [];
      this.done.set(p.tab, list);
    }
    list.push({
      method: p.method,
      url: p.url,
      type: p.type,
      status,
      ms: Math.max(0, Math.round(d.timeStamp - p.start)),
      start: p.start,
      frame: p.frame,
    });
    this.prune(p.tab, d.timeStamp);
  }

  /** @param {number} tab @param {number} now */
  prune(tab, now) {
    const list = this.done.get(tab);
    if (!list) return;
    let i = 0;
    while (i < list.length && (now - list[i].start > 15000 || list.length - i > 300)) i++;
    if (i) list.splice(0, i);
    if (!list.length) this.done.delete(tab);
  }

  /** @param {number} tab */
  forget(tab) {
    this.done.delete(tab);
  }

  /**
   * Requests in a tab that started in [from − 50 ms, to] and have finished, oldest first, ≤ 50.
   * @param {number} tab @param {number} from @param {number} to
   */
  between(tab, from, to) {
    return (this.done.get(tab) || [])
      .filter((r) => r.start >= from - 50 && r.start <= to)
      .sort((a, b) => a.start - b.start)
      .slice(0, 50);
  }
}
