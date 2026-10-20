import { PLAN_COMPLETE_TOOL_NAME } from '../planning/plan-complete-tool.js';
import { TODO_TOOL_NAME } from '../planning/todo-tool.js';
import type { PlanItemState } from '../planning/plan-schema.js';
import type { AigentEvent, TaskStatus } from './aigent-events.js';
import type { ActivityPhase, ActivityToolCall } from './activity-update.js';
import { ASK_USER_TOOL_NAME } from './ask-user-name.js';


const PLANNING_TOOLS: ReadonlySet<string> = new Set([PLAN_COMPLETE_TOOL_NAME, TODO_TOOL_NAME]);

interface DoneCount {
  done: number;
  total: number;
}

/** Everything an activity update is derived from. Plain data, replaced (never mutated) by `reduceActivity`. */
export interface ActivityState {
  phase: ActivityPhase;
  /** The agent's own `::aigent status` text, until the phase changes. */
  agentStatus?: string;
  current: ActivityToolCall[];
  /** Calls in flight in delegated sub-runs, by the parent's `delegate` call id. */
  delegated: Record<string, ActivityToolCall[]>;
  /** Latest activity title per call in flight. */
  titles: Record<string, string>;
  tokens: { input: number; output: number; cached: number };
  /** Model responses finished (one `usage` event each). */
  responses: number;
  plan: DoneCount;
  todo: DoneCount;
}

const TERMINAL_PHASES: ReadonlySet<ActivityPhase> = new Set<ActivityPhase>(['done', 'failed', 'cancelled']);

export function isTerminalPhase(phase: ActivityPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

function countDone(items: readonly { status: string }[]): DoneCount {
  return { done: items.filter(({ status }) => status === 'done').length, total: items.length };
}

export function createActivityState(plan: readonly PlanItemState[] = []): ActivityState {
  return { phase: 'thinking', current: [], delegated: {}, titles: {}, tokens: { input: 0, output: 0, cached: 0 }, responses: 0, plan: countDone(plan), todo: { done: 0, total: 0 } };
}

/** The terminal phase a run's status maps to. */
export function terminalPhase(status: TaskStatus): ActivityPhase {
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  return 'done';
}

function withPhase(state: ActivityState, phase: ActivityPhase): ActivityState {
  return state.phase === phase ? state : { ...state, phase, agentStatus: undefined };
}

function phaseForCalls(current: ActivityToolCall[]): ActivityPhase {
  if (current.length === 0) return 'thinking';
  if (current.some(({ tool }) => tool === ASK_USER_TOOL_NAME)) return 'waiting_for_user';
  return current.every(({ tool }) => PLANNING_TOOLS.has(tool)) ? 'planning' : 'calling_tools';
}

function startCall(params: { state: ActivityState; tool: string; callId: string; now: number }): ActivityState {
  const { state, tool, callId, now } = params;
  const current = [...state.current, { tool, callId, startedAt: now }];
  return { ...withPhase(state, phaseForCalls(current)), current };
}

function finishCall(params: { state: ActivityState; callId: string }): ActivityState {
  const { state, callId } = params;
  if (!state.current.some(call => call.callId === callId)) return state;
  const current = state.current.filter(call => call.callId !== callId);
  const { [callId]: _finished, ...titles } = state.titles;
  const { [callId]: _children, ...delegated } = state.delegated;
  return { ...withPhase(state, phaseForCalls(current)), current, titles, delegated };
}

function showView(params: { state: ActivityState; callId: string; title: string; progress?: { done: number; total: number } }): ActivityState {
  const { state, callId, title, progress } = params;
  if (!state.current.some(call => call.callId === callId)) return state;
  const current = progress == null ? state.current : state.current.map(call => (call.callId === callId ? { ...call, itemsDone: progress.done, itemsTotal: progress.total } : call));
  return { ...state, current, titles: { ...state.titles, [callId]: title } };
}

/** A sub-run's activity update replaces its calls in the parent's list (nested ids, marked with the sub-run's agent). */
function rollUp(params: { state: ActivityState; callId: string; agentName: string; event: AigentEvent }): ActivityState {
  const { state, callId, agentName, event } = params;
  if (event.type !== 'activity' || !state.current.some(call => call.callId === callId)) return state;
  const children = (event.update.current ?? []).map(child => ({ ...child, callId: `${callId}/${child.callId}`, delegatedTo: child.delegatedTo ?? { agentName, parentCallId: callId } }));
  return { ...state, delegated: { ...state.delegated, [callId]: children } };
}

/** The calls in flight, each sub-run's calls right after the `delegate` call that started it. */
export function currentCalls(state: ActivityState): ActivityToolCall[] {
  return state.current.flatMap(call => [call, ...state.delegated[call.callId] ?? []]);
}

/** The state after one loop event; unrelated events return `state` itself. */
export function reduceActivity(state: ActivityState, params: { event: AigentEvent; now(): number }): ActivityState {
  const { event, now } = params;
  switch (event.type) {
    case 'text-delta': return state.current.length === 0 ? withPhase(state, 'writing') : state;
    case 'thinking-delta': return state.current.length === 0 ? withPhase(state, 'thinking') : state;
    case 'tool-call': return startCall({ state, tool: event.name, callId: event.callId, now: now() });
    case 'tool-activity': return showView({ state, callId: event.callId, title: event.view.title, ...(event.view.progress == null ? {} : { progress: event.view.progress }) });
    case 'tool-result': return finishCall({ state, callId: event.callId });
    case 'queued': return withPhase(state, 'queued');
    case 'directive': return event.directive.type === 'status' ? { ...state, agentStatus: event.directive.data.text } : state;
    case 'plan-update': return { ...state, plan: countDone(event.items) };
    case 'todo-update': return { ...state, todo: countDone(event.items) };
    case 'delegated': return rollUp({ state, callId: event.callId, agentName: event.agentName, event: event.event });
    case 'usage': {
      const { inputTokens, outputTokens, cachedTokens } = event.usage;
      const { tokens } = state;
      return { ...state, responses: state.responses + 1, tokens: { input: tokens.input + inputTokens, output: tokens.output + outputTokens, cached: tokens.cached + cachedTokens } };
    }
    default: return state;
  }
}

/** `queued` moves on to `thinking` once the call is admitted (the next stream event says so). */
export function setPhase(state: ActivityState, phase: ActivityPhase): ActivityState {
  return withPhase(state, phase);
}

const PHASE_TEXT: Record<ActivityPhase, string> = {
  queued: 'Waiting for capacity', recalling: 'Recalling', planning: 'Updating the plan', thinking: 'Thinking', calling_tools: 'Running tools',
  waiting_for_user: 'Waiting for your answer', writing: 'Writing', verifying: 'Verifying', finishing: 'Finishing', done: 'Done', failed: 'Failed', cancelled: 'Cancelled',
};

/** The agent's own words when it gave some, otherwise derived from the phase and the tools in flight. */
export function statusText(state: ActivityState): string {
  const { agentStatus, phase, current, titles } = state;
  if (agentStatus != null && !isTerminalPhase(phase)) return agentStatus;
  if (phase !== 'calling_tools') return PHASE_TEXT[phase];
  const [only] = current;
  if (current.length === 1 && only != null) return titles[only.callId] ?? `Running ${only.tool}`;
  return `Running ${current.length} tools`;
}
