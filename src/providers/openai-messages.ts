import type { JsonSchema, ProviderMessage, ProviderRequest, ProviderToolSpec, ToolCall } from './provider-types.js';

/** Wire shapes of the OpenAI Chat Completions request (only the fields we send). */
export interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type OpenAiMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface OpenAiTool {
  type: 'function';
  function: { name: string; description: string; parameters: JsonSchema; strict: boolean };
}

export interface OpenAiChatRequest {
  model: string;
  messages: OpenAiMessage[];
  stream: true;
  stream_options: { include_usage: true };
  tools?: OpenAiTool[];
  max_tokens?: number;
}

function toOpenAiToolCall(call: ToolCall): OpenAiToolCall {
  const { id, name, args } = call;
  // String args are the model's own (possibly malformed) JSON; echo them back untouched.
  const serialised = typeof args === 'string' ? args : JSON.stringify(args);
  return { id, type: 'function', function: { name, arguments: serialised } };
}

function toOpenAiMessage(message: ProviderMessage): OpenAiMessage {
  const { role, text = '', toolCalls = [], toolCallId = '' } = message;
  switch (role) {
    case 'system':
    case 'user':
      return { role, content: text };
    case 'assistant':
      // OpenAI wants `null` rather than an empty string when the turn only called tools.
      return toolCalls.length === 0
        ? { role, content: text === '' ? null : text }
        : { role, content: text === '' ? null : text, tool_calls: toolCalls.map(toOpenAiToolCall) };
    case 'tool':
      return { role, tool_call_id: toolCallId, content: text };
  }
}

function toOpenAiTool(tool: ProviderToolSpec): OpenAiTool {
  const { name, description, parameters, strict } = tool;
  return { type: 'function', function: { name, description, parameters, strict } };
}

/** Translates a normalised request into the OpenAI streaming Chat Completions body. */
export function toOpenAiChatRequest(request: ProviderRequest): OpenAiChatRequest {
  const { model, messages, tools, maxOutputTokens } = request;
  return {
    model,
    messages: messages.map(toOpenAiMessage),
    stream: true,
    stream_options: { include_usage: true },
    ...(tools.length === 0 ? {} : { tools: tools.map(toOpenAiTool) }),
    ...(maxOutputTokens == null ? {} : { max_tokens: maxOutputTokens }),
  };
}
