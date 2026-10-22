/**
 * Variables that make Claude Code bill an API account instead of the local subscription login. They win over the
 * login, so subscription auth only works without them.
 */
export const SUBSCRIPTION_STRIPPED_VARIABLES: readonly string[] = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

export interface BuildRunnerEnvParams {
  /** The environment the subprocess would inherit (normally `process.env`). */
  parent: Readonly<Record<string, string | undefined>>;
  /** `claudeCode({ env })`: added on top of `parent`. */
  env?: Readonly<Record<string, string>>;
  /** Only when true are the API key variables removed. */
  useSubscriptionAuth: boolean;
}

export interface RunnerEnv {
  /** A new object; `parent` is never changed. */
  env: Record<string, string>;
  /** Names removed for subscription auth (as spelled in the environment). */
  removed: string[];
}

/**
 * The Claude Code subprocess environment: a copy of `parent` plus `env`. With `useSubscriptionAuth`, the API key
 * variables are left out (compared case-insensitively, as Windows does), so the CLI falls back to its own local
 * login. Nothing here reads any credential store: the CLI handles its login itself.
 */
export function buildRunnerEnv(params: BuildRunnerEnvParams): RunnerEnv {
  const { parent, env = {}, useSubscriptionAuth } = params;
  const stripped = new Set(SUBSCRIPTION_STRIPPED_VARIABLES.map(name => name.toUpperCase()));
  const result: Record<string, string> = {};
  const removed: string[] = [];
  for (const [name, value] of [...Object.entries(parent), ...Object.entries(env)]) {
    if (value == null) continue;
    if (useSubscriptionAuth && stripped.has(name.toUpperCase())) {
      if (!removed.includes(name)) removed.push(name);
      continue;
    }
    result[name] = value;
  }
  return { env: result, removed };
}
