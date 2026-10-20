export interface ResolveEnableFeedbackParams {
  /** The agent's (or else the runtime's) explicit choice. */
  explicit?: boolean;
  env: Record<string, string | undefined>;
}

const PRODUCTION = 'production';

/** An explicit value wins; otherwise feedback is on everywhere except `NODE_ENV=production`, where it would cost tokens. */
export function resolveEnableFeedback(params: ResolveEnableFeedbackParams): boolean {
  const { explicit, env } = params;
  return explicit ?? env.NODE_ENV !== PRODUCTION;
}
