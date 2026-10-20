/** One Server-Sent Events message: the optional `event` name and its `data` lines joined with `\n`. */
export interface SseMessage {
  event?: string;
  data: string;
}

interface SseState {
  /** Characters of the line currently being read (no terminator yet). */
  line: string;
  /** True right after a `\r`, so a directly following `\n` is swallowed as part of `\r\n`. */
  isAfterCarriageReturn: boolean;
  eventName?: string;
  dataLines: string[];
}

const COMMENT_PREFIX = ':';
const FIELD_SEPARATOR = ':';
const LEADING_SPACE = ' ';

function createState(): SseState {
  return { line: '', isAfterCarriageReturn: false, dataLines: [] };
}

/** Applies one complete line to the state; returns a message when the line was the blank terminator of one. */
function applyLine(state: SseState, line: string): SseMessage | undefined {
  if (line === '') return dispatch(state);
  if (line.startsWith(COMMENT_PREFIX)) return undefined;
  const separatorIndex = line.indexOf(FIELD_SEPARATOR);
  const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
  const rawValue = separatorIndex === -1 ? '' : line.slice(separatorIndex + 1);
  // WHATWG: exactly one leading space is dropped from the value.
  const value = rawValue.startsWith(LEADING_SPACE) ? rawValue.slice(LEADING_SPACE.length) : rawValue;
  if (field === 'event') state.eventName = value;
  else if (field === 'data') state.dataLines.push(value);
  // Every other field (id, retry, unknown) is deliberately ignored.
  return undefined;
}

function dispatch(state: SseState): SseMessage | undefined {
  const { eventName, dataLines } = state;
  state.eventName = undefined;
  state.dataLines = [];
  // A message with no data lines carries nothing for the consumer.
  if (dataLines.length === 0) return undefined;
  const data = dataLines.join('\n');
  return eventName === undefined ? { data } : { event: eventName, data };
}

/** Feeds decoded text through the line splitter, handling `\n`, `\r\n` and `\r` terminators across chunk edges. */
function feedText(state: SseState, text: string): SseMessage[] {
  const messages: SseMessage[] = [];
  const collect = (message: SseMessage | undefined): void => { if (message) messages.push(message); };
  for (const character of text) {
    if (state.isAfterCarriageReturn) {
      state.isAfterCarriageReturn = false;
      if (character === '\n') continue;
    }
    if (character === '\r' || character === '\n') {
      const { line } = state;
      state.line = '';
      state.isAfterCarriageReturn = character === '\r';
      collect(applyLine(state, line));
    } else {
      state.line += character;
    }
  }
  return messages;
}

/** At end of stream: process an unterminated last line, then flush any message still pending. */
function flush(state: SseState): SseMessage[] {
  const messages: SseMessage[] = [];
  if (state.line !== '') {
    const message = applyLine(state, state.line);
    state.line = '';
    if (message) messages.push(message);
  }
  const pending = dispatch(state);
  if (pending) messages.push(pending);
  return messages;
}

/**
 * Parses a Server-Sent Events byte stream into messages. Safe against arbitrary chunking, including splits inside a
 * line, a `\r\n` pair or a multi-byte UTF-8 character. `[DONE]` is not interpreted: adapters handle it.
 * Abandoning the iterator cancels the underlying body.
 */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncIterable<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  const state = createState();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield* feedText(state, decoder.decode(value, { stream: true }));
    }
    yield* feedText(state, decoder.decode());
    yield* flush(state);
  } finally {
    // Cancel is a no-op on a finished stream and errors on a failed one; neither matters while cleaning up.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
