import type { Provider, ProviderCapabilities, ProviderEvent, ProviderRequest } from '@anupheaus/aigent';
import { buildRunnerEnv } from './env.js';
import { buildPrompt } from './prompt.js';
import { createSdkRunner } from './sdk-boundary.js';
import type { ClaudeAgentRunner } from './sdk-boundary.js';
import { mapSdkStream } from './stream-mapper.js';
import { bridgeTools } from './tool-bridge.js';

/** The provider id: agents select it as `claude-code:<model>`. */
export const CLAUDE_CODE_PROVIDER_ID = 'claude-code';
/** `claude-code:default` lets Claude Code (or `options.model`) choose the model. */
const DEFAULT_MODEL = 'default';
const WARNING_CODE = 'AIGENT_CLAUDE_CODE_SUBSCRIPTION_AUTH';

export interface ClaudeCodeOptions {
  /** The boundary to Claude Code; default: the Claude Agent SDK (an optional peer, loaded on first use). */
  runner?: ClaudeAgentRunner;
  /** Used for `claude-code:default`; otherwise the model of the reference is passed through. */
  model?: string;
  /**
   * Remove `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` from the subprocess environment so Claude Code uses its own
   * local subscription login. Default false. Personal use only: see the package README for the policy position.
   */
  useSubscriptionAuth?: boolean;
  /** Built-in Claude Code tools are never allowed: only an empty list is accepted. */
  allowedTools?: never[];
  cwd?: string;
  /** Added to the subprocess environment. */
  env?: Record<string, string>;
  /** Receives the one-time notice that the API key variables were removed (default: `process.emitWarning`). */
  onWarning?(message: string): void;
}

/** Delegated loop: Claude Code runs the turns; our tools run in this process through the core's executor. */
const CAPABILITIES: ProviderCapabilities = {
  streaming: true, toolCalling: true, parallelToolCalls: true, promptCaching: false, vision: false, maxContextTokens: 200_000, ownsLoop: true,
  // The SDK takes no sampling settings; every model setting is reported as unsupported and left out.
  supportedSettings: [],
};

function emitProcessWarning(message: string): void {
  process.emitWarning(message, { code: WARNING_CODE });
}

/**
 * A provider that runs Claude through Claude Code (the Claude Agent SDK) in delegated-loop mode (`ownsLoop`). Never
 * reads any credential store: authentication is whatever the Claude Code CLI itself uses.
 */
export function claudeCode(options: ClaudeCodeOptions = {}): Provider {
  const { model: defaultModel, useSubscriptionAuth = false, cwd, env, onWarning = emitProcessWarning } = options;
  const runner = options.runner ?? createSdkRunner();
  let isWarned = false;

  function stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    const { system, prompt } = buildPrompt(request.messages);
    const built = buildRunnerEnv({ parent: process.env, ...(env == null ? {} : { env }), useSubscriptionAuth });
    if (built.removed.length > 0 && !isWarned) {
      isWarned = true;
      onWarning(`claude-code: removed ${built.removed.join(' and ')} from the Claude Code environment so it uses your local subscription login (personal use only; see the package README)`);
    }
    const model = request.model === DEFAULT_MODEL ? defaultModel : request.model;
    const tools = bridgeTools({ specs: request.tools, ...(request.toolExecutor == null ? {} : { executor: request.toolExecutor }) });
    const messages = runner.run({ prompt, system, ...(model == null ? {} : { model }), tools, env: built.env, ...(cwd == null ? {} : { cwd }), signal, includePartialMessages: true });
    return mapSdkStream({ messages, signal, label: `Provider '${CLAUDE_CODE_PROVIDER_ID}'` });
  }

  return { id: CLAUDE_CODE_PROVIDER_ID, capabilities: CAPABILITIES, stream };
}
