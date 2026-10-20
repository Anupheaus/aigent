import { createAigentError } from './aigent-error.js';

/** A `provider:model` string split into its parts. */
export interface ModelReference {
  providerId: string;
  model: string;
}

const MODEL_SEPARATOR = ':';

/** Splits `provider:model` at the first colon, since model ids may themselves contain colons. Throws `invalid_definition`. */
export function parseModelReference(modelReference: string): ModelReference {
  const separatorIndex = modelReference.indexOf(MODEL_SEPARATOR);
  const providerId = modelReference.slice(0, separatorIndex);
  const model = modelReference.slice(separatorIndex + 1);
  if (separatorIndex === -1 || providerId === '' || model === '') {
    throw createAigentError({ code: 'invalid_definition', message: `Model '${modelReference}' must be in the form provider:model, e.g. 'anthropic:claude-sonnet-5-5'`, details: { model: modelReference } });
  }
  return { providerId, model };
}
