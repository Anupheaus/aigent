export interface ProviderOptionsParams {
  /** This provider's `providerOptions` entry. */
  providerOptions?: Record<string, unknown>;
  /** Body fields the adapter sets itself (core fields and those settings map to). */
  reserved: readonly string[];
}

export interface ReservedOptionWarningsParams extends ProviderOptionsParams {
  providerId: string;
}

/**
 * The `providerOptions` fields to merge into a request body: every key except the reserved ones. A reserved key would
 * replace something the adapter depends on (`stream: false` breaks the SSE parser) or bypass the settings rules
 * (`temperature` while thinking), so it is never sent.
 */
export function bodyOptions(params: ProviderOptionsParams): Record<string, unknown> {
  const { providerOptions = {}, reserved } = params;
  return Object.fromEntries(Object.entries(providerOptions).filter(([key]) => !reserved.includes(key)));
}

/** One warning per reserved key in `providerOptions`, since `bodyOptions` leaves those out. */
export function reservedOptionWarnings(params: ReservedOptionWarningsParams): string[] {
  const { providerOptions = {}, reserved, providerId } = params;
  return Object.keys(providerOptions)
    .filter(key => reserved.includes(key))
    .map(key => `Provider '${providerId}' ignores providerOptions key '${key}': the adapter sets that field (use the matching model setting instead)`);
}
