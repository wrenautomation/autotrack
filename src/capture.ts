/**
 * The real screen: node-screenshots for captures and display geometry, and a worker thread
 * for JPEG encoding (inline when a worker can't start).
 *
 * Memory: a Retina capture is 24 MB of native memory V8 can't see, freed only when its JS
 * wrapper is collected, so each capture first runs a minor GC. Frames reach the worker through
 * one reused SharedArrayBuffer (the capture's buffer can't be transferred), one at a time.
 */
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { Worker } from "node:worker_threads";
import type { Screen as CoordScreen, Coords } from "./coords.ts";
import type { Display } from "./events.ts";
import { encodeJpeg, fitSize } from "./jpeg.ts";
import type { FrontAnswer } from "./probe.ts";
import type { Capturer, Encode, Shot } from "./screen.ts";

type Monitor = import("node-screenshots").Monitor;

/** A minor GC, or nothing when the flag can't be set. */
export const collect: () => void = (() => {
  try {
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as (o: { type: "minor" }) => void;
    return () => gc({ type: "minor" });
  } catch {
    return () => {};
  }
})();

export async function nodeCapturer(coords: () => Coords): Promise<Capturer> {
  const { Monitor } = await import("node-screenshots");
  const logical = (m: Monitor) =>
    coords().rect({ x: m.x(), y: m.y(), width: m.width(), height: m.height() });
  return {
    displays(): Display[] {
      return Monitor.all().map((m) => {
        const r = logical(m);
        const frame = fitSize(r.width * m.scaleFactor(), r.height * m.scaleFactor());
        return {
          id: String(m.id()),
          ...r,
          scale: Math.round((frame.width / r.width) * 1000) / 1000,
          primary: m.isPrimary(),
        };
      });
    },
    async capture(x, y): Promise<Shot | null> {
      const p = coords().toPhysical(x, y);
      const m = Monitor.fromPoint(p.x, p.y) ?? Monitor.all().find((d) => d.isPrimary()) ?? null;
      if (!m) return null;
      collect();
      let img: Awaited<ReturnType<Monitor["captureImage"]>> | null = await m.captureImage();
      let raw: Promise<Uint8Array> | null = null;
      return {
        display: String(m.id()),
        width: img.width,
        height: img.height,
        raw: () => {
          raw ??= img ? img.toRaw() : Promise.reject(new Error("frame released"));
          return raw;
        },
        release: () => {
          img = null;
          raw = null;
        },
      };
    },
  };
}

/** Displays as the OS reports them (physical pixels on Windows), for `coordsFor`. */
export async function osScreens(): Promise<CoordScreen[]> {
  const { Monitor } = await import("node-screenshots");
  return Monitor.all().map((m) => ({
    x: m.x(),
    y: m.y(),
    width: m.width(),
    height: m.height(),
    scale: m.scaleFactor(),
  }));
}

/** The display id under a logical point, without capturing. */
export async function displayAt(
  coords: () => Coords,
): Promise<(x: number, y: number) => string | undefined> {
  const { Monitor } = await import("node-screenshots");
  return (x, y) => {
    const p = coords().toPhysical(x, y);
    const m = Monitor.fromPoint(p.x, p.y);
    return m ? String(m.id()) : undefined;
  };
}

/**
 * Front app and window from the window list, for when the probe helper is missing: no bundle id
 * or exe path, so excluded apps match by name only.
 */
export async function windowFront(coords: () => Coords): Promise<() => FrontAnswer | null> {
  const { Window } = await import("node-screenshots");
  return () => {
    const focused = Window.all().filter((w) => w.isFocused() && !w.isMinimized());
    const w = focused.find((f) => f.title()) ?? focused[0];
    if (!w) return null;
    return {
      app: { name: w.appName(), id: "", pid: w.pid() },
      window: coords().rect({
        title: w.title(),
        x: w.x(),
        y: w.y(),
        width: w.width(),
        height: w.height(),
      }),
    };
  };
}

const inline: Encode = async (rgba, w, h) => encodeJpeg(rgba, w, h);

/** Encode on a worker thread; inline if the worker fails to start or dies. */
export function workerEncoder(log?: (msg: string) => void): { encode: Encode; close(): void } {
  const ext = import.meta.url.endsWith(".ts") ? "ts" : "js";
  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL(`./jpeg-worker.${ext}`, import.meta.url));
    worker.unref();
  } catch (e) {
    log?.(`screen: encoder worker failed, encoding inline: ${(e as Error).message}`);
  }
  let next = 1;
  const waiting = new Map<
    number,
    { resolve: (b: Uint8Array) => void; reject: (e: Error) => void }
  >();
  worker?.on("message", (m: { id: number; jpeg?: Uint8Array; error?: string }) => {
    const w = waiting.get(m.id);
    waiting.delete(m.id);
    if (m.jpeg) w?.resolve(m.jpeg);
    else w?.reject(new Error(m.error ?? "encode failed"));
  });
  worker?.on("error", (e) => {
    log?.(`screen: encoder worker died, encoding inline: ${e.message}`);
    worker = null;
    for (const w of waiting.values()) w.reject(e);
    waiting.clear();
  });
  let shared: SharedArrayBuffer | null = null;
  let turn: Promise<unknown> = Promise.resolve();
  const viaWorker = (w: Worker, rgba: Uint8Array, width: number, height: number) => {
    if (!shared || shared.byteLength < rgba.length) shared = new SharedArrayBuffer(rgba.length);
    const view = new Uint8Array(shared, 0, rgba.length);
    view.set(rgba);
    const id = next++;
    return new Promise<Uint8Array>((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      w.postMessage({ id, rgba: view, width, height });
    });
  };
  return {
    encode(rgba, width, height) {
      const run = async () => {
        const w = worker;
        return w ? viaWorker(w, rgba, width, height) : inline(rgba, width, height);
      };
      const result = turn.then(run, run); // one at a time: the shared buffer is reused
      turn = result.catch(() => {});
      return result;
    },
    close() {
      void worker?.terminate();
      worker = null;
    },
  };
}
