import { createAigentError } from '../core/aigent-error.js';
import type { Message, Part } from './message.js';
import type { MessageChanges } from './patches.js';

export interface MessageUpdate {
  partIndex?: number;
  delta?: string;
  set?: MessageChanges;
}

/** Parts whose text a streamed delta extends. */
type TextualPart = Extract<Part, { text: string }>;

function isTextual(part: Part): part is TextualPart {
  return 'text' in part;
}

function appendDelta(params: { message: Message; partIndex: number; delta: string }): Part[] {
  const { message: { id, parts }, partIndex, delta } = params;
  if (partIndex === parts.length) return [...parts, { type: 'text', text: delta }];
  const part = parts[partIndex];
  if (part == null || !isTextual(part)) {
    throw createAigentError({
      code: 'invalid_input',
      message: `Patch delta for message '${id}' targets part ${partIndex}, which is ${part == null ? 'missing' : `a '${part.type}' part`}; expected a part with text or the next free index ${parts.length}`,
      details: { messageId: id, partIndex },
    });
  }
  return parts.map((existing, index) => (index === partIndex ? { ...part, text: part.text + delta } : existing));
}

/** The message after one `message-updated` patch: the delta first, then the replaced fields. */
export function updateMessage(params: { message: Message; update: MessageUpdate }): Message {
  const { message, update: { partIndex = 0, delta, set } } = params;
  const parts = delta == null ? message.parts : appendDelta({ message, partIndex, delta });
  return { ...message, parts, ...set };
}
