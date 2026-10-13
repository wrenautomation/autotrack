import { describe, expect, it } from "vitest";
import "../content/redact.js";
import { Gate, searchOf, transitionOf, watch } from "../sw/browse.js";

const R = globalThis.__autotrack.redact;
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("searchOf", () => {
  const q = (u) => searchOf(u, R);

  it("reads the named engines", () => {
    expect(q("https://www.google.com/search?q=best+crm+for+roofers&hl=en")).toEqual({
      engine: "google",
      query: "best crm for roofers",
    });
    expect(q("https://www.bing.com/search?q=wren")).toEqual({ engine: "bing", query: "wren" });
    expect(q("https://duckduckgo.com/?q=a%20b")).toEqual({ engine: "duckduckgo", query: "a b" });
    expect(q("https://www.youtube.com/results?search_query=how+to+x")).toEqual({
      engine: "youtube",
      query: "how to x",
    });
    expect(q("https://www.amazon.com/s?k=usb+hub")).toEqual({ engine: "amazon", query: "usb hub" });
    expect(q("https://www.reddit.com/r/sales/search/?q=cold+email")).toEqual({
      engine: "reddit",
      query: "cold email",
    });
    expect(q("https://x.com/search?q=wren&src=typed_query")).toEqual({
      engine: "x",
      query: "wren",
    });
    expect(q("https://www.linkedin.com/search/results/people/?keywords=ceo")).toEqual({
      engine: "linkedin",
      query: "ceo",
    });
  });

  it("reads ?q=, ?query= and ?search= on any other site, named by host", () => {
    expect(q("https://docs.example.com/find?q=refunds")).toEqual({
      engine: "docs.example.com",
      query: "refunds",
    });
    expect(q("https://shop.example.com/?query=red%20shoes")).toEqual({
      engine: "shop.example.com",
      query: "red shoes",
    });
    expect(q("https://www.example.org/?search=hello")?.engine).toBe("example.org");
  });

  it("is null for non-searches", () => {
    expect(q("https://www.google.com/maps")).toBeNull();
    expect(q("https://example.com/?page=2")).toBeNull();
    expect(q("https://example.com/?q=")).toBeNull();
    expect(q("https://example.com/?q=%20%20")).toBeNull();
    expect(q("chrome://settings/?q=x")).toBeNull();
    expect(q("not a url")).toBeNull();
  });

  it("squeezes, caps at 300 and masks secret-shaped queries", () => {
    expect(q("https://example.com/?q=a%20%20%0A%20b")?.query).toBe("a b");
    expect(q(`https://example.com/?q=${"word+".repeat(100)}`)?.query).toHaveLength(300);
    expect(q("https://example.com/?q=sk-abcdefghijklmnopqrstuvwxyz")?.query).toBe(R.REDACTED);
    expect(q("https://example.com/?q=is+sk-abcdefghijklmnopqrstuvwxyz+valid")?.query).toBe(
      `is ${R.REDACTED} valid`,
    );
  });
});

describe("transitionOf", () => {
  it("keeps the type, and says back_forward for the qualifier", () => {
    expect(transitionOf("link")).toBe("link");
    expect(transitionOf("typed", ["from_address_bar"])).toBe("typed");
    expect(transitionOf("reload", ["forward_back"])).toBe("back_forward");
    expect(transitionOf("")).toBe("unknown");
  });
});

describe("Gate", () => {
  function gate() {
    let now = 10_000;
    const timers = [];
    const g = new Gate({
      now: () => now,
      setTimeout: (f, ms) => {
        const t = { f, at: now + ms, dead: false };
        timers.push(t);
        return t;
      },
      clearTimeout: (t) => {
        t.dead = true;
      },
    });
    const advance = (ms) => {
      now += ms;
      for (const t of timers.splice(0)) {
        if (t.dead) continue;
        if (t.at <= now) t.f();
        else timers.push(t);
      }
    };
    return { g, advance, timers };
  }

  it("sends the first at once, holds the next for the gap, latest wins", () => {
    const { g, advance } = gate();
    const out = [];
    const send = (x) => out.push(x);
    g.offer(1, "a", send);
    g.offer(1, "b", send);
    g.offer(1, "c", send);
    expect(out).toEqual(["a"]);
    advance(1999);
    expect(out).toEqual(["a"]);
    advance(1);
    expect(out).toEqual(["a", "c"]);
    // The gap restarts from the held one going out.
    g.offer(1, "d", send);
    expect(out).toEqual(["a", "c"]);
    advance(2000);
    expect(out).toEqual(["a", "c", "d"]);
    // Quiet for 2 s: the next goes at once.
    advance(2000);
    g.offer(1, "e", send);
    expect(out).toEqual(["a", "c", "d", "e"]);
  });

  it("keeps tabs apart, and forgets a closed one", () => {
    const { g, advance, timers } = gate();
    const out = [];
    const send = (x) => out.push(x);
    g.offer(1, "a1", send);
    g.offer(2, "b1", send);
    g.offer(1, "a2", send);
    expect(out).toEqual(["a1", "b1"]);
    g.forget(1);
    advance(5000);
    expect(out).toEqual(["a1", "b1"]);
    expect(timers).toHaveLength(0);
    g.offer(1, "a3", send); // the same id reused: a fresh start
    expect(out).toEqual(["a1", "b1", "a3"]);
  });
});

function fakeChrome(o = {}) {
  const l = {};
  const ev = (name) => ({ addListener: (f) => (l[name] = f) });
  const tabs = o.tabs || [];
  return {
    l,
    api: {
      webNavigation: {
        onCommitted: ev("committed"),
        onHistoryStateUpdated: ev("history"),
        onBeforeNavigate: ev("before"),
      },
      tabs: {
        onCreated: ev("created"),
        onRemoved: ev("removed"),
        onActivated: ev("activated"),
        onUpdated: ev("updated"),
        get: async (id) => tabs.find((t) => t.id === id),
        query: async (q) => {
          if (q.active) return tabs.filter((t) => t.active);
          if (q.windowId !== undefined) return tabs.filter((t) => t.windowId === q.windowId);
          return tabs;
        },
      },
      downloads: {
        onChanged: ev("download"),
        search: async ({ id }) => (o.downloads || []).filter((d) => d.id === id),
      },
    },
    tabs,
  };
}

function setup(o) {
  const c = fakeChrome(o);
  const sent = [];
  watch(c.api, { push: (e) => sent.push(e), redact: R, now: () => 5_000 });
  return { ...c, sent };
}

describe("watch: nav and search", () => {
  it("sends a nav with from, transition and a redacted url", async () => {
    const { l, sent } = setup({ tabs: [{ id: 7, url: "https://a.example.com/", windowId: 1 }] });
    await tick();
    l.committed({
      tabId: 7,
      frameId: 0,
      url: "https://b.example.com/x?token=abc123&p=1",
      timeStamp: 1234.6,
      transitionType: "link",
      transitionQualifiers: [],
    });
    expect(sent).toEqual([
      {
        kind: "web",
        act: "nav",
        ts: 1235,
        tab: 7,
        frame: 0,
        url: "https://b.example.com/x?token=%3Credacted%3E&p=1",
        title: "",
        from: "https://a.example.com/",
        transition: "link",
      },
    ]);
    // The next one's from is this one.
    l.committed({
      tabId: 7,
      frameId: 0,
      url: "https://c.example.com/",
      timeStamp: 1300,
      transitionType: "typed",
      transitionQualifiers: ["from_address_bar"],
    });
    expect(sent[1]).toMatchObject({
      from: "https://b.example.com/x?token=%3Credacted%3E&p=1",
      transition: "typed",
      qualifiers: ["from_address_bar"],
    });
  });

  it("marks history navigation and pushState, skips same-url pushState, subframes and blank", async () => {
    const { l, sent } = setup();
    l.committed({
      tabId: 1,
      frameId: 0,
      url: "https://x.example.com/a",
      timeStamp: 1,
      transitionType: "link",
      transitionQualifiers: ["forward_back"],
    });
    l.history({
      tabId: 1,
      frameId: 0,
      url: "https://x.example.com/b",
      timeStamp: 2,
      transitionType: "link",
      transitionQualifiers: [],
    });
    l.history({
      tabId: 1,
      frameId: 0,
      url: "https://x.example.com/b",
      timeStamp: 3,
      transitionType: "link",
      transitionQualifiers: [],
    });
    l.committed({
      tabId: 1,
      frameId: 3,
      url: "https://ads.example.com/",
      timeStamp: 4,
      transitionType: "auto_subframe",
      transitionQualifiers: [],
    });
    l.committed({
      tabId: 1,
      frameId: 0,
      url: "about:blank",
      timeStamp: 5,
      transitionType: "link",
      transitionQualifiers: [],
    });
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      transition: "back_forward",
      qualifiers: ["forward_back"],
      from: "",
    });
    expect(sent[0].spa).toBeUndefined();
    expect(sent[1]).toMatchObject({ spa: true, from: "https://x.example.com/a" });
  });

  it("takes from from the tab when the worker has just woken", async () => {
    // A tab the startup query missed (opened while the worker slept): onBeforeNavigate asks the tab.
    const c = fakeChrome({ tabs: [{ id: 9, url: "https://old.example.com/", windowId: 1 }] });
    const out = [];
    watch(c.api, { push: (e) => out.push(e), redact: R });
    await tick();
    c.l.committed({
      tabId: 9,
      frameId: 0,
      url: "https://new.example.com/",
      timeStamp: 1,
      transitionType: "link",
      transitionQualifiers: [],
    });
    expect(out[0].from).toBe("https://old.example.com/");
    c.tabs.push({ id: 11, url: "https://was.example.com/", windowId: 1 });
    c.l.before({ tabId: 11, frameId: 0, url: "https://next.example.com/" });
    await tick();
    c.l.committed({
      tabId: 11,
      frameId: 0,
      url: "https://next.example.com/",
      timeStamp: 2,
      transitionType: "link",
      transitionQualifiers: [],
    });
    expect(out[1].from).toBe("https://was.example.com/");
  });

  it("sends a search beside the nav, once for a commit then a history update", async () => {
    const { l, sent } = setup();
    l.committed({
      tabId: 2,
      frameId: 0,
      url: "https://www.google.com/search?q=wren+crm",
      timeStamp: 10,
      transitionType: "generated",
      transitionQualifiers: [],
    });
    l.history({
      tabId: 2,
      frameId: 0,
      url: "https://www.google.com/search?q=wren+crm&tbm=isch",
      timeStamp: 11,
      transitionType: "link",
      transitionQualifiers: [],
    });
    expect(sent.map((e) => e.act)).toEqual(["nav", "search", "nav"]);
    expect(sent[1]).toEqual({
      kind: "web",
      act: "search",
      ts: 10,
      tab: 2,
      frame: 0,
      url: "https://www.google.com/search?q=wren+crm",
      title: "",
      engine: "google",
      query: "wren crm",
    });
    // A new query is a new search; a plain page clears it so the same query later counts again.
    l.history({
      tabId: 2,
      frameId: 0,
      url: "https://www.google.com/search?q=other",
      timeStamp: 12,
      transitionType: "link",
      transitionQualifiers: [],
    });
    expect(sent.at(-1)).toMatchObject({ act: "search", query: "other" });
    l.committed({
      tabId: 2,
      frameId: 0,
      url: "https://example.com/",
      timeStamp: 13,
      transitionType: "link",
      transitionQualifiers: [],
    });
    l.committed({
      tabId: 2,
      frameId: 0,
      url: "https://www.google.com/search?q=other",
      timeStamp: 14,
      transitionType: "link",
      transitionQualifiers: [],
    });
    expect(sent.at(-1)).toMatchObject({ act: "search", query: "other", ts: 14 });
  });

  it("masks a secret in the query and in the search's url", async () => {
    const { l, sent } = setup();
    l.committed({
      tabId: 2,
      frameId: 0,
      url: "https://example.com/find?q=sk-abcdefghijklmnopqrstuvwxyz",
      timeStamp: 1,
      transitionType: "link",
      transitionQualifiers: [],
    });
    expect(sent[1].query).toBe(R.REDACTED);
    expect(JSON.stringify(sent)).not.toContain("abcdefghij");
  });
});

describe("watch: tabs", () => {
  const tabs = [
    { id: 1, windowId: 5, url: "https://a.example.com/", title: "A", active: true },
    { id: 2, windowId: 5, url: "https://b.example.com/?token=zzz", title: "B" },
    { id: 3, windowId: 6, url: "https://c.example.com/", title: "C" },
  ];

  it("open: the new tab and how many are in its window", async () => {
    const { l, sent } = setup({ tabs });
    l.created({ id: 2, windowId: 5, pendingUrl: "https://b.example.com/?token=zzz", title: "" });
    await tick();
    expect(sent).toEqual([
      {
        kind: "web",
        act: "tab",
        ts: 5000,
        tab: 2,
        frame: 0,
        url: "https://b.example.com/?token=%3Credacted%3E",
        title: "",
        op: "open",
        count: 2,
      },
    ]);
  });

  it("switch: the tab now shown", async () => {
    const { l, sent } = setup({ tabs });
    l.activated({ tabId: 2, windowId: 5 });
    await tick();
    expect(sent[0]).toMatchObject({ act: "tab", op: "switch", tab: 2, title: "B", count: 2 });
  });

  it("close: the last url and title the tab showed", async () => {
    const { l, sent } = setup({ tabs });
    await tick();
    l.updated(2, {}, { id: 2, url: "https://b.example.com/done", title: "Done" });
    l.removed(2, { windowId: 5, isWindowClosing: false });
    await tick();
    expect(sent[0]).toMatchObject({
      act: "tab",
      op: "close",
      tab: 2,
      url: "https://b.example.com/done",
      title: "Done",
    });
  });
});

describe("watch: downloads", () => {
  const item = {
    id: 4,
    url: "https://files.example.com/report.pdf?sig=abc",
    finalUrl: "https://cdn.example.com/r/report.pdf?sig=abc",
    referrer: "https://app.example.com/",
    filename: "/Users/me/Downloads/Q3 report secret-name.PDF",
    mime: "application/pdf",
    fileSize: 52341,
    totalBytes: 52341,
  };
  const tabs = [
    {
      id: 1,
      windowId: 5,
      active: true,
      url: "https://app.example.com/files?token=abc",
      title: "Files",
    },
  ];

  it("sends metadata only when a download completes", async () => {
    const { l, sent } = setup({ tabs, downloads: [item] });
    l.download({ id: 4, state: { previous: "in_progress", current: "complete" } });
    await tick();
    await tick();
    expect(sent).toEqual([
      {
        kind: "web",
        act: "download",
        ts: 5000,
        tab: 1,
        frame: 0,
        url: "https://app.example.com/files?token=%3Credacted%3E",
        title: "Files",
        ext: "pdf",
        mime: "application/pdf",
        bytes: 52341,
        origin: "https://cdn.example.com",
        state: "complete",
      },
    ]);
    // Never the file name, the path or the link's query.
    expect(JSON.stringify(sent)).not.toMatch(/secret-name|Downloads|sig=abc|report/);
  });

  it("says interrupted with what arrived; ignores other changes", async () => {
    const { l, sent } = setup({
      tabs,
      downloads: [{ ...item, fileSize: -1, totalBytes: 0, bytesReceived: 1000, filename: "" }],
    });
    l.download({ id: 4, paused: { current: true } });
    l.download({ id: 4, state: { current: "in_progress" } });
    l.download({ id: 4, state: { current: "interrupted" } });
    await tick();
    await tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ state: "interrupted", bytes: 1000, ext: "pdf" });
  });

  it("copes with no active tab or an unknown id", async () => {
    const { l, sent } = setup({ tabs: [], downloads: [item] });
    l.download({ id: 99, state: { current: "complete" } });
    l.download({ id: 4, state: { current: "complete" } });
    await tick();
    await tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ tab: -1, url: "", title: "" });
  });
});
