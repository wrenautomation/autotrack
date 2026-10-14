/**
 * `<device>/heartbeat.json`: the device says it is alive, what runs and what is wrong, at start,
 * before an update restart and every 15 minutes. autobrowse reads it (`autotrack devices`) and
 * the desk posts when one goes silent. Not under a session, so nothing that reads sessions sees it.
 */
import type { ObjectStore } from "./ship.ts";
import type { UpdaterStatus } from "./update.ts";

export const BEAT_MS = 15 * 60_000;

export interface ShipStatus {
  at: string;
  ok: boolean;
  error: string | null;
}

export interface Heartbeat {
  v: 1;
  version: string;
  platform: string;
  arch: string;
  os: string;
  at: string;
  startedAt: string;
  paused: string | null;
  level: string | null;
  waiting: { segments: number; bytes: number };
  ship: ShipStatus | null;
  update: Pick<UpdaterStatus, "checkedAt" | "latest" | "state" | "error"> | null;
}

export interface HeartOptions {
  store: ObjectStore | null;
  device: string;
  body(): Heartbeat;
  log?: (msg: string) => void;
}

export class Heart {
  private timer: NodeJS.Timeout | null = null;
  private beating: Promise<boolean> | null = null;

  private readonly o: HeartOptions;

  constructor(o: HeartOptions) {
    this.o = o;
  }

  /** One put; false when there is no code or it failed (logged; the next beat tries again). */
  beat(): Promise<boolean> {
    const store = this.o.store;
    if (!store) return Promise.resolve(false);
    this.beating ??= (async () => {
      try {
        const body = new TextEncoder().encode(`${JSON.stringify(this.o.body())}\n`);
        await store.put(`${this.o.device}/heartbeat.json`, body, "application/json");
        return true;
      } catch (e) {
        this.o.log?.(`heartbeat: ${(e as Error).message}`);
        return false;
      } finally {
        this.beating = null;
      }
    })();
    return this.beating;
  }

  start(every = BEAT_MS): void {
    this.stop();
    this.timer = setInterval(() => void this.beat(), every);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
