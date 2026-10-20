import { createAigentError } from '../../../core/aigent-error.js';
import type { Tool } from '../../tool-types.js';
import { createHttpFetch } from './http-fetch.js';
import { createPageExtract } from './page-extract.js';
import { createWebSearch } from './web-search.js';
import { resolveWebDeps } from './web-shared.js';
import type { WebToolsOptions } from './web-shared.js';

/**
 * The web pack: `http_fetch` and `page_extract` through `options.policy` (deny by default: every URL and redirect is
 * checked against the allowlist and SSRF rules), and `web_search` when a search provider is given.
 */
export function webTools(options: WebToolsOptions): Tool[] {
  if (typeof options?.policy?.checkUrl !== 'function') {
    throw createAigentError({ code: 'invalid_definition', message: 'webTools needs a policy from createHttpPolicy({ allowDomains })', details: { option: 'policy' } });
  }
  const deps = resolveWebDeps(options);
  return [createHttpFetch(deps), createPageExtract(deps), ...(deps.search == null ? [] : [createWebSearch(deps.search)])];
}
