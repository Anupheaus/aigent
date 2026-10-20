import { z } from 'zod';
import { ASK_USER_TOOL_NAME } from '../core/ask-user-name.js';
import { defineTool } from '../tools/define-tool.js';
import type { Tool } from '../tools/tool-types.js';
import { QUESTION_TYPES } from './message.js';
import type { JsonValue, Question } from './message.js';
import type { QuestionResult } from './question-state.js';

const MAX_QUESTIONS = 10;
const MAX_ID_LENGTH = 40;
const MAX_TEXT_LENGTH = 500;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 20;
const MAX_OPTION_LENGTH = 200;
/** Waiting for a person has no natural limit: the largest delay timers allow (about 24.8 days). */
const ASK_USER_TIMEOUT_MS = 2_147_483_647;
const CHOICE_TYPES: ReadonlySet<string> = new Set(['single_choice', 'multi_choice']);

const optionSchema = z.object({ value: z.string().min(1).max(MAX_OPTION_LENGTH), label: z.string().min(1).max(MAX_OPTION_LENGTH) }).strict();

const questionSchema = z.object({
  id: z.string().min(1).max(MAX_ID_LENGTH),
  text: z.string().min(1).max(MAX_TEXT_LENGTH),
  type: z.enum(QUESTION_TYPES),
  options: z.array(optionSchema).min(MIN_OPTIONS).max(MAX_OPTIONS).optional(),
  /** As text: a number, `yes`/`no`, an option value, or comma-separated values for multi_choice. */
  default: z.string().max(MAX_TEXT_LENGTH).optional(),
  required: z.boolean(),
  min: z.number().optional(),
  max: z.number().optional(),
}).strict();

export const askUserArgsSchema = z.object({
  questions: z.array(questionSchema).min(1).max(MAX_QUESTIONS),
}).strict().superRefine(({ questions }, context) => {
  const seen = new Set<string>();
  questions.forEach(({ id, type, options }, index) => {
    if (seen.has(id)) context.addIssue({ code: 'custom', message: `duplicate question id '${id}'`, path: ['questions', index, 'id'] });
    seen.add(id);
    if (CHOICE_TYPES.has(type) && options == null) context.addIssue({ code: 'custom', message: `${type} question '${id}' needs 2 to 20 options`, path: ['questions', index, 'options'] });
    if (!CHOICE_TYPES.has(type) && options != null) context.addIssue({ code: 'custom', message: `${type} question '${id}' takes no options`, path: ['questions', index, 'options'] });
  });
});

type AskUserArgs = z.infer<typeof askUserArgsSchema>;

/** Hands a batch to whoever answers it; resolves with one result per question. */
export type AskUser = (params: { questions: Question[]; callId: string; signal: AbortSignal }) => Promise<QuestionResult[]>;

function parseDefault(params: { type: Question['type']; text: string }): JsonValue {
  const { type, text } = params;
  if (type === 'number') { const parsed = Number(text); return Number.isFinite(parsed) ? parsed : text; }
  if (type === 'confirm') return ['yes', 'true'].includes(text.trim().toLowerCase());
  if (type === 'multi_choice') return text.split(',').map(part => part.trim()).filter(part => part !== '');
  return text;
}

/** The questions as the conversation stores them (`default` parsed into its type). */
export function toQuestions(args: AskUserArgs): Question[] {
  return args.questions.map(({ default: defaultText, ...question }) => ({ ...question, ...(defaultText == null ? {} : { default: parseDefault({ type: question.type, text: defaultText }) }) }));
}

const DESCRIPTION = [
  'Ask the user one or more questions at once (up to 10) when you cannot proceed well without their input.',
  'Types: text, number, confirm (yes/no), single_choice and multi_choice (both need 2 to 20 options).',
  'The result lists each question with ok and the value, or ok: false when it was not answered.',
].join(' ');

/** The `ask_user` tool: strict, never cached, never compacted, and waits for `ask` without a practical timeout. */
export function createAskUserTool(ask: AskUser): Tool {
  return defineTool({
    name: ASK_USER_TOOL_NAME, description: DESCRIPTION, args: askUserArgsSchema, deterministic: false, cache: false, compactable: false, timeoutMs: ASK_USER_TIMEOUT_MS,
    describeActivity: ({ questions }) => ({ title: questions.length === 1 ? 'Asking a question' : `Asking ${questions.length} questions` }),
    run: async (args, { callId, signal }) => ask({ questions: toQuestions(args), callId, signal }),
  });
}
