/**
 * Native messaging framing: each message is a 4-byte little-endian length, then that many bytes
 * of UTF-8 JSON. Chrome caps host → browser messages at 1 MB; the host holds browser → host
 * messages to the same cap and skips (without buffering) any larger one.
 */

export const MAX_MESSAGE = 1024 * 1024;

/** One framed message. Throws when the JSON is over the cap. */
export function encode(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > MAX_MESSAGE) throw new Error(`message over ${MAX_MESSAGE} bytes`);
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

/**
 * Feed chunks as they arrive (any split); calls `onMessage(value)` per whole message and
 * `onError(error)` for one that is oversized or not JSON, then carries on with the next.
 */
export class Decoder {
  constructor(onMessage, onError = () => {}, max = MAX_MESSAGE) {
    this.onMessage = onMessage;
    this.onError = onError;
    this.max = max;
    this.buf = Buffer.alloc(0);
    this.skip = 0; // bytes of an oversized body still to discard
  }

  push(chunk) {
    let data = chunk;
    if (this.skip) {
      const n = Math.min(this.skip, data.length);
      this.skip -= n;
      data = data.subarray(n);
      if (!data.length) return;
    }
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : data;
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0);
      if (len > this.max) {
        const have = Math.min(len, this.buf.length - 4);
        this.skip = len - have;
        this.buf = this.buf.subarray(4 + have);
        this.onError(new Error(`message of ${len} bytes over ${this.max}`));
        if (this.skip) return;
        continue;
      }
      if (this.buf.length < 4 + len) return;
      const body = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      let value;
      try {
        value = JSON.parse(body.toString("utf8"));
      } catch (e) {
        this.onError(e);
        continue;
      }
      this.onMessage(value);
    }
  }
}
