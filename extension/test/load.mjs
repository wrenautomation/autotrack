/** Loads the shipped content scripts into a jsdom page, as Chrome would at document_start. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const ext = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ISOLATED = [
  "content/redact.js",
  "content/hints.js",
  "content/outline.js",
  "content/bridge.js",
  "content/content.js",
];
export const source = (file) => readFileSync(join(ext, file), "utf8");

/**
 * @param {string} html
 * @param {{trusted?: boolean, order?: "main-first"|"isolated-first"|"isolated-only", files?: string[], url?: string, setup?: (w: any) => void}} [o]
 */
export function page(html, o = {}) {
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: o.url ?? "https://app.example.com/inbox?token=abc123&tab=2",
    pretendToBeVisual: true,
  });
  const w = dom.window;
  w.TextEncoder ??= TextEncoder;
  const sent = [];
  w.chrome = {
    runtime: {
      sendMessage: (m) => {
        sent.push(JSON.parse(JSON.stringify(m.autotrack)));
        return Promise.resolve();
      },
    },
  };
  // Synthetic events are never trusted in jsdom; tests opt in to treating them as real input.
  if (o.trusted !== false) w.__autotrack = { trusted: () => true };
  o.setup?.(w);
  const order = o.order ?? "main-first";
  const files = o.files ?? ISOLATED;
  if (order === "main-first") w.eval(source("main.js"));
  for (const f of files) w.eval(source(f));
  if (order === "isolated-first") w.eval(source("main.js"));
  return { dom, w, doc: w.document, sent, AT: w.__autotrack };
}
