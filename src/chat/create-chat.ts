import { createAigentError } from '../core/aigent-error.js';
import type { Store } from '../store/store-types.js';
import type { RecordWriter } from '../telemetry/record-writer.js';
import type { PatchLog } from './apply-patch.js';
import { createChatEngine } from './chat-engine.js';
import type { ChatEngine } from './chat-engine.js';
import type { ResolvedChatOptions } from './chat-options.js';
import { buildSession, openStoredSession } from './chat-session.js';
import type { OpenSession } from './chat-session.js';
import type { ChatRuntime, ChatSettings } from './chat-turn.js';
import type { Chat } from './chat-types.js';
import { createSender } from './chat-send.js';
import { createEmptyConversation } from './conversation.js';
import { lineage } from './lineage.js';

export interface CreateChatParams {
  runtime: ChatRuntime;
  options: ResolvedChatOptions;
  /** The runtime's store and writer, used with `persistence: 'store'`. */
  persistence?: { store: Store; writer: RecordWriter };
  /** Lets `ai.close()` wait for the chat's turns and writes. */
  track(work: Promise<unknown>): void;
  /** Lets `ai.close()` close the chat (a turn waiting for an answer would otherwise never settle); returns the unregister. */
  registerCloser(close: () => Promise<void>): () => void;
}

/** Everything a chat method needs once its session is loaded. */
interface Loaded {
  session: OpenSession;
  engine: ChatEngine;
}

export function createChat(params: CreateChatParams): Chat {
  const { runtime, options, persistence, track, registerCloser } = params;
  const { agent, services: { ids, clock } } = runtime;
  const sessionId = options.sessionId ?? ids.next('chat');
  const key = { agentName: agent.name, sessionId };
  const settings: ChatSettings = {
    ...(options.context == null ? {} : { context: options.context }), ...(options.constraints == null ? {} : { constraints: options.constraints }),
    ...(options.unattended == null ? {} : { unattended: options.unattended }), ...(options.modelSettings == null ? {} : { modelSettings: options.modelSettings }),
    ...(options.signal == null ? {} : { signal: options.signal }),
  };
  let loaded: Loaded | undefined;
  const load = (session: OpenSession): void => { loaded = { session, engine: createChatEngine({ runtime, log: session.log, settings }) }; };
  const sessionParams = { key, instanceId: agent.instanceId, clock };
  // An in-memory session is ready at once; a stored one is read first (methods wait for it on their own).
  const ready = options.persistence === 'store' && persistence != null
    ? openStoredSession({ ...sessionParams, persistence }).then(load)
    : Promise.resolve(load(buildSession(sessionParams)));
  track(ready);

  /** Runs `work` now when the session is loaded, else once it is (in call order). */
  function whenLoaded(work: (current: Loaded) => void): void {
    if (loaded != null) { work(loaded); return; }
    void ready.then(() => { if (loaded != null) work(loaded); });
  }

  function log(): PatchLog | undefined {
    return loaded?.session.log;
  }

  const send = createSender({ ids, track, whenLoaded: work => whenLoaded(({ session, engine }) => work({ log: session.log, engine })) });

  function requireLoaded(): Loaded {
    if (loaded == null) throw createAigentError({ code: 'invalid_input', message: `Chat session '${sessionId}' is still loading; await chat.ready first` });
    return loaded;
  }

  function requireLog(): PatchLog {
    const current = log();
    if (current == null) throw createAigentError({ code: 'invalid_input', message: `Chat session '${sessionId}' is still loading; await chat.ready first` });
    return current;
  }

  async function close(): Promise<void> {
    await ready;
    if (loaded == null) return;
    const { engine, session: { log: sessionLog, writer } } = loaded;
    // A turn waiting for an answer could wait forever: it is cancelled, and its questions stay open (and stored).
    if (sessionLog.state().status === 'waiting_for_user') engine.stopActive({ mode: 'immediate' });
    await engine.idle();
    writer?.snapshot(sessionLog.state());
    await writer?.flush();
  }

  const unregister = registerCloser(() => close());
  const chat: Chat = {
    sessionId,
    ready,
    send,
    conversation: () => log()?.state() ?? createEmptyConversation(key),
    subscribe: (listener, subscribeOptions) => {
      let unsubscribe: (() => void) | undefined;
      let isActive = true;
      whenLoaded(({ session }) => { if (isActive) unsubscribe = session.log.subscribe(listener, subscribeOptions); });
      return () => { isActive = false; unsubscribe?.(); };
    },
    history: () => (log() == null ? [] : lineage({ state: requireLog().state() })),
    setContext: text => { settings.context = text; },
    feedback: async feedback => {
      await ready;
      const latest = [...lineage({ state: requireLog().state() })].reverse().find(({ meta }) => meta.responseId != null)?.meta.responseId;
      const responseId = feedback.responseId ?? latest;
      if (responseId == null) throw createAigentError({ code: 'invalid_input', message: `Chat session '${sessionId}' has no reply to rate yet`, details: { sessionId } });
      await runtime.services.submitFeedback({ ...feedback, responseId });
    },
    answer: (questionId, value) => {
      const result = requireLoaded().engine.questions.answer({ questionId, value });
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    },
    react: async (messageId, rating, comment) => {
      await ready;
      const sessionLog = requireLog();
      const message = sessionLog.state().messages.find(({ id }) => id === messageId);
      const responseId = message?.meta.responseId;
      if (message == null || responseId == null) {
        throw createAigentError({ code: 'invalid_input', message: `Cannot react to message '${messageId}' in session '${sessionId}': it is not a finished agent reply`, details: { messageId } });
      }
      await runtime.services.submitFeedback({ responseId, rating: rating === 'up' ? 'correct' : 'incorrect', ...(comment == null ? {} : { comment }) });
      // Read again: the message may have changed while the feedback was stored.
      const { meta } = sessionLog.state().messages.find(({ id }) => id === messageId) ?? message;
      sessionLog.append({ type: 'message-updated', messageId, set: { meta: { ...meta, userRating: rating } } });
    },
    close: () => { unregister(); const closing = close(); track(closing); return closing; },
  };
  return chat;
}
