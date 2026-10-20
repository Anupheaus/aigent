import type { Guardrail, GuardrailOptions, GuardrailRunContext } from '../guardrail-types.js';
import { injectionGuardrails } from './injection.js';
import { loopGuardrails } from './loop-guard.js';
import { outputSchemaGuardrails } from './output-schema.js';
import { piiGuardrails } from './pii.js';
import { scopeGuardrails } from './scope.js';
import { secretGuardrails } from './secrets.js';

/**
 * The built-in guardrails for one run, in their fixed order (secrets, pii, injection, scope, loop-guard,
 * output-schema), each on unless set to `false`. Built per run: the loop guard counts that run's calls.
 */
export function defaultGuardrails(params: { builtins?: GuardrailOptions['builtins']; run: GuardrailRunContext }): Guardrail[] {
  const { builtins = {}, run } = params;
  const optionsOf = <T>(value: false | T | undefined): T | undefined => (value === false ? undefined : value ?? ({} as T));
  const secrets = optionsOf(builtins.secrets);
  const pii = optionsOf(builtins.pii);
  const injection = optionsOf(builtins.injection);
  const scope = optionsOf(builtins.scope);
  const loop = optionsOf(builtins['loop-guard']);
  const outputSchema = optionsOf(builtins['output-schema']);
  return [
    ...(secrets == null ? [] : secretGuardrails()),
    ...(pii == null ? [] : piiGuardrails(pii)),
    ...(injection == null ? [] : injectionGuardrails()),
    ...(scope == null ? [] : scopeGuardrails({ options: scope, run })),
    ...(loop == null ? [] : loopGuardrails(loop)),
    ...(outputSchema == null ? [] : outputSchemaGuardrails(run)),
  ];
}
