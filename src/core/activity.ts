import type { PlanItemState } from '../planning/plan-schema.js';
import type { Usage } from '../providers/provider-types.js';
import { createActivityState, currentCalls, isTerminalPhase, reduceActivity, setPhase, statusText, terminalPhase } from './activity-state.js';
import type { ActivityState } from './activity-state.js';
import type { ActivityPhase, ActivityUpdate } from './activity-update.js';
import type { AigentEvent, TaskStatus } from './aigent-events.js';
import type { Clock, Sleeper } from './runtime-services.js';

/** At most one update per this many ms (the terminal update is never held back). */
export const DEFAULT_ACTIVITY_THROTTLE_MS = 250;
/** A keep-alive update after this long without one, while the agent is busy. */
export const DEFAULT_ACTIVITY_HEARTBEAT_MS = 5_000;

/** `createAigent({ activity })`. */
export interface ActivityOptions {
  /** Default 250. */
  throttleMs?: number;
  /** Default 5000. */
  heartbeatMs?: number;
}

export interface CreateActivityParams {
  runId: string;
  messageId?: string;
  clock: Clock;
  sleep: Sleeper;
  options?: ActivityOptions;
  maxTurns: number;
  plan?: readonly PlanItemState[];
  criteriaTotal?: number;
  /** The run's cost so far (0 without a price). */
  price(usage: Usage): number;
  publish(update: ActivityUpdate): void;
}

export interface ActivityPublisher {
  observe(event: AigentEvent): void;
  /** Moves to a phase the events do not show (`finishing`). */
  enter(phase: Exclude<ActivityPhase, 'done' | 'failed' | 'cancelled'>): void;
  /** Publishes the terminal update at once and stops every timer; later calls do nothing. */
  finish(status: TaskStatus): void;
}

/** Turns loop events into throttled activity updates with heartbeats; no model call of its own. */
export function createActivityPublisher(params: CreateActivityParams): ActivityPublisher {
  const { runId, messageId, clock, sleep, options = {}, maxTurns, plan, criteriaTotal = 0, price, publish } = params;
  const { throttleMs = DEFAULT_ACTIVITY_THROTTLE_MS, heartbeatMs = DEFAULT_ACTIVITY_HEARTBEAT_MS } = options;
  const startedAt = clock.now();
  const timers = new AbortController();
  let state: ActivityState = createActivityState(plan);
  let seq = 0;
  let lastPublishedAt = Number.NEGATIVE_INFINITY;
  let isTrailingScheduled = false;
  let isDirty = false;

  function snapshot(params: { heartbeat: boolean; now: number }): ActivityUpdate {
    const { heartbeat, now } = params;
    const { phase, tokens, responses, plan: planCount, todo } = state;
    const current = currentCalls(state);
    const isTerminal = isTerminalPhase(phase);
    seq += 1;
    return {
      seq, runId, ...(messageId == null ? {} : { messageId }), phase, statusText: statusText(state),
      ...(current.length === 0 ? {} : { current: current.map(call => ({ ...call })) }),
      progress: {
        planDone: planCount.done, planTotal: planCount.total, todoDone: todo.done, todoTotal: todo.total, criteriaMet: 0, criteriaTotal,
        turn: isTerminal ? responses : Math.min(responses + 1, maxTurns), maxTurns,
      },
      elapsedMs: now - startedAt, tokens: { input: tokens.input, output: tokens.output },
      costUsd: price({ inputTokens: tokens.input, outputTokens: tokens.output, cachedTokens: tokens.cached }), heartbeat,
    };
  }

  // The clock is read once per change (never per event), since an injected clock may count its reads.
  function emitNow(params: { heartbeat: boolean; now: number }): void {
    isDirty = false;
    lastPublishedAt = params.now;
    publish(snapshot(params));
  }

  function scheduleTrailing(now: number): void {
    if (isTrailingScheduled) return;
    isTrailingScheduled = true;
    const waitMs = Math.max(lastPublishedAt + throttleMs - now, 0);
    void sleep(waitMs, timers.signal).then(() => {
      isTrailingScheduled = false;
      if (!timers.signal.aborted && isDirty) emitNow({ heartbeat: false, now: clock.now() });
    });
  }

  function changed(next: ActivityState): void {
    if (next === state || isTerminalPhase(state.phase)) return;
    state = next;
    isDirty = true;
    const now = clock.now();
    if (now - lastPublishedAt >= throttleMs) emitNow({ heartbeat: false, now });
    else scheduleTrailing(now);
  }

  async function heartbeats(): Promise<void> {
    while (!timers.signal.aborted) {
      await sleep(heartbeatMs, timers.signal);
      // Waiting for the user is not being busy, so nothing needs keeping alive then.
      if (timers.signal.aborted || state.phase === 'waiting_for_user') continue;
      const now = clock.now();
      if (now - lastPublishedAt >= heartbeatMs) emitNow({ heartbeat: true, now });
    }
  }

  emitNow({ heartbeat: false, now: startedAt });
  void heartbeats();

  return {
    observe: event => changed(reduceActivity(event.type === 'queued' ? state : setPhase(state, state.phase === 'queued' ? 'thinking' : state.phase), { event, now: () => clock.now() })),
    enter: phase => changed(setPhase(state, phase)),
    finish: status => {
      if (isTerminalPhase(state.phase)) return;
      timers.abort();
      state = { ...setPhase(state, terminalPhase(status)), current: [], delegated: {} };
      emitNow({ heartbeat: false, now: clock.now() });
    },
  };
}
