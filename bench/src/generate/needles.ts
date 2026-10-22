import type { PlantContext } from './plant-context.js';
import type { FamilyId } from './repo-types.js';
import { plantApiRoutes } from './families/api-routes.js';
import { plantBugHunt } from './families/bug-hunt.js';
import { plantDeadExports } from './families/dead-exports.js';
import { plantEnvVar } from './families/env-var.js';
import { plantFileFind } from './families/file-find.js';
import { plantGdprApi } from './families/gdpr-api.js';
import { plantPiiFields } from './families/pii-fields.js';
import { plantReact } from './families/react.js';
import { plantStringSearch } from './families/string-search.js';
import { plantSymbol } from './families/symbol.js';
import { plantTestMap } from './families/test-map.js';
import { plantTheme } from './families/theme.js';
import { plantTraps } from './families/traps.js';
import { plantUiCustomer } from './families/ui-customer.js';

/** Each family's planter: writes its needles, decoys and noise through the context. */
export const FAMILY_PLANTERS: Record<FamilyId, (ctx: PlantContext) => void> = {
  'file-find': plantFileFind,
  'string-search': plantStringSearch,
  theme: plantTheme,
  react: plantReact,
  'ui-customer': plantUiCustomer,
  'gdpr-api': plantGdprApi,
  'bug-hunt': plantBugHunt,
  traps: plantTraps,
  symbol: plantSymbol,
  'api-routes': plantApiRoutes,
  'env-var': plantEnvVar,
  'test-map': plantTestMap,
  'dead-exports': plantDeadExports,
  'pii-fields': plantPiiFields,
};
