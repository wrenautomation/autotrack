/**
 * Mac only. uiohook looks up the character of each key press with dispatch_sync onto the main
 * queue, and Node never drains that queue: the first key press froze the hook thread (no more
 * input, and stop() hung). This runs the main CFRunLoop briefly, through CoreFoundation by FFI.
 */
export interface RunLoop {
  /** Handle what is queued on the main thread, waiting up to `waitMs` for one item. */
  drain(waitMs: number): void;
}

const CF = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";

export async function mainRunLoop(): Promise<RunLoop> {
  const koffi = (await import("koffi")).default;
  const cf = koffi.load(CF);
  const run = cf.func("int32 CFRunLoopRunInMode(void *mode, double seconds, bool once)");
  const mode = koffi.decode(cf.symbol("kCFRunLoopDefaultMode", "void *"), "void *");
  return { drain: (waitMs) => run(mode, waitMs / 1000, true) };
}
