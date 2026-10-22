import { ASK_USER_TOOL_NAME } from '../core/ask-user-name.js';
import { FEEDBACK_TOOL_NAME } from '../feedback/feedback-tool.js';
import { PLAN_COMPLETE_TOOL_NAME } from '../planning/plan-complete-tool.js';
import { TODO_TOOL_NAME } from '../planning/todo-tool.js';
import { RESULT_ORIGINAL_TOOL_NAME } from '../shapers/result-original-tool.js';
import { MULTI_TOOL_NAME } from '../tools/multi-tool.js';

/** Longest tool name providers accept (and `defineTool` allows). */
export const MAX_TOOL_NAME_CHARS = 64;
/** Built-in tool names an MCP tool may never take. */
export const RESERVED_TOOL_NAMES: readonly string[] = [MULTI_TOOL_NAME, FEEDBACK_TOOL_NAME, TODO_TOOL_NAME, PLAN_COMPLETE_TOOL_NAME, ASK_USER_TOOL_NAME, RESULT_ORIGINAL_TOOL_NAME];
/** Joins the server and tool parts, so `files__read` reads as "tool read of server files". */
const PART_SEPARATOR = '__';
/** Prefix for names that would otherwise not start with a letter. */
const LETTER_PREFIX = 'mcp_';

/** `readFile`, `read-file` and `Read File` all become `read_file`; empty when nothing usable is left. */
export function snakeCase(text: string): string {
  return text.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export interface McpToolNameParams {
  server: string;
  tool: string;
  namePrefix: 'server' | 'none';
  /** Names already used (updated with the result); a collision gets `_2`, `_3`... */
  taken: Set<string>;
}

/** The aigent name of an MCP tool: snake_case, `<server>__<tool>` by default, at most 64 characters, unique. */
export function mcpToolName(params: McpToolNameParams): string {
  const { server, tool, namePrefix, taken } = params;
  const toolPart = snakeCase(tool) || 'tool';
  const joined = namePrefix === 'server' ? `${snakeCase(server) || 'server'}${PART_SEPARATOR}${toolPart}` : toolPart;
  const base = /^[a-z]/.test(joined) ? joined : `${LETTER_PREFIX}${joined}`;
  let candidate = base.slice(0, MAX_TOOL_NAME_CHARS);
  for (let suffix = 2; taken.has(candidate); suffix += 1) {
    const tail = `_${suffix}`;
    candidate = `${base.slice(0, MAX_TOOL_NAME_CHARS - tail.length)}${tail}`;
  }
  taken.add(candidate);
  return candidate;
}
