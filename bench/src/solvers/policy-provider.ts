import { createAigentError } from '../../../src/index.js';
import type { Provider, ProviderEvent, ProviderRequest, ToolCall } from '../../../src/index.js';
import { estimateTokens, requestTokens } from '../measure/token-estimator.js';
import type { SolverAnswer } from '../task-spec.js';
import type { Policy, PolicyCall, PolicyResult } from './policy-types.js';

/** The summary returned when the run asks for a compaction summary (a request without tools). */
const COMPACTION_SUMMARY = 'Goal: answer the task. Facts: earlier tool results were reviewed by the policy, which keeps its own notes.';
/** Context window the policy "model" declares (the same as the library's fake provider). */
const POLICY_CONTEXT_TOKENS = 128_000;

type Action = { kind: 'calls'; calls: ToolCall[] } | { kind: 'answer'; answer: SolverAnswer } | { kind: 'error'; message: string };

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}

/** The tool message text as a parsed envelope; the text may carry a guardrail heading before the JSON. */
function parseEnvelope(params: { call: ToolCall; text: string }): PolicyResult {
  const { call, text } = params;
  const start = text.indexOf('{');
  try {
    const envelope = JSON.parse(start < 0 ? text : text.slice(start)) as { ok?: boolean; result?: unknown; error?: { code?: string; message?: string } };
    return { name: call.name, args: call.args, ok: envelope.ok === true, text, ...(envelope.result === undefined ? {} : { result: envelope.result }), ...(envelope.error == null ? {} : { error: envelope.error }) };
  } catch {
    // Not JSON (e.g. truncated by the result budget): the policy gets the text and a failure.
    return { name: call.name, args: call.args, ok: false, text, error: { code: 'unparsed', message: text.slice(0, 200) } };
  }
}

/**
 * A provider that plays a scripted policy: each request resumes the policy with the results of its previous calls and
 * streams its next calls (or its final answer, as JSON text). Usage is the bench estimator over the request as sent.
 */
export function createPolicyProvider(params: { policy: Policy; prompt: string; scope: string[]; id?: string }): Provider {
  const { policy, prompt, scope, id = 'policy' } = params;
  let next = deferred<Action>();
  let pending: Deferred<PolicyResult[]> | undefined;
  let lastCalls: ToolCall[] = [];
  let isStarted = false;
  let turn = 0;

  const start = (tools: string[]): void => {
    isStarted = true;
    const call = (calls: PolicyCall[]): Promise<PolicyResult[]> => {
      turn += 1;
      lastCalls = calls.map((policyCall, index) => ({ id: `t${turn}c${index + 1}`, name: policyCall.name, args: policyCall.args }));
      pending = deferred<PolicyResult[]>();
      next.resolve({ kind: 'calls', calls: lastCalls });
      return pending.promise;
    };
    policy({ prompt, scope, tools, call }).then(
      answer => next.resolve({ kind: 'answer', answer }),
      (error: unknown) => next.resolve({ kind: 'error', message: error instanceof Error ? error.message : String(error) }),
    );
  };

  async function* stream(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
    if (request.tools.length === 0) {
      yield { type: 'text-delta', text: COMPACTION_SUMMARY };
      yield { type: 'usage', usage: { inputTokens: requestTokens(request), outputTokens: estimateTokens(COMPACTION_SUMMARY), cachedTokens: 0 } };
      yield { type: 'done', finishReason: 'stop' };
      return;
    }
    if (!isStarted) start(request.tools.map(({ name }) => name));
    else if (pending != null) {
      next = deferred<Action>();
      const texts = new Map(request.messages.filter(({ role }) => role === 'tool').map(({ toolCallId, text }) => [toolCallId, text ?? '']));
      const resolving = pending;
      pending = undefined;
      resolving.resolve(lastCalls.map(call => parseEnvelope({ call, text: texts.get(call.id) ?? '{"ok":false,"error":{"message":"no tool result"}}' })));
    }
    const action = await next.promise;
    const input = requestTokens(request);
    if (action.kind === 'error') throw createAigentError({ code: 'provider_failed', message: `policy failed: ${action.message}` });
    if (action.kind === 'calls') {
      for (const call of action.calls) yield { type: 'tool-call', call };
      yield { type: 'usage', usage: { inputTokens: input, outputTokens: estimateTokens(JSON.stringify(action.calls)), cachedTokens: 0 } };
      yield { type: 'done', finishReason: 'tool_calls' };
      return;
    }
    const text = JSON.stringify(action.answer);
    yield { type: 'text-delta', text };
    yield { type: 'usage', usage: { inputTokens: input, outputTokens: estimateTokens(text), cachedTokens: 0 } };
    yield { type: 'done', finishReason: 'stop' };
  }

  return {
    id,
    capabilities: { streaming: true, toolCalling: true, parallelToolCalls: true, promptCaching: false, vision: false, maxContextTokens: POLICY_CONTEXT_TOKENS, supportedSettings: [] },
    stream,
  };
}
