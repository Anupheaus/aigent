import type { Clock } from '../core/runtime-services.js';
import type { Store } from '../store/store-types.js';
import type { RecordWriter } from '../telemetry/record-writer.js';
import { createPatchLog } from './apply-patch.js';
import type { PatchLog } from './apply-patch.js';
import { createEmptyConversation } from './conversation.js';
import type { Patch } from './patches.js';
import { createSessionWriter, loadSession } from './session-persistence.js';
import type { SessionKey, SessionWriter, StoredSession } from './session-persistence.js';

export interface OpenSessionParams {
  key: SessionKey;
  instanceId: string;
  clock: Clock;
  /** Present with `persistence: 'store'`: the session is read from it and every patch written to it. */
  persistence?: { store: Store; writer: RecordWriter };
  /** Patches a forked session starts with (written like any other). */
  seed?(log: PatchLog): void;
}

export interface OpenSession {
  log: PatchLog;
  /** Absent with `persistence: 'memory'`. */
  writer?: SessionWriter;
}

/** A reopened session's reply that was still streaming has no run any more: it is kept as cancelled. */
function settleOrphans(log: PatchLog): void {
  const state = log.state();
  for (const { id, state: messageState } of state.messages) if (messageState === 'streaming') log.append({ type: 'message-interrupted', messageId: id });
  if (state.status !== 'idle') log.append({ type: 'status-changed', status: 'idle' });
}

/** Builds the session from what was stored (nothing for a new or in-memory one) and wires new patches to the store. */
export function buildSession(params: OpenSessionParams & { stored?: StoredSession }): OpenSession {
  const { key, instanceId, clock, persistence, seed, stored } = params;
  const base = createEmptyConversation(key);
  const history: Patch[] = stored?.patches ?? [];
  const snapshot = stored?.record.snapshot;
  const log = createPatchLog({ base, history, ...(snapshot == null ? {} : { snapshot }), now: () => clock.now() });
  const writer = persistence == null ? undefined : createSessionWriter({ writer: persistence.writer, key, instanceId });
  if (writer != null) log.subscribe(patch => writer.append(patch, log.state()));
  if (stored != null) settleOrphans(log);
  else seed?.(log);
  return { log, ...(writer == null ? {} : { writer }) };
}

/** Loads (or starts) a stored session. */
export async function openStoredSession(params: OpenSessionParams & { persistence: NonNullable<OpenSessionParams['persistence']> }): Promise<OpenSession> {
  const stored = await loadSession({ store: params.persistence.store, key: params.key });
  return buildSession({ ...params, ...(stored == null ? {} : { stored }) });
}
