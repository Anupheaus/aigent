import type { TaskResultData } from './agent-types.js';
import { runAgentTurns } from './run-agent-turns.js';
import type { RunAgentTurnsParams } from './run-agent-turns-types.js';
import type { NewContextMessage } from './run-context.js';

export interface TaskPromptTexts {
  /** The system prompt as sent (compression applied). */
  systemPrompt: string;
  /** The task brief as sent (compression applied). */
  brief: string;
}

export type RunTaskParams = Omit<RunAgentTurnsParams, 'initial'> & TaskPromptTexts;

/** A task run starts from the system prompt and the task brief. */
export function taskInitialMessages(texts: TaskPromptTexts): NewContextMessage[] {
  const { systemPrompt, brief } = texts;
  return [{ kind: 'system', message: { role: 'system', text: systemPrompt } }, { kind: 'brief', message: { role: 'user', text: brief } }];
}

/** Runs the agent loop for a task until the model answers, a limit is hit, the run is stopped or the provider fails. */
export function runTask(params: RunTaskParams): Promise<TaskResultData> {
  const { systemPrompt, brief, ...loop } = params;
  return runAgentTurns({ ...loop, initial: taskInitialMessages({ systemPrompt, brief }) });
}
