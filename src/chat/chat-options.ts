import { z } from 'zod';
import { createAigentError } from '../core/aigent-error.js';
import { describeIssues } from '../core/describe-issues.js';
import { modelSettingsSchema } from '../core/model-settings.js';
import type { ChatAttachmentOptions, ChatOptions } from './chat-types.js';

const DELIVERY_MODES = ['queue', 'steer', 'interrupt'] as const;
const isFunction = (value: unknown): boolean => typeof value === 'function';

const attachmentOptionsSchema = z.object({
  readAttachment: z.custom<ChatAttachmentOptions['readAttachment']>(isFunction, 'readAttachment must be a function').optional(),
  onNoVision: z.enum(['error', 'describe']).optional(),
  describe: z.custom<ChatAttachmentOptions['describe']>(isFunction, 'describe must be a function').optional(),
}).strict().refine(({ onNoVision, describe }) => onNoVision !== 'describe' || describe != null, { message: "onNoVision 'describe' needs a describe function" });

const chatOptionsSchema = z.object({
  sessionId: z.string().min(1).max(200).optional(),
  persistence: z.enum(['store', 'memory']).optional(),
  context: z.string().optional(),
  constraints: z.array(z.string()).optional(),
  unattended: z.boolean().optional(),
  signal: z.instanceof(AbortSignal).optional(),
  whileBusy: z.enum(DELIVERY_MODES).optional(),
  coalesce: z.boolean().optional(),
  onStop: z.enum(['discard', 'keep']).optional(),
  modelSettings: modelSettingsSchema.optional(),
  autoTitle: z.boolean().optional(),
  attachments: attachmentOptionsSchema.optional(),
}).strict();

/** `ChatOptions` after validation, with `persistence` resolved against the runtime's store. */
export interface ResolvedChatOptions extends ChatOptions {
  persistence: 'store' | 'memory';
}

/** Validates `agent.chat(options)`; throws `invalid_input` naming each bad field. */
export function parseChatOptions(params: { options: unknown; hasStore: boolean }): ResolvedChatOptions {
  const { options = {}, hasStore } = params;
  const result = chatOptionsSchema.safeParse(options);
  if (!result.success) throw createAigentError({ code: 'invalid_input', message: `Invalid chat options: ${describeIssues(result.error)}`, details: { issues: result.error.issues.length } });
  const { persistence = hasStore ? 'store' : 'memory' } = result.data;
  if (persistence === 'store' && !hasStore) {
    throw createAigentError({ code: 'invalid_input', message: "Chat persistence 'store' needs createAigent({ store }); pass persistence: 'memory' or give the runtime a store" });
  }
  return { ...(result.data as ChatOptions), persistence };
}
