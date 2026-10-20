import { createAigentError } from '../core/aigent-error.js';
import { GUARDRAIL_STAGES } from './guardrail-types.js';
import type { Guardrail } from './guardrail-types.js';

const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

function invalid(params: { name: string; message: string }): never {
  const { name, message } = params;
  throw createAigentError({ code: 'invalid_definition', message: `Guardrail '${name}': ${message}`, details: { guardrail: name } });
}

/** Validates a custom guardrail (name, stage, check, flags) and returns it; throws `invalid_definition`. */
export function defineGuardrail(guardrail: Guardrail): Guardrail {
  const { name, stage, check, blockLevel, order } = guardrail;
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) invalid({ name: String(name), message: `name must match ${NAME_PATTERN}, got '${String(name)}'` });
  if (!(GUARDRAIL_STAGES as readonly unknown[]).includes(stage)) invalid({ name, message: `stage must be one of ${GUARDRAIL_STAGES.join(', ')}, got '${String(stage)}'` });
  if (typeof check !== 'function') invalid({ name, message: 'check must be a function of the value and its context' });
  if (blockLevel !== undefined && typeof blockLevel !== 'boolean') invalid({ name, message: `blockLevel must be a boolean, got ${String(blockLevel)}` });
  if (order !== undefined && !Number.isFinite(order)) invalid({ name, message: `order must be a finite number, got ${String(order)}` });
  return guardrail;
}
