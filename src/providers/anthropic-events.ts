import { z } from 'zod';

// Only the fields we read; everything nullish so new or omitted fields never break parsing.
const usageSchema = z.object({
  input_tokens: z.number().nullish(),
  output_tokens: z.number().nullish(),
  cache_read_input_tokens: z.number().nullish(),
  cache_creation_input_tokens: z.number().nullish(),
});

/** One Anthropic stream event, as far as the adapter reads it. */
export const eventSchema = z.object({
  type: z.string().nullish(),
  index: z.number().int().nonnegative().nullish(),
  message: z.object({ usage: usageSchema.nullish() }).nullish(),
  content_block: z.object({
    type: z.string(),
    id: z.string().nullish(),
    name: z.string().nullish(),
    thinking: z.string().nullish(),
    signature: z.string().nullish(),
    data: z.string().nullish(),
  }).nullish(),
  delta: z.object({
    type: z.string().nullish(),
    text: z.string().nullish(),
    thinking: z.string().nullish(),
    signature: z.string().nullish(),
    partial_json: z.string().nullish(),
    stop_reason: z.string().nullish(),
  }).nullish(),
  usage: usageSchema.nullish(),
  error: z.object({ type: z.string().nullish(), message: z.string().nullish() }).nullish(),
});

export type AnthropicEvent = z.infer<typeof eventSchema>;
