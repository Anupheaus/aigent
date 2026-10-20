import { findSecrets, openSecretStart } from '../guardrails/builtin/secret-patterns.js';
import { findPii } from '../guardrails/builtin/pii.js';
import { defaultGuardrails } from '../guardrails/builtin/index-builtins.js';
import { OUTPUT_SCHEMA_NAME } from '../guardrails/builtin/output-schema.js';
import type { GuardrailDecisionRecord, GuardrailOptions, GuardrailRunContext, ToolCallValue, ToolResultValue } from '../guardrails/guardrail-types.js';
import { createGuardrailPipeline } from '../guardrails/pipeline.js';
import type { PipelineResult } from '../guardrails/pipeline.js';
import { createStreamHoldback } from '../guardrails/stream-holdback.js';
import type { StreamHoldback } from '../guardrails/stream-holdback.js';
import type { ToolCall } from '../providers/provider-types.js';
import type { ExecutedToolCall } from '../tools/execute-tool-call.js';
import type { ToolErrorDetail } from '../tools/tool-error-detail.js';
import type { AigentEvent } from './aigent-events.js';
import { errorTextsOf, withErrorTexts } from './guard-error-texts.js';

/** The error code every guardrail block carries in a tool envelope (the guardrail's own code is in `details.code`). */
export const GUARDRAIL_BLOCKED_CODE = 'guardrail_blocked';

type Blocked = Extract<PipelineResult, { action: 'block' }>;

/** A call the guardrails let through (arguments possibly rewritten), or the error that refuses it. */
export type CallVerdict = { call: ToolCall } | { error: ToolErrorDetail };

/** A final answer after the output guardrails: kept or rewritten, or blocked (with the answer as rewritten before the block). */
export type AnswerVerdict = { answer: string } | { blocked: Blocked; answer: string };

/** Whether the answer, as the model wrote it, has the task's required structure (`output-schema`). */
export type StructureVerdict = { ok: true } | { ok: false; reason: string };

/** One run's guardrails: the checks at each fixed point of the loop and every non-allow decision. */
export interface RunGuardrails {
  decisions: GuardrailDecisionRecord[];
  /** The task text (or the chat message being answered); blocked input means the run does not start. */
  checkInput(text: string): Promise<{ text: string } | { blocked: Blocked }>;
  /** Synchronous while every `toolCall` check is, so calls start in arrival order. */
  checkToolCall(call: ToolCall): CallVerdict | Promise<CallVerdict>;
  /** The envelope the model will see, after the `toolResult` checks. */
  checkToolResult(executed: ExecutedToolCall): Promise<ExecutedToolCall>;
  checkOutput(answer: string): Promise<AnswerVerdict>;
  /**
   * The task's `output` schema over the answer as the model wrote it, before any rewrite: a redaction or other rewrite
   * never makes a correct answer fail (the model could not fix what it did not do).
   */
  checkStructure(answer: string): Promise<StructureVerdict>;
  /** A turn's stream filter (hold-back and `stream` checks); undefined when no `stream` guardrail is on. */
  stream(): StreamHoldback | undefined;
}

export interface CreateRunGuardrailsParams {
  options: GuardrailOptions;
  ids: { runId: string; agentName: string };
  run: GuardrailRunContext;
  emit(event: AigentEvent): void;
}

/** The structured failure the agent sees when a guardrail stops its call or the call's result. */
export function guardrailError(params: { blocked: Blocked; subject: 'call' | 'result' }): ToolErrorDetail {
  const { blocked: { guardrail, reason, code }, subject } = params;
  return {
    category: 'denied', code: GUARDRAIL_BLOCKED_CODE, retryable: false, message: `Guardrail '${guardrail}' blocked this ${subject}: ${reason}`,
    suggestion: subject === 'call' ? 'Change the call or do without it; the same call will be blocked again.' : 'Continue without this result, or try another way to get what you need.',
    details: { guardrail, code },
  };
}

export function createRunGuardrails(params: CreateRunGuardrailsParams): RunGuardrails {
  const { options: { builtins = {}, custom = [], failMode = 'closed', timeoutMs }, ids, run, emit } = params;
  const decisions: GuardrailDecisionRecord[] = [];
  const onDecision = (record: GuardrailDecisionRecord): void => {
    decisions.push(record);
    emit({ type: 'guardrail', ...record });
    if (record.action === 'warn' || (record.action === 'error' && record.isBlocking !== true)) emit({ type: 'warning', message: `Guardrail '${record.guardrail}' (${record.stage}): ${record.message}` });
  };
  const all = defaultGuardrails({ builtins, run });
  const settings = { failMode, ...(timeoutMs == null ? {} : { timeoutMs }), onDecision };
  const pipeline = createGuardrailPipeline({ builtins: all.filter(({ name }) => name !== OUTPUT_SCHEMA_NAME), custom, ...settings });
  const structure = createGuardrailPipeline({ builtins: all.filter(({ name }) => name === OUTPUT_SCHEMA_NAME), ...settings });
  const secrets = builtins.secrets === false ? undefined : builtins.secrets ?? {};
  const isPiiStreamed = builtins.pii !== false && builtins.pii?.output === 'redact';

  const checkToolCall = (call: ToolCall): CallVerdict | Promise<CallVerdict> => {
    const toVerdict = (result: PipelineResult): CallVerdict => (result.action === 'block' ? { error: guardrailError({ blocked: result, subject: 'call' }) } : { call: { ...call, args: (result.value as ToolCallValue).args } });
    if (!pipeline.has('toolCall')) return { call };
    const result = pipeline.run({ stage: 'toolCall', value: { tool: call.name, args: call.args }, context: { ...ids, callId: call.id } });
    return result instanceof Promise ? result.then(toVerdict) : toVerdict(result);
  };

  const checkToolResult = async (executed: ExecutedToolCall): Promise<ExecutedToolCall> => {
    const { envelope } = executed;
    if (!pipeline.has('toolResult')) return executed;
    // A failure's texts are untrusted too (a driver error carries its DSN, an HTTP error its body): guarded like a result.
    const content = envelope.ok ? envelope.result : errorTextsOf(envelope.error);
    const result = await pipeline.run({ stage: 'toolResult', value: { tool: envelope.tool, result: content }, context: { ...ids, callId: envelope.id } });
    if (result.action === 'block') return { ...executed, envelope: { id: envelope.id, tool: envelope.tool, ok: false, error: guardrailError({ blocked: result, subject: 'result' }) } };
    const guarded = (result.value as ToolResultValue).result;
    if (envelope.ok) return { ...executed, envelope: { ...envelope, result: guarded } };
    return guarded === content ? executed : { ...executed, envelope: { ...envelope, error: withErrorTexts({ error: envelope.error, guarded }) } };
  };

  /** A released stream segment through the `stream` checks; a check that is not synchronous fails per `failMode`. */
  const releaseSegment = (segment: string): string => {
    const result = pipeline.run({ stage: 'stream', value: segment, context: ids });
    if (result instanceof Promise) {
      void result.catch(() => undefined);
      emit({ type: 'warning', message: 'A stream guardrail returned a promise; stream checks must be synchronous' });
      return failMode === 'closed' ? '' : segment;
    }
    return result.action === 'block' ? '' : String(result.value);
  };

  return {
    decisions,
    checkInput: async text => {
      if (!pipeline.has('input')) return { text };
      const result = await pipeline.run({ stage: 'input', value: text, context: ids });
      return result.action === 'block' ? { blocked: result } : { text: String(result.value) };
    },
    checkToolCall,
    checkToolResult,
    checkOutput: async answer => {
      if (!pipeline.has('output')) return { answer };
      const result = await pipeline.run({ stage: 'output', value: answer, context: ids });
      return result.action === 'block' ? { blocked: result, answer: String(result.value) } : { answer: String(result.value) };
    },
    checkStructure: async answer => {
      if (!structure.has('output')) return { ok: true };
      const result = await structure.run({ stage: 'output', value: answer, context: ids });
      return result.action === 'block' ? { ok: false, reason: result.reason } : { ok: true };
    },
    stream: () => {
      if (!pipeline.has('stream')) return undefined;
      return createStreamHoldback({
        ...(secrets?.holdBackChars == null ? {} : { holdBackChars: secrets.holdBackChars }),
        ...(secrets == null ? {} : { openStart: openSecretStart }),
        // A complete secret or piece of personal data is released whole, so its check sees all of it.
        spans: text => [...(secrets == null ? [] : findSecrets(text)), ...(isPiiStreamed ? findPii(text).map(({ start, end }) => ({ matchStart: start, matchEnd: end })) : [])],
        release: releaseSegment,
      });
    },
  };
}
