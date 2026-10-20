/** A response body read up to a byte cap. */
export interface LimitedBody {
  body: Uint8Array;
  /** The body went on past `maxBytes`; `body` holds its first `maxBytes` bytes. */
  truncated: boolean;
}

export interface ReadLimitedBodyParams {
  /** The (already decoded) body stream; null for no body. Counting decoded bytes bounds compression bombs too. */
  stream: ReadableStream<Uint8Array> | null;
  maxBytes: number;
  /** Aborting cancels the body and rejects. */
  signal: AbortSignal;
}

/**
 * Reads a body chunk by chunk and stops at `maxBytes`, cancelling the rest, so a huge (or endless, or decompressing)
 * body is never buffered whole: at most one chunk past the cap is ever pulled.
 */
export async function readLimitedBody(params: ReadLimitedBodyParams): Promise<LimitedBody> {
  const { stream, maxBytes, signal } = params;
  if (stream == null) return { body: new Uint8Array(0), truncated: false };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  const onAbort = (): void => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('The body read was aborted');
      const { done, value } = await reader.read();
      if (done) break;
      const room = maxBytes - size;
      if (value.byteLength > room) {
        chunks.push(value.subarray(0, room));
        size += room;
        truncated = true;
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('The body read was aborted');
  } finally {
    signal.removeEventListener('abort', onAbort);
    // Stop the transfer: the rest is never read.
    if (truncated || signal.aborted) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return { body, truncated };
}
