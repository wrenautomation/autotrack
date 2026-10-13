/** Worker thread: RGBA in, JPEG out, so encoding never stalls the input hook. */
import { parentPort } from "node:worker_threads";
import { encodeJpeg } from "./jpeg.ts";

parentPort?.on("message", (m: { id: number; rgba: Uint8Array; width: number; height: number }) => {
  try {
    const jpeg = encodeJpeg(m.rgba, m.width, m.height);
    parentPort?.postMessage({ id: m.id, jpeg }, [jpeg.buffer as ArrayBuffer]);
  } catch (e) {
    parentPort?.postMessage({ id: m.id, error: (e as Error).message });
  }
});
