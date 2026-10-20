/** One search result as a provider returns it. */
export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** What `web_search` asks a provider for. */
export interface SearchOptions {
  /** Results wanted (1 to 10). */
  limit: number;
  signal: AbortSignal;
}

/**
 * A web search backend the consumer supplies (none ships: each needs its own keys and terms). `web_search` is only
 * registered when one is given. A throw becomes a structured `search_failed` item failure.
 */
export interface SearchProvider {
  /** Shown in results and failures, e.g. `brave` or `internal-docs`. */
  name: string;
  search(query: string, options: SearchOptions): Promise<SearchHit[]>;
}
