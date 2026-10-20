// Test-only HTTP doubles for provider adapters. Excluded from the build (see tsconfig.build.json) and never exported.

/** One call the fake `fetch` received. */
export interface RecordedRequest {
  url: string;
  init: RequestInit;
}

/** How a fake body ends once its chunks are delivered. */
export type FakeBodyEnding = 'close' | 'hang' | 'error';

export interface FakeBodyOptions {
  chunks: Uint8Array[];
  /** Pause before each chunk, so a consumer can abort mid-stream. */
  delayMs?: number;
  /** `hang` never closes (only cancel ends it); `error` fails the stream like a dropped connection. Default `close`. */
  ending?: FakeBodyEnding;
}

export interface FakeBody {
  stream: ReadableStream<Uint8Array>;
  /** True once the consumer cancelled the body. */
  isCancelled(): boolean;
}

export interface FakeResponseSpec {
  status?: number;
  body: FakeBody | string;
}

export interface FakeFetch {
  fetch: typeof fetch;
  requests: RecordedRequest[];
}

const OK_STATUS = 200;
const NETWORK_ERROR_MESSAGE = 'socket hang up';

const encoder = new TextEncoder();

export function encodeText(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Splits text into network chunks of `size` bytes, so lines and multi-byte characters are cut mid-way. */
export function byteChunks(params: { text: string; size: number }): Uint8Array[] {
  const { text, size } = params;
  const bytes = encodeText(text);
  const chunks: Uint8Array[] = [];
  for (let start = 0; start < bytes.length; start += size) chunks.push(bytes.slice(start, start + size));
  return chunks;
}

export function createFakeBody(options: FakeBodyOptions): FakeBody {
  const { chunks, delayMs = 0, ending = 'close' } = options;
  let nextChunk = 0;
  let isCancelled = false;
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  const wait = (): Promise<void> => new Promise(resolve => { pendingTimer = setTimeout(resolve, delayMs); });

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = chunks[nextChunk];
      if (chunk == null) {
        if (ending === 'close') controller.close();
        else if (ending === 'error') controller.error(new TypeError(NETWORK_ERROR_MESSAGE));
        // 'hang': leave the pull unresolved forever; only cancel ends the stream.
        else await new Promise<never>(() => undefined);
        return;
      }
      if (delayMs > 0) await wait();
      if (isCancelled) return;
      nextChunk += 1;
      controller.enqueue(chunk);
    },
    cancel() {
      isCancelled = true;
      clearTimeout(pendingTimer);
    },
  });
  return { stream, isCancelled: () => isCancelled };
}

/** A `fetch` double that records every call and answers each with the next spec from `respond`. */
export function createFakeFetch(respond: (request: RecordedRequest) => FakeResponseSpec): FakeFetch {
  const requests: RecordedRequest[] = [];
  const fakeFetch: typeof fetch = async (input, init = {}) => {
    const request: RecordedRequest = { url: String(input), init };
    requests.push(request);
    const { status = OK_STATUS, body } = respond(request);
    return new Response(typeof body === 'string' ? body : body.stream, { status });
  };
  return { fetch: fakeFetch, requests };
}
