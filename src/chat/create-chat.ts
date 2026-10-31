import { createAigentError } from '../core/aigent-error.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { Store } from '../store/store-types.js';
import { createRecordWriter } from '../telemetry/record-writer.js';
import type { RecordWriter } from '../telemetry/record-writer.js';
import type { PatchLog } from './apply-patch.js';
import { attachmentSaver, prepareAttachments } from './attachments.js';
import { closedError } from './chat-closed.js';
import { createChatEngine } from './chat-engine.js';
import type { ChatEngine } from './chat-engine.js';
import { rateReply, reactTo } from './chat-feedback.js';
import { branchAndRun, forkSeed, selectBranch, setPinned, threadOf } from './chat-navigation.js';
import type { ResolvedChatOptions } from './chat-options.js';
import { createSender } from './chat-send.js';
import { buildSession, openStoredSession } from './chat-session.js';
import type { OpenSession } from './chat-session.js';
import { titleRouting, titleSession } from './chat-title.js';
import { createSuspendedTurns } from './suspended-turns.js';
import { resumeOnDecision } from './engine-approvals.js';
import type { ChatRuntime, ChatSettings } from './chat-turn.js';
import type { Chat } from './chat-types.js';
import { createEmptyConversation } from './conversation.js';
import { lineage } from './lineage.js';
import { memoryOnlyRuntime } from './memory-runtime.js';

export interface CreateChatParams {
  runtime: ChatRuntime;
  options: ResolvedChatOptions;
  /** The runtime's store and writer, used with `persistence: 'store'`. */
  persistence?: { store: Store; writer: RecordWriter };
  /** Lets `ai.close()` wait for the chat's turns and writes. */
  track(work: Promise<unknown>): void;
  /** Lets `ai.close()` close the chat (a turn waiting for an answer would otherwise never settle); returns the unregister. */
  registerCloser(close: () => Promise<void>): () => void;
  /** A fork's first patches. */
  seed?(log: PatchLog): void;
  /**
   * The runtime's open stored sessions (`<agentName>:<sessionId>`): two live chats on one stored session would number
   * their patches from the same seq and overwrite each other's chunks, so a second open is refused.
   */
  openSessions?: Set<string>;
}

/** Everything a chat method needs once its session is loaded. */
interface Loaded {
  session: OpenSession;
  engine: ChatEngine;
}

function chatSettings(options: ResolvedChatOptions): ChatSettings {
  const { context, constraints, unattended, dryRun, modelSettings, signal, memoryScopeKey } = options;
  return {
    ...(context == null ? {} : { context }), ...(constraints == null ? {} : { constraints }), ...(unattended == null ? {} : { unattended }), ...(dryRun == null ? {} : { dryRun }),
    ...(modelSettings == null ? {} : { modelSettings }), ...(signal == null ? {} : { signal }), ...(memoryScopeKey == null ? {} : { memoryScopeKey }),
  };
}

export function createChat(params: CreateChatParams): Chat {
  const { options, persistence, track, registerCloser, seed } = params;
  const runtime = options.persistence === 'memory' ? memoryOnlyRuntime(params.runtime) : params.runtime;
  const { agent, services } = runtime;
  const { ids, clock, writeQueue } = services;
  const now = (): number => clock.now();
  const sessionId = options.sessionId ?? ids.next('chat');
  const key = { agentName: agent.name, sessionId };
  const settings = chatSettings(options);
  const stored = options.persistence === 'store' ? persistence : undefined;
  const openKey = `${agent.name}:${sessionId}`;
  if (stored != null && params.openSessions?.has(openKey) === true) {
    throw createAigentError({ code: 'invalid_input', message: `Chat session '${sessionId}' of agent '${agent.name}' is already open in this runtime; close it before opening it again`, details: { sessionId, agentName: agent.name } });
  }
  if (stored != null) params.openSessions?.add(openKey);
  let loaded: Loaded | undefined;
  /** The one title call in flight; close() aborts it rather than waiting for a slow model. */
  let titling: Promise<void> | undefined;
  const titleAbort = new AbortController();

  function afterReply(): void {
    const log = loaded?.session.log;
    if (options.autoTitle !== true || titling != null || log == null || log.state().title != null) return;
    const signals = [titleAbort.signal, ...(settings.signal == null ? [] : [settings.signal])];
    titling = titleSession({ log, routing: titleRouting({ agent, services }), signals }).finally(() => { titling = undefined; });
  }

  // With checkpoints, a stored session's suspended turns can be continued after a restart.
  const suspended = stored == null || services.resume == null ? undefined : createSuspendedTurns({ runtime: services.resume, agent, sessionId, clock, track });
  const load = (session: OpenSession): void => {
    const engine = createChatEngine({ runtime, log: session.log, settings, afterReply, ...(options.onStop == null ? {} : { onStop: options.onStop }), ...(suspended == null ? {} : { suspended }) });
    loaded = { session, engine };
    if (suspended != null && agent.approvals != null) resumeOnDecision({ suspended, approvals: agent.approvals, ids, accept: pending => engine.accept(pending) });
  };
  const sessionParams = { key, instanceId: agent.instanceId, clock, ...(seed == null ? {} : { seed }) };
  // An in-memory session is ready at once; a stored one is read first (methods wait for it on their own).
  const ready = stored != null ? Promise.all([openStoredSession({ ...sessionParams, persistence: stored }), suspended?.load()]).then(([session]) => load(session)) : Promise.resolve(load(buildSession(sessionParams)));
  track(ready);

  function whenLoaded(work: (current: Loaded) => void): void {
    if (loaded != null) { work(loaded); return; }
    void ready.then(() => { if (loaded != null) work(loaded); });
  }

  function requireLoaded(): Loaded {
    if (loaded == null) throw createAigentError({ code: 'invalid_input', message: `Chat session '${sessionId}' is still loading; await chat.ready first`, details: { sessionId } });
    return loaded;
  }

  const requireLog = (): PatchLog => requireLoaded().session.log;
  const navigation = (): { log: PatchLog; engine: ChatEngine; ids: typeof ids; now: () => number } => ({ log: requireLog(), engine: requireLoaded().engine, ids, now });
  const save = attachmentSaver({ writer: stored?.writer ?? createRecordWriter({ store: createInMemoryStore(), writeQueue }), queueKey: `chat:${agent.name}:${sessionId}` });

  const send = createSender({
    ids, track, whenLoaded: work => whenLoaded(({ session, engine }) => work({ log: session.log, engine })),
    defaults: { delivery: options.whileBusy ?? 'queue', coalesce: options.coalesce ?? false },
    prepareAttachments: attachments => prepareAttachments({ attachments, options: options.attachments ?? {}, vision: agent.targets[0].provider.capabilities.vision, model: agent.targets[0].reference, save, now }),
  });

  let isClosed = false;
  /** Anything that would change a closed session throws instead (sends fail their own turn in the engine). */
  function requireOpen(): void {
    if (isClosed) throw closedError(sessionId);
  }

  async function close(): Promise<void> {
    isClosed = true;
    try {
      await closeSession();
    } finally {
      if (stored != null) params.openSessions?.delete(openKey);
    }
  }

  async function closeSession(): Promise<void> {
    await ready;
    if (loaded == null) return;
    const { engine, session: { log, writer } } = loaded;
    // A turn waiting for an answer (now or once it asks) could wait forever: it is cancelled, its questions stay open (and stored).
    engine.close();
    await engine.idle();
    titleAbort.abort();
    await titling;
    if (writer == null) return;
    // Never a snapshot ahead of patches that are not stored: the writer refuses it after a failure.
    writer.snapshot(log.state());
    const failures = await writer.flush();
    const failedSeqs = writer.failedSeqs();
    if (failedSeqs.length > 0) {
      throw createAigentError({
        code: 'store_failed', message: `Chat session '${sessionId}' closed with ${failedSeqs.length} patch(es) not stored (seqs ${failedSeqs[0]}-${failedSeqs.at(-1)}): ${failures.join('; ')}`,
        details: { sessionId, agentName: agent.name, failedSeqs, failures },
      });
    }
  }

  const unregister = registerCloser(() => close());
  const chat: Chat = {
    sessionId,
    ready,
    send,
    conversation: () => loaded?.session.log.state() ?? createEmptyConversation(key),
    subscribe: (listener, subscribeOptions) => {
      let unsubscribe: (() => void) | undefined;
      let isActive = true;
      whenLoaded(({ session }) => { if (isActive) unsubscribe = session.log.subscribe(listener, subscribeOptions); });
      return () => { isActive = false; unsubscribe?.(); };
    },
    history: () => (loaded == null ? [] : lineage({ state: requireLog().state() })),
    setContext: text => { settings.context = text; },
    feedback: async feedback => { await ready; await rateReply({ log: requireLog(), submit: services.submitFeedback, feedback }); },
    react: async (messageId, rating, comment) => { await ready; await reactTo({ log: requireLog(), submit: services.submitFeedback, messageId, rating, ...(comment == null ? {} : { comment }) }); },
    answer: (questionId, value) => {
      if (isClosed) return { ok: false, error: closedError(sessionId).message };
      const result = requireLoaded().engine.questions.answer({ questionId, value });
      if (!result.ok) return { ok: false, error: result.error };
      return result.freshTurn == null ? { ok: true } : { ok: true, turn: result.freshTurn.turn };
    },
    queue: Object.assign(() => (loaded == null ? [] : requireLoaded().engine.queue.list()), {
      edit: (id: string, text: string) => requireLoaded().engine.queue.edit(id, text),
      move: (id: string, toIndex: number) => requireLoaded().engine.queue.move(id, toIndex),
      remove: (id: string) => requireLoaded().engine.queue.remove(id),
    }),
    thread: messageId => threadOf({ ...navigation(), messageId }),
    fork: (forkOptions = {}) => { requireOpen(); return createChat({ ...params, options: { ...options, sessionId: ids.next('chat') }, seed: forkSeed({ parent: requireLog(), ...(forkOptions.atMessageId == null ? {} : { atMessageId: forkOptions.atMessageId }) }) }); },
    branches: () => requireLog().state().branches,
    selectBranch: branchId => selectBranch({ log: requireLog(), branchId }),
    edit: (messageId, newText) => { requireOpen(); return branchAndRun({ ...navigation(), messageId, reason: 'edit', newText }); },
    regenerate: messageId => { requireOpen(); return branchAndRun({ ...navigation(), messageId, reason: 'regenerate' }); },
    pin: messageId => setPinned({ log: requireLog(), messageId, pinned: true }),
    unpin: messageId => setPinned({ log: requireLog(), messageId, pinned: false }),
    close: () => { unregister(); const closing = close(); track(closing); return closing; },
  };
  return chat;
}
